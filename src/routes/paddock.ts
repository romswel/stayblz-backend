/**
 * Stayblz Paddock for signed-in members: the home list, creating/editing meetings, and joining.
 * In-call traffic (and guests) use routes/paddockLive.ts.
 */
import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { supabase } from "../lib/supabase";
import {
  InputError,
  PADDOCK_MAX_PEOPLE,
  iceServers,
  isCode,
  isPeerId,
  meetingInput,
  newCode,
  type MeetingFields,
} from "../lib/paddock";
import * as live from "../lib/paddockRooms";
import * as alerts from "../lib/paddockAlerts";
import { pushPaddock } from "../lib/push";

export interface Meeting {
  id: string;
  code: string;
  title: string;
  hostId: string;
  hostName: string;
  scheduledFor: string | null;
  durationMinutes: number;
  access: "open" | "ask";
  guestsAllowed: boolean;
  stableId: string | null;
  stableName: string | null;
  cohostIds: string[];
  createdAt: string;
  lastLiveAt: string | null;
  role: "host" | "cohost" | "invited" | "team" | "none" | "guest";
  removed: boolean;
  lastJoinedAt: string | null;
  invitees: { id: string; name: string }[] | null;
}

const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if ((req as AuthenticatedRequest).user.passwordSetupRequired) {
    res.status(403).json({ error: "Set your account password before joining meetings." });
    return;
  }
  next();
});
const user = (req: Request) => (req as AuthenticatedRequest).user;
export const paddockUnavailable = (res: Response) =>
  res.status(503).json({ error: "Stayblz Paddock is unavailable right now. Please try again in a moment." });
const notFound = (res: Response) =>
  res.status(404).json({ code: "not_found", error: "There's no meeting with that code. Check the code or link and try again." });

export async function loadMeeting(code: string, accountId: string | null) {
  const { data, error } = await supabase.rpc("paddock_access", { p_code: code, p_user: accountId });
  if (error) return { error: true as const };
  return { meeting: (data ?? null) as Meeting | null };
}
export const roomInfo = (m: Meeting): live.MeetingInfo => ({
  id: m.id,
  code: m.code,
  title: m.title,
  hostId: m.hostId,
  cohostIds: m.cohostIds ?? [],
  guestsAllowed: m.guestsAllowed,
});
/** Who walks straight in: hosts, co-hosts, invitees, the linked stable, anyone when it's open, or people a host let in. */
const joinsDirectly = (m: Meeting, accountId: string) =>
  ["host", "cohost", "invited", "team"].includes(m.role) || m.access === "open" || live.isAdmitted(m.id, accountId);
/** What browsers get: no internal account ids (the host sees invitee names to edit the list). */
const withLive = ({ hostId: _host, cohostIds: _cohosts, ...m }: Meeting) => ({ ...m, live: live.liveSummary(m.id) });
export const joinErrors: Record<string, [number, string]> = {
  full: [409, `This call is full (${PADDOCK_MAX_PEOPLE} people). Try again when someone leaves.`],
  locked: [403, "The host locked this meeting, so nobody new can join right now."],
  removed: [403, "The host removed you from this meeting, so you can't join again."],
  conflict: [409, "Something went wrong joining. Refresh the page and try again."],
};

