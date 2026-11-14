import { supabase } from "./supabase";

/**
 * Horse and post photos live in a private Supabase Storage bucket (created by the
 * 202611150001_community migration). The API streams them after a visibility check;
 * there are no public or signed URLs.
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

export const communityStorage = {
  async upload(path: string, file: Buffer, type: string) {
    const { error } = await supabase.storage
      .from(COMMUNITY_BUCKET)
      .upload(path, file, { contentType: type, upsert: false, cacheControl: "3600" });
    if (error) throw error;
  },
  async download(path: string): Promise<Buffer> {
    const { data, error } = await supabase.storage.from(COMMUNITY_BUCKET).download(path);
    if (error || !data) throw error ?? new Error("missing_file");
    return Buffer.from(await data.arrayBuffer());
  },
  async remove(paths: string[]) {
    const list = paths.filter(Boolean);
    if (!list.length) return;
    // Storage removes up to 1000 paths per call.
    for (let i = 0; i < list.length; i += 1000) {
      const { error } = await supabase.storage.from(COMMUNITY_BUCKET).remove(list.slice(i, i + 1000));
      if (error) throw error;
    }
  },
};
