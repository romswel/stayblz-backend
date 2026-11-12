import { supabase } from "./supabase";

/**
 * Chat attachments live in the private Supabase Storage bucket `chat-files` (created by
 * migration 202611120001_chat_v2.sql). Only the backend touches it, after the chat_* functions
 * have checked membership. Overridable in tests.
 */
export const CHAT_BUCKET = "chat-files";
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const QUOTA_BYTES = 50 * 1024 * 1024;

export const chatStorage = {
  async upload(path: string, body: Buffer, contentType: string): Promise<void> {
    const { error } = await supabase.storage.from(CHAT_BUCKET).upload(path, body, { contentType, upsert: false });
    if (error) throw error;
  },
  async download(path: string): Promise<Buffer> {
    const { data, error } = await supabase.storage.from(CHAT_BUCKET).download(path);
    if (error || !data) throw error ?? new Error("missing_file");
    return Buffer.from(await data.arrayBuffer());
  },
  async remove(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const { error } = await supabase.storage.from(CHAT_BUCKET).remove(paths);
    if (error) throw error;
  },
};

/** Allowed file types. Photos are shrunk in the browser before upload; SVG/HTML are never accepted. */
export const ALLOWED_TYPES: Record<string, { image: boolean; magic?: (b: Buffer) => boolean }> = {
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
