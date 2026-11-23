import { tvChannel } from "./tvChannels";
import {
  FEED_FRESH_MS,
  VIDEO_ID,
  channelFeeds,
  classify,
  youtubeReplays,
  type Feed,
  type YouTubeVideo,
} from "./youtubeFeed";

/**
 * STAYBLZ TV — which track channels are live right now, what's coming up, and the latest finished
 * broadcast, from the YouTube Data API.
 *
 *   YOUTUBE_API_KEY   A YouTube Data API v3 key (Google Cloud → APIs & Services → Credentials; restrict
 *                     it to "YouTube Data API v3"). Without it nothing here calls YouTube, Live falls back
 *                     to the manual TV_ON_AIR switch (lib/tv.ts) and replays still come from RSS.
 *
 * How: each channel's RSS feed (free) lists its newest videos, running and scheduled livestreams
 * included. The newest few ids of every channel go to `videos.list` (1 quota unit per 50 ids), which
 * says live / upcoming / ended, viewers, length and whether the video may be embedded.
 * Finished videos never change, so their details are kept for a day; live and upcoming ones for
 * 2 minutes. With ~20 channels that is well under 1,000 of the 10,000 free daily units.
 */

const API = "https://www.googleapis.com/youtube/v3/videos";
const FIELDS =
  "items(id,snippet(channelId,title,liveBroadcastContent),liveStreamingDetails(actualStartTime,actualEndTime,scheduledStartTime,concurrentViewers),contentDetails(duration),status(embeddable))";
/** How old a streaming channel's feed may be during a live check (a new stream shows up within this). */
const LIVE_FEED_MS = 2 * 60_000;
const STATUS_MS = 2 * 60_000;
/** A status older than this isn't served while a new one loads (e.g. after the server sat idle). */
const STATUS_STALE_MS = 10 * 60_000;
const ACTIVE_MS = 2 * 60_000;
const DONE_MS = 24 * 60 * 60_000;
const PER_CHANNEL = 5;
const LONG_LIVE_SEC = 60 * 60;
/** On a cold start /status waits at most this long for YouTube before answering without it. */
const COLD_WAIT_MS = 4000;
/** An upcoming stream stays "next" for a while after its scheduled start, until the track goes live. */
const LATE_START_MS = 30 * 60_000;

export interface VideoDetails {
  id: string;
  channelId: string;
  title: string;
  liveState: "live" | "upcoming" | "none";
  /** The video is (or was) a livestream. */
  wasLive: boolean;
  startedAt: string | null;
  endedAt: string | null;
  scheduledAt: string | null;
  viewers: number | null;
  durationSec: number | null;
  embeddable: boolean;
}

export interface LiveNow {
  channelId: string;
  channelName: string;
  track: string | null;
  videoId: string;
  title: string;
  startedAt: string | null;
  viewers: number | null;
  embeddable: boolean;
}
export interface UpNext {
  channelId: string;
  channelName: string;
  videoId: string;
  title: string;
  startsAt: string;
}
export interface LatestBroadcast {
  channelId: string;
  channelName: string;
  videoId: string;
  title: string;
  endedAt: string;
}
export interface YouTubeStatus {
  live: LiveNow[];
  upcoming: UpNext | null;
  latest: LatestBroadcast | null;
}

const EMPTY: YouTubeStatus = { live: [], upcoming: null, latest: null };

export function youtubeKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env.YOUTUBE_API_KEY?.trim();
  return key && /^[A-Za-z0-9_-]{20,100}$/.test(key) ? key : null;
}

/** ISO 8601 duration ("PT1H2M3S", "P1DT2H") in seconds; null for "P0D" (still live) or nonsense. */
export function parseDuration(iso: unknown): number | null {
  const m = typeof iso === "string" ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso) : null;
  if (!m) return null;
  const sec = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
  return sec > 0 ? sec : null;
}

const isoOrNull = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** A `videos.list` response → details; anything malformed is dropped. */
export function parseVideos(json: unknown): VideoDetails[] {
  const items = obj(json).items;
  if (!Array.isArray(items)) return [];
  const out: VideoDetails[] = [];
  for (const raw of items) {
    const item = obj(raw);
    const snippet = obj(item.snippet);
    const id = item.id;
    const channelId = snippet.channelId;
    if (typeof id !== "string" || !VIDEO_ID.test(id) || typeof channelId !== "string") continue;
    const live = item.liveStreamingDetails ? obj(item.liveStreamingDetails) : null;
    const state = snippet.liveBroadcastContent;
    const viewers = Number(live?.concurrentViewers);
    out.push({
      id,
      channelId,
      title: typeof snippet.title === "string" ? snippet.title.replace(/\s+/g, " ").trim().slice(0, 200) : "",
      liveState: state === "live" || state === "upcoming" ? state : "none",
      wasLive: !!live,
      startedAt: isoOrNull(live?.actualStartTime),
      endedAt: isoOrNull(live?.actualEndTime),
      scheduledAt: isoOrNull(live?.scheduledStartTime),
      viewers: Number.isFinite(viewers) && viewers >= 0 ? viewers : null,
      durationSec: parseDuration(obj(item.contentDetails).duration),
      embeddable: obj(item.status).embeddable !== false,
    });
  }
  return out;
}

/* ---------- Video details with a cache ---------- */

const details = new Map<string, { at: number; d: VideoDetails | null }>();
let status: { at: number; value: YouTubeStatus } | null = null;
let loading: Promise<YouTubeStatus> | null = null;

/** For tests. */
export function clearLiveCache() {
  details.clear();
  status = null;
  loading = null;
}

