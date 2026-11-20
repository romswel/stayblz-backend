/**
 * Presence ("Online" / "Away" / "Offline") and "typing…" for chat, kept in this server's memory only — never
 * written to the database (the free plan can't afford a write every few seconds). Render runs one instance, so
 * this is shared by everyone; a restart simply forgets it, which is harmless.
 *
 * An open Stayblz page checks in at least every ~20 s (the site-wide poll, or an open chat's long-poll) and says
 * whether its person is using it ("active") or not ("idle": the tab is hidden, or no tap/key for a few minutes).
 *   online  = an active check-in within ONLINE_MS
 *   away    = Stayblz is open but idle, or the last active check-in was a few minutes ago
 *   offline = nothing for AWAY_MS
 * The windows are several check-ins long, so one late or failed poll never makes a dot blink off and on.
 */
const ONLINE_MS = 75_000;
const AWAY_MS = 6 * 60_000;
const REMEMBER_MS = 24 * 60 * 60_000;
const TYPING_MS = 6_000;
const ACCESS_MS = 10 * 60_000;
const MAX_ENTRIES = 20_000;

export type Presence = "online" | "away" | "offline";
const lastSeen = new Map<string, number>();
const lastActive = new Map<string, number>();
const typing = new Map<string, Map<string, { name: string; until: number }>>();
const access = new Map<string, number>();

function trim<K, V>(map: Map<K, V>) {
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as K);
}
function mark(map: Map<string, number>, userId: string, at: number) {
  map.delete(userId);
  map.set(userId, at);
  trim(map);
}

/** A request from this person. "idle" = Stayblz is open but they aren't using it (hidden tab, no input). */
export function touch(userId: string, state: "active" | "idle" = "active") {
  const now = Date.now();
  mark(lastSeen, userId, now);
  if (state === "active") mark(lastActive, userId, now);
}
/** `?presence=idle` on a poll means the page is open but not in use; anything else counts as active. */
export const presenceParam = (value: unknown): "active" | "idle" => (value === "idle" ? "idle" : "active");

export function presenceOf(userId: string, now = Date.now()): Presence {
  const seen = lastSeen.get(userId);
  if (!seen || now - seen > AWAY_MS) return "offline";
  const active = lastActive.get(userId);
  return active && now - active < ONLINE_MS ? "online" : "away";
}

/** When this person was last using Stayblz (within a day), or null. */
export function seenAt(userId: string): string | null {
  const at = lastActive.get(userId) ?? lastSeen.get(userId);
  if (!at || Date.now() - at > REMEMBER_MS) return null;
  return new Date(at).toISOString();
}
export const isActive = (userId: string) => presenceOf(userId) === "online";

const key = (kind: string, conversation: string) => `${kind}:${conversation}`;

/** Remember that this person just loaded this chat, so typing pings don't need a database check. */
export function allow(kind: string, conversation: string, userId: string) {
  const k = `${key(kind, conversation)}:${userId}`;
  access.delete(k);
  access.set(k, Date.now());
  trim(access);
}
export function allowed(kind: string, conversation: string, userId: string) {
  const at = access.get(`${key(kind, conversation)}:${userId}`);
  return !!at && Date.now() - at < ACCESS_MS;
}

export function setTyping(kind: string, conversation: string, userId: string, name: string, on: boolean) {
  const k = key(kind, conversation);
  const room = typing.get(k) ?? new Map();
  if (on) room.set(userId, { name, until: Date.now() + TYPING_MS });
  else room.delete(userId);
  if (room.size) typing.set(k, room);
  else typing.delete(k);
  trim(typing);
}

/** Names of the other people typing in this chat right now. */
export function typers(kind: string, conversation: string, exceptUser: string): string[] {
  const room = typing.get(key(kind, conversation));
  if (!room) return [];
  const now = Date.now();
  const names: string[] = [];
  for (const [id, entry] of room) {
    if (entry.until < now) room.delete(id);
    else if (id !== exceptUser) names.push(entry.name);
  }
  return names;
}

/** For tests. */
export function resetPresence() {
  lastSeen.clear();
  lastActive.clear();
  typing.clear();
  access.clear();
}
