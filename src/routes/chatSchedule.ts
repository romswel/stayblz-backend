import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../middleware/asyncRoute";
import type { AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { supabase } from "../lib/supabase";
import {
  chatChoices,
  DEFAULT_TIMES,
  handledAfterSave,
  hasScheduleAccess,
  hhmm,
  LATE_MS,
  lastDue,
  loadLog,
  loadNotes,
  logSend,
  logView,
  MAX_NOTE,
  noteView,
  SCHEDULE_ZONE,
  scheduleClientId,
  sendNote,
  SLOTS,
  TIME_PATTERN,
  type NoteRow,
} from "../lib/chatSchedule";

/**
 * Scheduled updates (`/api/messages/scheduled`, lib/chatSchedule.ts): three notes, each sent once a day at its
 * Philippine time into a chat you're in. Only accounts in `chat_schedule_access` see it; everyone else gets the same
 * "not found" as an address that doesn't exist.
 */
const router = Router();
const me = (req: Request) => (req as AuthenticatedRequest).user.id;
const busy = (res: Response) => res.status(503).json({ error: "Scheduled updates are busy right now. Try again in a moment." });
const DAY_MS = 86_400_000;
/** Exactly what app.ts answers for an address that doesn't exist. */
const hidden = (res: Response) => res.status(404).json({ error: "Route not found.", code: "route_not_found" });

router.use(
  asyncRoute(async (req, res, next) => {
    if (await hasScheduleAccess(me(req))) return next();
    hidden(res);
  }),
);
router.param("slot", (req, res, next, slot) => {
  if (SLOTS.includes(Number(slot) as 1 | 2 | 3) && /^\d$/.test(slot)) next();
  else hidden(res);
});

async function noteOf(account: string, slot: number) {
  const rows = await loadNotes(account);
  return rows.find((r) => r.slot === slot);
}

router.get(
  "/",
  asyncRoute(async (req, res) => {
    const account = me(req);
    let rows: NoteRow[];
    try {
      rows = await loadNotes(account);
    } catch {
      return busy(res);
    }
    const [chats, history] = await Promise.all([chatChoices(account).catch(() => null), loadLog(account)]);
    const now = Date.now();
    res.set("Cache-Control", "no-store");
    res.json({
      zone: SCHEDULE_ZONE,
      lateMinutes: LATE_MS / 60_000,
      now: new Date(now).toISOString(),
      notes: SLOTS.map((slot) => noteView(rows.find((r) => r.slot === slot), slot, now)),
      chats: chats ?? [],
      chatsError: chats === null,
      history,
    });
  }),
);

/** Save a note: any of body, enabled, sendAt ("HH:MM", Philippine time), chat ({kind, id, stableId} or null), keepAfterSend. */
router.put(
  "/:slot",
  asyncRoute(async (req, res) => {
    const account = me(req);
    const slot = Number(req.params.slot);
    const input = req.body ?? {};
    const bad = (error: string) => res.status(400).json({ error });
    if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > MAX_NOTE))
      return bad("Notes can be up to 4,000 characters.");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") return bad("Turn it on or off.");
    if (input.keepAfterSend !== undefined && typeof input.keepAfterSend !== "boolean") return bad("Pick keep or empty.");
    if (input.sendAt !== undefined && (typeof input.sendAt !== "string" || !TIME_PATTERN.test(input.sendAt)))
      return bad("Pick a time like 21:00.");
    let chat: { kind: "personal" | "team"; id: string; stableId: string | null } | null | undefined;
    if (input.chat === null) chat = null;
    else if (input.chat !== undefined) {
      const c = input.chat;
      if (!c || (c.kind !== "personal" && c.kind !== "team") || !isUuid(c.id) || (c.kind === "team" && !isUuid(c.stableId)))
        return bad("Pick a chat from the list.");
      const choices = await chatChoices(account).catch(() => null);
      if (!choices) return busy(res);
      const found = choices.find((x) => x.kind === c.kind && x.id === c.id && (c.kind === "personal" || x.stableId === c.stableId));
      if (!found) return bad("You can only send to a chat you're in.");
      chat = { kind: found.kind, id: found.id, stableId: found.stableId };
    }
    let before: NoteRow | undefined;
    try {
      before = await noteOf(account, slot);
    } catch {
      return busy(res);
    }
    const sendAt = input.sendAt ?? (before ? hhmm(before.send_at) : DEFAULT_TIMES[slot]);
    const target = chat === undefined ? before : null;
    const row = {
      account_id: account,
      slot,
      body: input.body ?? before?.body ?? "",
      enabled: input.enabled ?? before?.enabled ?? true,
      send_at: sendAt,
      chat_kind: chat === undefined ? (target?.chat_kind ?? null) : (chat?.kind ?? null),
      chat_id: chat === undefined ? (target?.chat_id ?? null) : (chat?.id ?? null),
      stable_id: chat === undefined ? (target?.stable_id ?? null) : chat?.kind === "team" ? chat.stableId : null,
      keep_after_send: input.keepAfterSend ?? before?.keep_after_send ?? false,
      // A new time resets a "skip next" (it was for the old time).
      handled_due: handledAfterSave(sendAt, input.sendAt && before && input.sendAt !== hhmm(before.send_at) ? null : before?.handled_due),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from("chat_scheduled_notes").upsert(row, { onConflict: "account_id,slot" }).select("*");
    if (error) return busy(res);
    res.json({ note: noteView(((data as any[] | null) ?? [])[0] ?? row, slot) });
  }),
);

