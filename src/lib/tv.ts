import { isProduction } from "./site";

/**
 * STAYBLZ TV broadcast settings. They come from server environment variables only (no database
 * table yet), so changing what is on air means changing them in Render → Environment:
 *
 *   TV_ON_AIR       "true" while a broadcast is running. Anything else means off air.
 *   TV_STREAM_URL   The HLS playlist (.m3u8) to play. Must be https (http only for localhost
 *                   outside production). Without a valid one the channel is never reported live.
 *   TV_TITLE        Optional. What is on, or on next, e.g. "Keeneland – Race 7". Max 120 characters.
 *   TV_NEXT_AT      Optional. ISO date-time of the next broadcast, shown while off air if in the future.
 *   TV_EMBED_URL    Optional, for demos until a stream provider is connected: a YouTube broadcast
 *                   (watch / youtu.be / live / embed link, or a channel's /live link). Used only when
 *                   TV_STREAM_URL is empty or invalid; the page then shows YouTube's own player.
 *
 * Settings are read on every request, so tests (and a Render restart) pick up changes immediately.
 */
export type TvState = "live" | "upcoming" | "off_air";

export interface TvSettings {
  state: TvState;
  title: string | null;
  /** Start of the next broadcast; only set when state is "upcoming". */
  startsAt: string | null;
  /** Only set when state is "live". Never sent by /status: playback hands it out. */
  streamUrl: string | null;
  /** "hls" plays streamUrl in our player; "embed" shows it in the provider's player (YouTube demo). */
  kind: "hls" | "embed" | null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A playable stream address, or null. Rejects anything that isn't plain http(s) without credentials. */
export function streamUrl(raw: string | undefined, production = isProduction()): string | null {
  const value = (raw ?? "").trim();
  if (!value || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && !production && LOCAL_HOSTS.has(url.hostname)) return url.toString();
  return null;
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * A YouTube link turned into an embed address we build ourselves (so nothing but a video or channel
 * id from the setting reaches the page), or null. A "t"/"start" offset in seconds is kept.
 * Video links → youtube-nocookie.com/embed/<id>; channel /live links → that channel's current live stream.
 */
export function youtubeEmbed(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  let video: string | null = null;
  let channel: string | null = null;
  if (host === "youtu.be") video = parts[0] ?? null;
  else if (YOUTUBE_HOSTS.has(host)) {
    if (parts[0] === "watch") video = url.searchParams.get("v");
    else if (parts[0] === "live" || parts[0] === "shorts") video = parts[1] ?? null;
    else if (parts[0] === "embed" && parts[1] === "live_stream") channel = url.searchParams.get("channel");
    else if (parts[0] === "embed") video = parts[1] ?? null;
    else if (parts[0] === "channel" && parts[2] === "live") channel = parts[1] ?? null;
  }
  // No mute=1: YouTube starts with sound when the browser allows it and otherwise falls back to
  // muted autoplay with its own Unmute button (the page keeps that corner of the player clear).
  const params = new URLSearchParams({ autoplay: "1", playsinline: "1", rel: "0" });
  if (channel && CHANNEL_ID.test(channel)) {
    params.set("channel", channel);
    return `https://www.youtube.com/embed/live_stream?${params}`;
  }
  if (!video || !VIDEO_ID.test(video)) return null;
  const start = Number.parseInt((url.searchParams.get("t") ?? url.searchParams.get("start") ?? "").replace(/s$/, ""), 10);
  if (Number.isFinite(start) && start > 0) params.set("start", String(start));
  return `https://www.youtube-nocookie.com/embed/${video}?${params}`;
}

/** Trimmed single-line title without control characters, or null. */
function title(raw: string | undefined): string | null {
  const value = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return value || null;
}

export function tvSettings(env: NodeJS.ProcessEnv = process.env, now = Date.now()): TvSettings {
  const name = title(env.TV_TITLE);
  const stream = streamUrl(env.TV_STREAM_URL);
  const embed = stream ? null : youtubeEmbed(env.TV_EMBED_URL);
  // "Live" needs both the switch and something to play: a live badge with nothing behind it is worse than off air.
  if (env.TV_ON_AIR?.trim().toLowerCase() === "true" && (stream || embed))
    return { state: "live", title: name, startsAt: null, streamUrl: stream ?? embed, kind: stream ? "hls" : "embed" };
  const next = Date.parse(env.TV_NEXT_AT ?? "");
  if (Number.isFinite(next) && next > now)
    return { state: "upcoming", title: name, startsAt: new Date(next).toISOString(), streamUrl: null, kind: null };
  return { state: "off_air", title: null, startsAt: null, streamUrl: null, kind: null };
}
