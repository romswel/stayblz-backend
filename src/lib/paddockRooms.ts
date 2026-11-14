/**
 * Stayblz Paddock live rooms, kept in this server's memory only.
 *
 * The server never sees video or audio. It only introduces browsers to each other: who is in the
 * room, their mic/camera state, the short "call setup" messages (signals) browsers exchange to
 * connect directly, the waiting room, in-call chat and reactions. Render runs one instance, so
 * this is shared by everyone. A restart forgets it: browsers stay connected to each other and
 * quietly re-join (see `gone` reasons below).
 *
 * Each browser keeps one request open at a time (`sync`, a long-poll): it returns as soon as
 * something changes for that person, or after `wait` ms with nothing new.
 */
import { randomBytes } from "node:crypto";
import { PADDOCK_MAX_PEOPLE } from "./paddock";

export type PeerRole = "host" | "cohost" | "member" | "guest";
export type GoneReason = "left" | "removed" | "ended" | "expired";

export interface PeerState {
  mic: boolean;
  cam: boolean;
  screen: boolean;
  /** When the hand went up (ms), or null. Earlier hands are answered first. */
  hand: number | null;
}
export interface Signal {
  seq: number;
  from: string;
  type: string;
  gen: number;
  data: unknown;
}
interface Peer {
  id: string;
  accountId: string | null;
  guestId: string | null;
  name: string;
  role: PeerRole;
  joinedAt: number;
  lastSeen: number;
  polling: number;
  state: PeerState;
  inbox: Signal[];
  nextSeq: number;
  /** Changes when this inbox starts again (a new person, or after a restart); acks only count for the same epoch. */
  epoch: string;
  seat: string;
  seatExpires: number;
  waiter: (() => void) | null;
  sendTimes: number[];
}
interface Knock {
  id: string;
  token: string;
  roomId: string;
  accountId: string | null;
  guestId: string | null;
  name: string;
  at: number;
  lastSeen: number;
  status: "waiting" | "admitted" | "denied" | "ended" | "full";
  waiter: (() => void) | null;
}
export interface FeedItem {
  seq: number;
  kind: "chat" | "reaction" | "notice";
  id: string;
  from: string;
  name: string;
  text: string;
  at: number;
}
export interface MeetingInfo {
  id: string;
  code: string;
  title: string;
  hostId: string;
  cohostIds: string[];
  guestsAllowed: boolean;
}
interface Room {
  info: MeetingInfo;
  peers: Map<string, Peer>;
  knocks: Map<string, Knock>;
  /** Identities a host let in while this room is open: account id or "g:<guest id>". */
  admitted: Set<string>;
  /** Guests a host removed (accounts are kept out by the database). */
  removedGuests: Set<string>;
  feed: FeedItem[];
  feedSeq: number;
  version: number;
  locked: boolean;
  startedAt: number;
  emptySince: number | null;
}

// Timings. Tests shorten them with setTimings().
const timings = {
  /** Longest a sync waits for news. Below common proxy limits. */
  maxWait: Number(process.env.PADDOCK_WAIT_MS ?? 15_000),
  /** No open request and nothing heard for this long: the person left (closed the tab, lost signal). */
  stale: 25_000,
  /** A waiting-room request nobody checks on for this long is dropped. */
  knockStale: 35_000,
  /** An admitted person has this long to come in. */
  admittedFor: 90_000,
  /** An empty room is forgotten after this long. */
  emptyFor: 120_000,
  /** Signed-in seats are re-checked (account still active, still allowed) this often. */
  seatFor: 15 * 60_000,
};
export const setTimings = (changes: Partial<typeof timings>) => Object.assign(timings, changes);

const SIGNALS_PER_10S = 600;
const MAX_INBOX = 800;
const MAX_SIGNAL_CHARS = 24_000;
const MAX_FEED = 300;
const MAX_KNOCKS = 12;
const SIGNAL_TYPES = new Set(["description", "candidate", "reset", "restart", "bye"]);
export const REACTIONS = ["👍", "👏", "❤️", "😂", "🎉", "😮", "🐎", "🏆"];

const rooms = new Map<string, Room>();
const seats = new Map<string, { roomId: string; peerId: string }>();
const knocks = new Map<string, Knock>();
const gone = new Map<string, { reason: GoneReason; at: number }>();

