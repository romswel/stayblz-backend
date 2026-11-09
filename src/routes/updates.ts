import { Router } from "express";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { UPDATE_KINDS, updateStore, type UpdateKind } from "../lib/updates";

/** Public Updates feed. Signed-in accounts also see members-only posts. */
const router = Router();
router.use(optionalAuth);

router.get(
  "/",
  asyncRoute(async (req, res) => {
    const members = !!(req as Partial<AuthenticatedRequest>).user;
    const kind = typeof req.query.kind === "string" && req.query.kind ? req.query.kind : null;
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const before = typeof req.query.before === "string" && req.query.before ? req.query.before : null;
    const limit = Number(req.query.limit ?? 12);
    if (
      (kind && !UPDATE_KINDS.includes(kind as UpdateKind)) ||
      (before && Number.isNaN(Date.parse(before))) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 30
    ) {
      res.status(400).json({ error: "Those filters aren't valid." });
      return;
    }
    try {
      const feed = await updateStore.list({
        members,
        kind,
        query: query || null,
        before: before ? new Date(before).toISOString() : null,
        limit,
      });
      res.json({ ...feed, signedIn: members });
    } catch {
      res.status(503).json({ error: "Updates are unavailable right now. Try again shortly." });
    }
  }),
);

router.get(
  "/:slug",
  asyncRoute(async (req, res) => {
    const slug = String(req.params.slug);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
      res.status(404).json({ error: "That update was not found." });
      return;
    }
    const members = !!(req as Partial<AuthenticatedRequest>).user;
    try {
      const found = await updateStore.get(slug, members);
      if (!found) {
        res.status(404).json({
          code: members ? "not_found" : "not_found_or_members",
          error: "That update was not found.",
        });
        return;
      }
      res.json(found);
    } catch {
      res.status(503).json({ error: "Updates are unavailable right now. Try again shortly." });
    }
  }),
);

export default router;
