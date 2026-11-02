import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { publicRecord } from "./publicRacing";
const router = Router();
router.use(requireAuth);
const kinds = ["horses", "jockeys", "trainers"] as const;
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const kind = req.query.kind ?? "horses";
    if (
      typeof kind !== "string" ||
      !kinds.includes(kind as (typeof kinds)[number])
    )
      return res
        .status(400)
        .json({ error: "Choose horses, jockeys or trainers." });
    const [saved, published] = await Promise.all([
      supabase
        .from("member_watchlist")
        .select("record_id,name")
        .eq("user_id", user.id)
        .eq("kind", kind)
        .order("created_at", { ascending: false }),
      supabase
        .from("site_racing_records")
        .select("id,payload")
        .eq("kind", kind)
        .eq("publication_status", "published")
        .lte("published_at", new Date().toISOString())
        .order("sort_order")
        .limit(500),
    ]);
    if (saved.error || published.error)
      return res
        .status(503)
        .json({ error: "Your virtual stable is unavailable." });
    const watched = new Map(
      (saved.data ?? []).map((r) => [r.record_id, r.name]),
    );
    const records = new Map<string, any>();
    for (const row of published.data ?? []) {
      const record = publicRecord(row, kind as (typeof kinds)[number]);
      if (record)
        records.set(row.id, {
          id: row.id,
          kind,
          name: record.name,
          watched: watched.has(row.id),
          lastActivity: record.detail ?? "Published racing record",
          nextAlert: null,
        });
    }
    for (const [id, name] of watched)
      if (!records.has(id))
        records.set(id, {
          id,
          kind,
          name,
          watched: true,
          lastActivity: "Saved follow · no current public details available",
          nextAlert: null,
        });
    res.json({ stable: [...records.values()] });
  }),
);
router.post(
  "/toggle",
  asyncRoute(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const { id, watched } = req.body ?? {};
    if (user.passwordSetupRequired)
      return res
        .status(403)
        .json({ error: "Complete your password setup first." });
    if (!isUuid(id) || typeof watched !== "boolean")
      return res
        .status(400)
        .json({ error: "Choose a horse and whether to watch it." });
    if (!watched) {
      const { error } = await supabase
        .from("member_watchlist")
        .delete()
        .eq("user_id", user.id)
        .eq("record_id", id);
      if (error)
        return res
          .status(503)
          .json({ error: "Watch preference could not be saved." });
      return res.json({ id, watched: false });
    }
    const { data, error } = await supabase
      .from("site_racing_records")
      .select("id,payload,kind")
      .eq("id", id)
      .in("kind", [...kinds])
      .eq("publication_status", "published")
      .lte("published_at", new Date().toISOString())
      .maybeSingle();
    if (error)
      return res.status(503).json({ error: "Horse record is unavailable." });
    const record =
      data && kinds.includes(data.kind) && publicRecord(data, data.kind);
    if (!record)
      return res.status(404).json({ error: "Published horse not found." });
    const saved = await supabase
      .from("member_watchlist")
      .upsert(
        {
          user_id: user.id,
          record_id: id,
          name: record.name,
          kind: data!.kind,
        },
        { onConflict: "user_id,record_id" },
      );
    if (saved.error)
      return res
        .status(503)
        .json({ error: "Watch preference could not be saved." });
    res.json({ id, watched: true });
  }),
);
export default router;
