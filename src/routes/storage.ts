import { Router } from "express";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { r2Storage } from "../lib/r2Storage";

/**
 * R2 storage status for admins (mounted at /api/admin/storage). There is deliberately no generic
 * upload here: each feature (horse photos, documents...) adds its own upload route that checks who
 * may add or see that file first. See docs/r2-storage.md.
 *
 *  GET  /        what is set up (no keys or secrets)
 *  GET  /check   connection check that reads and changes nothing
 *  POST /check   also writes, reads back and deletes one tiny file under stayblz/_checks/
 */
const router = Router();
router.use(requireAuth, requireRole("admin"));
const checkLimit = authLimit("storage-check", 10, 60_000, (req) => (req as AuthenticatedRequest).user.id);

router.get("/", (_req, res) => {
  res.json({ storage: r2Storage.status() });
});

router.get(
  "/check",
  checkLimit,
  asyncRoute(async (_req, res) => {
    res.json({ storage: await r2Storage.check() });
  }),
);

router.post(
  "/check",
  checkLimit,
  asyncRoute(async (req, res) => {
    const report = await r2Storage.check({ write: true });
    console.info(`[storage] write check by ${(req as AuthenticatedRequest).user.id}: ${report.ok ? "ok" : "failed"}`);
    res.json({ storage: report });
  }),
);

export default router;
