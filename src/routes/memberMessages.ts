import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireStable, isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { scope, text, participantIds, messageRecord, messageCursor } from "../lib/workspace";
const router = Router();
router.use(requireAuth, requireStable);
const preview = (r: any, names: Map<string, string>) => ({
  id: r.id,
  title: r.title,
  participants: r.member_ids.map(
    (id: string) => names.get(id) ?? "Former teammate",
  ),
  lastMessage: r.last_message,
  lastMessageAt: r.last_message_at,
  unread: 0,
});
async function memberNames(stableId: string) {
  const { data, error } = await supabase
    .from("stable_memberships")
    .select("user_id,display_name")
    .eq("stable_id", stableId);
  if (error) throw error;
  return new Map<string, string>(
    (data ?? []).map((r) => [r.user_id, r.display_name]),
  );
}
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { stable, user } = scope(req);
    const { data, error } = await supabase
      .from("member_conversations")
      .select("*")
      .eq("stable_id", stable.id)
      .contains("member_ids", [user.id])
      .order("last_message_at", { ascending: false })
      .limit(100);
    if (error)
      return res.status(503).json({ error: "Messages are unavailable." });
    const names = await memberNames(stable.id);
    res.json({ conversations: (data ?? []).map((r) => preview(r, names)) });
  }),
);
router.post(
  "/",
  asyncRoute(async (req, res) => {
    let title, members;
    try {
      title = text(req.body?.title, 120);
      members = participantIds(req.body?.memberIds ?? []);
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a title and select up to 29 teammates." });
    }
    const { stable, user } = scope(req);
    const { data, error } = await supabase.rpc("create_member_conversation", {
      p_user: user.id,
      p_stable: stable.id,
      p_title: title,
      p_members: members,
    });
    if (error) {
      if (error.message?.includes("invalid_participants"))
        return res
          .status(400)
          .json({ error: "Every participant must belong to this stable." });
      return res
        .status(503)
        .json({ error: "Conversation could not be created." });
    }
    const names = await memberNames(stable.id);
    res
      .status(201)
      .json({ conversation: { ...preview(data, names), messages: [] } });
  }),
);
router.get(
  "/:id",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id))
      return res.status(404).json({ error: "Conversation not found." });
    const { stable, user } = scope(req);
    const { data, error } = await supabase
      .from("member_conversations")
      .select("*")
      .eq("id", req.params.id)
      .eq("stable_id", stable.id)
      .contains("member_ids", [user.id])
      .maybeSingle();
    if (error)
      return res.status(503).json({ error: "Messages are unavailable." });
    if (!data)
      return res.status(404).json({ error: "Conversation not found." });
    const before = req.query.before;
    const cursorInput = messageCursor(before);
    if (before !== undefined && !cursorInput)
      return res.status(400).json({ error: "Invalid message cursor." });
    let query = supabase
      .from("member_messages")
      .select("*")
      .eq("conversation_id", data.id)
      .order("sent_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(101);
    if (cursorInput)
      query = query.or(
        `sent_at.lt.${cursorInput.time},and(sent_at.eq.${cursorInput.time},id.lt.${cursorInput.id})`,
      );
    const response = await query;
    if (response.error)
      return res.status(503).json({ error: "Messages are unavailable." });
    const page = (response.data ?? []).slice(0, 100);
    const names = await memberNames(stable.id);
    const cursor = page.length
      ? `${page[page.length - 1].sent_at}|${page[page.length - 1].id}`
      : null;
    res.json({
      conversation: {
        ...preview(data, names),
        messages: page.reverse().map((r) => messageRecord(r, user.id)),
      },
      before: (response.data ?? []).length > 100 ? cursor : null,
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
        .json({
          error:
            "Your message could not be sent. Use 1–4000 characters and try again.",
        });
    }
    const { stable, user } = scope(req);
    const { data, error } = await supabase.rpc("send_member_message", {
      p_user: user.id,
      p_stable: stable.id,
      p_conversation: req.params.id,
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
    res.status(201).json({ message: messageRecord(data, user.id) });
  }),
);
export default router;
