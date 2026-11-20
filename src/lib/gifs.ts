/**
 * GIF search for Stayblz Chat through GIPHY (https://developers.giphy.com). The browser never talks to GIPHY's API:
 * it asks our server, which adds the key (GIPHY_API_KEY, kept on Render) and returns a short list. The chosen GIF is
 * sent as an ordinary message whose text is the GIF's GIPHY media link, so older apps still see a working link;
 * the picture itself loads from GIPHY's media servers (allowed in vercel.json's Content-Security-Policy).
 *
 * Without a key the picker stays hidden (`enabled: false`). Tests never reach GIPHY (see setGifFetch).
 * GIPHY's terms ask for "Powered by GIPHY" next to results; the picker shows it.
 */
const API = "https://api.giphy.com/v1/gifs";
const RATING = "pg";
const PAGE = 24;
const CACHE_MS = 10 * 60_000;
const MAX_CACHE = 300;

export interface Gif {
  id: string;
  title: string;
  /** What gets sent: the GIF itself (GIPHY's "downsized" rendition, up to about 2 MB). */
  url: string;
  /** Small moving preview for the picker grid. */
  preview: string;
  width: number;
  height: number;
}
export interface GifPage {
  enabled: boolean;
  results: Gif[];
  next: number | null;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher | null = null;
/** For tests: stand in for GIPHY. */
export function setGifFetch(fn: Fetcher | null) {
  fetcher = fn;
  cache.clear();
}

export function gifKey() {
  if (process.env.NODE_ENV === "test" && !fetcher) return null;
  const key = process.env.GIPHY_API_KEY?.trim();
  return key || null;
}

/** GIPHY media links Stayblz shows as a GIF inside a message (the same rule the browser uses). */
export const GIF_URL = /^https:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/[\w./?=&%-]+$/i;

const cache = new Map<string, { at: number; page: GifPage }>();

const num = (v: unknown) => (typeof v === "string" || typeof v === "number" ? Number(v) || 0 : 0);
function toGif(item: any): Gif | null {
  const images = item?.images ?? {};
  const main = images.downsized?.url ? images.downsized : images.fixed_height;
  const small = images.fixed_height_small ?? images.fixed_height ?? main;
  const url = typeof main?.url === "string" ? main.url : "";
  const preview = typeof small?.webp === "string" && small.webp ? small.webp : typeof small?.url === "string" ? small.url : url;
  if (!item?.id || !GIF_URL.test(url) || !GIF_URL.test(preview)) return null;
  return {
    id: String(item.id),
    title: typeof item.title === "string" ? item.title.slice(0, 120) : "GIF",
    url,
    preview,
    width: num(main.width),
    height: num(main.height),
  };
}

/** Trending GIFs (empty query) or a search. `offset` pages through results. */
export async function findGifs(query: string, offset: number): Promise<GifPage> {
  const key = gifKey();
  if (!key) return { enabled: false, results: [], next: null };
  const q = query.trim().slice(0, 50);
  const at = Math.max(0, Math.min(500, Math.floor(offset) || 0));
  const id = `${q.toLowerCase()}|${at}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
  const params = new URLSearchParams({ api_key: key, limit: String(PAGE), offset: String(at), rating: RATING, bundle: "messaging_non_clips" });
  if (q) params.set("q", q);
  const res = await (fetcher ?? fetch)(`${API}/${q ? "search" : "trending"}?${params}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`giphy_${res.status}`);
  const body: any = await res.json();
  const results = (Array.isArray(body?.data) ? body.data : []).map(toGif).filter((g: Gif | null): g is Gif => !!g);
  const total = num(body?.pagination?.total_count);
  const count = num(body?.pagination?.count) || results.length;
  const page: GifPage = { enabled: true, results, next: count && at + count < Math.min(total, 500) ? at + count : null };
  cache.set(id, { at: Date.now(), page });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
  return page;
}