/** Stable and invitees must be real: your own stable, active accounts (never yourself). */
async function checkLinks(fields: MeetingFields, accountId: string) {
  if (fields.stable_id) {
    const { data, error } = await supabase
      .from("stable_memberships")
      .select("role")
      .eq("stable_id", fields.stable_id)
      .eq("user_id", accountId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new InputError("Choose one of your stables.");
  }
  if (fields.invitee_ids) {
    const wanted = fields.invitee_ids.filter((id) => id !== accountId);
    if (wanted.length) {
      const { data, error } = await supabase.from("accounts").select("id,status").in("id", wanted);
      if (error) throw error;
      const active = new Set((data ?? []).filter((a: { status: string }) => a.status === "active").map((a: { id: string }) => a.id));
      fields.invitee_ids = wanted.filter((id) => active.has(id));
    } else fields.invitee_ids = [];
  }
}

const createLimit = authLimit("paddock-create", () => Number(process.env.PADDOCK_CREATES_PER_HOUR ?? 40), 3600_000, (req) =>
  (req as Partial<AuthenticatedRequest>).user?.id ?? null,
);
const knockLimit = authLimit("paddock-knock", () => Number(process.env.PADDOCK_KNOCKS_PER_10MIN ?? 30), 600_000, (req) =>
  (req as Partial<AuthenticatedRequest>).user?.id ?? null,
);
const ringLimit = authLimit("paddock-ring", () => Number(process.env.PADDOCK_RINGS_PER_10MIN ?? 40), 600_000, (req) =>
  (req as Partial<AuthenticatedRequest>).user?.id ?? null,
);

/**
 * Alert people about a meeting (ring, started, invited): only active accounts that haven't blocked
 * the sender and allow call alerts. Web Push goes out in the background. Returns who was alerted.
 */
async function alertPeople(
  kind: alerts.AlertKind,
  meeting: { id: string; code: string; title: string; scheduledFor: string | null },
  from: { id: string; name: string },
  ids: string[],
  video = true,
) {
  const wanted = [...new Set(ids)].filter((id) => id !== from.id).slice(0, 50);
  if (!wanted.length) return [];
  const { data, error } = await supabase.rpc("paddock_alert_targets", { p_from: from.id, p_users: wanted });
  if (error || !Array.isArray(data)) return [];
  const targets = data as { userId: string; name: string; push: { endpoint: string; p256dh: string; auth: string }[] }[];
  const made = alerts.raise({ kind, meeting, from, video, to: targets.map((t) => ({ id: t.userId, name: t.name })) });
  for (const alert of made) {
    const push = targets.find((t) => t.userId === alert.to)?.push ?? [];
    void pushPaddock({ ...alert, kind }, push);
  }
  return made.map((a) => ({ id: a.to, name: a.toName }));
}

/** Everyone a meeting names: invitees, co-hosts and the host. */
async function namedPeople(meetingId: string) {
  const { data, error } = await supabase.from("paddock_meetings").select("host_id,invitee_ids,cohost_ids").eq("id", meetingId).single();
  if (error || !data) return null;
  const row = data as { host_id: string; invitee_ids: string[] | null; cohost_ids: string[] | null };
  return { hostId: row.host_id, invitees: row.invitee_ids ?? [], cohosts: row.cohost_ids ?? [] };
}

// ————— Alerts (incoming calls, meetings starting, invitations) —————

/** The browser's alert line (a read, so GET): answers at once when something changed since `since`, else after `wait` ms. */
const count = (value: unknown) => {
  const n = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : 0;
  return Number.isSafeInteger(n) ? n : 0;
};
router.get(
  "/alerts",
  asyncRoute(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const since = count(req.query.since);
    const wait = count(req.query.wait);
    let cancel: (() => void) | null = null;
    res.on("close", () => {
      if (!res.writableEnded) cancel?.();
    });
    const answer = await alerts.waitFor(user(req).id, since, wait, (fn) => {
      cancel = fn;
    });
    if (res.writableEnded || res.destroyed) return;
    res.json(answer);
  }),
);

router.post("/alerts/:id/decline", (req, res) => {
  if (!alerts.decline(user(req).id, req.params.id)) return res.status(404).json({ error: "That call has already ended." });
  res.json({ ok: true });
});

router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.rpc("paddock_home", { p_user: user(req).id });
    if (error) return paddockUnavailable(res);
    res.json({ meetings: ((data ?? []) as Meeting[]).map(withLive), maxPeople: PADDOCK_MAX_PEOPLE });
  }),
);

router.post(
  "/",
  createLimit,
  asyncRoute(async (req, res) => {
    let fields: MeetingFields;
    try {
      fields = meetingInput(req.body ?? {}, false);
      await checkLinks(fields, user(req).id);
    } catch (error) {
      if (error instanceof InputError) return res.status(400).json({ error: error.message });
      return paddockUnavailable(res);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const { error } = await supabase
        .from("paddock_meetings")
        .insert({ ...fields, code, host_id: user(req).id })
        .select("id")
        .single();
      if (error && (error as { code?: string }).code === "23505") continue;
      if (error) return paddockUnavailable(res);
      const { meeting, error: loadError } = await loadMeeting(code, user(req).id);
      if (loadError || !meeting) return paddockUnavailable(res);
      // A scheduled meeting tells the people invited to it.
      if (meeting.scheduledFor && fields.invitee_ids?.length)
        await alertPeople("invited", meeting, { id: user(req).id, name: user(req).displayName }, fields.invitee_ids).catch(() => undefined);
      return res.status(201).json({ meeting: withLive(meeting) });
    }
    paddockUnavailable(res);
  }),
);

router.use("/:code", (req, res, next) => (isCode(req.params.code) ? next() : notFound(res)));

router.get(
  "/:code",
  asyncRoute(async (req, res) => {
    const { meeting, error } = await loadMeeting(req.params.code, user(req).id);
    if (error) return paddockUnavailable(res);
    if (!meeting) return notFound(res);
    res.json({
      meeting: withLive(meeting),
      canJoin: !meeting.removed && joinsDirectly(meeting, user(req).id),
      maxPeople: PADDOCK_MAX_PEOPLE,
    });
  }),
);

