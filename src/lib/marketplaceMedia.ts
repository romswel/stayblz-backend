import { Readable } from "node:stream";
import { newKey, r2Storage, StorageError } from "./r2Storage";
import { supabase } from "./supabase";

/**
 * Marketplace photos, videos and documents (see "Where the files live" below). The marketplace routes check who may add or see a file
 * before anything here runs; nothing in this file is reachable from the browser directly.
 */
/**
 * Photos, videos and documents are all optional: a listing can have any mix of them, or none
 * (boss's request, 2026-11-15). Cards without a picture show the drawn horse portrait.
 */
export const MIN_MEDIA = 0;
export const MAX_PHOTOS = 8;
export const MAX_VIDEOS = 3;
export const MAX_DOCUMENTS = 5;
/** Files uploaded but not yet saved with a listing (one form's worth plus some slack). */
export const MAX_PENDING_FILES = 20;
/** Unsaved uploads older than this are cleaned up the next time the seller uploads. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 180;
export const MAX_POSTER_BYTES = 2 * 1024 * 1024;
/** Photos and documents are read into memory; videos are streamed straight to R2. */
export const MAX_UPLOAD_BYTES = Math.max(MAX_PHOTO_BYTES, MAX_DOCUMENT_BYTES);
/**
 * All of one seller's marketplace files together (saved and unsaved). While files are kept in
 * Supabase Storage (1 GB on the free plan, shared with chat and community photos), one seller
 * can't fill it; R2 has far more room.
 */
export const MAX_SELLER_BYTES_SUPABASE = 300 * 1024 * 1024;
export const MAX_SELLER_BYTES_R2 = 2 * 1024 * 1024 * 1024;
/**
 * Without R2, a video (up to 50 MB) is read into memory before it goes to Supabase. Render's free
 * server has 512 MB, so only this many are taken at once (R2 uploads stream and aren't limited).
 */
export const MAX_BUFFERED_VIDEO_UPLOADS = 2;

export type FileKind = "photo" | "video" | "document";

type FileType = { kind: FileKind; extension: string; maxBytes: number; looksRight: (b: Buffer) => boolean };

/** Only these types are accepted, and the first bytes must match the type the browser claims (no SVG, no HTML). */
export const FILE_TYPES: Record<string, FileType> = {
  "image/jpeg": {
    kind: "photo",
    extension: "jpg",
    maxBytes: MAX_PHOTO_BYTES,
    looksRight: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  "image/png": {
    kind: "photo",
    extension: "png",
    maxBytes: MAX_PHOTO_BYTES,
    looksRight: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  "image/webp": {
    kind: "photo",
    extension: "webp",
    maxBytes: MAX_PHOTO_BYTES,
    looksRight: (b) => b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP",
  },
  // MP4 and MOV (iPhone) start with a box whose type is "ftyp"; WebM starts with the EBML header.
  "video/mp4": {
    kind: "video",
    extension: "mp4",
    maxBytes: MAX_VIDEO_BYTES,
    looksRight: (b) => b.length > 12 && b.subarray(4, 8).toString("ascii") === "ftyp",
  },
  "video/quicktime": {
    kind: "video",
    extension: "mov",
    maxBytes: MAX_VIDEO_BYTES,
    looksRight: (b) => b.length > 12 && ["ftyp", "moov", "wide", "mdat", "free"].includes(b.subarray(4, 8).toString("ascii")),
  },
  "video/webm": {
    kind: "video",
    extension: "webm",
    maxBytes: MAX_VIDEO_BYTES,
    looksRight: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
  },
  "application/pdf": {
    kind: "document",
    extension: "pdf",
    maxBytes: MAX_DOCUMENT_BYTES,
    looksRight: (b) => b.length > 5 && b.subarray(0, 5).toString("ascii") === "%PDF-",
  },
};

/** A document's name as the seller sees it: plain text, no folders, ends in .pdf. */
export function documentName(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f<>"`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.pdf$/i, "")
    .slice(0, 110)
    .trim();
  return `${clean || "Document"}.pdf`;
}

/* ---------- Where the files live ----------
 * Cloudflare R2 (private bucket, stayblz/marketplace/…) when this server has the R2_* settings;
 * otherwise a private Supabase Storage bucket, the same way community photos fall back. Files are
 * read from wherever they are, so listings keep working when R2 is connected later.
 */
export const SUPABASE_BUCKET = process.env.MARKETPLACE_MEDIA_BUCKET || "marketplace-media";
/** Supabase Storage holds smaller files than R2, so videos are capped while it is the store. */
export const MAX_FALLBACK_VIDEO_BYTES = 50 * 1024 * 1024;

const usingR2 = () => r2Storage.isConfigured("private");

let bucketReady: Promise<void> | null = null;
/** Creates the private bucket the first time it's needed (no migration to run). */
function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const { error } = await supabase.storage.createBucket(SUPABASE_BUCKET, { public: false });
    if (error && !/exist|duplicate/i.test(error.message ?? "")) {
      bucketReady = null;
      throw new StorageError("unavailable", `Supabase bucket: ${error.message}`);
    }
  })();
  return bucketReady;
}