const now = () => Date.now();
const token = () => randomBytes(32).toString("hex");
const identity = (p: { accountId: string | null; guestId: string | null }) =>
  p.accountId ?? `g:${p.guestId}`;

function wake(target: { waiter: (() => void) | null }) {
  const waiter = target.waiter;
  target.waiter = null;
  waiter?.();
}
function bump(room: Room) {
  room.version++;
  for (const peer of room.peers.values()) wake(peer);
}
function hostPresent(room: Room) {
  for (const peer of room.peers.values()) if (peer.role === "host" || peer.role === "cohost") return true;
  return false;
}
const roleFor = (info: MeetingInfo, accountId: string | null): PeerRole =>
  !accountId ? "guest" : accountId === info.hostId ? "host" : info.cohostIds.includes(accountId) ? "cohost" : "member";

/** Open (or find) the live room for a meeting, refreshing its details from the database row. */
export function openRoom(info: MeetingInfo): Room {
  let room = rooms.get(info.id);
  if (!room) {
    room = {
      info,
      peers: new Map(),
      knocks: new Map(),
      admitted: new Set(),
      removedGuests: new Set(),
      feed: [],
      feedSeq: 0,
      version: 1,
      locked: false,
      startedAt: now(),
      emptySince: now(),
    };
    rooms.set(info.id, room);
  } else updateRoom(info);
  return room;
}

/** The meeting was edited: names, co-hosts and guest rules apply straight away. */
export function updateRoom(info: MeetingInfo) {
  const room = rooms.get(info.id);
  if (!room) return;
  room.info = info;
  for (const peer of room.peers.values()) peer.role = roleFor(info, peer.accountId);
  if (!info.guestsAllowed)
    for (const knock of room.knocks.values())
      if (knock.status === "waiting" && !knock.accountId) answerKnock(room, knock, "denied");
  bump(room);
}

export function liveSummary(meetingId: string) {
  const room = rooms.get(meetingId);
  const peers = room ? [...room.peers.values()] : [];
  return {
    count: peers.length,
    names: peers.slice(0, 4).map((p) => p.name),
    full: peers.length >= PADDOCK_MAX_PEOPLE,
    locked: !!room?.locked,
    hostPresent: room ? hostPresent(room) : false,
    startedAt: room && peers.length ? room.startedAt : null,
  };
}

export const isAdmitted = (meetingId: string, accountId: string) => !!rooms.get(meetingId)?.admitted.has(accountId);
export const isLocked = (meetingId: string) => !!rooms.get(meetingId)?.locked;

export type JoinResult =
  | { ok: true; seat: string; peerId: string; role: PeerRole }
  | { ok: false; code: "full" | "locked" | "removed" | "conflict" };

interface JoinInput {
  peerId: string;
  accountId: string | null;
  guestId: string | null;
  name: string;
  /** This browser's previous person in the room (a reload): removed straight away. */
  replaces?: string;
  /** Mic/camera as they are now, so others never see a wrong state while this browser joins. */
  state?: unknown;
}
/** Only true/false values are read; anything else counts as off. */
export function startState(value: unknown): PeerState {
  const s = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { mic: s.mic === true, cam: s.cam === true, screen: s.screen === true, hand: s.hand === true ? now() : null };
}

/** Put a person in the room. Joining again with the same id keeps their place (a quiet re-join). */
export function join(room: Room, input: JoinInput): JoinResult {
  const id = identity(input);
  if (!input.accountId && room.removedGuests.has(id)) return { ok: false, code: "removed" };
  const role = roleFor(room.info, input.accountId);
  const existing = room.peers.get(input.peerId);
  if (existing) {
    if (identity(existing) !== id) return { ok: false, code: "conflict" };
    seats.delete(existing.seat);
    existing.seat = token();
    existing.seatExpires = input.accountId ? now() + timings.seatFor : Infinity;
    existing.name = input.name;
    existing.role = role;
    existing.lastSeen = now();
    seats.set(existing.seat, { roomId: room.info.id, peerId: existing.id });
    bump(room);
    return { ok: true, seat: existing.seat, peerId: existing.id, role };
  }
  if (input.replaces && input.replaces !== input.peerId) {
    const old = room.peers.get(input.replaces);
    if (old && identity(old) === id) dropPeer(room, old, "left");
  }
  if (room.locked && role !== "host" && role !== "cohost" && !room.admitted.has(id))
    return { ok: false, code: "locked" };
  if (room.peers.size >= PADDOCK_MAX_PEOPLE) return { ok: false, code: "full" };
  const peer: Peer = {
    id: input.peerId,
    accountId: input.accountId,
    guestId: input.guestId,
    name: input.name,
    role,
    joinedAt: now(),
    lastSeen: now(),
    polling: 0,
    state: startState(input.state),
    inbox: [],
    nextSeq: 1,
    epoch: randomBytes(6).toString("hex"),
    seat: token(),
    seatExpires: input.accountId ? now() + timings.seatFor : Infinity,
    waiter: null,
    sendTimes: [],
  };
  if (room.peers.size === 0) room.startedAt = now();
  room.peers.set(peer.id, peer);
  room.emptySince = null;
  seats.set(peer.seat, { roomId: room.info.id, peerId: peer.id });
  notice(room, `${peer.name} joined`, peer);
  bump(room);
  return { ok: true, seat: peer.seat, peerId: peer.id, role };
}

