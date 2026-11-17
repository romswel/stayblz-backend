/**
 * STAYBLZ TV — past broadcasts from YouTube channels (demo until a stream provider is connected).
 *
 *   TV_YOUTUBE_CHANNELS   Comma-separated YouTube channel ids (UC…), at most 5. When empty, the channel
 *                         of a channel-live TV_EMBED_URL is used. Nothing set = no YouTube replays.
 *
 * Source: each channel's public RSS feed (https://www.youtube.com/feeds/videos.xml?channel_id=…), which
 * needs no key and lists the channel's latest 15 videos. Feeds are cached for 10 minutes; if YouTube
 * can't be reached, the last good copy (up to a day old) is served instead.
 *
 * Race data is read only from what the channel writes, e.g. Los Alamitos's
 * "8 Races starting at 5:10 PM. The G2 Las Damas highlights the program." Horse-by-horse results are
 * not in the feed (they are Equibase data and need a licence).
 */

export interface YouTubeChannel {
  id: string;
  name: string;
  url: string;
}

export interface YouTubeVideo {
  id: string;
  channelId: string;
  /** The title as the channel wrote it. */
  title: string;
  /** "card" = a full race-card broadcast, "preview" = a preview/handicapping show, else "video". */
  kind: "card" | "preview" | "video";
  /** Short heading for cards, e.g. "Sunday night card"; the title otherwise. */
  heading: string;
  /** When YouTube published it (ISO). */
  publishedAt: string;
  /** Race day as YYYY-MM-DD when the title names one ("Sunday, November 15"), else null. */
  raceDay: string | null;
  races: number | null;
  /** First post time as written, normalised to "5:10 PM". */
  firstPost: string | null;
  /** The rest of a card's description, e.g. "The G2 Las Damas highlights the program." */
  highlight: string | null;
  description: string;
  views: number | null;
}

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const FRESH_MS = 10 * 60_000;
const STALE_MS = 24 * 60 * 60_000;
const MAX_BYTES = 2_000_000;

export function youtubeChannels(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env.TV_YOUTUBE_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => CHANNEL_ID.test(s));
  if (listed.length) return [...new Set(listed)].slice(0, 5);
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
const DAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[,\s]+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i;

/** "Sunday, November 15" in a title published 2026-11-16 → "2026-11-15" (handles December races published in January). */
function raceDayOf(title: string, publishedAt: string): { day: string; weekday: string } | null {
  const m = DAY_RE.exec(title);
  const published = new Date(publishedAt);
  if (!m || Number.isNaN(published.getTime())) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  const date = Number(m[3]);
  let year = published.getUTCFullYear();
  if (month > published.getUTCMonth() + 1) year -= 1;
  const d = new Date(Date.UTC(year, month, date));
  if (d.getUTCMonth() !== month) return null;
  const weekday = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return { day: d.toISOString().slice(0, 10), weekday };
}

const CARD_RE = /^(\d{1,2})\s+races?\s+starting\s+at\s+(\d{1,2}:\d{2})\s*([ap])\.?\s*m\.?\s*[.!]?\s*([\s\S]*)$/i;

export function parseFeed(xml: string): { channel: YouTubeChannel | null; videos: YouTubeVideo[] } {
  const head = xml.split("<entry>")[0];
  const channelRaw = text(tag(head, "yt:channelId")).trim();
  const channelId = channelRaw.startsWith("UC") ? channelRaw : `UC${channelRaw}`;
  const name = oneLine(text(tag(tag(head, "author") ?? "", "name") ?? tag(head, "title")));
  const channel = CHANNEL_ID.test(channelId) && name
    ? { id: channelId, name: name.slice(0, 120), url: `https://www.youtube.com/channel/${channelId}` }
    : null;

  const videos: YouTubeVideo[] = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const id = text(tag(entry, "yt:videoId")).trim();
    if (!VIDEO_ID.test(id)) continue;
    const title = oneLine(text(tag(entry, "title"))).slice(0, 200);
    const publishedAt = new Date(text(tag(entry, "published")).trim());
    if (!title || Number.isNaN(publishedAt.getTime())) continue;
    const description = text(tag(entry, "media:description")).trim().slice(0, 2000);
    const viewsRaw = /<media:statistics\s+views="(\d+)"/.exec(entry)?.[1];

    const card = CARD_RE.exec(oneLine(description));
    const isCard = /full\s*card/i.test(title) || !!card;
    const kind: YouTubeVideo["kind"] = isCard ? "card" : /preview/i.test(title) ? "preview" : "video";
    const day = raceDayOf(title, publishedAt.toISOString());
    const night = /night/i.test(title) ? "night card" : "race card";
    videos.push({
      id,
      channelId: channel?.id ?? channelId,
      title,
      kind,
      heading: kind === "card" && day ? `${day.weekday} ${night}` : kind === "preview" ? "Preview show" : title,
      publishedAt: publishedAt.toISOString(),
      raceDay: day?.day ?? null,
      races: card ? Number(card[1]) : null,
      firstPost: card ? `${card[2]} ${card[3].toUpperCase()}M` : null,
      highlight: card ? oneLine(card[4]).slice(0, 300) || null : null,
      description,
      views: viewsRaw ? Number(viewsRaw) : null,
    });
  }
  return { channel, videos };
}

/* ---------- Fetching with a small cache ---------- */

type Feed = ReturnType<typeof parseFeed> & { channel: YouTubeChannel };
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

async function feedFor(channelId: string, now: number): Promise<Feed | null> {
  const hit = cache.get(channelId);
  if (hit && now - hit.at < FRESH_MS) return hit.feed;
  try {
    const feed = await fetchFeed(channelId);
    cache.set(channelId, { at: now, feed });
    return feed;
  } catch {
    return hit && now - hit.at < STALE_MS ? hit.feed : null;
  }
}

/** Channels that loaded and their videos (newest first); `failed` is true when none could be loaded. */
export async function youtubeReplays(env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const ids = youtubeChannels(env);
  const feeds = await Promise.all(ids.map((id) => feedFor(id, now)));
  const ok = feeds.filter((f): f is Feed => !!f);
  return {
    failed: ids.length > 0 && ok.length === 0,
    channels: ok.map((f) => f.channel),
    videos: ok.flatMap((f) => f.videos).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
  };
}