const supabaseStore = {
  async put(key: string, body: Buffer, contentType: string) {
    await ensureBucket();
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).upload(key, body, { contentType, upsert: false, cacheControl: "3600" });
    if (error) throw new StorageError(/exist|duplicate/i.test(error.message ?? "") ? "exists" : "unavailable", `Supabase upload: ${error.message}`);
  },
  async get(key: string): Promise<{ body: Buffer; contentType: string }> {
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).download(key);
    if (error || !data) throw new StorageError("not_found");
    return { body: Buffer.from(await data.arrayBuffer()), contentType: data.type || "application/octet-stream" };
  },
  /** Streams a file (or a byte range of it) through a one-minute signed link that never leaves the server. */
  async open(key: string, range?: string) {
    const { data, error } = await supabase.storage.from(SUPABASE_BUCKET).createSignedUrl(key, 60);
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
  async remove(keys: string[]) {
    if (!keys.length) return;
    const { error } = await supabase.storage.from(SUPABASE_BUCKET).remove(keys);
    if (error) throw new StorageError("unavailable", `Supabase remove: ${error.message}`);
  },
};

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

export const marketplaceFiles = {
  /** "r2" when this server has the R2 settings, otherwise "supabase". */
  backend: (): "r2" | "supabase" => (usingR2() ? "r2" : "supabase"),
  /** A new, unguessable key in the seller's folder. */
  key: (sellerId: string, type: string) => newKey(`marketplace/${sellerId}`, FILE_TYPES[type]?.extension),
  /** A video poster lives next to its video: "<video key>.poster.jpg". */
  posterKey: (videoKey: string) => `${videoKey}.poster.jpg`,

  put: (key: string, body: Buffer, contentType: string) =>
    usingR2()
      ? r2Storage.put("private", key, body, contentType, { cacheControl: "private, max-age=3600" })
      : supabaseStore.put(key, body, contentType),

  /** Videos: streamed straight to R2; with Supabase Storage they are read first (up to 50 MB). */
  async putStream(key: string, body: Readable, length: number, contentType: string) {
    if (usingR2()) return r2Storage.putStream("private", key, body, length, contentType, { cacheControl: "private, max-age=3600" });
    return supabaseStore.put(key, await readAll(body, MAX_FALLBACK_VIDEO_BYTES), contentType);
  },

  /** Reads from R2 first (when set up), then from Supabase Storage, so files are found wherever they were saved. */
  async get(key: string) {
    if (usingR2()) {
      try {
        return await r2Storage.get("private", key);
      } catch (e) {
        if (!(e instanceof StorageError) || e.code !== "not_found") throw e;
      }
    }
    return supabaseStore.get(key);
  },
  async open(key: string, range?: string) {
    if (usingR2()) {
      try {
        return await r2Storage.open("private", key, { range });
      } catch (e) {
        if (!(e instanceof StorageError) || e.code !== "not_found") throw e;
      }
    }
    return supabaseStore.open(key, range);
  },
  async remove(keys: string[]) {
    const list = [...new Set(keys.filter(Boolean))];
    if (!list.length) return;
    // A file may be in either store; removing a missing file is fine in both.
    const jobs: Promise<unknown>[] = [supabaseStore.remove(list)];
    if (usingR2()) jobs.push(r2Storage.remove("private", list));
    const failed = (await Promise.allSettled(jobs)).find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) throw failed.reason;
  },
};

/** Which R2 settings are missing or wrong on this server (setting names only, never values). */
export function storageProblems(): string[] {
  const { private: bucket, problems } = r2Storage.status();
  if (bucket.configured) return [];
  // Public-bucket notes don't matter here: marketplace files only use the private bucket.
  return problems.filter((p) => !/R2_BUCKET_PUBLIC|R2_PUBLIC_URL/.test(p));
}

/** Logs storage failures (without secrets) so setup problems show up in the server log. */
export function logStorageFailure(where: string, error: unknown) {
  const code = error instanceof StorageError ? error.code : "unexpected";
  const detail = code === "not_configured" ? ` (${storageProblems().join("; ") || "R2 private storage is not set up"})` : "";
  console.error(`[marketplace] ${where}: storage ${code}${detail}`);
  return code;
}

// Say once at startup where files will go, so the deploy log shows it straight away.
{
  const problems = storageProblems();
  if (problems.length)
    console.warn(`[marketplace] R2 isn't set up on this server (${problems.join("; ")}): listing files are kept in Supabase Storage ("${SUPABASE_BUCKET}") for now.`);
  else console.info("[marketplace] Listing files are stored in Cloudflare R2.");
}