router.patch(
  "/:code",
  asyncRoute(async (req, res) => {
    const { meeting, error } = await loadMeeting(req.params.code, user(req).id);
    if (error) return paddockUnavailable(res);
    if (!meeting) return notFound(res);
    if (meeting.role !== "host") return res.status(403).json({ error: "Only the host can change this meeting." });
    let fields: MeetingFields;
    try {
      fields = meetingInput(req.body ?? {}, true);
      await checkLinks(fields, user(req).id);
    } catch (reason) {
      if (reason instanceof InputError) return res.status(400).json({ error: reason.message });
      return paddockUnavailable(res);
    }
    const { error: saveError } = await supabase
      .from("paddock_meetings")
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq("id", meeting.id);
    if (saveError) return paddockUnavailable(res);
    const fresh = await loadMeeting(meeting.code, user(req).id);
    if (fresh.error || !fresh.meeting) return paddockUnavailable(res);
    live.updateRoom(roomInfo(fresh.meeting));
    // Newly invited people hear about a scheduled meeting.
    const before = new Set((meeting.invitees ?? []).map((p) => p.id));
    const added = (fields.invitee_ids ?? []).filter((id) => !before.has(id));
    if (fresh.meeting.scheduledFor && added.length)
      await alertPeople("invited", fresh.meeting, { id: user(req).id, name: user(req).displayName }, added).catch(() => undefined);
    res.json({ meeting: withLive(fresh.meeting) });
  }),
);

router.delete(
  "/:code",
  asyncRoute(async (req, res) => {
    const { meeting, error } = await loadMeeting(req.params.code, user(req).id);
    if (error) return paddockUnavailable(res);
    if (!meeting) return notFound(res);
    if (meeting.role !== "host") return res.status(403).json({ error: "Only the host can delete this meeting." });
    const { error: deleteError } = await supabase.from("paddock_meetings").delete().eq("id", meeting.id);
    if (deleteError) return paddockUnavailable(res);
    live.endRoom(meeting.id);
    res.json({ ok: true });
  }),
);

/** Join straight in (when allowed). The answer is this browser's seat for the in-call routes. */
router.post(
  "/:code/join",
  asyncRoute(async (req, res) => {
    const peerId = req.body?.peerId;
    const replaces = isPeerId(req.body?.replaces) ? req.body.replaces : undefined;
    if (!isPeerId(peerId)) return res.status(400).json({ error: "Refresh the page and try joining again." });
    const me = user(req);
    const { meeting, error } = await loadMeeting(req.params.code, me.id);
    if (error) return paddockUnavailable(res);
    if (!meeting) return notFound(res);
    if (meeting.removed) return res.status(403).json({ code: "removed", error: joinErrors.removed[1] });
    if (!joinsDirectly(meeting, me.id))
      return res.status(403).json({ code: "ask", error: "Ask to join, and the host will let you in." });
    const wasEmpty = live.liveSummary(meeting.id).count === 0;
    const room = live.openRoom(roomInfo(meeting));
    const result = live.join(room, { peerId, accountId: me.id, guestId: null, name: me.displayName, replaces, state: req.body?.state });
    if (!result.ok) {
      const [status, message] = joinErrors[result.code];
      return res.status(status).json({ code: result.code, error: message });
    }
    const { data: recorded, error: recordError } = await supabase.rpc("paddock_joined", {
      p_meeting: meeting.id,
      p_user: me.id,
    });
    if (recordError || recorded === false) {
      live.leave(result.seat);
      return recordError
        ? paddockUnavailable(res)
        : res.status(403).json({ code: "removed", error: joinErrors.removed[1] });
    }
    // A host opening a scheduled meeting lets the invited people know (not again on quick re-joins).
    const lastLive = meeting.lastLiveAt ? Date.parse(meeting.lastLiveAt) : 0;
    if (wasEmpty && meeting.scheduledFor && (result.role === "host" || result.role === "cohost") && Date.now() - lastLive > 30 * 60_000) {
      const named = await namedPeople(meeting.id);
      if (named) {
        const here = live.accountsIn(meeting.id);
        const ids = [...named.invitees, ...named.cohosts, named.hostId].filter((id) => !here.has(id));
        await alertPeople("started", meeting, { id: me.id, name: me.displayName }, ids).catch(() => undefined);
      }
    }
    const ice = await iceServers();
    res.json({ seat: result.seat, peerId: result.peerId, role: result.role, ...ice, maxPeople: PADDOCK_MAX_PEOPLE });
  }),
);

/**
 * Ring people: everyone named on the meeting who isn't in the call (or just `ids`). Hosts and
 * co-hosts can ring; invited people can too once they're in the call (a group call).
 */
