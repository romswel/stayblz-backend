import { TV_CHANNELS, tvChannel, type Breed } from "./tvChannels";

/**
 * STAYBLZ TV — broadcasts and replays from racetrack YouTube channels.
 *
 *   Channels              The official track channels in lib/tvChannels.ts, plus any extra ids in
 *                         TV_YOUTUBE_CHANNELS (comma-separated UC… ids). TV_YOUTUBE_DEFAULTS=off drops
 *                         the built-in list (tests use this). With neither, the channel of a channel-live
 *                         TV_EMBED_URL is used. Nothing at all = no YouTube replays.
 *
 * Source: each channel's public RSS feed (https://www.youtube.com/feeds/videos.xml?channel_id=…), which
 * needs no key and lists the channel's latest 15 videos (scheduled and running livestreams included).
 * Feeds are cached for 10 minutes; if YouTube can't be reached, the last good copy (up to a day old) is
 * served instead. Live state, length and "was this a livestream" come from the YouTube Data API when a
 * key is set (lib/youtubeLive.ts).
 *
 * Race data is read only from what the channel writes, e.g. Los Alamitos's
 * "8 Races starting at 5:10 PM. The G2 Las Damas highlights the program." Horse-by-horse results are
 * not in the feed (they are Equibase data and need a licence).
 */

export interface YouTubeChannel {
  id: string;
  name: string;
  url: string;
  /** From lib/tvChannels.ts; null for channels only listed in TV_YOUTUBE_CHANNELS. */
  track: string | null;
  breed: Breed | null;
  /** Streams live racing on YouTube (can show up under Live). */
  streamsCards: boolean;
}

export type VideoKind = "card" | "race" | "preview" | "video";

export interface YouTubeVideo {
  id: string;
  channelId: string;
  /** The title as the channel wrote it. */
  title: string;
  /** "card" = a race-card broadcast, "race" = one race's replay, "preview" = a preview/handicapping show, else "video". */
  kind: VideoKind;
  /** Short heading for cards, e.g. "Sunday night card"; the title otherwise. */
  heading: string;
  /** When YouTube published it (ISO). */
  publishedAt: string;
  /** Race day as YYYY-MM-DD when the title names one ("Sunday, November 15", "11/23/2026"), else null. */
  raceDay: string | null;
  races: number | null;
  /** First post time as written, normalised to "5:10 PM". */
  firstPost: string | null;
  /** The rest of a card's description, e.g. "The G2 Las Damas highlights the program." */
  highlight: string | null;
  description: string;
  views: number | null;
  /** Filled in from the YouTube Data API when a key is set; null when unknown. */
  durationSec: number | null;
  wasLive: boolean | null;
  /** "live" / "upcoming" while that is the case, else null. */
  liveState: "live" | "upcoming" | null;
}

export const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const FEED_FRESH_MS = 10 * 60_000;
const STALE_MS = 24 * 60 * 60_000;
const MAX_BYTES = 2_000_000;
/** Feeds fetched at once, so a page load doesn't fire 20+ requests at YouTube together. */
const PARALLEL = 5;

export function youtubeChannels(env: NodeJS.ProcessEnv = process.env): string[] {
  const defaults = env.TV_YOUTUBE_DEFAULTS?.trim().toLowerCase() === "off" ? [] : TV_CHANNELS.map((c) => c.id);
  const listed = (env.TV_YOUTUBE_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => CHANNEL_ID.test(s));
  const all = [...new Set([...defaults, ...listed])];
  if (all.length) return all;
  const live = /youtube\.com\/(?:channel\/(UC[A-Za-z0-9_-]{22})\/live|embed\/live_stream\?(?:.*&)?channel=(UC[A-Za-z0-9_-]{22}))/.exec(
    env.TV_EMBED_URL ?? "",
  );
  const id = live?.[1] ?? live?.[2];
  return id ? [id] : [];
}

/* ---------- Feed parsing ---------- */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function text(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const tag = (xml: string, name: string) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = "(january|february|march|april|may|june|july|august|september|october|november|december)";
/** "Sunday, November 15", "September 9th, 2026", "November 22, 2026" */
const NAMED_RE = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "i");
/** "2026 November 21" */
const YEAR_FIRST_RE = new RegExp(`\\b(\\d{4})\\s+${MONTH}\\s+(\\d{1,2})\\b`, "i");
/** "11/23/2026", "9-19-2026", "11-18-26" */
const NUMERIC_RE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/;

