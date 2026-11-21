import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { featureAccess } from "../lib/billing/engine";
import { tvSettings } from "../lib/tv";
import { youtubeReplays } from "../lib/youtubeFeed";

/**
 * STAYBLZ TV (signed-in only). Two steps on purpose:
 *  - GET /status   what is on: live, upcoming or off air. Never includes the stream address.
 *  - GET /playback the stream address, only while live.
 *  - GET /youtube  past broadcasts from the configured YouTube channels (demo; see lib/youtubeFeed.ts).
 * The paywall will check access in /playback only, so the page can always say what's on
 * while the stream itself stays behind the check. Settings: see lib/tv.ts.
 */
const router = Router();
router.use(requireAuth);

// access: whether this person may watch (always true while paywalls are off; see Billing settings).
router.get(
  "/status",
  asyncRoute(async (req, res) => {
    const { state, title, startsAt } = tvSettings();
    const access = await featureAccess((req as AuthenticatedRequest).user, "tv.watch");
    res.json({ state, title, startsAt, access: { allowed: access.allowed, reason: access.reason, plan: "tv_monthly" } });
  }),
);

router.get(
  "/playback",
  asyncRoute(async (req, res) => {
    const { state, title, streamUrl, kind } = tvSettings();
    // The stream address is only handed out to people with the STAYBLZ TV Pass (when paywalls are on).
    const access = await featureAccess((req as AuthenticatedRequest).user, "tv.watch");
    if (!access.allowed) {
      res.status(402).json({ code: "subscription_required", plan: "tv_monthly", error: "Live races need the STAYBLZ TV Pass." });
      return;
    }
    if (state !== "live" || !streamUrl) {
      res.status(409).json({ code: "off_air", error: "Nothing is on air right now." });
      return;
    }
    res.json({ url: streamUrl, title, kind });
  }),
);

router.get("/youtube", async (_req, res) => {
  const { failed, channels, videos } = await youtubeReplays();
  if (failed) {
    res.status(502).json({ error: "YouTube replays couldn't be loaded right now." });
    return;
  }
  res.json({ channels, videos });
});

export default router;
