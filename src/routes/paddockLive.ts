/**
 * Stayblz Paddock during a call, and for guests. No sign-in cookie needed here: a person in a call
 * holds a seat (a random 64-character key, sent as X-Paddock-Seat) that only works for their own
 * place in that one room. Seats come from a signed-in join (routes/paddock.ts), or from the waiting
 * room once a host lets someone in. Signed-in seats expire every 15 minutes and the browser quietly
 * joins again, so a suspended account or a removal can't linger.
 */
import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { supabase } from "../lib/supabase";
import {
  PADDOCK_MAX_PEOPLE,
  cleanName,
  iceServers,
  InputError,
  isCode,
  isPeerId,
  newGuestId,
  passFor,
  readPass,
} from "../lib/paddock";
import * as live from "../lib/paddockRooms";
import { joinErrors, knockError, loadMeeting, paddockUnavailable, roomInfo } from "./paddock";

const router = Router();

const goneAnswers: Record<live.GoneReason, string> = {
  left: "You left the call.",
  removed: "The host removed you from this call.",
  ended: "The host ended the call for everyone.",
  expired: "Your place in the call timed out. Joining again…",
};
const seatOf = (req: Request) => req.get("X-Paddock-Seat") ?? req.body?.seat;
function seated(req: Request, res: Response): live.Seated | null {
  const found = live.bySeat(seatOf(req));
  if ("gone" in found) {
    res.status(410).json({ code: found.gone, error: goneAnswers[found.gone] });
    return null;
  }
  return found;
}
const count = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
/** Long requests end early when the browser goes away, so nothing waits for nobody. */
function onGoneAway(res: Response) {
  let cancel: (() => void) | null = null;
  res.on("close", () => {
    if (!res.writableEnded) cancel?.();
  });
  return (fn: () => void) => {
    cancel = fn;
  };
}
const ipLimit = (action: string, envName: string, fallback: number, windowMs: number) =>
  authLimit(action, () => Number(process.env[envName] ?? fallback), windowMs);
// Behind the Vercel proxy many visitors share one address, so these are flood guards. Each room
// also holds at most 12 waiting requests, and a host can lock the meeting.
const guestInfoLimit = ipLimit("paddock-guest-info", "PADDOCK_GUEST_LOOKUPS_PER_10MIN", 600, 600_000);
const guestKnockLimit = ipLimit("paddock-guest-knock", "PADDOCK_GUEST_KNOCKS_PER_10MIN", 40, 600_000);
const passLimit = ipLimit("paddock-rejoin", "PADDOCK_REJOINS_PER_10MIN", 300, 600_000);

// In-call chat and reactions: generous for people, tight for scripts.
const bursts = new Map<string, number[]>();
function burstAllowed(key: string, max: number, windowMs: number) {
  const t = Date.now();
  const recent = (bursts.get(key) ?? []).filter((at) => t - at < windowMs);
  if (recent.length >= max) {
    bursts.set(key, recent);
    return false;
  }
  recent.push(t);
  bursts.set(key, recent);
  if (bursts.size > 5000) bursts.delete(bursts.keys().next().value!);
  return true;
}

async function seatAnswer(result: { seat: string; peerId: string; role: live.PeerRole }, pass?: string) {
  const ice = await iceServers();
  return { seat: result.seat, peerId: result.peerId, role: result.role, ...(pass ? { pass } : {}), ...ice, maxPeople: PADDOCK_MAX_PEOPLE };
}

router.post(
  "/sync",
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const result = await live.sync(
      seatOf(req),
      {
        since: count(body.since),
        ack: count(body.ack),
        epoch: typeof body.epoch === "string" ? body.epoch.slice(0, 32) : undefined,
        feedSince: count(body.feedSince),
        wait: count(body.wait),
      },
      onGoneAway(res),
    );
    if (res.writableEnded || res.destroyed) return;
    if (!result.ok) return res.status(410).json({ code: result.gone, error: goneAnswers[result.gone] });
    res.json(result.data);
  }),
);

router.post("/send", (req, res) => {
  const found = seated(req, res);
  if (!found) return;
  const result = live.send(found, req.body ?? {});
  if (!result.ok)
    return res
      .status(result.code === "busy" ? 429 : 400)
      .json({ error: result.code === "busy" ? "Too many updates at once. Slow down a little." : "That update wasn't valid." });
  res.json({ delivered: result.delivered });
});

