import { createHash } from "node:crypto";
import { supabase } from "./supabase";
import { messageArrived, rememberMembers } from "./chatLive";
import { notifyChat } from "./chatAlerts";
import { plainText } from "./chatFormat";

/**
 * Scheduled updates (Stayblz Chat, migration 202611260001): up to three notes per person, each sent once a day at its
 * own Philippine time into a chat that person is in, through the normal chat send (live update, alerts, push).
 * Private: only accounts in `chat_schedule_access` (granted in the SQL editor) can use it.
 *
 * Every minute while the API is awake, each note's latest due time is claimed in SQL (`chat_schedule_claim`) before
 * anything is sent, and the message's client id is fixed per note + time, so a time never goes out twice, even with
 * two servers awake. Up to LATE_MS late it still sends (the API was restarting); after that the time is "missed".
 */
export type ScheduleKind = "personal" | "team";
export const SCHEDULE_ZONE = "Asia/Manila";
/** The Philippines is UTC+8 all year (no daylight saving). */
const OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
export const LATE_MS = 30 * 60_000;
/** Saving a note this long after its time leaves today's time alone (it waits for the next one). */
const SAVE_GRACE_MS = 2 * 60_000;
export const SLOTS = [1, 2, 3] as const;
export const DEFAULT_TIMES: Record<number, string> = { 1: "21:00", 2: "01:00", 3: "05:00" };
export const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const MAX_NOTE = 4000;

export interface NoteRow {
  account_id: string;
  slot: number;
  body: string;
  enabled: boolean;
  send_at: string;
  chat_kind: ScheduleKind | null;
  chat_id: string | null;
  stable_id: string | null;
  keep_after_send: boolean;
  handled_due: string | null;
  updated_at: string;
}

export interface ChatChoice {
  kind: ScheduleKind;
  id: string;
  stableId: string | null;
  stableName: string | null;
  title: string;
  group: boolean;
}

/** "21:00:00" → "21:00". */
export function hhmm(value: unknown): string {
  const match = /^(\d{2}):(\d{2})/.exec(String(value ?? ""));
  return match && TIME_PATTERN.test(`${match[1]}:${match[2]}`) ? `${match[1]}:${match[2]}` : "21:00";
}

/** The latest moment at or before `now` when a note set for `sendAt` (Philippine time) was due. */
export function lastDue(sendAt: string, now = Date.now()): number {
  const [h, m] = hhmm(sendAt).split(":").map(Number);
  const localDayStart = Math.floor((now + OFFSET_MS) / DAY_MS) * DAY_MS;
  const due = localDayStart + (h * 60 + m) * 60_000 - OFFSET_MS;
  return due > now ? due - DAY_MS : due;
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);
const iso = (time: number) => new Date(time).toISOString();

