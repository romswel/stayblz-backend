/**
 * Stayblz Paddock alerts for signed-in members, kept in this server's memory (like live rooms):
 *  - "ring":    someone is calling you right now (rings for 45 seconds, then it's a missed call)
 *  - "started": a scheduled meeting you're invited to has started
 *  - "invited": someone invited you to a scheduled meeting
 * Each browser keeps one long-poll open (GET /api/paddock/alerts) and shows a ringing card,
 * a system notification or (with Web Push) an alert while Stayblz is closed (lib/push.ts).
 * A restart forgets alerts; that's acceptable for something that lasts under a minute.
 */
import { randomBytes } from "node:crypto";
import * as rooms from "./paddockRooms";

export type AlertKind = "ring" | "started" | "invited";
export type AlertStatus = "active" | "declined" | "answered" | "missed" | "cancelled";
export interface PaddockAlert {
  id: string;
  kind: AlertKind;
  to: string;
  toName: string;
  meetingId: string;
  code: string;
  title: string;
  fromId: string;
  fromName: string;
  video: boolean;
  /** Scheduled start, for "invited". */
  scheduledFor: string | null;
  at: number;
  expiresAt: number;
  status: AlertStatus;
  changedAt: number;
}
interface Inbox {
  alerts: PaddockAlert[];
  version: number;
  waiters: Set<() => void>;
  lastSeen: number;
}

const timings = {
  ring: 45_000,
  started: 15 * 60_000,
  invited: 30 * 60_000,
  /** Ended alerts stay readable this long, so a browser learns "missed" or "declined". */
  keepEnded: 2 * 60_000,
  maxWait: Number(process.env.PADDOCK_WAIT_MS ?? 15_000),
};
export const setAlertTimings = (changes: Partial<typeof timings>) => Object.assign(timings, changes);

const inboxes = new Map<string, Inbox>();
const now = () => Date.now();

function inboxOf(userId: string): Inbox {
  let inbox = inboxes.get(userId);
  if (!inbox) {
    inbox = { alerts: [], version: 1, waiters: new Set(), lastSeen: now() };
    inboxes.set(userId, inbox);
  }
  return inbox;
}
function bump(inbox: Inbox) {
  inbox.version++;
  const waiters = [...inbox.waiters];
  inbox.waiters.clear();
  waiters.forEach((wake) => wake());
}

export interface Raise {
  kind: AlertKind;
  meeting: { id: string; code: string; title: string; scheduledFor?: string | null };
  from: { id: string; name: string };
  to: { id: string; name: string }[];
  video?: boolean;
}

/** Send an alert to each person (replacing an earlier active one for the same meeting). */
export function raise({ kind, meeting, from, to, video = true }: Raise): PaddockAlert[] {
  const made: PaddockAlert[] = [];
  const t = now();
  for (const person of to) {
    if (person.id === from.id) continue;
    const inbox = inboxOf(person.id);
    for (const old of inbox.alerts)
      if (old.status === "active" && old.meetingId === meeting.id) end(old, "cancelled", false);
    const alert: PaddockAlert = {
      id: randomBytes(12).toString("hex"),
      kind,
      to: person.id,
      toName: person.name,
      meetingId: meeting.id,
      code: meeting.code,
      title: meeting.title,
      fromId: from.id,
      fromName: from.name,
      video,
      scheduledFor: meeting.scheduledFor ?? null,
      at: t,
      expiresAt: t + timings[kind],
      status: "active",
      changedAt: t,
    };
    inbox.alerts.push(alert);
    if (inbox.alerts.length > 30) inbox.alerts.splice(0, inbox.alerts.length - 30);
    if (kind === "ring") rooms.setRinging(meeting.id, person.id, { name: person.name, until: alert.expiresAt });
    bump(inbox);
    made.push(alert);
  }
  return made;
}

function end(alert: PaddockAlert, status: Exclude<AlertStatus, "active">, notify = true) {
  if (alert.status !== "active") return;
  alert.status = status;
  alert.changedAt = now();
  if (alert.kind === "ring") {
    rooms.setRinging(alert.meetingId, alert.to, null);
    if (notify && status === "declined") rooms.roomNotice(alert.meetingId, `${alert.toName} can't join right now`);
    if (notify && status === "missed") rooms.roomNotice(alert.meetingId, `${alert.toName} didn't answer`);
  }
  const inbox = inboxes.get(alert.to);
  if (inbox) bump(inbox);
}

/** What a browser gets: this person's live alerts and ones that ended in the last two minutes. */
function view(inbox: Inbox) {
  const t = now();
  return {
    version: inbox.version,
    now: t,
    alerts: inbox.alerts
      .filter((a) => a.status === "active" || t - a.changedAt < timings.keepEnded)
      .map((a) => ({
        id: a.id,
        kind: a.kind,
        status: a.status,
        code: a.code,
        title: a.title,
        fromId: a.fromId,
        fromName: a.fromName,
        video: a.video,
        scheduledFor: a.scheduledFor,
        at: a.at,
        expiresAt: a.expiresAt,
      })),
  };
}
export type AlertView = ReturnType<typeof view>;

/** Long-poll: answers at once when something changed since `since`, otherwise after `wait` ms. */
export async function waitFor(userId: string, since: number, wait: number, cancelled?: (cancel: () => void) => void): Promise<AlertView> {
  const inbox = inboxOf(userId);
  inbox.lastSeen = now();
  const ms = Math.max(0, Math.min(timings.maxWait, wait));
  if (ms > 0 && inbox.version <= since) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        inbox.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      inbox.waiters.add(finish);
      cancelled?.(finish);
    });
    inbox.lastSeen = now();
  }
  return view(inbox);
}

/** "Decline" on a ringing call. Returns false when there's no such ring for this person. */
export function decline(userId: string, alertId: unknown) {
  const alert = typeof alertId === "string" ? inboxes.get(userId)?.alerts.find((a) => a.id === alertId) : undefined;
  if (!alert || alert.status !== "active") return false;
  end(alert, alert.kind === "ring" ? "declined" : "cancelled");
  return true;
}

/** Is this person being rung for this meeting right now? (So the caller isn't rung twice.) */
export const ringing = (userId: string, meetingId: string) =>
  !!inboxes.get(userId)?.alerts.some((a) => a.kind === "ring" && a.status === "active" && a.meetingId === meetingId);

// Joining the call answers its alerts; an empty room stops the ringing.
rooms.onRoomEvent((event) => {
  if (event.type === "joined") {
    for (const alert of inboxes.get(event.accountId)?.alerts ?? [])
      if (alert.status === "active" && alert.meetingId === event.meetingId) end(alert, "answered");
  } else {
    for (const inbox of inboxes.values())
      for (const alert of inbox.alerts)
        if (alert.status === "active" && alert.meetingId === event.meetingId && alert.kind !== "invited") end(alert, "cancelled", false);
  }
});

export function sweepAlerts() {
  const t = now();
  for (const [userId, inbox] of inboxes) {
    for (const alert of inbox.alerts) if (alert.status === "active" && alert.expiresAt <= t) end(alert, alert.kind === "ring" ? "missed" : "cancelled");
    const before = inbox.alerts.length;
    inbox.alerts = inbox.alerts.filter((a) => a.status === "active" || t - a.changedAt < timings.keepEnded);
    if (inbox.alerts.length !== before) inbox.version++;
    if (!inbox.alerts.length && !inbox.waiters.size && t - inbox.lastSeen > 10 * 60_000) inboxes.delete(userId);
  }
}
setInterval(sweepAlerts, 2_000).unref?.();

/** For tests. */
export function resetAlerts() {
  inboxes.clear();
}