/** Skip the next time only ({skip:true}), or take the skip back ({skip:false}). */
router.post(
  "/:slot/skip",
  asyncRoute(async (req, res) => {
    const account = me(req);
    const slot = Number(req.params.slot);
    if (typeof req.body?.skip !== "boolean") return res.status(400).json({ error: "Skip or don't skip." });
    let note: NoteRow | undefined;
    try {
      note = await noteOf(account, slot);
    } catch {
      return busy(res);
    }
    if (!note) return res.status(409).json({ error: "Write the note first." });
    const now = Date.now();
    const last = lastDue(note.send_at, now);
    const handled = req.body.skip ? new Date(last + DAY_MS).toISOString() : new Date(last).toISOString();
    const { data, error } = await supabase
      .from("chat_scheduled_notes")
      .update({ handled_due: handled, updated_at: new Date().toISOString() })
      .eq("account_id", account)
      .eq("slot", slot)
      .select("*");
    if (error) return busy(res);
    res.json({ note: noteView(((data as any[] | null) ?? [])[0] ?? note, slot) });
  }),
);

/** Send this note now (doesn't change its schedule). Pressing twice in the same minute sends it once. */
router.post(
  "/:slot/send",
  asyncRoute(async (req, res) => {
    const account = me(req);
    const slot = Number(req.params.slot);
    let note: NoteRow | undefined;
    try {
      note = await noteOf(account, slot);
    } catch {
      return busy(res);
    }
    if (!note || !note.body.trim()) return res.status(409).json({ error: "Write the note first." });
    if (!note.chat_id) return res.status(409).json({ error: "Pick a chat to send it to first." });
    const result = await sendNote(note, scheduleClientId(account, slot, "now", note.body, Math.floor(Date.now() / 60_000)));
    if (!result.ok) {
      await logSend(note, null, "failed", { detail: result.detail });
      return res.status(result.retry ? 503 : 409).json({ error: result.retry ? "Not sent. The chat server is busy — try again in a moment." : result.detail });
    }
    const entry = await logSend(note, null, "sent", { messageId: result.message.id });
    const after = await noteOf(account, slot).catch(() => note);
    res.status(201).json({ note: noteView(after, slot), entry: entry ? logView(entry) : null });
  }),
);

export default router;
