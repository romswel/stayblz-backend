import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { text, messageRecord, messageCursor } from "../lib/workspace";
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
const preview = (row: any, id: string) => ({
  id: row.id,
  title: row.title,
  participants: row.member_ids.map(
    (i: string) => row.member_names[i] ?? "Participant",
  ),
  lastMessage: row.last_message,
  lastMessageAt: row.last_message_at,
  unread: 0,
  canInvite: row.created_by === id,
});
const unavailable = (res: any) =>
  res
    .status(503)
    .json({ error: "Messages are temporarily unavailable. Please try again." });
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("personal_conversations")
      .select("*")
      .contains("member_ids", [user(req).id])
      .order("last_message_at", { ascending: false })
      .limit(100);
    if (error) return unavailable(res);
    res.json({
      conversations: (data ?? []).map((r) => preview(r, user(req).id)),
    });
  }),
);
router.post(
  "/",
  asyncRoute(async (req, res) => {
    let title;
    try {
      title = text(req.body?.title, 120);
    } catch {
      return res.status(400).json({ error: "Enter a conversation title." });
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
      .select("*")
      .single();
    if (error) return unavailable(res);
    res
      .status(201)
      .json({ conversation: { ...preview(data, identity.id), messages: [] } });
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
router.get(
  "/:id",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id))
      return res.status(404).json({ error: "Conversation not found." });
    const { data, error } = await supabase
      .from("personal_conversations")
      .select("*")
      .eq("id", req.params.id)
      .contains("member_ids", [user(req).id])
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data)
      return res.status(404).json({ error: "Conversation not found." });
    const before = req.query.before;
    const cursor = messageCursor(before);
    if (before !== undefined && !cursor)
      return res.status(400).json({ error: "Invalid history request." });
    let query = supabase
      .from("personal_messages")
      .select("*")
      .eq("conversation_id", data.id)
      .order("sent_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(101);
    if (cursor)
      query = query.or(
        `sent_at.lt.${cursor.time},and(sent_at.eq.${cursor.time},id.lt.${cursor.id})`,
      );
    const response = await query;
    if (response.error) return unavailable(res);
    const page = (response.data ?? []).slice(0, 100);
    const last = page[page.length - 1];
    res.json({
      conversation: {
        ...preview(data, user(req).id),
        messages: page.reverse().map((r) => messageRecord(r, user(req).id)),
      },
      before:
        (response.data ?? []).length > 100
          ? `${last.sent_at}|${last.id}`
          : null,
    });
  }),
);
router.post(
  "/:id/messages",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id))
      return res.status(404).json({ error: "Conversation not found." });
    let body;
    try {
      body = text(req.body?.body, 4000);
      if (!isUuid(req.body?.clientId)) throw Error();
    } catch {
      return res
        .status(400)
        .json({ error: "Use 1–4,000 characters and try again." });
    }
    const identity = user(req);
    const { data, error } = await supabase.rpc("send_personal_message", {
      p_user: identity.id,
      p_conversation: req.params.id,
      p_display: identity.displayName,
      p_body: body,
      p_client: req.body.clientId,
    });
    if (error) {
      if (error.message?.includes("not_a_participant"))
        return res.status(404).json({ error: "Conversation not found." });
      return res
        .status(503)
        .json({
          error: "Message could not be saved. Your draft has been kept.",
        });
    }
    res.status(201).json({ message: messageRecord(data, identity.id) });
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
export default router;