router.post(
  "/:code/ring",
  ringLimit,
  asyncRoute(async (req, res) => {
    const me = user(req);
    const { meeting, error } = await loadMeeting(req.params.code, me.id);
    if (error) return paddockUnavailable(res);
    if (!meeting) return notFound(res);
    const here = live.accountsIn(meeting.id);
    const manages = meeting.role === "host" || meeting.role === "cohost";
    if (!manages && !(["invited", "team"].includes(meeting.role) && here.has(me.id)))
      return res.status(403).json({ error: "Only the host can ring people for this meeting." });
    const named = await namedPeople(meeting.id);
    if (!named) return paddockUnavailable(res);
    const allowedIds = new Set([...named.invitees, ...named.cohosts, named.hostId]);
    const asked = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).filter((id): id is string => typeof id === "string") : null;
    if (asked && asked.length > 20) return res.status(400).json({ error: "Ring up to 20 people at a time." });
    const ids = (asked ?? [...allowedIds])
      .map((id) => id.toLowerCase())
      .filter((id) => allowedIds.has(id) && !here.has(id) && id !== me.id && !alerts.ringing(id, meeting.id));
    const video = req.body?.video !== false;
    const rang = await alertPeople("ring", meeting, { id: me.id, name: me.displayName }, ids, video);
    res.json({ rang });
  }),
);

/** Add Stayblz members to the meeting (they join straight in) and, by default, ring them. Hosts and co-hosts. */
router.post(
  "/:code/invite",
  ringLimit,
  asyncRoute(async (req, res) => {
    const me = user(req);
    const { meeting, error } = await loadMeeting(req.params.code, me.id);
    if (error) return paddockUnavailable(res);
    if (!meeting) return notFound(res);
    if (meeting.role !== "host" && meeting.role !== "cohost")
      return res.status(403).json({ error: "Only the host and co-hosts can add people." });
    let fields: MeetingFields;
    try {
      fields = meetingInput({ inviteeIds: req.body?.ids }, true);
      await checkLinks(fields, me.id);
    } catch (reason) {
      if (reason instanceof InputError) return res.status(400).json({ error: reason.message });
      return paddockUnavailable(res);
    }
    const adding = fields.invitee_ids ?? [];
    if (!adding.length) return res.status(400).json({ error: "Choose people to add." });
    const named = await namedPeople(meeting.id);
    if (!named) return paddockUnavailable(res);
    const invitee_ids = [...new Set([...named.invitees, ...adding])].filter((id) => id !== named.hostId);
    if (invitee_ids.length > 50) return res.status(400).json({ error: "A meeting can have up to 50 invited people." });
    const { error: saveError } = await supabase
      .from("paddock_meetings")
      .update({ invitee_ids, updated_at: new Date().toISOString() })
      .eq("id", meeting.id);
    if (saveError) return paddockUnavailable(res);
    const here = live.accountsIn(meeting.id);
    const fresh = adding.filter((id) => !here.has(id));
    const ring = req.body?.ring !== false && live.liveSummary(meeting.id).count > 0;
    const alerted = await alertPeople(ring ? "ring" : "invited", meeting, { id: me.id, name: me.displayName }, fresh, req.body?.video !== false);
    res.json({ added: adding.length, rang: ring ? alerted : [], invited: ring ? [] : alerted });
  }),
);

/** Ask to join (no direct access). Check the answer at /api/paddock/live/knock/:id. */
router.post(
  "/:code/knock",
  knockLimit,
  asyncRoute(async (req, res) => {
    const me = user(req);
    const { meeting, error } = await loadMeeting(req.params.code, me.id);
    if (error) return paddockUnavailable(res);
    if (!meeting) return notFound(res);
    if (meeting.removed) return res.status(403).json({ code: "removed", error: joinErrors.removed[1] });
    if (joinsDirectly(meeting, me.id)) return res.status(409).json({ code: "direct", error: "You can join this meeting directly." });
    const result = live.knock(live.openRoom(roomInfo(meeting)), { accountId: me.id, guestId: null, name: me.displayName });
    if (!result.ok) return knockError(res, result.code);
    res.status(201).json({ knock: { id: result.id, token: result.token } });
  }),
);

export function knockError(res: Response, code: "busy" | "locked" | "removed" | "guests_off") {
  const answers = {
    busy: [429, "Lots of people are waiting to join. Try again in a minute."],
    locked: [403, "The host locked this meeting, so nobody new can join right now."],
    removed: [403, "The host removed you from this meeting, so you can't join again."],
    guests_off: [403, "This meeting doesn't take guests. Sign in to Stayblz to ask to join."],
  } as const;
  const [status, message] = answers[code];
  return res.status(status).json({ code, error: message });
}

export default router;