/** What the page shows for one note (a slot nobody has saved yet gets its default time). */
export function noteView(row: NoteRow | undefined, slot: number, now = Date.now()) {
  const sendAt = row ? hhmm(row.send_at) : DEFAULT_TIMES[slot];
  const enabled = row?.enabled ?? true;
  const last = lastDue(sendAt, now);
  const handled = ms(row?.handled_due);
  // Due a moment ago and not handled yet: it goes out with the next check.
  const pending = !!row && enabled && handled < last && now - last <= LATE_MS;
  const skipping = handled >= last + DAY_MS;
  return {
    slot,
    body: row?.body ?? "",
    enabled,
    sendAt,
    chat: row?.chat_id && row.chat_kind ? { kind: row.chat_kind, id: row.chat_id, stableId: row.stable_id } : null,
    keepAfterSend: row?.keep_after_send ?? false,
    nextAt: iso(pending ? last : skipping ? last + 2 * DAY_MS : last + DAY_MS),
    skippingAt: skipping ? iso(last + DAY_MS) : null,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * The `handled_due` to save with an edit: a time that passed more than a couple of minutes ago counts as handled, so
 * turning a note on (or writing it) after its time waits for the next one instead of sending late or showing "missed".
 */
export function handledAfterSave(sendAt: string, previous: string | null | undefined, now = Date.now()): string | null {
  const last = lastDue(sendAt, now);
  const before = ms(previous);
  if (now - last > SAVE_GRACE_MS && before < last) return iso(last);
  return previous ?? null;
}

export async function hasScheduleAccess(accountId: string): Promise<boolean> {
  const { data, error } = await supabase.from("chat_schedule_access").select("account_id").eq("account_id", accountId).limit(1);
  return !error && Array.isArray(data) && data.length > 0;
}

export async function loadNotes(accountId: string): Promise<NoteRow[]> {
  const { data, error } = await supabase.from("chat_scheduled_notes").select("*").eq("account_id", accountId);
  if (error) throw new Error("schedule_unavailable");
  return (data ?? []) as NoteRow[];
}

/** Chats this person can send to: their personal chats (not unanswered requests) and the team chats of their stables. */
export async function chatChoices(accountId: string): Promise<ChatChoice[]> {
  const out: ChatChoice[] = [];
  const personal = await supabase.rpc("chat_list", { p_kind: "personal", p_user: accountId, p_stable: null });
  if (personal.error) throw new Error("schedule_unavailable");
  for (const c of (personal.data ?? []) as any[])
    if (!c.request && c.id) out.push({ kind: "personal", id: c.id, stableId: null, stableName: null, title: String(c.title || "Chat"), group: c.kind === "group" });
  const { data: memberships } = await supabase.from("stable_memberships").select("stable_id").eq("user_id", accountId);
  const stableIds = [...new Set(((memberships ?? []) as any[]).map((m) => m.stable_id as string))].slice(0, 10);
  if (stableIds.length) {
    const { data: stables } = await supabase.from("member_stables").select("id,name").in("id", stableIds);
    const names = new Map(((stables ?? []) as any[]).map((s) => [s.id as string, String(s.name ?? "Stable")]));
    for (const stableId of stableIds) {
      const team = await supabase.rpc("chat_list", { p_kind: "team", p_user: accountId, p_stable: stableId });
      for (const c of (team.data ?? []) as any[])
        if (c.id) out.push({ kind: "team", id: c.id, stableId, stableName: names.get(stableId) ?? "Stable", title: String(c.title || "Team chat"), group: c.kind !== "direct" });
    }
  }
  return out;
}

/** A fixed message id per note + time (or per "Send now" press), so a retry finds the message instead of resending. */
export function scheduleClientId(...parts: (string | number)[]): string {
  const hex = createHash("sha256").update(["stayblz-schedule", ...parts].join(":")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const REASONS: [RegExp, string][] = [
  [/not_found|not_a_participant/, "You're no longer in that chat. Pick another one."],
  [/request_pending/, "That chat is still a message request. Accept it first."],
  [/blocked/, "You can't message that person."],
  [/invalid_message/, "The note is longer than 4,000 characters."],
];

type SendResult = { ok: true; message: any } | { ok: false; detail: string; retry: boolean };

/** Sends one note's text as its owner, through chat_send (same checks as typing it), then wakes the chat and alerts. */
export async function sendNote(note: NoteRow, clientId: string): Promise<SendResult> {
  if (!note.chat_id || !note.chat_kind) return { ok: false, detail: "No chat picked for this note.", retry: false };
  const kind = note.chat_kind;
  const { data: people } = await supabase.from("accounts").select("first_name,last_name").eq("id", note.account_id).limit(1);
  const person = (people as any[] | null)?.[0];
  const display = person ? `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim() : "";
  const { data, error } = await supabase.rpc("chat_send", {
    p_kind: kind,
    p_user: note.account_id,
    p_stable: kind === "team" ? note.stable_id : null,
    p_conversation: note.chat_id,
    p_display: display || "Member",
    p_body: note.body,
    p_client: clientId,
    p_reply: null,
    p_attachment: null,
    p_forwarded: false,
  });
  if (error || !data?.id) {
    const reason = REASONS.find(([pattern]) => pattern.test(error?.message ?? ""));
    return reason ? { ok: false, detail: reason[1], retry: false } : { ok: false, detail: "The chat server was busy.", retry: true };
  }
  // Wake everyone's open chat and badge straight away, as when someone types.
  const table = kind === "team" ? "member_conversations" : "personal_conversations";
  const { data: chat } = await supabase.from(table).select("member_ids").eq("id", note.chat_id).limit(1);
  const members = (chat as any[] | null)?.[0]?.member_ids;
  if (Array.isArray(members)) rememberMembers(kind, note.chat_id, members);
  messageArrived(kind, note.chat_id, note.account_id);
  void notifyChat(kind, note.chat_id, note.account_id, { type: "message", messageId: data.id });
  // Not kept: the note empties, unless it was changed in the meantime.
  if (!note.keep_after_send)
    await supabase
      .from("chat_scheduled_notes")
      .update({ body: "", updated_at: new Date().toISOString() })
      .eq("account_id", note.account_id)
      .eq("slot", note.slot)
      .eq("body", note.body);
  return { ok: true, message: data };
}

export async function logSend(
  note: Pick<NoteRow, "account_id" | "slot" | "chat_kind" | "chat_id" | "stable_id" | "body">,
  due: number | null,
  status: "sent" | "empty" | "missed" | "failed",
  extra: { messageId?: string; detail?: string } = {},
) {
  const preview = status === "sent" ? plainText(note.body).replace(/\s+/g, " ").trim().slice(0, 140) : null;
  const { data } = await supabase
    .from("chat_scheduled_log")
    .insert({
      account_id: note.account_id,
      slot: note.slot,
      due_at: due === null ? null : iso(due),
      status,
      chat_kind: note.chat_kind,
      chat_id: note.chat_id,
      stable_id: note.stable_id,
      message_id: extra.messageId ?? null,
      preview,
      detail: extra.detail?.slice(0, 300) ?? null,
    })
    .select("*");
  return ((data as any[] | null) ?? [])[0] ?? null;
}

export function logView(row: any) {
  return {
    id: String(row.id),
    slot: row.slot,
    dueAt: row.due_at ?? null,
    status: row.status,
    chat: row.chat_id ? { kind: row.chat_kind, id: row.chat_id, stableId: row.stable_id ?? null } : null,
    preview: row.preview ?? null,
    detail: row.detail ?? null,
    at: row.created_at,
  };
}

export async function loadLog(accountId: string, limit = 30) {
  const { data } = await supabase
    .from("chat_scheduled_log")
    .select("*")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data as any[] | null) ?? []).map(logView);
}

let running = false;

/** One pass over every note. Returns how many were sent. Never throws. */
export async function runChatSchedule(now = Date.now()): Promise<number> {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    const { data: access } = await supabase.from("chat_schedule_access").select("account_id");
    const allowed = new Set(((access ?? []) as any[]).map((a) => a.account_id as string));
    if (!allowed.size) return 0;
    const { data: notes } = await supabase.from("chat_scheduled_notes").select("*").eq("enabled", true);
    for (const note of (notes ?? []) as NoteRow[]) {
      if (!allowed.has(note.account_id)) continue;
      const due = lastDue(note.send_at, now);
      if (ms(note.handled_due) >= due) continue;
      const { data: claimed } = await supabase.rpc("chat_schedule_claim", {
        p_account: note.account_id,
        p_slot: note.slot,
        p_due: iso(due),
      });
      if (!claimed) continue; // another server (or an earlier pass) has it
      const row = claimed as NoteRow;
      if (now - due > LATE_MS) {
        await logSend(row, due, "missed", { detail: "Stayblz's server was offline or busy at that time, so nothing was sent." });
        continue;
      }
      if (!row.body.trim()) {
        await logSend(row, due, "empty", { detail: "The note was empty." });
        continue;
      }
      const result = await sendNote(row, scheduleClientId(row.account_id, row.slot, due));
      if (result.ok) {
        sent += 1;
        await logSend(row, due, "sent", { messageId: result.message.id });
      } else if (result.retry && now - due < LATE_MS) {
        // Busy for a moment: give the time back so the next pass tries again (same message id, so never twice).
        await supabase
          .from("chat_scheduled_notes")
          .update({ handled_due: note.handled_due })
          .eq("account_id", row.account_id)
          .eq("slot", row.slot)
          .eq("handled_due", iso(due));
      } else {
        await logSend(row, due, "failed", { detail: result.detail });
      }
    }
  } catch {
    /* The database was unreachable: the next pass tries again. */
  } finally {
    running = false;
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;

/** Checks at the start of every minute while the API is awake. CHAT_SCHEDULE=off turns it off. */
export function startChatSchedule(): boolean {
  if (timer || process.env.CHAT_SCHEDULE === "off") return false;
  const tick = () => void runChatSchedule().catch(() => undefined);
  const first = 60_000 - (Date.now() % 60_000) + 1_500;
  timer = setTimeout(() => {
    tick();
    timer = setInterval(tick, 60_000);
    timer.unref();
  }, first);
  timer.unref();
  return true;
}