function dropPeer(room: Room, peer: Peer, reason: GoneReason) {
  room.peers.delete(peer.id);
  seats.delete(peer.seat);
  gone.set(peer.seat, { reason, at: now() });
  wake(peer);
  if (reason !== "ended") notice(room, reason === "removed" ? `${peer.name} was removed` : `${peer.name} left`, peer);
  if (room.peers.size === 0) room.emptySince = now();
  bump(room);
}

function notice(room: Room, text: string, peer: Peer) {
  pushFeed(room, { kind: "notice", id: `n${room.feedSeq + 1}`, from: peer.id, name: peer.name, text });
}
function pushFeed(room: Room, item: Omit<FeedItem, "seq" | "at">) {
  room.feed.push({ ...item, seq: ++room.feedSeq, at: now() });
  if (room.feed.length > MAX_FEED) room.feed.splice(0, room.feed.length - MAX_FEED);
}

export type Seated = { room: Room; peer: Peer };
export type SeatCheck = Seated | { gone: GoneReason };

/** Who holds this seat. Unknown seats (a restart, a long sleep) say "expired": the browser re-joins. */
export function bySeat(seat: unknown): SeatCheck {
  if (typeof seat !== "string" || !/^[a-f0-9]{64}$/.test(seat)) return { gone: "expired" };
  const where = seats.get(seat);
  const room = where && rooms.get(where.roomId);
  const peer = room?.peers.get(where!.peerId);
  if (!room || !peer || peer.seat !== seat) return { gone: gone.get(seat)?.reason ?? "expired" };
  if (peer.seatExpires < now()) return { gone: "expired" };
  return { room, peer };
}

export function leave(seat: unknown) {
  const found = bySeat(seat);
  if ("room" in found) dropPeer(found.room, found.peer, "left");
}

function snapshot(room: Room, peer: Peer, feedSince: number) {
  const canManage = peer.role === "host" || peer.role === "cohost";
  return {
    version: room.version,
    now: now(),
    you: { id: peer.id, role: peer.role, state: peer.state, epoch: peer.epoch },
    room: {
      title: room.info.title,
      code: room.info.code,
      locked: room.locked,
      startedAt: room.startedAt,
      guestsAllowed: room.info.guestsAllowed,
      maxPeople: PADDOCK_MAX_PEOPLE,
    },
    peers: [...room.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      guest: !p.accountId,
      state: p.state,
      joinedAt: p.joinedAt,
    })),
    signals: peer.inbox.slice(0, 200),
    // A new arrival sees the chat so far, not old reactions or join notices.
    feed: room.feed.filter((f) => f.seq > feedSince && (feedSince > 0 || f.kind === "chat")),
    feedSeq: room.feedSeq,
    knocks: canManage
      ? [...room.knocks.values()]
          .filter((k) => k.status === "waiting")
          .map((k) => ({ id: k.id, name: k.name, guest: !k.accountId, at: k.at }))
      : [],
  };
}
export type Snapshot = ReturnType<typeof snapshot>;

/**
 * The browser's one open request. Signals up to `ack` were handled and are dropped. Returns at
 * once when the room changed since `since` or signals are waiting; otherwise after `wait` ms.
 */
