import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import {
  requireStable,
  requireStableManager,
  isUuid,
} from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import {
  scope,
  text,
  horseInput,
  trackingInput,
  inventoryRecord,
  trackerRecord,
  postRecord,
} from "../lib/workspace";
export const memberInventory = Router(),
  memberHorses = Router(),
  memberFeed = Router();
for (const router of [memberInventory, memberHorses, memberFeed])
  router.use(requireAuth, requireStable);
const unavailable = (res: any) =>
  res
    .status(503)
    .json({ error: "Stable records are unavailable. Please try again." });
const validId = (req: any, res: any, next: any) =>
  isUuid(req.params.id)
    ? next()
    : res.status(404).json({ error: "Record not found." });

memberInventory.get(
  "/",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("member_horses")
      .select("id,inventory")
      .eq("stable_id", scope(req).stable.id)
      .order("created_at");
    if (error) return unavailable(res);
    res.json({ items: (data ?? []).map(inventoryRecord) });
  }),
);
memberInventory.get(
  "/:id",
  validId,
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("member_horses")
      .select("id,inventory")
      .eq("stable_id", scope(req).stable.id)
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data) return res.status(404).json({ error: "Record not found." });
    res.json({ item: inventoryRecord(data) });
  }),
);
memberInventory.post(
  "/",
  requireStableManager,
  asyncRoute(async (req, res) => {
    let inventory;
    try {
      inventory = horseInput(req.body ?? {});
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a horse name and valid horse details." });
    }
    const { stable, user } = scope(req);
    const { data, error } = await supabase
      .from("member_horses")
      .insert({
        stable_id: stable.id,
        created_by: user.id,
        inventory,
        tracking: trackingInput({}),
      })
      .select("id,inventory")
      .single();
    if (error) return unavailable(res);
    res.status(201).json({ item: inventoryRecord(data) });
  }),
);
memberInventory.patch(
  "/:id",
  validId,
  requireStableManager,
  asyncRoute(async (req, res) => {
    let inventory;
    try {
      inventory = horseInput(req.body ?? {});
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a horse name and valid horse details." });
    }
    const { data, error } = await supabase
      .from("member_horses")
      .update({ inventory })
      .eq("stable_id", scope(req).stable.id)
      .eq("id", req.params.id)
      .select("id,inventory")
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data) return res.status(404).json({ error: "Record not found." });
    res.json({ item: inventoryRecord(data) });
  }),
);
memberHorses.get(
  "/",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("member_horses")
      .select("id,inventory,tracking")
      .eq("stable_id", scope(req).stable.id)
      .order("created_at");
    if (error) return unavailable(res);
    res.json({ horses: (data ?? []).map(trackerRecord) });
  }),
);
memberHorses.get(
  "/:id",
  validId,
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("member_horses")
      .select("id,inventory,tracking")
      .eq("stable_id", scope(req).stable.id)
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data) return res.status(404).json({ error: "Horse not found." });
    res.json({ horse: trackerRecord(data) });
  }),
);
memberHorses.patch(
  "/:id",
  validId,
  requireStableManager,
  asyncRoute(async (req, res) => {
    let tracking;
    try {
      tracking = trackingInput(req.body ?? {});
    } catch {
      return res
        .status(400)
        .json({
          error:
            "Enter valid tracking details and a condition between 0 and 100.",
        });
    }
    const { data, error } = await supabase
      .from("member_horses")
      .update({ tracking })
      .eq("stable_id", scope(req).stable.id)
      .eq("id", req.params.id)
      .select("id,inventory,tracking")
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data) return res.status(404).json({ error: "Horse not found." });
    res.json({ horse: trackerRecord(data) });
  }),
);
memberFeed.get(
  "/",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("member_posts")
      .select("id,author,role,body,created_at")
      .eq("stable_id", scope(req).stable.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return unavailable(res);
    res.json({ posts: (data ?? []).map(postRecord) });
  }),
);
memberFeed.post(
  "/",
  asyncRoute(async (req, res) => {
    let body;
    try {
      body = text(req.body?.body, 500);
    } catch {
      return res
        .status(400)
        .json({ error: "Write an update of 1–500 characters." });
    }
    const { stable, user } = scope(req);
    const { data, error } = await supabase
      .from("member_posts")
      .insert({
        stable_id: stable.id,
        author_id: user.id,
        author: user.displayName,
        role: stable.role,
        body,
      })
      .select("id,author,role,body,created_at")
      .single();
    if (error) return unavailable(res);
    res.status(201).json({ post: postRecord(data) });
  }),
);
