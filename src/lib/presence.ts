/**
 * "Active now" and "typing…" for chat, kept in this server's memory only — never written to the
 * database (the free plan can't afford a write every few seconds). Render runs one instance, so
 * this is shared by everyone; a restart simply forgets it, which is harmless.
 */
const ACTIVE_MS = 2 * 60_000;
const REMEMBER_MS = 60 * 60_000;
const TYPING_MS = 6_000;
const ACCESS_MS = 10 * 60_000;
const MAX_ENTRIES = 20_000;

const lastSeen = new Map<string, number>();
const typing = new Map<string, Map<string, { name: string; until: number }>>();
const access = new Map<string, number>();

function trim<K, V>(map: Map<K, V>) {
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as K);
}

export function touch(userId: string) {
  lastSeen.delete(userId);
  lastSeen.set(userId, Date.now());
  trim(lastSeen);
}

/** When this person was last seen on chat (within the last hour), or null. */
export function seenAt(userId: string): string | null {
  const at = lastSeen.get(userId);
  if (!at || Date.now() - at > REMEMBER_MS) return null;
  return new Date(at).toISOString();
}
export const isActive = (userId: string) => {
  const at = lastSeen.get(userId);
  return !!at && Date.now() - at < ACTIVE_MS;
};

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
  typing.clear();
  access.clear();
}