export async function sync(
  seat: unknown,
  options: { since: number; ack: number; epoch?: string; feedSince: number; wait: number },
  cancelled?: (cancel: () => void) => void,
): Promise<{ ok: true; data: Snapshot } | { ok: false; gone: GoneReason }> {
  let found = bySeat(seat);
  if (!("room" in found)) return { ok: false, gone: found.gone };
  const { peer } = found;
  peer.lastSeen = now();
  if (options.ack > 0 && (options.epoch === undefined || options.epoch === peer.epoch))
    peer.inbox = peer.inbox.filter((s) => s.seq > options.ack);
  const wait = Math.max(0, Math.min(timings.maxWait, options.wait));
  if (wait > 0 && found.room.version <= options.since && peer.inbox.length === 0) {
    wake(peer); // An older request from this browser answers now.
    peer.polling++;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (peer.waiter === finish) peer.waiter = null;
        resolve();
      }, wait);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      peer.waiter = finish;
      cancelled?.(() => {
        if (peer.waiter === finish) peer.waiter = null;
        finish();
      });
    });
    peer.polling--;
    peer.lastSeen = now();
    found = bySeat(seat);
    if (!("room" in found)) return { ok: false, gone: found.gone };
  }
  return { ok: true, data: snapshot(found.room, found.peer, options.feedSince) };
}

export type SendResult = { ok: true; delivered: number } | { ok: false; code: "invalid" | "busy" };

/** State changes (mic, camera, screen, hand) and call-setup signals to other people in the room. */
export function send(found: Seated, body: { state?: unknown; signals?: unknown }): SendResult {
  const { room, peer } = found;
  peer.lastSeen = now();
  if (body.state !== undefined) {
    const s = body.state as Partial<PeerState> | null;
    if (!s || typeof s !== "object") return { ok: false, code: "invalid" };
    const next: PeerState = { ...peer.state };
    for (const key of ["mic", "cam", "screen"] as const)
      if (s[key] !== undefined) {
        if (typeof s[key] !== "boolean") return { ok: false, code: "invalid" };
        next[key] = s[key] as boolean;
      }
    if (s.hand !== undefined) {
      if (s.hand !== null && typeof s.hand !== "boolean") return { ok: false, code: "invalid" };
      next.hand = s.hand ? (peer.state.hand ?? now()) : null;
    }
    if (JSON.stringify(next) !== JSON.stringify(peer.state)) {
      peer.state = next;
      bump(room);
    }
  }
  let delivered = 0;
  if (body.signals !== undefined) {
    if (!Array.isArray(body.signals) || body.signals.length > 60) return { ok: false, code: "invalid" };
    const t = now();
    peer.sendTimes = peer.sendTimes.filter((at) => t - at < 10_000);
    if (peer.sendTimes.length + body.signals.length > SIGNALS_PER_10S) return { ok: false, code: "busy" };
    const woken = new Set<Peer>();
    for (const raw of body.signals) {
      const s = raw as { to?: unknown; type?: unknown; gen?: unknown; data?: unknown };
      if (
        !s ||
        typeof s.to !== "string" ||
        typeof s.type !== "string" ||
        !SIGNAL_TYPES.has(s.type) ||
        typeof s.gen !== "number" ||
        !Number.isInteger(s.gen) ||
        s.gen < 0
      )
        return { ok: false, code: "invalid" };
      if ((JSON.stringify(s.data ?? null) ?? "").length > MAX_SIGNAL_CHARS) return { ok: false, code: "invalid" };
      const target = room.peers.get(s.to);
      peer.sendTimes.push(t);
      if (!target || target === peer) continue;
      target.inbox.push({ seq: target.nextSeq++, from: peer.id, type: s.type, gen: s.gen, data: s.data ?? null });
      if (target.inbox.length > MAX_INBOX) target.inbox.splice(0, target.inbox.length - MAX_INBOX);
      woken.add(target);
      delivered++;
    }
    for (const target of woken) wake(target);
  }
  return { ok: true, delivered };
}

/** In-call chat: kept only while the room is open. The same `id` twice is stored once. */
export function chat(found: Seated, id: string, text: string) {
  const { room, peer } = found;
  if (room.feed.some((f) => f.kind === "chat" && f.id === id && f.from === peer.id)) return;
  pushFeed(room, { kind: "chat", id, from: peer.id, name: peer.name, text });
  bump(room);
}

export function react(found: Seated, emoji: string) {
  const { room, peer } = found;
  pushFeed(room, { kind: "reaction", id: `r${room.feedSeq + 1}`, from: peer.id, name: peer.name, text: emoji });
  bump(room);
}

