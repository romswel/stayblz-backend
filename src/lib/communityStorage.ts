import { Readable } from "node:stream";
import { mediaStore, supabaseFiles } from "./mediaStore";
import { r2Storage, StorageError } from "./r2Storage";
import { supabase } from "./supabase";

/**
 * Horse photos, post photos and profile pictures: Cloudflare R2 (stayblz/community/<path>) when it
 * is set up, otherwise the private Supabase Storage bucket (created by the 202611150001_community
 * migration); older files are read from Supabase either way (see lib/mediaStore.ts). The API streams
 * them after a visibility check; there are no public or signed URLs.
 */
export const COMMUNITY_BUCKET = process.env.COMMUNITY_MEDIA_BUCKET || "community-media";
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_HORSE_IMAGES = 12;
export const MAX_PENDING_POST_IMAGES = 12;

/** Only real raster images: the first bytes must match the type the browser claims. SVG is never accepted. */
export const IMAGE_TYPES: Record<string, (file: Buffer) => boolean> = {
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  "image/gif": (b) => b.length > 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("ascii")),
};

export const communityStorage = mediaStore("community", supabaseFiles(COMMUNITY_BUCKET, { cacheControl: "3600" }));

/* ---------- Horse videos ---------- */
export const MAX_HORSE_VIDEOS = 3;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
/** Supabase Storage (the fallback) takes smaller files, and the video is read into memory first. */
export const MAX_FALLBACK_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 180;
export const MAX_POSTER_BYTES = 2 * 1024 * 1024;

/** MP4 and MOV start with a box whose type is "ftyp"; WebM starts with the EBML header. */
export const VIDEO_TYPES: Record<string, { extension: string; looksRight: (b: Buffer) => boolean }> = {
  "video/mp4": { extension: "mp4", looksRight: (b) => b.length > 12 && b.subarray(4, 8).toString("ascii") === "ftyp" },
  "video/quicktime": {
    extension: "mov",
    looksRight: (b) => b.length > 12 && ["ftyp", "moov", "wide", "mdat", "free"].includes(b.subarray(4, 8).toString("ascii")),
  },
  "video/webm": { extension: "webm", looksRight: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
};

const r2On = () => r2Storage.isConfigured("private");
const r2Path = (path: string) => `community/${path}`;

async function readAll(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new StorageError("too_large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Horse videos: streamed to R2 (never held in memory) and played back in parts (Range), so they
 * start quickly and can be seeked. Without R2 they go to the Supabase bucket (up to 50 MB).
 * Same paths and folders as the photos, so communityStorage.remove() deletes them too.
 */
export const communityVideos = {
  backend: (): "r2" | "supabase" => (r2On() ? "r2" : "supabase"),
  maxBytes: () => (r2On() ? MAX_VIDEO_BYTES : MAX_FALLBACK_VIDEO_BYTES),

  async putStream(path: string, body: Readable, length: number, contentType: string) {
    if (r2On()) return r2Storage.putStream("private", r2Path(path), body, length, contentType, { cacheControl: "private, max-age=3600" });
    const { error } = await supabase.storage
      .from(COMMUNITY_BUCKET)
      .upload(path, await readAll(body, MAX_FALLBACK_VIDEO_BYTES), { contentType, upsert: false, cacheControl: "3600" });
    if (error) throw new StorageError("unavailable", `Supabase upload: ${error.message}`);
  },

  /** A video (or a byte range of it) as a stream: R2 first, then Supabase through a one-minute signed link kept on the server. */
  async open(path: string, range?: string) {
    if (r2On()) {
      try {
        return await r2Storage.open("private", r2Path(path), { range });
      } catch (e) {
        if (!(e instanceof StorageError) || e.code !== "not_found") throw e;
      }
    }
    const { data, error } = await supabase.storage.from(COMMUNITY_BUCKET).createSignedUrl(path, 60);
    if (error || !data?.signedUrl) throw new StorageError("not_found");
    const wanted = range && /^bytes=\d*-\d*$/.test(range) && range !== "bytes=-" ? range : undefined;
    const res = await fetch(data.signedUrl, { headers: wanted ? { Range: wanted } : {} }).catch(() => null);
    if (!res) throw new StorageError("unavailable");
    if (res.status === 416) throw new StorageError("bad_key", "range_not_satisfiable");
    if (res.status === 404 || res.status === 400) throw new StorageError("not_found");
    if (!res.ok || !res.body) throw new StorageError("unavailable");
    const length = Number(res.headers.get("content-length"));
    return {
      stream: Readable.fromWeb(res.body as any),
      contentType: res.headers.get("content-type") || "application/octet-stream",
      size: Number.isFinite(length) && length > 0 ? length : null,
      partial: res.status === 206,
      contentRange: res.headers.get("content-range"),
    };
  },
};
