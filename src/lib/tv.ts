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
  // "Live" needs both the switch and something to play: a live badge with nothing behind it is worse than off air.
  if (env.TV_ON_AIR?.trim().toLowerCase() === "true" && stream)
    return { state: "live", title: name, startsAt: null, streamUrl: stream };
  const next = Date.parse(env.TV_NEXT_AT ?? "");
  if (Number.isFinite(next) && next > now)
    return { state: "upcoming", title: name, startsAt: new Date(next).toISOString(), streamUrl: null };
  return { state: "off_air", title: null, startsAt: null, streamUrl: null };
}
