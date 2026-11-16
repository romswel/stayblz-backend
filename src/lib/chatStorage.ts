import { mediaStore, supabaseFiles } from "./mediaStore";
import { r2Storage } from "./r2Storage";

/**
 * Chat attachments: Cloudflare R2 (stayblz/chat/<path>) when it is set up, otherwise the private
 * Supabase Storage bucket `chat-files` (created by migration 202611120001_chat_v2.sql); older files
 * are read from Supabase either way (see lib/mediaStore.ts). Only the backend touches them, after the
 * chat_* functions have checked membership. Overridable in tests.
 */
export const CHAT_BUCKET = "chat-files";
/** Supabase Storage (free plan, 1 GB shared): small files only. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const QUOTA_BYTES = 50 * 1024 * 1024;
/** Cloudflare R2 (when the R2_* settings exist): videos and bigger files. Matches r2Storage's 25 MB read limit. */
export const MAX_R2_FILE_BYTES = 25 * 1024 * 1024;
export const R2_QUOTA_BYTES = 500 * 1024 * 1024;

export const chatStorage = mediaStore("chat", supabaseFiles(CHAT_BUCKET));

/** What this server can store right now, per file and per person. The chat app shows these exact numbers. */
export function chatLimits() {
  const r2 = r2Storage.isConfigured("private");
  return {
    storage: r2 ? ("r2" as const) : ("supabase" as const),
    fileBytes: r2 ? MAX_R2_FILE_BYTES : MAX_FILE_BYTES,
    quotaBytes: r2 ? R2_QUOTA_BYTES : QUOTA_BYTES,
  };
}

/** Group photos: square JPEG/PNG/WebP made in the browser, up to 2 MB. */
export const MAX_GROUP_PHOTO_BYTES = 2 * 1024 * 1024;

/**
 * Allowed file types. Photos are shrunk in the browser before upload; SVG/HTML are never accepted.
 * Audio = voice clips recorded in the browser (WebM/Ogg Opus on Chrome/Firefox, MP4/AAC on Safari).
 * Keep in sync with chat_attachment_ok() (migration 202611170001_chat_v3.sql) and the frontend's files.ts.
 */
const isoMedia = (b: Buffer) => ["ftyp", "moov", "wide", "mdat", "free", "skip"].includes(b.subarray(4, 8).toString("latin1"));
export const ALLOWED_TYPES: Record<string, { image: boolean; audio?: boolean; video?: boolean; magic?: (b: Buffer) => boolean }> = {
  "video/mp4": { image: false, video: true, magic: isoMedia },
  "video/quicktime": { image: false, video: true, magic: isoMedia },
  "video/webm": { image: false, video: true, magic: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  "audio/webm": { image: false, audio: true, magic: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  "audio/ogg": { image: false, audio: true, magic: (b) => b.subarray(0, 4).toString("latin1") === "OggS" },
  "audio/mp4": { image: false, audio: true, magic: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" },
  "audio/mpeg": {
    image: false,
    audio: true,
    magic: (b) => b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
  },
  "image/jpeg": { image: true, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { image: true, magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/gif": { image: true, magic: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  "image/webp": { image: true, magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  "application/pdf": { image: false, magic: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  "text/plain": { image: false },
  "text/csv": { image: false },
  "application/msword": { image: false },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { image: false, magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  "application/vnd.ms-excel": { image: false },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { image: false, magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
};

/** A file name that is safe to show and to put in a download header. (Express has already decoded the query.) */
export function safeFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f"\\/<>:|?*]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name === "." || name === "..") return null;
  return name.slice(0, 120);
}
