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
      supabase
        .from("racing_follows")
        .select("id", { count: "exact", head: true })
        .eq("user_id", id),
    ]);
    if (results.some((r) => r.error)) return unavailable(res);
    res.json({
      // Earlier flat-record follows + follows on the linked racing data.
      following: (results[0].count ?? 0) + (results[3].count ?? 0),
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
/** Racing alerts reach the bell, on-screen cards and (with notifications on) devices; email isn't sent yet. */
const delivery = { deliveryAvailable: true, emailAvailable: false };
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
    // No saved choice = racing alerts on (SQL racing_alert_wanted), email off.
    res.json({
      preferences: Object.fromEntries(
        keys.map((k) => [k, values ? values[k] === true : k !== "email_enabled"]),
      ),
      ...delivery,
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
    res.json({ preferences, ...delivery });
  }),
);

// ----- Following on the linked racing data (horses, people, a horse's family) -----
// Rows: racing_follows (202611190004_racing_follows.sql). Alerts are sent by lib/racingAlerts.ts.
const followKinds = ["horse", "family", "person"] as const;
const followFailures: Record<string, [number, string]> = {
  unknown_target: [404, "That horse or person isn't on Stayblz racing pages yet."],
  too_many_follows: [409, "You can follow up to 300 horses, people and families. Unfollow some first."],
  invalid_kind: [400, "Choose a horse, a family or a person to follow."],
};
router.get(
  "/follows",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.rpc("racing_follows_list", { p_user: userId(req) });
    if (error) return res.status(503).json({ error: "Your follows are temporarily unavailable. Please try again." });
    res.set("Cache-Control", "no-store");
    res.json({ follows: Array.isArray(data) ? data : [] });
  }),
);
router.get(
  "/follows/state",
  asyncRoute(async (req, res) => {
    const id = req.query.id;
    if (!isUuid(id)) return res.status(400).json({ error: "Choose a horse or person." });
    const { data, error } = await supabase.rpc("racing_follow_state", { p_user: userId(req), p_target: id });
    if (error) return res.status(503).json({ error: "Follow status is temporarily unavailable." });
    res.set("Cache-Control", "no-store");
    res.json({ state: data });
  }),
);
router.post(
  "/follows",
  asyncRoute(async (req, res) => {
    const { kind, id, on } = req.body ?? {};
    if (!followKinds.includes(kind) || !isUuid(id) || typeof on !== "boolean")
      return res.status(400).json({ error: "Choose a horse, a family or a person to follow." });
    const { data, error } = await supabase.rpc("racing_follow_set", { p_user: userId(req), p_kind: kind, p_target: id, p_on: on });
    if (error) {
      const message = String(error.message ?? "");
      const known = Object.keys(followFailures).find((key) => message.includes(key));
      if (known) return res.status(followFailures[known][0]).json({ error: followFailures[known][1] });
      return res.status(503).json({ error: "Your follow could not be saved. Please try again." });
    }
    res.json({ state: data });
  }),
);
export default router;