router.post("/chat", (req, res) => {
  const found = seated(req, res);
  if (!found) return;
  const { id, text } = req.body ?? {};
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{6,40}$/.test(id)) return res.status(400).json({ error: "Send that message again." });
  const message = typeof text === "string" ? text.replace(/\r\n?/g, "\n").trim() : "";
  if (!message) return res.status(400).json({ error: "Type a message first." });
  if (message.length > 1000) return res.status(400).json({ error: "Messages can be up to 1,000 characters." });
  if (!burstAllowed(`chat:${found.peer.id}`, 20, 10_000))
    return res.status(429).json({ error: "You're sending messages very fast. Wait a few seconds." });
  live.chat(found, id, message);
  res.status(201).json({ ok: true });
});

router.post("/react", (req, res) => {
  const found = seated(req, res);
  if (!found) return;
  const emoji = req.body?.emoji;
  if (typeof emoji !== "string" || !live.REACTIONS.includes(emoji)) return res.status(400).json({ error: "Pick a reaction." });
  if (!burstAllowed(`react:${found.peer.id}`, 12, 10_000)) return res.status(429).json({ error: "That's a lot of reactions! Wait a moment." });
  live.react(found, emoji);
  res.status(201).json({ ok: true });
});

/** Host and co-host tools. "cohost" and "end" also update the database. */
router.post(
  "/host",
  asyncRoute(async (req, res) => {
    const found = seated(req, res);
    if (!found) return;
    const { action, peer, knock, on } = req.body ?? {};
    if (!live.canManage(found)) return res.status(403).json({ error: "Only the host and co-hosts can do that." });
    const meetingId = found.room.info.id;
    switch (action) {
      case "admit":
      case "deny": {
        const answer = live.admit(found, knock, action === "admit");
        if (answer === "missing") return res.status(404).json({ error: "That person stopped waiting." });
        if (answer === "full") return res.status(409).json({ error: joinErrors.full[1] });
        return res.json({ ok: true });
      }
      case "admit-all":
        return res.json({ ok: true, admitted: live.admitAll(found) });
      case "mute":
      case "lower-hand":
      case "stop-screen":
        if (!live.control(found, peer, action)) return res.status(404).json({ error: "That person isn't in the call." });
        return res.json({ ok: true });
      case "mute-all":
        live.controlAll(found, "mute");
        return res.json({ ok: true });
      case "lower-all":
        live.controlAll(found, "lower-hand");
        return res.json({ ok: true });
      case "lock":
        if (typeof on !== "boolean") return res.status(400).json({ error: "Choose lock or unlock." });
        live.setLocked(found, on);
        return res.json({ ok: true });
      case "remove": {
        const removed = live.removePeer(found, peer);
        if (!removed) return res.status(404).json({ error: "That person can't be removed." });
        if (removed.accountId) {
          const { error } = await supabase.rpc("paddock_remove", { p_meeting: meetingId, p_user: removed.accountId });
          if (error) return res.status(503).json({ error: "They left the call, but may be able to rejoin. Try removing them again." });
        }
        return res.json({ ok: true });
      }
      case "cohost": {
        if (found.peer.role !== "host") return res.status(403).json({ error: "Only the host can choose co-hosts." });
        const accountId = live.peerAccount(found, peer);
        if (!accountId || typeof on !== "boolean")
          return res.status(400).json({ error: "Only people signed in to Stayblz can be co-hosts." });
        const current = new Set(found.room.info.cohostIds);
        if (on) current.add(accountId);
        else current.delete(accountId);
        if (current.size > 10) return res.status(400).json({ error: "A meeting can have up to 10 co-hosts." });
        const cohost_ids = [...current];
        const { error } = await supabase
          .from("paddock_meetings")
          .update({ cohost_ids, updated_at: new Date().toISOString() })
          .eq("id", meetingId);
        if (error) return paddockUnavailable(res);
        live.updateRoom({ ...found.room.info, cohostIds: cohost_ids });
        return res.json({ ok: true });
      }
      case "end":
        live.endRoom(meetingId);
        return res.json({ ok: true });
      default:
        return res.status(400).json({ error: "Unknown action." });
    }
  }),
);

/** Leaving. Also accepts the seat in the body, for the "page is closing" beacon. */
router.post("/leave", (req, res) => {
  live.leave(seatOf(req));
  res.status(204).end();
});

// ————— Guests and the waiting room —————