// ————— Waiting room —————

export type KnockResult = { ok: true; id: string; token: string } | { ok: false; code: "busy" | "locked" | "removed" | "guests_off" };

/** Ask to join. Asking again from the same person updates their request instead of adding another. */
export function knock(room: Room, who: { accountId: string | null; guestId: string | null; name: string }): KnockResult {
  const id = identity(who);
  if (!who.accountId && !room.info.guestsAllowed) return { ok: false, code: "guests_off" };
  if (!who.accountId && room.removedGuests.has(id)) return { ok: false, code: "removed" };
  if (room.locked) return { ok: false, code: "locked" };
  for (const k of room.knocks.values())
    if (identity(k) === id && k.status === "waiting") {
      k.name = who.name;
      k.lastSeen = now();
      bump(room);
      return { ok: true, id: k.id, token: k.token };
    }
  if ([...room.knocks.values()].filter((k) => k.status === "waiting").length >= MAX_KNOCKS)
    return { ok: false, code: "busy" };
  const k: Knock = {
    id: randomBytes(12).toString("hex"),
    token: token(),
    roomId: room.info.id,
    accountId: who.accountId,
    guestId: who.guestId,
    name: who.name,
    at: now(),
    lastSeen: now(),
    status: "waiting",
    waiter: null,
  };
  room.knocks.set(k.id, k);
  knocks.set(k.id, k);
  bump(room);
  return { ok: true, id: k.id, token: k.token };
}

function answerKnock(room: Room, k: Knock, status: Knock["status"]) {
  k.status = status;
  k.lastSeen = now();
  if (status === "admitted") room.admitted.add(identity(k));
  wake(k);
}

function findKnock(id: unknown, secret: unknown): { room: Room; knock: Knock } | null {
  if (typeof id !== "string" || typeof secret !== "string") return null;
  const k = knocks.get(id);
  if (!k || k.token !== secret) return null;
  const room = rooms.get(k.roomId);
  if (!room) {
    knocks.delete(id);
    return null;
  }
  return { room, knock: k };
}

/** The person waiting checks on their request (long-poll). */
export async function knockStatus(id: unknown, secret: unknown, wait: number, cancelled?: (cancel: () => void) => void) {
  const found = findKnock(id, secret);
  if (!found) return null;
  const { knock: k } = found;
  k.lastSeen = now();
  const ms = Math.max(0, Math.min(timings.maxWait, wait));
  if (ms > 0 && k.status === "waiting") {
    wake(k);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (k.waiter === finish) k.waiter = null;
        resolve();
      }, ms);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      k.waiter = finish;
      cancelled?.(() => {
        if (k.waiter === finish) k.waiter = null;
        finish();
      });
    });
    k.lastSeen = now();
  }
  const room = rooms.get(k.roomId);
  return {
    status: room ? k.status : ("ended" as const),
    hostPresent: room ? hostPresent(room) : false,
    title: room?.info.title ?? "",
  };
}

export function cancelKnock(id: unknown, secret: unknown) {
  const found = findKnock(id, secret);
  if (!found) return;
  found.room.knocks.delete(found.knock.id);
  knocks.delete(found.knock.id);
  wake(found.knock);
  bump(found.room);
}

/** Come in after a host said yes. */
export function joinFromKnock(id: unknown, secret: unknown, peerId: string, state?: unknown) {
  const found = findKnock(id, secret);
  if (!found || found.knock.status !== "admitted") return null;
  const { room, knock: k } = found;
  const result = join(room, { peerId, accountId: k.accountId, guestId: k.guestId, name: k.name, state });
  if (result.ok || result.code !== "full") {
    room.knocks.delete(k.id);
    knocks.delete(k.id);
  }
  return {
    result,
    who: { meetingId: room.info.id, code: room.info.code, accountId: k.accountId, guestId: k.guestId, name: k.name },
  };
}

/** Knocks waiting in this room right now (for the host's "let in" list). */
export function knockInfo(found: Seated, knockId: unknown) {
  const k = typeof knockId === "string" ? found.room.knocks.get(knockId) : undefined;
  return k && k.status === "waiting" ? k : null;
}

// ————— Host tools —————

export const canManage = (found: Seated) => found.peer.role === "host" || found.peer.role === "cohost";