function isoDay(year: number, month: number, date: number): string | null {
  const d = new Date(Date.UTC(year, month, date));
  return d.getUTCMonth() === month && d.getUTCDate() === date ? d.toISOString().slice(0, 10) : null;
}

/**
 * The race day a title names, as YYYY-MM-DD. Without a year it is the one the video was published in
 * (a December race published in January belongs to the year before).
 */
export function raceDayOf(title: string, publishedAt: string): string | null {
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return null;
  const guessYear = (month: number) => published.getUTCFullYear() - (month > published.getUTCMonth() + 1 ? 1 : 0);
  let m = YEAR_FIRST_RE.exec(title);
  if (m) return isoDay(Number(m[1]), MONTHS.indexOf(m[2].toLowerCase()), Number(m[3]));
  m = NAMED_RE.exec(title);
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    return isoDay(m[3] ? Number(m[3]) : guessYear(month), month, Number(m[2]));
  }
  m = NUMERIC_RE.exec(title);
  if (m) {
    const month = Number(m[1]) - 1;
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return month >= 0 && month < 12 ? isoDay(year, month, Number(m[2])) : null;
  }
  return null;
}

export const weekdayOf = (day: string) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];

const CARD_RE = /^(\d{1,2})\s+races?\s+starting\s+at\s+(\d{1,2}:\d{2})\s*([ap])\.?\s*m\.?\s*[.!]?\s*([\s\S]*)$/i;
/** Looser reads for other channels' wording: "10-race card", "first post 1:10 PM", "post time is 12:45 p.m." */
const RACES_RE = /\b(\d{1,2})[\s-]+races?\b/i;
const POST_RE = /\b(?:first post|post time|starting at|starts at)\s*(?:is\s*)?(?:at\s*)?(\d{1,2}:\d{2})\s*([ap])\.?\s*m\b/i;
/** Titles that mean a broadcast of the races (when the Data API can't say it was a long livestream). */
const BROADCAST_RE = /full\s*card|live\s*stream|\blive racing\b|day at the races|\blive\s+[-–|]|second delay/i;
const RACE_RE = /\brace\s*#?\s*\d{1,2}\b|\bR\d{1,2}\b/i;
const PREVIEW_RE = /preview|handicapping/i;
/** Long livestreams that aren't racing: horse sales, post-position draws, press conferences. */
const NOT_RACING_RE = /\bsales?\b|\bdraw\b|press conference|interview|podcast/i;

/** Sets kind and the fields that follow from it. `wasLongLive` = the Data API says it was a livestream of an hour or more. */
export function classify(v: YouTubeVideo, wasLongLive = false): YouTubeVideo {
  const desc = oneLine(v.description);
  const strict = CARD_RE.exec(desc);
  const preview = PREVIEW_RE.test(v.title);
  const isCard = !preview && !NOT_RACING_RE.test(v.title) && (wasLongLive || BROADCAST_RE.test(v.title) || !!strict);
  const kind: VideoKind = isCard ? "card" : preview ? "preview" : RACE_RE.test(v.title) ? "race" : "video";
  const night = /night/i.test(v.title) ? "night card" : "race card";
  // Race count, first post and highlight only describe a card.
  const card = isCard ? strict : null;
  const races = card ? Number(card[1]) : isCard ? Number(RACES_RE.exec(desc)?.[1] ?? NaN) : NaN;
  const post = card ? [card[2], card[3]] : isCard ? POST_RE.exec(desc)?.slice(1, 3) : undefined;
  return {
    ...v,
    kind,
    heading: kind === "card" && v.raceDay ? `${weekdayOf(v.raceDay)} ${night}` : kind === "preview" ? "Preview show" : v.title,
    races: Number.isFinite(races) && races > 0 ? races : null,
    firstPost: post ? `${post[0]} ${post[1].toUpperCase()}M` : null,
    highlight: card ? oneLine(card[4]).slice(0, 300) || null : null,
  };
}

