import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { text } from "../lib/workspace";
import { touch } from "../lib/presence";
import { chatError, chatRoutes, loadThread } from "./chat";
import chatPeople from "./chatPeople";
import chatFolders from "./chatFolders";
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if ((req as AuthenticatedRequest).user.passwordSetupRequired) {
    res
      .status(403)
      .json({ error: "Complete password setup before using messages." });
    return;
  }
  next();
});
const user = (req: any) => (req as AuthenticatedRequest).user;
const unavailable = (res: any) =>
  res
    .status(503)
    .json({ error: "Messages are temporarily unavailable. Please try again." });

// Starting chats by email can reveal whether an address has an account, so keep it slow.
const DIRECT_LIMIT = 15;
const DIRECT_WINDOW_MS = 10 * 60 * 1000;
const directAttempts = new Map<string, number[]>();
function directAllowed(id: string) {
  const now = Date.now();
  const recent = (directAttempts.get(id) ?? []).filter((t) => now - t < DIRECT_WINDOW_MS);
  if (recent.length >= DIRECT_LIMIT) {
    directAttempts.set(id, recent);
    return false;
  }
  recent.push(now);
  directAttempts.set(id, recent);
  if (directAttempts.size > 5000) directAttempts.delete(directAttempts.keys().next().value!);
  return true;
}

/** Menu badge: unread personal chats, message requests, and unread team chats. */
router.get(
  "/unread",
  asyncRoute(async (req, res) => {
    touch(user(req).id);
    // This poll also marks new messages as "Delivered" to this person (writes only when something is new).
    await supabase.rpc("chat_mark_delivered", { p_user: user(req).id });
    const { data, error } = await supabase.rpc("chat_unread", { p_user: user(req).id });
    if (error) return unavailable(res);
    res.set("Cache-Control", "no-store");
    res.json(data);
  }),
);

/** Start (or reopen) a one-to-one chat with the account that uses this email. */
router.post(
  "/direct",
  asyncRoute(async (req, res) => {
    let email;
    try {
      email = text(req.body?.email, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error();
    } catch {
      return res.status(400).json({ error: "Enter the person’s account email." });
    }
    const identity = user(req);
    if (!directAllowed(identity.id))
      return res.status(429).json({
        error: "You’ve started a lot of chats. Wait a few minutes and try again.",
        retryAfterSeconds: 600,
      });
    const { data, error } = await supabase.rpc("chat_start_direct", {
      p_user: identity.id,
      p_display: identity.displayName,
      p_email: email,
    });
    if (error) {
      if (error.message?.includes("no_account"))
        return res.status(404).json({
          code: "no_account",
          error: "No Stayblz account uses that email. Check the spelling, or start a group and send them an invite link.",
        });
      if (error.message?.includes("self"))
        return res.status(400).json({ error: "That’s your own email. Enter someone else’s." });
      return unavailable(res);
    }
    const thread = await loadThread(req, "personal", data);
    if (thread.error) return chatError(res, thread.error);
    res.status(201).json(thread.data);
  }),
);

/** New group chat (people join with an invite link). */
router.post(
  "/",
  asyncRoute(async (req, res) => {
    let title;
    try {
      title = text(req.body?.title, 120);
    } catch {
      return res.status(400).json({ error: "Enter a group name." });
    }
    const identity = user(req);
    const { data, error } = await supabase
      .from("personal_conversations")
      .insert({
        title,
        created_by: identity.id,
        member_ids: [identity.id],
        member_names: { [identity.id]: identity.displayName },
      })
      .select("id")
      .single();
    if (error) return unavailable(res);
    const thread = await loadThread(req, "personal", data.id);
    if (thread.error) return chatError(res, thread.error);
    res.status(201).json(thread.data);
  }),
);
router.post(
  "/accept-invitation",
  asyncRoute(async (req, res) => {
    const identity = user(req),
      token = req.body?.token;
    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !identity.email
    )
      return res
        .status(400)
        .json({ error: "This invitation cannot be accepted." });
    const { data, error } = await supabase.rpc("accept_personal_invitation", {
      p_user: identity.id,
      p_email: identity.email.toLowerCase(),
      p_display: identity.displayName,
      p_hash: createHash("sha256").update(token).digest("hex"),
    });
    if (error) {
      if (error.message?.includes("invalid_invitation"))
        return res
          .status(400)
          .json({
            error:
              "This invitation is expired, used, revoked, or addressed to another email.",
          });
      if (error.message?.includes("conversation_full"))
        return res
          .status(409)
          .json({
            error: "This conversation has reached its participant limit.",
          });
      return unavailable(res);
    }
    res.json({ conversationId: data });
  }),
);
router.use("/:id/invitations", (req, res, next) => {
  if (!isUuid(req.params.id)) {
    res.status(404).json({ error: "Conversation not found." });
    return;
  }
  void supabase
    .from("personal_conversations")
    .select("id")
    .eq("id", req.params.id)
    .eq("created_by", user(req).id)
    .maybeSingle()
    .then(({ data, error }) => {
      if (error) unavailable(res);
      else if (!data)
        res.status(404).json({ error: "Conversation not found." });
      else next();
    }, next);
});
router.get(
  "/:id/invitations",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("personal_invitations")
      .select("id,email,expires_at")
      .eq("conversation_id", req.params.id)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    if (error) return unavailable(res);
    res.json({ invitations: data ?? [] });
  }),
);
router.post(
  "/:id/invitations",
  asyncRoute(async (req, res) => {
    let email;
    try {
      email = text(req.body?.email, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error();
    } catch {
      return res
        .status(400)
        .json({ error: "Enter the recipient’s account email." });
    }
    const token = randomBytes(32).toString("hex");
    const { data, error } = await supabase
      .from("personal_invitations")
      .insert({
        conversation_id: req.params.id,
        email,
        invited_by: user(req).id,
        token_hash: createHash("sha256").update(token).digest("hex"),
      })
      .select("id,email,expires_at")
      .single();
    if (error) return unavailable(res);
    res.status(201).json({ invitation: data, token });
  }),
);
router.post(
  "/:id/invitations/:invitation/revoke",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.invitation))
      return res.status(404).json({ error: "Invitation not found." });
    const { error } = await supabase
      .from("personal_invitations")
      .delete()
      .eq("id", req.params.invitation)
      .eq("conversation_id", req.params.id)
      .is("accepted_at", null);
    if (error) return unavailable(res);
    res.json({ ok: true });
  }),
);
router.post(
  "/:id/accept",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id))
      return res.status(404).json({ error: "Conversation not found." });
    const { error } = await supabase.rpc("chat_accept", {
      p_user: user(req).id,
      p_conversation: req.params.id,
    });
    if (error) return chatError(res, error);
    res.json({ ok: true });
  }),
);
router.use("/people", chatPeople);
router.use("/folders", chatFolders);
router.use(chatRoutes("personal"));
export default router;