router.get(
  "/guest/:code",
  guestInfoLimit,
  asyncRoute(async (req, res) => {
    if (!isCode(req.params.code)) return res.status(404).json({ code: "not_found", error: "There's no meeting with that code." });
    const { meeting, error } = await loadMeeting(req.params.code, null);
    if (error) return paddockUnavailable(res);
    if (!meeting) return res.status(404).json({ code: "not_found", error: "There's no meeting with that code." });
    const summary = live.liveSummary(meeting.id);
    res.json({
      meeting: {
        code: meeting.code,
        title: meeting.title,
        hostName: meeting.hostName,
        scheduledFor: meeting.scheduledFor,
        durationMinutes: meeting.durationMinutes,
        guestsAllowed: meeting.guestsAllowed,
      },
      // Guests see how many are in, not who.
      live: { count: summary.count, full: summary.full, locked: summary.locked, hostPresent: summary.hostPresent },
      maxPeople: PADDOCK_MAX_PEOPLE,
    });
  }),
);

router.post(
  "/guest/:code/knock",
  guestKnockLimit,
  asyncRoute(async (req, res) => {
    if (!isCode(req.params.code)) return res.status(404).json({ code: "not_found", error: "There's no meeting with that code." });
    let name: string;
    try {
      name = cleanName(req.body?.name);
    } catch (error) {
      return res.status(400).json({ error: error instanceof InputError ? error.message : "Enter your name." });
    }
    const { meeting, error } = await loadMeeting(req.params.code, null);
    if (error) return paddockUnavailable(res);
    if (!meeting) return res.status(404).json({ code: "not_found", error: "There's no meeting with that code." });
    if (!meeting.guestsAllowed) return knockError(res, "guests_off");
    const result = live.knock(live.openRoom(roomInfo(meeting)), { accountId: null, guestId: newGuestId(), name });
    if (!result.ok) return knockError(res, result.code);
    res.status(201).json({ knock: { id: result.id, token: result.token } });
  }),
);

/** Waiting for an answer (long-poll). */
router.post(
  "/knock/:id",
  asyncRoute(async (req, res) => {
    const status = await live.knockStatus(req.params.id, req.body?.token, count(req.body?.wait), onGoneAway(res));
    if (res.writableEnded || res.destroyed) return;
    if (!status) return res.status(404).json({ code: "gone", error: "This request to join has expired. Ask again." });
    res.json(status);
  }),
);

router.post("/knock/:id/cancel", (req, res) => {
  live.cancelKnock(req.params.id, req.body?.token);
  res.status(204).end();
});

/** Come in after a host said yes. The answer includes a return pass. */
router.post(
  "/knock/:id/join",
  asyncRoute(async (req, res) => {
    const peerId = req.body?.peerId;
    if (!isPeerId(peerId)) return res.status(400).json({ error: "Refresh the page and try joining again." });
    const joined = live.joinFromKnock(req.params.id, req.body?.token, peerId, req.body?.state);
    if (!joined) return res.status(404).json({ code: "gone", error: "This request to join has expired. Ask again." });
    const { result, who } = joined;
    if (!result.ok) {
      const [status, message] = joinErrors[result.code];
      return res.status(status).json({ code: result.code, error: message });
    }
    if (who.accountId) {
      const { data, error } = await supabase.rpc("paddock_joined", { p_meeting: who.meetingId, p_user: who.accountId });
      if (error || data === false) {
        live.leave(result.seat);
        return error ? paddockUnavailable(res) : res.status(403).json({ code: "removed", error: joinErrors.removed[1] });
      }
    }
    res.json(await seatAnswer(result, passFor(who)));
  }),
);

/** Back in with a return pass (a dropped connection, a reload, or a server restart). */
router.post(
  "/rejoin",
  passLimit,
  asyncRoute(async (req, res) => {
    const pass = readPass(req.body?.pass);
    const peerId = req.body?.peerId;
    const replaces = isPeerId(req.body?.replaces) ? req.body.replaces : undefined;
    if (!pass || !isPeerId(peerId)) return res.status(403).json({ code: "ask", error: "Ask to join again." });
    const { meeting, error } = await loadMeeting(pass.code, pass.accountId);
    if (error) return paddockUnavailable(res);
    if (!meeting || meeting.id !== pass.meetingId) return res.status(404).json({ code: "not_found", error: "This meeting no longer exists." });
    if (meeting.removed) return res.status(403).json({ code: "removed", error: joinErrors.removed[1] });
    if (!pass.accountId && !meeting.guestsAllowed) return knockError(res, "guests_off");
    const room = live.openRoom(roomInfo(meeting));
    live.grantAdmission(room, pass);
    const result = live.join(room, { peerId, accountId: pass.accountId, guestId: pass.guestId, name: pass.name, replaces, state: req.body?.state });
    if (!result.ok) {
      const [status, message] = joinErrors[result.code];
      return res.status(status).json({ code: result.code, error: message });
    }
    res.json(await seatAnswer(result, req.body.pass));
  }),
);

export default router;
