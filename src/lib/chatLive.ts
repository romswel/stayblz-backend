/**
 * Stayblz Chat "live" signals, kept in this server's memory (Render runs one instance; a restart only means the
 * next poll answers at once). No websockets on the free plan, so browsers long-poll instead:
 *
 * - Each conversation has a version that goes up whenever something in it changes (a message, edit, reaction,
 *   pin, unsend, read, delivered, typing, members, name, photo). `GET /:id/updates?v=&wait=` waits here until the
 *   version moves past the one the browser has, then reads the database once.
 * - Each person has a version too, bumped when something reaches them (a new message in any of their chats, an
 *   alert, a friend request). The site-wide `/unread?uv=&wait=` poll waits on it, so badges, the bell and device
 *   notifications follow within a moment instead of half a minute.
 *
 * Versions are only compared for equality with what the browser sent: a restart (versions back at 0) or a
 * different number answers immediately.
 */
const MAX_WAIT_MS = 15_000;
const MAX_ENTRIES = 20_000;
const MEMBERS_TTL_MS = 30 * 60_000;

type Waiter = () => void;
interface Channel {
  version: number;
  waiters: Set<Waiter>;
}

const chats = new Map<string, Channel>();
const people = new Map<string, Channel>();
/** Who is in a conversation (learned when someone loads it), so a new message can wake its members. */
const members = new Map<string, { ids: string[]; at: number }>();
/** Chats with a message this person hasn't had marked "delivered" yet (cleared when their poll marks them). */
const undelivered = new Map<string, Set<string>>();

const chatKey = (kind: string, conversation: string) => `${kind}:${conversation}`;

function trim<K, V>(map: Map<K, V>) {
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as K);
}
function channel(map: Map<string, Channel>, key: string) {
  let c = map.get(key);
  if (!c) {
    c = { version: 0, waiters: new Set() };
    map.set(key, c);
    trim(map);
  }
  return c;
}
function bump(map: Map<string, Channel>, key: string) {
  const c = channel(map, key);
  c.version++;
  const waiting = [...c.waiters];
  c.waiters.clear();
  for (const wake of waiting) wake();
}
function wait(map: Map<string, Channel>, key: string, known: number | null, ms: number, onCancel?: (cancel: () => void) => void) {
  const c = channel(map, key);
  const limit = Math.max(0, Math.min(MAX_WAIT_MS, ms));
  // Nothing to compare with, a different version, or no wait asked for: answer now.
  if (known === null || known !== c.version || limit === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      c.waiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, limit);
    c.waiters.add(finish);
    onCancel?.(finish);
  });
}

/** Parses `?v=` / `?uv=` and `?wait=` (seconds). */
export function liveParams(version: unknown, waitSeconds: unknown) {
  const v = typeof version === "string" && /^\d{1,12}$/.test(version) ? Number(version) : null;
  const s = typeof waitSeconds === "string" && /^\d{1,3}$/.test(waitSeconds) ? Number(waitSeconds) : 0;
  return { version: v, waitMs: Math.min(MAX_WAIT_MS, s * 1000) };
}

export const chatVersion = (kind: string, conversation: string) => channel(chats, chatKey(kind, conversation)).version;
export const personVersion = (userId: string) => channel(people, userId).version;

/** Something in this chat changed: wake everyone waiting on it. */
export function bumpChat(kind: string, conversation: string) {
  bump(chats, chatKey(kind, conversation));
}
/** Something reached these people (an alert, a new message): wake their site-wide poll. */
export function bumpPeople(ids: Iterable<string>) {
  for (const id of new Set(ids)) if (id) bump(people, id);
}

export function waitForChat(kind: string, conversation: string, known: number | null, ms: number, onCancel?: (cancel: () => void) => void) {
  return wait(chats, chatKey(kind, conversation), known, ms, onCancel);
}
export function waitForPerson(userId: string, known: number | null, ms: number, onCancel?: (cancel: () => void) => void) {
  return wait(people, userId, known, ms, onCancel);
}

export function rememberMembers(kind: string, conversation: string, ids: string[]) {
  const key = chatKey(kind, conversation);
  members.delete(key);
  members.set(key, { ids: ids.filter((id) => typeof id === "string"), at: Date.now() });
  trim(members);
}
export function membersOf(kind: string, conversation: string): string[] {
  const known = members.get(chatKey(kind, conversation));
  return known && Date.now() - known.at < MEMBERS_TTL_MS ? known.ids : [];
}

/**
 * A new message in this chat: wake the chat, wake its other members' site-wide polls, and remember that it
 * still has to reach them (their poll marks it delivered, which then wakes the chat again for the sender's ✓✓).
 */
export function messageArrived(kind: string, conversation: string, senderId: string) {
  bumpChat(kind, conversation);
  const others = membersOf(kind, conversation).filter((id) => id !== senderId);
  const key = chatKey(kind, conversation);
  for (const id of others) {
    const set = undelivered.get(id) ?? new Set<string>();
    set.add(key);
    undelivered.set(id, set);
  }
  trim(undelivered);
  bumpPeople(others);
}

/** This person's poll just marked their new messages delivered: let the senders' open chats know. */
export function deliveredTo(userId: string) {
  const set = undelivered.get(userId);
  if (!set) return;
  undelivered.delete(userId);
  for (const key of set) bump(chats, key);
}

/** For tests. */
export function resetChatLive() {
  for (const c of [...chats.values(), ...people.values()]) for (const wake of c.waiters) wake();
  chats.clear();
  people.clear();
  members.clear();
  undelivered.clear();
}