function channelOf(id: string, feedName: string): YouTubeChannel {
  const known = tvChannel(id);
  return {
    id,
    name: known?.name ?? feedName.slice(0, 120),
    url: `https://www.youtube.com/channel/${id}`,
    track: known?.track ?? null,
    breed: known?.breed ?? null,
    streamsCards: known?.streamsCards ?? false,
  };
}

export function parseFeed(xml: string): { channel: YouTubeChannel | null; videos: YouTubeVideo[] } {
  const head = xml.split("<entry>")[0];
  const channelRaw = text(tag(head, "yt:channelId")).trim();
  const channelId = channelRaw.startsWith("UC") ? channelRaw : `UC${channelRaw}`;
  const name = oneLine(text(tag(tag(head, "author") ?? "", "name") ?? tag(head, "title")));
  const channel = CHANNEL_ID.test(channelId) && name ? channelOf(channelId, name) : null;

  const videos: YouTubeVideo[] = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const id = text(tag(entry, "yt:videoId")).trim();
    if (!VIDEO_ID.test(id)) continue;
    const title = oneLine(text(tag(entry, "title"))).slice(0, 200);
    const publishedAt = new Date(text(tag(entry, "published")).trim());
    if (!title || Number.isNaN(publishedAt.getTime())) continue;
    const description = text(tag(entry, "media:description")).trim().slice(0, 2000);
    const viewsRaw = /<media:statistics\s+views="(\d+)"/.exec(entry)?.[1];
    videos.push(
      classify({
        id,
        channelId: channel?.id ?? channelId,
        title,
        kind: "video",
        heading: title,
        publishedAt: publishedAt.toISOString(),
        raceDay: raceDayOf(title, publishedAt.toISOString()),
        races: null,
        firstPost: null,
        highlight: null,
        description,
        views: viewsRaw ? Number(viewsRaw) : null,
        durationSec: null,
        wasLive: null,
        liveState: null,
      }),
    );
  }
  return { channel, videos };
}

/* ---------- Fetching with a small cache ---------- */

export type Feed = ReturnType<typeof parseFeed> & { channel: YouTubeChannel };
const cache = new Map<string, { at: number; feed: Feed }>();

/** For tests. */
export function clearYouTubeCache() {
  cache.clear();
}

async function fetchFeed(channelId: string): Promise<Feed> {
  const response = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
    signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/atom+xml, application/xml;q=0.9" },
  });
  if (!response.ok) throw new Error(`YouTube feed ${response.status}`);
  const body = await response.text();
  if (body.length > MAX_BYTES) throw new Error("YouTube feed too large");
  const parsed = parseFeed(body);
  if (!parsed.channel || parsed.channel.id !== channelId) throw new Error("Unexpected YouTube feed");
  return parsed as Feed;
}

async function feedFor(channelId: string, now: number, freshMs: number): Promise<Feed | null> {
  const hit = cache.get(channelId);
  if (hit && now - hit.at < freshMs) return hit.feed;
  try {
    const feed = await fetchFeed(channelId);
    cache.set(channelId, { at: now, feed });
    return feed;
  } catch {
    return hit && now - hit.at < STALE_MS ? hit.feed : null;
  }
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the order. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/**
 * Every channel's feed (null where it couldn't be loaded). `freshMs(channel id)` can ask for a
 * fresher copy than the 10-minute default, e.g. for live checks.
 */
export async function channelFeeds(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  freshMs: (channelId: string) => number = () => FEED_FRESH_MS,
): Promise<{ ids: string[]; feeds: (Feed | null)[] }> {
  const ids = youtubeChannels(env);
  return { ids, feeds: await mapLimit(ids, PARALLEL, (id) => feedFor(id, now, freshMs(id))) };
}

/** Channels that loaded and their videos (newest first); `failed` is true when none could be loaded. */
export async function youtubeReplays(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const { ids, feeds } = await channelFeeds(env, now);
  const ok = feeds.filter((f): f is Feed => !!f);
  return {
    failed: ids.length > 0 && ok.length === 0,
    channels: ok.map((f) => f.channel),
    videos: ok.flatMap((f) => f.videos).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
  };
}