export function admit(found: Seated, knockId: unknown, allow: boolean): "ok" | "missing" | "full" {
  const k = knockInfo(found, knockId);
  if (!k) return "missing";
  const coming = [...found.room.knocks.values()].filter((x) => x.status === "admitted").length;
  if (allow && found.room.peers.size + coming >= PADDOCK_MAX_PEOPLE) return "full";
  answerKnock(found.room, k, allow ? "admitted" : "denied");
  if (!allow) {
    // Off the host's list now; the answer stays readable for a minute so the browser learns it.
    found.room.knocks.delete(k.id);
    setTimeout(() => knocks.get(k.id) === k && knocks.delete(k.id), 60_000).unref?.();
  }
  bump(found.room);
  return "ok";
}

/** Let everyone waiting in, while there's room. Returns how many came in. */
export function admitAll(found: Seated) {
  let admitted = 0;
  for (const k of [...found.room.knocks.values()])
    if (k.status === "waiting" && admit(found, k.id, true) === "ok") admitted++;
  return admitted;
}

/** Let someone straight back in (a returning admitted person, e.g. after a server restart). */
export function grantAdmission(room: Room, who: { accountId: string | null; guestId: string | null }) {
  room.admitted.add(identity(who));
}

/** A host's request to someone's own browser (mute, lower hand, stop presenting). */
export function control(found: Seated, peerId: unknown, action: "mute" | "lower-hand" | "stop-screen") {
  const target = typeof peerId === "string" ? found.room.peers.get(peerId) : undefined;
  if (!target) return false;
  if (action === "mute") target.state = { ...target.state, mic: false };
  if (action === "lower-hand") target.state = { ...target.state, hand: null };
  if (action === "stop-screen") target.state = { ...target.state, screen: false };
  target.inbox.push({ seq: target.nextSeq++, from: found.peer.id, type: "control", gen: 0, data: { action } });
  bump(found.room);
  return true;
}

export function controlAll(found: Seated, action: "mute" | "lower-hand") {
  for (const peer of found.room.peers.values()) if (peer !== found.peer) control(found, peer.id, action);
}

/** Remove someone. Returns their account id (kept out by the database) or null for a guest. */
export function removePeer(found: Seated, peerId: unknown): { accountId: string | null } | null {
  const target = typeof peerId === "string" ? found.room.peers.get(peerId) : undefined;
  if (!target || target === found.peer || target.role === "host") return null;
  if (!target.accountId) found.room.removedGuests.add(identity(target));
  else found.room.admitted.delete(target.accountId);
  dropPeer(found.room, target, "removed");
  return { accountId: target.accountId };
}

export function setLocked(found: Seated, locked: boolean) {
  found.room.locked = locked;
  bump(found.room);
}

export function peerAccount(found: Seated, peerId: unknown) {
  const target = typeof peerId === "string" ? found.room.peers.get(peerId) : undefined;
  return target?.accountId ?? null;
}

/** End the call for everyone (or the meeting was deleted). */
export function endRoom(meetingId: string) {
  const room = rooms.get(meetingId);
  if (!room) return;
  for (const peer of [...room.peers.values()]) dropPeer(room, peer, "ended");
  for (const k of room.knocks.values()) {
    answerKnock(room, k, "ended");
    knocks.delete(k.id);
  }
  rooms.delete(meetingId);
}

// ————— Housekeeping —————

export function sweep() {
  const t = now();
  for (const room of rooms.values()) {
    for (const peer of [...room.peers.values()])
      if (peer.polling === 0 && t - peer.lastSeen > timings.stale) dropPeer(room, peer, "expired");
    for (const k of [...room.knocks.values()]) {
      const limit = k.status === "admitted" ? timings.admittedFor : timings.knockStale;
      if (t - k.lastSeen > limit) {
        room.knocks.delete(k.id);
        knocks.delete(k.id);
        if (k.status === "waiting") bump(room);
      }
    }
    if (room.peers.size === 0 && room.knocks.size === 0 && room.emptySince && t - room.emptySince > timings.emptyFor)
      rooms.delete(room.info.id);
  }
  for (const [seat, entry] of gone) if (t - entry.at > 10 * 60_000) gone.delete(seat);
}
setInterval(sweep, 5_000).unref?.();

/** For tests. */
export function resetRooms() {
  rooms.clear();
  seats.clear();
  knocks.clear();
  gone.clear();
}
