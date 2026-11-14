import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { isUuid } from "../middleware/stable";

/** Stayblz Paddock: browser-to-browser calls work well for a handful of people. */
export const PADDOCK_MAX_PEOPLE = 8;

// No i, l or o: codes are easy to read out loud and type.
const LETTERS = "abcdefghjkmnpqrstuvwxyz";
const group = () => Array.from({ length: 4 }, () => LETTERS[randomInt(LETTERS.length)]).join("");
export const newCode = () => `${group()}-${group()}`;
export const isCode = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z]{4}-[a-z]{4}$/.test(value);

export class InputError extends Error {}

// ————— Return passes —————
// Someone a host let in (a guest, or a member without direct access) gets a signed pass, so a
// dropped connection or a server restart puts them straight back in instead of the waiting room.
// The key is random per server start unless PADDOCK_SECRET is set (then passes survive restarts).
const PASS_HOURS = 12;
const passKey = process.env.PADDOCK_SECRET?.trim() || randomBytes(32).toString("hex");
export interface Pass {
  meetingId: string;
  code: string;
  accountId: string | null;
  guestId: string | null;
  name: string;
}
const sign = (body: string) => createHmac("sha256", passKey).update(`paddock-pass:${body}`).digest("base64url");
export function passFor(pass: Pass): string {
  const body = Buffer.from(
    JSON.stringify({
      m: pass.meetingId,
      c: pass.code,
      a: pass.accountId,
      g: pass.guestId,
      n: pass.name,
      e: Date.now() + PASS_HOURS * 3600_000,
    }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}
export function readPass(value: unknown): Pass | null {
  if (typeof value !== "string" || value.length > 1200) return null;
  const [body, mac] = value.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof p.e !== "number" || p.e < Date.now() || !isUuid(p.m) || !isCode(p.c) || typeof p.n !== "string") return null;
    if (p.a !== null && !isUuid(p.a)) return null;
    if (p.g !== null && (typeof p.g !== "string" || !/^[a-f0-9]{24}$/.test(p.g))) return null;
    if ((p.a === null) === (p.g === null)) return null;
    return { meetingId: p.m, code: p.c, accountId: p.a, guestId: p.g, name: p.n };
  } catch {
    return null;
  }
}
export const newGuestId = () => randomBytes(12).toString("hex");
export const isPeerId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{8,40}$/.test(value);

/** A person's name for a call: printable, single-spaced, 2–40 characters. */
export function cleanName(value: unknown): string {
  if (typeof value !== "string") throw new InputError("Enter your name.");
  const name = value
    .normalize("NFC")
    // Control and invisible formatting characters (zero-width, direction overrides, line separators).
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 2) throw new InputError("Enter your name (at least 2 letters).");
  if (name.length > 40) throw new InputError("Use a shorter name (40 characters or fewer).");
  return name;
}

export interface MeetingFields {
  title?: string;
  scheduled_for?: string | null;
  duration_minutes?: number;
  access?: "open" | "ask";
  guests_allowed?: boolean;
  stable_id?: string | null;
  invitee_ids?: string[];
}

