import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../middleware/asyncRoute";
import { isUuid, type StableRequest } from "../middleware/stable";
import type { AuthenticatedRequest } from "../middleware/auth";
import { supabase } from "../lib/supabase";
import { messageCursor } from "../lib/workspace";

/**
 * Chat endpoints shared by personal messages (/api/messages) and team messages
 * (/api/team-messages). Every read and write is one checked SQL function (`chat_*` in
 * migrations/202611110001_messenger.sql) that verifies membership itself.
 *
 * No websockets on the free plan: the browser polls `GET /:id/updates?since=` while a chat is
 * open and visible, which returns only messages added or changed since the last poll.
 */
export type ChatKind = "personal" | "team";
export const PAGE_SIZE = 50;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export function chatScope(req: Request, kind: ChatKind) {
  return {
    p_kind: kind,
    p_user: (req as AuthenticatedRequest).user.id,
    p_stable: kind === "team" ? (req as StableRequest).stable.id : null,
  };
}

export function chatError(res: Response, error: { message?: string } | null) {
  const reason = error?.message ?? "";
  if (/not_found|not_a_participant/.test(reason))
    return res.status(404).json({ error: "Conversation not found." });
  if (reason.includes("request_pending"))
    return res.status(409).json({
      error: "Accept this message request before you reply or react.",
      code: "request_pending",
    });
  if (reason.includes("invalid_reaction"))
    return res.status(400).json({ error: "Pick one of the reactions shown." });
  if (reason.includes("invalid_message"))
    return res.status(400).json({ error: "Use 1–4,000 characters and try again." });
  return res.status(503).json({
    error: "Chat is busy right now. Wait a moment and try again.",
  });
}

/** One conversation with its newest page of messages (or the page before `before`). */
export async function loadThread(
  req: Request,
  kind: ChatKind,
  id: string,
  before?: { time: string; id: string } | null,
) {
  return supabase.rpc("chat_thread", {
    ...chatScope(req, kind),
    p_conversation: id,
    p_before_time: before?.time ?? null,
    p_before_id: before?.id ?? null,
    p_since: null,
    p_limit: PAGE_SIZE,
  });
}

export function chatRoutes(kind: ChatKind) {
  const router = Router();
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
      res.json({ conversations: data ?? [] });
    }),
  );

  router.get(
    "/:id",
    asyncRoute(async (req, res) => {
      const before = req.query.before;
      const cursor = messageCursor(before);
      if (before !== undefined && !cursor)
        return res.status(400).json({ error: "Invalid history request." });
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
      const user = (req as AuthenticatedRequest).user;
      const { data, error } = await supabase.rpc("chat_send", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_display: user.displayName,
        p_body: body,
        p_client: req.body.clientId,
        p_reply: replyTo,
      });
      if (error) {
        if (/not_found|not_a_participant|request_pending|invalid_message/.test(error.message ?? ""))
          return chatError(res, error);
        return res.status(503).json({
          error: "Message not sent. The chat server is busy — tap Retry in a moment.",
        });
      }
      res.status(201).json({ message: data });
    }),
  );

  router.post(
    "/:id/read",
    asyncRoute(async (req, res) => {
      const { error } = await supabase.rpc("chat_read", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
      });
      if (error) return chatError(res, error);
      res.json({ ok: true });
    }),
  );

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
    "/:id/messages/:message/unsend",
    asyncRoute(async (req, res) => {
      const { data, error } = await supabase.rpc("chat_unsend", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
        p_message: req.params.message,
      });
      if (error) return chatError(res, error);
      res.json({ message: data });
    }),
  );

  router.post(
    "/:id/leave",
    asyncRoute(async (req, res) => {
      const { error } = await supabase.rpc("chat_leave", {
        ...chatScope(req, kind),
        p_conversation: req.params.id,
      });
      if (error) return chatError(res, error);
      res.json({ ok: true });
    }),
  );

  return router;
}
