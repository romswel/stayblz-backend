import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { featureAccess } from "../lib/billing/engine";
import { tvSettings, youtubeEmbed } from "../lib/tv";
import { CHANNEL_ID, youtubeChannels } from "../lib/youtubeFeed";
import { youtubeBroadcasts, youtubeStatus } from "../lib/youtubeLive";

/**
 * STAYBLZ TV (signed-in only).
 *  - GET /status            what is on: live, upcoming or off air, plus every track channel live on
 *                           YouTube right now (latest start first), the next scheduled one and the latest
 *                           finished broadcast. Never includes the featured stream's address.
 *  - GET /playback          the featured broadcast (our own stream, TV_ON_AIR) while live. Behind the
 *                           STAYBLZ TV Pass when paywalls are on.
 *  - GET /playback?channel= a track's live YouTube stream. Free for every member: YouTube's terms don't
 *                           allow charging for access to YouTube videos.
 *  - GET /youtube           past broadcasts and replays from the track channels (lib/youtubeFeed.ts).
 * Settings: lib/tv.ts (featured broadcast), lib/youtubeLive.ts (YOUTUBE_API_KEY), lib/tvChannels.ts.
 */
const router = Router();
router.use(requireAuth);

const earliest = (...times: (string | null)[]) => times.filter((t): t is string => !!t).sort()[0] ?? null;

// access: whether this person may watch the featured broadcast (always true while paywalls are off).
router.get(
  "/status",
  asyncRoute(async (req, res) => {
    const featured = tvSettings();
    const [access, yt] = await Promise.all([featureAccess((req as AuthenticatedRequest).user, "tv.watch"), youtubeStatus()]);
    const featuredLive = featured.state === "live";
    const state = featuredLive || yt.live.length ? "live" : featured.state === "upcoming" || yt.upcoming ? "upcoming" : "off_air";
    // The featured broadcast's own "next" time wins over a track's when it is sooner.
    const startsAt = state === "upcoming" ? earliest(featured.startsAt, yt.upcoming?.startsAt ?? null) : null;
    const title =
      state === "live"
        ? featuredLive
          ? featured.title
          : yt.live[0].title
        : state === "upcoming"
          ? startsAt === featured.startsAt
            ? featured.title
            : yt.upcoming?.title ?? null
          : null;
    res.json({
      state,
      title,
      startsAt,
      access: { allowed: access.allowed, reason: access.reason, plan: "tv_monthly" },
      featured: featuredLive,
      // Track streams are free, so their video ids may be listed (for thumbnails); the featured stream's address never is.
      live: yt.live.map(({ channelId, channelName, track, videoId, title, startedAt, viewers }) => ({ channelId, channelName, track, videoId, title, startedAt, viewers })),
      upcoming: yt.upcoming && { channelId: yt.upcoming.channelId, channelName: yt.upcoming.channelName, title: yt.upcoming.title, startsAt: yt.upcoming.startsAt },
      latest: yt.latest,
    });
  }),
);

router.get(
  "/playback",
  asyncRoute(async (req, res) => {
    const channel = req.query.channel;
    if (channel !== undefined) {
      if (typeof channel !== "string" || !CHANNEL_ID.test(channel) || !youtubeChannels().includes(channel)) {
        res.status(404).json({ code: "unknown_channel", error: "That channel isn't on STAYBLZ TV." });
        return;
      }
      const now = (await youtubeStatus()).live.find((l) => l.channelId === channel);
      if (!now) {
        res.status(409).json({ code: "off_air", error: "This track isn't live right now." });
        return;
      }
      res.json({
        url: youtubeEmbed(`https://www.youtube.com/watch?v=${now.videoId}`),
        title: now.title,
        kind: "embed",
        embeddable: now.embeddable,
        watchUrl: `https://www.youtube.com/watch?v=${now.videoId}`,
      });
      return;
    }
    const { state, title, streamUrl, kind } = tvSettings();
    // The featured stream is only handed out to people with the STAYBLZ TV Pass (when paywalls are on).
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
  const { failed, channels, videos } = await youtubeBroadcasts();
  if (failed) {
    res.status(502).json({ error: "YouTube replays couldn't be loaded right now." });
    return;
  }
  res.json({ channels, videos });
});

export default router;
