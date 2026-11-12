import express, { Router, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { asyncRoute } from "../middleware/asyncRoute";
import { isUuid, type StableRequest } from "../middleware/stable";
import type { AuthenticatedRequest } from "../middleware/auth";
import { supabase } from "../lib/supabase";
import { messageCursor } from "../lib/workspace";
import { ALLOWED_TYPES, MAX_FILE_BYTES, QUOTA_BYTES, chatStorage, safeFileName } from "../lib/chatStorage";
import { allow, allowed, isActive, seenAt, setTyping, touch, typers } from "../lib/presence";

/**
 * Stayblz Chat endpoints shared by personal chats (/api/messages) and team chats (/api/team-messages).
 * Every read and write is a checked SQL function (`chat_*`, migrations 202611110001 + 202611120001) that
 * verifies membership itself. RPC arguments are passed in parameter order.
 *
 * No websockets on the free plan: the browser polls `GET /:id/updates?since=` while a chat is open.
 * "Typing…" and "Active now" live in server memory (lib/presence.ts), not the database.
 */
export type ChatKind = "personal" | "team";
export const PAGE_SIZE = 50;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const user = (req: Request) => (req as AuthenticatedRequest).user;

export function chatScope(req: Request, kind: ChatKind) {
  return {
    p_kind: kind,
    p_user: user(req).id,
    p_stable: kind === "team" ? (req as StableRequest).stable.id : null,
  };
}

const ERRORS: Record<string, [number, string]> = {
  request_pending: [409, "Accept this message request before you reply or react."],
  blocked: [403, "You can't message this person."],
  invalid_reaction: [400, "Pick one of the reactions shown."],
  invalid_message: [400, "Use 1–4,000 characters and try again."],
  edit_window: [409, "Messages can only be edited for 15 minutes after sending."],
  not_editable: [400, "Only text messages can be edited."],
  pin_limit: [409, "You can pin up to 20. Unpin one first."],
  invalid_folder: [400, "That folder no longer exists."],
  invalid_settings: [400, "Those settings couldn't be saved."],
  not_group: [400, "That only works in group chats."],
  not_admin: [403, "Only the person who created the group can remove people."],
  invalid_participants: [400, "Some of those people can't be added."],
  conversation_full: [409, "Groups can have up to 30 people."],
  invalid_query: [400, "Type at least 2 characters to search."],
  invalid_attachment: [400, "That file can't be sent."],
  invalid_title: [400, "Use 1–120 characters for the group name."],
};

export function chatError(res: Response, error: { message?: string } | null) {
  const reason = error?.message ?? "";
  if (/not_found|not_a_participant/.test(reason))
    return res.status(404).json({ error: "Conversation not found." });
  for (const [code, [status, message]] of Object.entries(ERRORS))
    if (reason.includes(code)) return res.status(status).json({ error: message, code });
  return res.status(503).json({ error: "Chat is busy right now. Wait a moment and try again." });
}

/** One conversation with its newest page of messages (or the page before `before`). */
export async function loadThread(req: Request, kind: ChatKind, id: string, before?: { time: string; id: string } | null) {
  const result = await supabase.rpc("chat_thread", {
    ...chatScope(req, kind),
    p_conversation: id,
    p_before_time: before?.time ?? null,
    p_before_id: before?.id ?? null,
    p_since: null,
    p_limit: PAGE_SIZE,
  });
  if (!result.error && result.data) decorate(kind, user(req).id, result.data);
  return result;
}

/** Adds what only the server's memory knows: who's active and who's typing. */
function decorate(kind: ChatKind, me: string, data: any) {
  const c = data?.conversation;
  if (!c) return;
  allow(kind, c.id, me);
  const mine = (c.members ?? []).find((m: any) => m.me);
  const share = mine?.showActive !== false;
  for (const m of c.members ?? []) {
    const visible = share && m.showActive !== false && !m.me;
    m.active = visible && isActive(m.id);
    m.seenAt = visible ? seenAt(m.id) : null;
    delete m.showActive;
  }
  c.typing = typers(kind, c.id, me);
}

/** Last-sent errors for uploads: per person, 40 files per 10 minutes. */
const uploads = new Map<string, number[]>();
function uploadAllowed(id: string) {
  const now = Date.now();
  const recent = (uploads.get(id) ?? []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 40) return false;
  recent.push(now);
  uploads.set(id, recent);
  if (uploads.size > 5000) uploads.delete(uploads.keys().next().value!);
  return true;
}

const rawFile = express.raw({ type: () => true, limit: MAX_FILE_BYTES });
function rawFileOrError(req: Request, res: Response, next: NextFunction) {
  rawFile(req, res, (error?: any) => {
    if (error?.type === "entity.too.large")
      return res.status(413).json({ error: "Files can be up to 4 MB.", code: "file_too_large" });
    if (error) return next(error);
    next();
  });
}

export function chatRoutes(kind: ChatKind) {
  const router = Router();
  router.use((req, _res, next) => {
    touch(user(req).id);
    next();
  });
  router.param("id", (req, res, next, id) => {
    if (isUuid(id)) next();
    else res.status(404).json({ error: "Conversation not found." });
  });
  router.param("message", (req, res, next, id) => {
    if (isUuid(id)) next();
    else res.status(404).json({ error: "Message not found." });
  });

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase.rpc("chat_list", chatScope(req, kind));
      if (error) return chatError(res, error);
      const rows: any[] = data ?? [];
      // "Active now" dots for one-to-one chats, respecting everyone's "show when I'm active" choice.
      const others = [...new Set(rows.map((c) => c.otherId).filter(isUuid))] as string[];
      if (others.length) {
        const me = user(req).id;
        const { data: hidden } = await supabase
          .from("chat_profiles")
          .select("user_id")
          .in("user_id", [...others, me])
          .eq("show_active", false);
        const off = new Set((hidden ?? []).map((r: any) => r.user_id));
        for (const c of rows)
          c.active = !off.has(me) && !!c.otherId && !off.has(c.otherId) && isActive(c.otherId);
      }
      res.json({ conversations: rows });
    }),
  );

  router.get(
    "/:id",
    asyncRoute(async (req, res) => {
      const before = req.query.before;
      const cursor = messageCursor(before);
      if (before !== undefined && !cursor) return res.status(400).json({ error: "Invalid history request." });
      const { data, error } = await loadThread(req, kind, req.params.id, cursor);
      if (error) return chatError(res, error);
      res.json(data);
    }),
  );

  // Cheap poll: only what changed since `since` (the `now` from the previous response).
  router.get(
    "/:id/updates",
    asyncRoute(async (req, res) => {
      const since = req.query.since;
      if (typeof since !== "string" || !ISO.test(since) || !Number.isFinite(Date.parse(since)))
        return res.status(400).json({ error: "Invalid update request." });
      const { data, error } = await supabase.rpc("chat_thread", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_before_time: null,
        p_before_id: null,
        p_since: since,
        p_limit: PAGE_SIZE,
      });
      if (error) return chatError(res, error);
      decorate(kind, user(req).id, data);
      res.json(data);
    }),
  );

  router.post(
    "/:id/messages",
    asyncRoute(async (req, res) => {
      const body = req.body?.body;
      const replyTo = req.body?.replyTo ?? null;
      if (
        typeof body !== "string" ||
        !body.trim() ||
        body.trim().length > 4000 ||
        !isUuid(req.body?.clientId) ||
        (replyTo !== null && !isUuid(replyTo))
      )
        return res.status(400).json({ error: "Use 1–4,000 characters and try again." });
      setTyping(kind, req.params.id, user(req).id, "", false);
      const { data, error } = await supabase.rpc("chat_send", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_display: user(req).displayName,
        p_body: body,
        p_client: req.body.clientId,
        p_reply: replyTo,
        p_attachment: null,
        p_forwarded: false,
      });
      if (error) {
        if (/not_found|not_a_participant|request_pending|invalid_message|blocked/.test(error.message ?? ""))
          return chatError(res, error);
        return res.status(503).json({ error: "Message not sent. The chat server is busy — tap Retry in a moment." });
      }
      res.status(201).json({ message: data });
    }),
  );

  // One photo or file per message. The body is the raw file; details travel in the query string.
  router.post(
    "/:id/attachments",
    rawFileOrError,
    asyncRoute(async (req, res) => {
      const me = user(req);
      const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const rule = ALLOWED_TYPES[type];
      const name = safeFileName(req.query.name);
      const clientId = req.query.clientId;
      const replyTo = req.query.replyTo ?? null;
      const file = req.body;
      if (!rule) return res.status(415).json({ error: "Send photos (JPG, PNG, WebP, GIF) or PDF, Word, Excel and text files.", code: "file_type" });
      if (!Buffer.isBuffer(file) || !file.length || !name || !isUuid(clientId) || (replyTo !== null && !isUuid(replyTo)))
        return res.status(400).json({ error: "That file can't be sent." });
      if (rule.magic && !rule.magic(file)) return res.status(415).json({ error: "That file doesn't look like the type it claims to be.", code: "file_type" });
      if (!uploadAllowed(me.id)) return res.status(429).json({ error: "You've sent a lot of files. Wait a few minutes.", retryAfterSeconds: 600 });

      const scope = chatScope(req, kind);
      const { data: chat, error: chatErr } = await supabase.rpc("chat_get", { ...scope, p_conversation: req.params.id });
      if (chatErr) return chatError(res, chatErr);
      if (!chat) return res.status(404).json({ error: "Conversation not found." });
      if ((chat.requested_ids ?? []).includes(me.id)) return chatError(res, { message: "request_pending" });

      // A retry of a file that already arrived: return the saved message, don't store it twice.
      const table = kind === "team" ? "member_messages" : "personal_messages";
      const { data: existing } = await supabase.from(table).select("id").eq("conversation_id", req.params.id)
        .eq("sender_id", me.id).eq("client_id", clientId).maybeSingle();
      if (!existing) {
        const { data: used, error: quotaErr } = await supabase.rpc("chat_quota", { p_user: me.id });
        if (quotaErr) return chatError(res, quotaErr);
        if (Number(used ?? 0) + file.length > QUOTA_BYTES)
          return res.status(413).json({ error: "You've used your 50 MB of chat files. Unsend some old files to make room.", code: "quota" });
      }

      const path = `${kind}/${req.params.id}/${randomUUID()}`;
      const dims = (v: unknown) => (typeof v === "string" && /^\d{1,5}$/.test(v) ? Number(v) : undefined);
      const attachment = {
        path,
        name,
        size: file.length,
        type,
        ...(rule.image && dims(req.query.width) && dims(req.query.height)
          ? { width: dims(req.query.width), height: dims(req.query.height) }
          : {}),
      };
      if (!existing) {
        try {
          await chatStorage.upload(path, file, type);
        } catch {
          return res.status(503).json({ error: "File storage is busy. Tap Retry in a moment." });
        }
      }
      const { data, error } = await supabase.rpc("chat_send", {
        ...scope,
        p_conversation: req.params.id,
        p_display: me.displayName,
        p_body: "",
        p_client: clientId,
        p_reply: replyTo,
        p_attachment: existing ? null : attachment,
        p_forwarded: false,
      });
      if (error) {
        if (!existing) await chatStorage.remove([path]).catch(() => undefined);
        return chatError(res, error);
      }
      res.status(201).json({ message: data });
    }),
  );

  // Streams a stored file to members only. Same-origin, so the site's image policy doesn't change.
  router.get(
    "/:id/files/:message",
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase.rpc("chat_attachment", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_message: req.params.message,
      });
      if (error) return chatError(res, error);
      const rule = ALLOWED_TYPES[data?.type];
      let file: Buffer;
      try {
        file = await chatStorage.download(data.path);
      } catch {
        return res.status(404).json({ error: "This file is no longer available." });
      }
      const inline = !!rule?.image && req.query.download !== "1";
      res.setHeader("Content-Type", rule ? data.type : "application/octet-stream");
      res.setHeader("Content-Length", String(file.length));
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename="${String(data.name).replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(data.name)}`,
      );
      res.end(file);
    }),
  );

  router.post(
    "/:id/read",
    asyncRoute(async (req, res) => {
      const { error } = await supabase.rpc("chat_read", { ...chatScope(req, kind), p_conversation: req.params.id });
      if (error) return chatError(res, error);
      res.json({ ok: true });
    }),
  );

  // "Typing…": memory only. Only people who loaded this chat recently can set it.
  router.post("/:id/typing", (req, res) => {
    const me = user(req);
    if (!allowed(kind, req.params.id, me.id)) return res.json({ ok: false });
    setTyping(kind, req.params.id, me.id, me.displayName, req.body?.on !== false);
    res.json({ ok: true });
  });

  router.post(
    "/:id/messages/:message/react",
    asyncRoute(async (req, res) => {
      const emoji = req.body?.emoji ?? "";
      if (typeof emoji !== "string" || emoji.length > 16)
        return res.status(400).json({ error: "Pick one of the reactions shown." });
      const { data, error } = await supabase.rpc("chat_react", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_message: req.params.message,
        p_emoji: emoji,
      });
      if (error) return chatError(res, error);
      res.json({ message: data });
    }),
  );

  router.post(
    "/:id/messages/:message/edit",
    asyncRoute(async (req, res) => {
      const body = req.body?.body;
      if (typeof body !== "string" || !body.trim() || body.trim().length > 4000)
        return res.status(400).json({ error: "Use 1–4,000 characters and try again." });
      const { data, error } = await supabase.rpc("chat_edit", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_message: req.params.message,
        p_body: body,
      });
      if (error) return chatError(res, error);
      res.json({ message: data });
    }),
  );

  router.post(
    "/:id/messages/:message/pin",
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase.rpc("chat_pin", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_message: req.params.message,
        p_pin: req.body?.pin !== false,
      });
      if (error) return chatError(res, error);
      res.json({ message: data });
    }),
  );

  router.post(
    "/:id/messages/:message/unsend",
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase.rpc("chat_unsend", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_message: req.params.message,
      });
      if (error) return chatError(res, error);
      if (data?.removePath) await chatStorage.remove([data.removePath]).catch(() => undefined);
      res.json({ message: data?.message });
    }),
  );

  // Forward one message to up to 10 chats of the same kind (team: same stable).
  router.post(
    "/:id/messages/:message/forward",
    asyncRoute(async (req, res) => {
      const to = req.body?.to;
      if (!Array.isArray(to) || !to.length || to.length > 10 || !to.every(isUuid))
        return res.status(400).json({ error: "Choose up to 10 chats." });
      const results: { to: string; ok: boolean; error?: string }[] = [];
      for (const target of [...new Set(to as string[])]) {
        const { error } = await supabase.rpc("chat_forward", {
          ...chatScope(req, kind),
          p_from: req.params.id,
          p_message: req.params.message,
          p_to: target,
          p_display: user(req).displayName,
          p_client: randomUUID(),
        });
        const code = error ? Object.keys(ERRORS).find((k) => error.message?.includes(k)) : undefined;
        results.push(error ? { to: target, ok: false, error: code ? ERRORS[code][1] : "Not sent." } : { to: target, ok: true });
      }
      res.json({ results });
    }),
  );

  // Your own settings for this chat: pin, archive, mute, mark unread, folder.
  router.post(
    "/:id/settings",
    asyncRoute(async (req, res) => {
      const body = req.body ?? {};
      const changes: Record<string, unknown> = {};
      for (const key of ["pinned", "archived", "muted", "unread"])
        if (key in body) {
          if (typeof body[key] !== "boolean") return res.status(400).json({ error: "Those settings couldn't be saved." });
          changes[key] = body[key];
        }
      if ("folder" in body) {
        if (body.folder !== null && !isUuid(body.folder)) return res.status(400).json({ error: "That folder no longer exists." });
        changes.folder = body.folder;
      }
      const { data, error } = await supabase.rpc("chat_settings_set", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_changes: changes,
      });
      if (error) return chatError(res, error);
      res.json({ settings: data });
    }),
  );

  router.get(
    "/:id/search",
    asyncRoute(async (req, res) => {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const { data, error } = await supabase.rpc("chat_search", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_query: q,
      });
      if (error) return chatError(res, error);
      res.json({ messages: data ?? [] });
    }),
  );

  router.get(
    "/:id/media",
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase.rpc("chat_media", { ...chatScope(req, kind), p_conversation: req.params.id });
      if (error) return chatError(res, error);
      res.json({ messages: data ?? [] });
    }),
  );

  router.post(
    "/:id/rename",
    asyncRoute(async (req, res) => {
      const title = req.body?.title;
      if (typeof title !== "string") return res.status(400).json({ error: "Use 1–120 characters for the group name." });
      const { error } = await supabase.rpc("chat_rename", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_display: user(req).displayName,
        p_title: title,
      });
      if (error) return chatError(res, error);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/:id/members",
    asyncRoute(async (req, res) => {
      const ids = req.body?.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 29 || !ids.every(isUuid))
        return res.status(400).json({ error: "Choose up to 29 people." });
      const { data, error } = await supabase.rpc("chat_add_members", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_display: user(req).displayName,
        p_ids: ids,
      });
      if (error) return chatError(res, error);
      res.json({ added: data });
    }),
  );

  router.post(
    "/:id/members/:member/remove",
    asyncRoute(async (req, res) => {
      if (!isUuid(req.params.member)) return res.status(404).json({ error: "Member not found." });
      const { error } = await supabase.rpc("chat_remove_member", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_display: user(req).displayName,
        p_target: req.params.member,
      });
      if (error) return chatError(res, error);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/:id/leave",
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase.rpc("chat_leave", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_display: user(req).displayName,
      });
      if (error) return chatError(res, error);
      const paths = Array.isArray(data?.removePaths) ? data.removePaths.filter((p: unknown) => typeof p === "string") : [];
      if (paths.length) await chatStorage.remove(paths).catch(() => undefined);
      res.json({ ok: true });
    }),
  );

  return router;
}
