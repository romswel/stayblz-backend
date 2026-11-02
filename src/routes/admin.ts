import { Router } from "express";
import { requireAuth, requireWorkspaceAdmin } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
const router = Router();
router.use(requireAuth, requireWorkspaceAdmin);
// Directory metadata only. Private conversations still require participation.
router.get(
  "/stables",
  asyncRoute(async (_req, res) => {
    const { data, error } = await supabase
      .from("member_stables")
      .select("id,name,created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error)
      return res
        .status(503)
        .json({ error: "The stable directory is unavailable." });
    res.json({ stables: data ?? [] });
  }),
);
export default router;
