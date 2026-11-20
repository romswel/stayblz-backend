import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { findGifs } from "../lib/gifs";

/** GIF search for Stayblz Chat (signed in): GET /api/gifs?q=&offset=  → { enabled, results, next }. */
const router = Router();
router.use(requireAuth);

// 60 searches a minute each is plenty for typing in the picker (GIPHY's own limits are per key).
const recent = new Map<string, number[]>();
function allowed(id: string) {
  const now = Date.now();
  const list = (recent.get(id) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 60) return false;
  list.push(now);
  recent.set(id, list);
  if (recent.size > 5000) recent.delete(recent.keys().next().value as string);
  return true;
}

router.get(
  "/",
  asyncRoute(async (req, res) => {
    const me = (req as AuthenticatedRequest).user.id;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const offset = typeof req.query.offset === "string" && /^\d{1,3}$/.test(req.query.offset) ? Number(req.query.offset) : 0;
    if (!allowed(me)) return res.status(429).json({ error: "That's a lot of searches. Wait a moment.", retryAfterSeconds: 60 });
    try {
      res.set("Cache-Control", "private, max-age=300");
      res.json(await findGifs(q, offset));
    } catch {
      res.status(503).json({ error: "GIFs aren't loading right now. Try again in a moment." });
    }
  }),
);

export default router;
