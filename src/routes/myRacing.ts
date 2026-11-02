import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { text } from "../lib/workspace";
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (
    req.method !== "GET" &&
    (req as AuthenticatedRequest).user.passwordSetupRequired
  ) {
    res
      .status(403)
      .json({
        error: "Complete password setup before saving your racing information.",
      });
    return;
  }
  next();
});
const userId = (req: any) => (req as AuthenticatedRequest).user.id;
const unavailable = (res: any) =>
  res
    .status(503)
    .json({
      error:
        "Your racing notebook is temporarily unavailable. Please try again.",
    });
router.get(
  "/summary",
  asyncRoute(async (req, res) => {
    const id = userId(req);
    const results = await Promise.all([
      supabase
        .from("member_watchlist")
        .select("record_id", { count: "exact", head: true })
        .eq("user_id", id),
      supabase
        .from("racing_notes")
        .select("id", { count: "exact", head: true })
        .eq("user_id", id),
      supabase
        .from("personal_conversations")
        .select("id", { count: "exact", head: true })
        .contains("member_ids", [id]),
    ]);
    if (results.some((r) => r.error)) return unavailable(res);
    res.json({
      following: results[0].count ?? 0,
      notes: results[1].count ?? 0,
      conversations: results[2].count ?? 0,
    });
  }),
);
router.get(
  "/notes",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("racing_notes")
      .select("id,title,body,updated_at")
      .eq("user_id", userId(req))
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) return unavailable(res);
    res.json({ notes: data ?? [] });
  }),
);
function noteInput(body: any) {
  if (typeof body?.body !== "string" || body.body.length > 4000)
    throw new Error("invalid_note");
  return { title: text(body?.title, 120), body: body.body };
}
router.post(
  "/notes",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = noteInput(req.body);
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a note title and up to 4,000 characters." });
    }
    const { data, error } = await supabase
      .from("racing_notes")
      .insert({ ...input, user_id: userId(req) })
      .select("id,title,body,updated_at")
      .single();
    if (error) return unavailable(res);
    res.status(201).json({ note: data });
  }),
);
router.patch(
  "/notes/:id",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id))
      return res.status(404).json({ error: "Note not found." });
    let input;
    try {
      input = noteInput(req.body);
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a note title and up to 4,000 characters." });
    }
    const { data, error } = await supabase
      .from("racing_notes")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("user_id", userId(req))
      .select("id,title,body,updated_at")
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data) return res.status(404).json({ error: "Note not found." });
    res.json({ note: data });
  }),
);
router.post(
  "/notes/:id/remove",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id))
      return res.status(404).json({ error: "Note not found." });
    const { data, error } = await supabase
      .from("racing_notes")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", userId(req))
      .select("id")
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data) return res.status(404).json({ error: "Note not found." });
    res.json({ ok: true });
  }),
);
const keys = [
  "entry_alerts",
  "workout_alerts",
  "result_alerts",
  "email_enabled",
] as const;
router.get(
  "/preferences",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("racing_preferences")
      .select(keys.join(","))
      .eq("user_id", userId(req))
      .maybeSingle();
    if (error) return unavailable(res);
    const values = data as unknown as Record<string, unknown> | null;
    res.json({
      preferences: Object.fromEntries(
        keys.map((k) => [k, values?.[k] === true]),
      ),
      deliveryAvailable: false,
    });
  }),
);
router.patch(
  "/preferences",
  asyncRoute(async (req, res) => {
    if (!keys.every((k) => typeof req.body?.[k] === "boolean"))
      return res.status(400).json({ error: "Choose valid alert preferences." });
    const preferences = Object.fromEntries(keys.map((k) => [k, req.body[k]]));
    const { error } = await supabase
      .from("racing_preferences")
      .upsert(
        {
          ...preferences,
          user_id: userId(req),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
    if (error) return unavailable(res);
    res.json({ preferences, deliveryAvailable: false });
  }),
);
export default router;
