import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { tvSettings } from "../lib/tv";

/**
 * STAYBLZ TV (signed-in only). Two steps on purpose:
 *  - GET /status   what is on: live, upcoming or off air. Never includes the stream address.
 *  - GET /playback the stream address, only while live.
 * The paywall will check access in /playback only, so the page can always say what's on
 * while the stream itself stays behind the check. Settings: see lib/tv.ts.
 */
const router = Router();
router.use(requireAuth);

router.get("/status", (_req, res) => {
  const { state, title, startsAt } = tvSettings();
  res.json({ state, title, startsAt });
});

router.get("/playback", (_req, res) => {
  const { state, title, streamUrl } = tvSettings();
  // Access checks (subscription / entitlement) go here, before the address is handed out.
  if (state !== "live" || !streamUrl) {
    res.status(409).json({ code: "off_air", error: "Nothing is on air right now." });
    return;
  }
  res.json({ url: streamUrl, title });
});

export default router;
