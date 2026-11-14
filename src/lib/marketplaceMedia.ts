import { newKey, r2Storage, StorageError } from "./r2Storage";

/**
 * Marketplace photos and documents, stored in the private R2 bucket under
 * stayblz/marketplace/<seller>/. The marketplace routes check who may add or see a file
 * before anything here runs; nothing in this file is reachable from the browser directly.
 */
export const MIN_PHOTOS = 1;
export const MAX_PHOTOS = 8;
export const MAX_DOCUMENTS = 5;
/** Files uploaded but not yet saved with a listing (one form's worth plus some slack). */
export const MAX_PENDING_FILES = 20;
/** Unsaved uploads older than this are cleaned up the next time the seller uploads. */
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = Math.max(MAX_PHOTO_BYTES, MAX_DOCUMENT_BYTES);

export type FileKind = "photo" | "document";

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

export const marketplaceFiles = {
  /** A new, unguessable key in the seller's folder. */
  key: (sellerId: string, type: string) => newKey(`marketplace/${sellerId}`, FILE_TYPES[type]?.extension),
  put: (key: string, body: Buffer, contentType: string) =>
    r2Storage.put("private", key, body, contentType, { cacheControl: "private, max-age=3600" }),
  get: (key: string) => r2Storage.get("private", key),
  remove: (keys: string[]) => r2Storage.remove("private", keys),
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

// Say it once at startup too, so a missing setting is visible in the deploy log straight away.
{
  const problems = storageProblems();
  if (problems.length) console.warn(`[marketplace] Photo uploads won't work until R2 is set up: ${problems.join("; ")}`);
}