/** Checks the meeting form. `partial` (editing) only reads the fields that were sent. */
export function meetingInput(body: Record<string, unknown>, partial: boolean): MeetingFields {
  const out: MeetingFields = {};
  const has = (key: string) => body[key] !== undefined;
  if (has("title") || !partial) {
    const raw = body.title === undefined ? "Paddock meeting" : body.title;
    if (typeof raw !== "string" || !raw.trim()) throw new InputError("Give the meeting a name.");
    const title = raw.replace(/\s+/g, " ").trim();
    if (title.length > 100) throw new InputError("Use a shorter meeting name (100 characters or fewer).");
    out.title = title;
  }
  if (has("scheduledFor")) {
    if (body.scheduledFor === null || body.scheduledFor === "") out.scheduled_for = null;
    else {
      const at = typeof body.scheduledFor === "string" ? Date.parse(body.scheduledFor) : NaN;
      const now = Date.now();
      if (!Number.isFinite(at)) throw new InputError("Choose a date and time.");
      if (at < now - 24 * 3600_000) throw new InputError("That time has already passed. Choose a later time.");
      if (at > now + 366 * 24 * 3600_000) throw new InputError("Schedule meetings up to a year ahead.");
      out.scheduled_for = new Date(at).toISOString();
    }
  }
  if (has("durationMinutes")) {
    const minutes = body.durationMinutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 5 || minutes > 480)
      throw new InputError("Meetings last between 5 minutes and 8 hours.");
    out.duration_minutes = minutes;
  }
  if (has("access")) {
    if (body.access !== "open" && body.access !== "ask") throw new InputError("Choose who can join.");
    out.access = body.access;
  }
  if (has("guestsAllowed")) {
    if (typeof body.guestsAllowed !== "boolean") throw new InputError("Choose whether guests can ask to join.");
    out.guests_allowed = body.guestsAllowed;
  }
  if (has("stableId")) {
    if (body.stableId !== null && !isUuid(body.stableId)) throw new InputError("Choose one of your stables.");
    out.stable_id = (body.stableId as string | null) ?? null;
  }
  if (has("inviteeIds")) {
    const ids = body.inviteeIds;
    if (!Array.isArray(ids) || !ids.every(isUuid)) throw new InputError("Choose people to invite.");
    const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
    if (unique.length > 50) throw new InputError("Invite up to 50 people.");
    out.invitee_ids = unique;
  }
  return out;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// Free public STUN servers: they only tell each browser its own internet address.
const STUN: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const RELAY_CACHE_MS = 5 * 60_000;
let relayCache: { at: number; servers: IceServer[] } | null = null;

function asServers(value: unknown): IceServer[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .filter((s): s is IceServer => !!s && typeof s === "object" && "urls" in s)
    .map((s) => ({
      ...s,
      // Browsers can stall on port 53; Cloudflare's guide suggests leaving it out.
      urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === "string" && !/:53(\?|$)/.test(u)),
    }))
    .filter((s) => (s.urls as string[]).length > 0);
}

async function cloudflareRelay(keyId: string, token: string): Promise<IceServer[]> {
  const base = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials`;
  for (const path of ["generate-ice-servers", "generate"]) {
    const response = await fetch(`${base}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 6 * 3600 }),
      signal: AbortSignal.timeout(3000),
    });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`relay ${response.status}`);
    const body = (await response.json()) as { iceServers?: unknown };
    return asServers(body.iceServers).filter((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith("turn")));
  }
  throw new Error("relay endpoint missing");
}

/**
 * How browsers find each other. Always free STUN. A relay (TURN) helps when strict office or
 * mobile networks block direct calls: set PADDOCK_TURN_KEY_ID + PADDOCK_TURN_KEY_TOKEN (Cloudflare,
 * 1,000 GB/month free) or PADDOCK_TURN_URLS + PADDOCK_TURN_USERNAME + PADDOCK_TURN_CREDENTIAL.
 * A relay failure never blocks a call; it only falls back to STUN.
 */
export async function iceServers(): Promise<{ iceServers: IceServer[]; relay: boolean }> {
  const keyId = process.env.PADDOCK_TURN_KEY_ID?.trim();
  const token = process.env.PADDOCK_TURN_KEY_TOKEN?.trim();
  const urls = process.env.PADDOCK_TURN_URLS?.trim();
  let relay: IceServer[] = [];
  if (keyId && token) {
    if (relayCache && Date.now() - relayCache.at < RELAY_CACHE_MS) relay = relayCache.servers;
    else {
      try {
        relay = await cloudflareRelay(keyId, token);
        relayCache = { at: Date.now(), servers: relay };
      } catch {
        relay = [];
      }
    }
  } else if (urls) {
    relay = asServers({
      urls: urls.split(",").map((u) => u.trim()).filter(Boolean),
      username: process.env.PADDOCK_TURN_USERNAME?.trim(),
      credential: process.env.PADDOCK_TURN_CREDENTIAL?.trim(),
    });
  }
  return { iceServers: [...STUN, ...relay], relay: relay.length > 0 };
}
