import { Router, type Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { isUuid } from "../middleware/stable";
import { supabase } from "../lib/supabase";
import { isActive, presenceOf, presenceParam, seenAt, touch } from "../lib/presence";
import { chatError, loadThread } from "./chat";
import { notifyPerson } from "../lib/chatAlerts";
import { chatLimits } from "../lib/chatStorage";

/**
 * Stayblz Chat people: find members by name, friends + requests, blocking, and your chat privacy
 * (findable by name, show when you're active). Mounted at /api/messages/people (signed in).
 */
const router = Router();
const me = (req: any) => (req as AuthenticatedRequest).user;
router.use((req, _res, next) => {
  touch(me(req).id, presenceParam(req.query.presence));
  next();
});

// Friend requests and new chats can be used to pester people, so keep them slow: 30 per 10 minutes each.
const attempts = new Map<string, number[]>();
function allowed(id: string) {
  const now = Date.now();
  const recent = (attempts.get(id) ?? []).filter((t) => now - t < 10 * 60_000);
  if (recent.length >= 30) return false;
  recent.push(now);
  attempts.set(id, recent);
  if (attempts.size > 5000) attempts.delete(attempts.keys().next().value!);
  return true;
}
const slowDown = (res: Response) =>
  res.status(429).json({ error: "That's a lot of requests. Wait a few minutes and try again.", retryAfterSeconds: 600 });

const PEOPLE_ERRORS: Record<string, [number, string]> = {
  invalid_query: [400, "Type at least 2 letters of a name."],
  invalid_person: [404, "That person isn't available."],
  blocked: [403, "You can't connect with this person."],
  no_account: [404, "That person isn't available."],
  self: [400, "That's you."],
  not_found: [404, "That request is no longer there."],
};
function fail(res: Response, error: { message?: string } | null) {
  for (const [code, [status, message]] of Object.entries(PEOPLE_ERRORS))
    if (error?.message?.includes(code)) return res.status(status).json({ error: message, code });
  return res.status(503).json({ error: "People are unavailable right now. Try again shortly." });
}

/** Adds Online / Away / Offline only for people who share it, and only if you share yours. */
async function withActive<T extends { id: string }>(viewer: string, people: T[]) {
  if (!people.length) return people;
  const { data } = await supabase
    .from("chat_profiles")
    .select("user_id")
    .in("user_id", [...people.map((p) => p.id), viewer])
    .eq("show_active", false);
  const off = new Set((data ?? []).map((r: any) => r.user_id));
  return people.map((p) => {
    const shown = !off.has(viewer) && !off.has(p.id);
    return { ...p, presence: shown ? presenceOf(p.id) : null, active: shown && isActive(p.id), seenAt: shown ? seenAt(p.id) : null };
  });
}

const CONTACT_CHATS = 300;
const nameOf = (a: { first_name?: string | null; last_name?: string | null }) =>
  `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Stayblz member";

/**
 * Everyone you're connected with in Stayblz Chat: your friends, plus the people in your one-to-one and group chats
 * (not message requests you haven't accepted, not anyone blocked either way, not closed accounts). Friends first;
 * each person comes with Online / Away / Offline (when both of you share it), how many chats you share and when
 * one of them last had a message.
 */
async function contactsOf(me: string) {
  const [friendsRes, chatsRes, mineRes, theirsRes] = await Promise.all([
    supabase.rpc("chat_friends", { p_user: me }),
    supabase
      .from("personal_conversations")
      .select("id,member_ids,requested_ids,last_message_at")
      .contains("member_ids", [me])
      .order("last_message_at", { ascending: false })
      .limit(CONTACT_CHATS),
    supabase.from("chat_blocks").select("blocked_id").eq("user_id", me),
    supabase.from("chat_blocks").select("user_id").eq("blocked_id", me),
  ]);
  if (friendsRes.error || chatsRes.error || mineRes.error || theirsRes.error)
    throw friendsRes.error ?? chatsRes.error ?? mineRes.error ?? theirsRes.error;
  const blocked = new Set<string>([
    ...(mineRes.data ?? []).map((b: any) => b.blocked_id as string),
    ...(theirsRes.data ?? []).map((b: any) => b.user_id as string),
  ]);
  const shared = new Map<string, { chats: number; lastAt: string | null }>();
  for (const c of (chatsRes.data ?? []) as { member_ids: string[]; requested_ids: string[] | null; last_message_at: string | null }[]) {
    const pending = new Set(c.requested_ids ?? []);
    if (pending.has(me)) continue; // a request to you that you haven't accepted
    for (const id of c.member_ids ?? []) {
      if (id === me || pending.has(id) || blocked.has(id)) continue;
      const s = shared.get(id) ?? { chats: 0, lastAt: null };
      s.chats++;
      if (c.last_message_at && (!s.lastAt || c.last_message_at > s.lastAt)) s.lastAt = c.last_message_at;
      shared.set(id, s);
    }
  }
  const friendRows: any[] = [
    ...(friendsRes.data?.friends ?? []),
    ...(friendsRes.data?.incoming ?? []),
    ...(friendsRes.data?.outgoing ?? []),
  ];
  const friendStatus = new Map<string, any>(friendRows.map((p) => [p.id, p]));
  const ids = [...new Set([...shared.keys(), ...(friendsRes.data?.friends ?? []).map((p: any) => p.id)])].filter((id) => !blocked.has(id));
  if (!ids.length) return [];
  const { data: accounts, error } = await supabase
    .from("accounts")
    .select("id,first_name,last_name,racing_role,status")
    .in("id", ids)
    .eq("status", "active");
  if (error) throw error;
  const people = (accounts ?? []).map((a: any) => {
    const f = friendStatus.get(a.id);
    const s = shared.get(a.id);
    return {
      id: a.id as string,
      name: nameOf(a),
      role: a.racing_role ?? undefined,
      status: (f?.status ?? "none") as string,
      sharedChats: s?.chats ?? 0,
      lastAt: s?.lastAt ?? null,
    };
  });
  const rank = { online: 0, away: 1, offline: 2 } as Record<string, number>;
  return (await withActive(me, people)).sort(
    (a: any, b: any) =>
      Number(b.status === "friends") - Number(a.status === "friends") ||
      (rank[a.presence ?? "offline"] ?? 2) - (rank[b.presence ?? "offline"] ?? 2) ||
      String(b.lastAt ?? "").localeCompare(String(a.lastAt ?? "")) ||
      a.name.localeCompare(b.name),
  );
}

router.get(
  "/contacts",
  asyncRoute(async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      res.json({ people: await contactsOf(me(req).id) });
    } catch {
      res.status(503).json({ error: "People are unavailable right now. Try again shortly." });
    }
  }),
);

router.get(
  "/search",
  asyncRoute(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const { data, error } = await supabase.rpc("chat_people_search", { p_user: me(req).id, p_query: q });
    if (error) return fail(res, error);
    res.json({ people: await withActive(me(req).id, data ?? []) });
  }),
);

router.get(
  "/friends",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.rpc("chat_friends", { p_user: me(req).id });
    if (error) return fail(res, error);
    res.json({ ...data, friends: await withActive(me(req).id, data?.friends ?? []) });
  }),
);

const friendAction = (action: "request" | "accept" | "decline" | "remove") =>
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.person)) return res.status(404).json({ error: "That person isn't available." });
    const user = me(req).id;
    if (action === "request" && !allowed(user)) return slowDown(res);
    const call =
      action === "request"
        ? supabase.rpc("chat_friend_request", { p_user: user, p_other: req.params.person })
        : action === "remove"
          ? supabase.rpc("chat_friend_remove", { p_user: user, p_other: req.params.person })
          : supabase.rpc("chat_friend_respond", { p_user: user, p_other: req.params.person, p_accept: action === "accept" });
    const { data, error } = await call;
    if (error) return fail(res, error);
    res.json({ status: data });
    // "X wants to be friends" for a new request; "X accepted" when this made you friends.
    if (action === "request" && data === "outgoing") void notifyPerson(user, req.params.person, "friend_request");
    else if ((action === "request" || action === "accept") && data === "friends") void notifyPerson(user, req.params.person, "friend_accepted");
  });
router.post("/friends/:person/request", friendAction("request"));
router.post("/friends/:person/accept", friendAction("accept"));
router.post("/friends/:person/decline", friendAction("decline"));
router.post("/friends/:person/remove", friendAction("remove"));

router.get(
  "/blocks",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.rpc("chat_blocks_list", { p_user: me(req).id });
    if (error) return fail(res, error);
    res.json({ blocked: data ?? [] });
  }),
);
router.post(
  "/blocks/:person",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.person)) return res.status(404).json({ error: "That person isn't available." });
    if (typeof req.body?.block !== "boolean") return res.status(400).json({ error: "Choose block or unblock." });
    const { data, error } = await supabase.rpc("chat_block_set", {
      p_user: me(req).id,
      p_other: req.params.person,
      p_block: req.body.block,
    });
    if (error) return fail(res, error);
    res.json({ blocked: data });
  }),
);

router.get(
  "/profile",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.rpc("chat_profile_get", { p_user: me(req).id });
    if (error) return fail(res, error);
    // The real file limits right now: 4 MB / 50 MB on Supabase Storage, 25 MB / 500 MB when R2 is set up.
    res.json({ profile: data, limits: chatLimits() });
  }),
);
router.post(
  "/profile",
  asyncRoute(async (req, res) => {
    const { discoverable, showActive } = req.body ?? {};
    if ((discoverable !== undefined && typeof discoverable !== "boolean") || (showActive !== undefined && typeof showActive !== "boolean"))
      return res.status(400).json({ error: "Those settings couldn't be saved." });
    const { data, error } = await supabase.rpc("chat_profile_set", {
      p_user: me(req).id,
      p_discoverable: discoverable ?? null,
      p_show_active: showActive ?? null,
    });
    if (error) return fail(res, error);
    res.json({ profile: data });
  }),
);

/** Start (or reopen) a one-to-one chat with someone found in People. */
router.post(
  "/:person/chat",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.person)) return res.status(404).json({ error: "That person isn't available." });
    if (!allowed(me(req).id)) return slowDown(res);
    const { data, error } = await supabase.rpc("chat_start_direct_user", {
      p_user: me(req).id,
      p_display: me(req).displayName,
      p_other: req.params.person,
    });
    if (error) return fail(res, error);
    const thread = await loadThread(req, "personal", data);
    if (thread.error) return chatError(res, thread.error);
    res.status(201).json(thread.data);
  }),
);

export default router;