async function videoDetails(ids: string[], key: string, now: number): Promise<Map<string, VideoDetails>> {
  const wanted = [...new Set(ids)];
  const need = wanted.filter((id) => {
    const hit = details.get(id);
    return !hit || now - hit.at >= (hit.d && hit.d.liveState !== "none" ? ACTIVE_MS : DONE_MS);
  });
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    try {
      const params = new URLSearchParams({ part: "snippet,liveStreamingDetails,contentDetails,status", id: batch.join(","), fields: FIELDS, key });
      const response = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`YouTube API ${response.status}`);
      const found = new Map(parseVideos(await response.json()).map((d) => [d.id, d]));
      // Ids YouTube doesn't return (private or deleted) are remembered as such, so they aren't asked for again.
      for (const id of batch) details.set(id, { at: now, d: found.get(id) ?? null });
    } catch {
      // Keep whatever we knew; the next check tries again.
    }
  }
  if (details.size > 5000) for (const [id, hit] of details) if (now - hit.at > 2 * DONE_MS) details.delete(id);
  const out = new Map<string, VideoDetails>();
  for (const id of wanted) {
    const d = details.get(id)?.d;
    if (d) out.set(id, d);
  }
  return out;
}

/** YYYY-MM-DD in Pacific time: every North American card (11 am Atlantic to 11 pm Pacific) falls on its own day. */
function pacificDay(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** A video with its Data API details folded in (kind re-checked: a long livestream is a race card). */
export function withDetails(v: YouTubeVideo, d: VideoDetails | undefined): YouTubeVideo {
  if (!d) return v;
  return classify(
    {
      ...v,
      durationSec: d.durationSec,
      wasLive: d.wasLive,
      liveState: d.liveState === "none" ? null : d.liveState,
      raceDay: v.raceDay ?? pacificDay(d.startedAt ?? d.scheduledAt),
    },
    d.wasLive && (d.durationSec ?? 0) >= LONG_LIVE_SEC,
  );
}

/** Racing, not a sale or a draw: anything classify() wouldn't file as a plain video if it ran long. */
const isRacing = (v: YouTubeVideo) => classify(v, true).kind !== "video";

async function computeStatus(env: NodeJS.ProcessEnv, key: string, now: number): Promise<YouTubeStatus> {
  const { feeds } = await channelFeeds(env, now, (id) => (tvChannel(id)?.streamsCards === false ? FEED_FRESH_MS : LIVE_FEED_MS));
  const ok = feeds.filter((f): f is Feed => !!f);
  const newest = new Map(ok.map((f) => [f, [...f.videos].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, PER_CHANNEL)]));
  const info = await videoDetails([...newest.values()].flat().map((v) => v.id), key, now);

  const live: LiveNow[] = [];
  const upcoming: UpNext[] = [];
  const ended: LatestBroadcast[] = [];
  for (const [feed, videos] of newest) {
    const channelName = feed.channel.name;
    let best: LiveNow | null = null;
    for (const v of videos) {
      const d = info.get(v.id);
      if (!d || d.channelId !== feed.channel.id || !isRacing({ ...v, title: d.title || v.title })) continue;
      const title = d.title || v.title;
      if (d.liveState === "live") {
        const entry = { channelId: feed.channel.id, channelName, track: feed.channel.track, videoId: d.id, title, startedAt: d.startedAt, viewers: d.viewers, embeddable: d.embeddable };
        // One stream per channel: the one with the most viewers.
        if (!best || (entry.viewers ?? -1) > (best.viewers ?? -1)) best = entry;
      } else if (d.liveState === "upcoming" && d.scheduledAt && Date.parse(d.scheduledAt) > now - LATE_START_MS) {
        upcoming.push({ channelId: feed.channel.id, channelName, videoId: d.id, title, startsAt: d.scheduledAt });
      } else if (d.wasLive && d.endedAt && (d.durationSec ?? 0) >= LONG_LIVE_SEC) {
        ended.push({ channelId: feed.channel.id, channelName, videoId: d.id, title, endedAt: d.endedAt });
      }
    }
    if (best) live.push(best);
  }
  // The stream that started most recently leads (it plays first under Live).
  live.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || (b.viewers ?? -1) - (a.viewers ?? -1));
  upcoming.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  ended.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  return { live, upcoming: upcoming[0] ?? null, latest: ended[0] ?? null };
}

/**
 * Live / upcoming / latest across all channels. Cached for 2 minutes; a stale copy is served while a
 * new one loads, and a cold start waits at most a few seconds, so /status always answers quickly.
 */
export async function youtubeStatus(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<YouTubeStatus> {
  const key = youtubeKey(env);
  if (!key) return EMPTY;
  if (status && now - status.at < STATUS_MS) return status.value;
  if (!loading)
    loading = computeStatus(env, key, now)
      .then((value) => {
        status = { at: now, value };
        return value;
      })
      .catch(() => status?.value ?? EMPTY)
      .finally(() => {
        loading = null;
      });
  if (status && now - status.at < STATUS_STALE_MS) return status.value;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<YouTubeStatus>((resolve) => {
    timer = setTimeout(() => resolve(status?.value ?? EMPTY), COLD_WAIT_MS);
  });
  try {
    return await Promise.race([loading, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The replay list for GET /api/tv/youtube: RSS videos with length and livestream details from the
 * Data API when a key is set. Streams that are live or still scheduled are left out (Live shows them).
 */
export async function youtubeBroadcasts(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const replays = await youtubeReplays(env, now);
  const key = youtubeKey(env);
  if (!key || replays.failed) return replays;
  const info = await videoDetails(replays.videos.map((v) => v.id), key, now);
  return {
    ...replays,
    videos: replays.videos.map((v) => withDetails(v, info.get(v.id))).filter((v) => v.liveState === null),
  };
}
