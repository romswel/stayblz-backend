import { supabase } from "./supabase";
import { r2Key, r2Storage, StorageError } from "./r2Storage";

/**
 * File storage for photos and attachments: Cloudflare R2 when it is set up, Supabase Storage otherwise.
 *
 * - Upload: to R2 (private bucket, key `stayblz/<area>/<path>`) when the R2_* settings exist. If they
 *   don't, or R2 fails, the file goes to the Supabase bucket exactly as before, so uploads never get
 *   worse than they were.
 * - Download: R2 first, then Supabase. Files saved before R2 was switched on keep working, with no
 *   copying and no change to the paths kept in the database.
 * - Remove: from both places (removing a file that isn't there is harmless in either).
 *
 * The database keeps the same `path` either way, so SQL checks on paths (chat) are untouched.
 * Like all R2 access, everything stays inside the Stayblz folder of the shared (Suprah) buckets.
 */
export type FileStore = {
  upload(path: string, body: Buffer, contentType: string): Promise<void>;
  download(path: string): Promise<Buffer>;
  remove(paths: string[]): Promise<void>;
};

/** Supabase Storage bucket as a FileStore (the fallback, and the only store when R2 is off). */
export function supabaseFiles(bucket: string, options: { cacheControl?: string } = {}): FileStore {
  return {
    async upload(path, body, contentType) {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(path, body, { contentType, upsert: false, ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}) });
      if (error) throw error;
    },
    async download(path) {
      const { data, error } = await supabase.storage.from(bucket).download(path);
      if (error || !data) throw error ?? new Error("missing_file");
      return Buffer.from(await data.arrayBuffer());
    },
    async remove(paths) {
      // Storage removes up to 1000 paths per call.
      for (let i = 0; i < paths.length; i += 1000) {
        const { error } = await supabase.storage.from(bucket).remove(paths.slice(i, i + 1000));
        if (error) throw error;
      }
    },
  };
}

const codeOf = (error: unknown) => (error instanceof StorageError ? error.code : "error");

/** `area` is a fixed folder name under stayblz/ in R2, such as "community" or "chat". */
export function mediaStore(area: string, fallback: FileStore): FileStore {
  const r2Path = (path: string) => `${area}/${path}`;
  const r2Ready = (path?: string) => {
    if (!r2Storage.isConfigured("private")) return false;
    if (path === undefined) return true;
    try {
      r2Key(r2Path(path));
      return true;
    } catch {
      return false; // a path R2 can't take (shouldn't happen) simply stays on Supabase
    }
  };

  return {
    async upload(path, body, contentType) {
      if (r2Ready(path)) {
        try {
          await r2Storage.put("private", r2Path(path), body, contentType);
          return;
        } catch (error) {
          console.warn(`[storage] R2 upload failed (${codeOf(error)}); saving to Supabase instead.`);
        }
      }
      await fallback.upload(path, body, contentType);
    },

    async download(path) {
      let r2Failure: unknown = null;
      if (r2Ready(path)) {
        try {
          return (await r2Storage.get("private", r2Path(path))).body;
        } catch (error) {
          // not_found = probably an older file kept in Supabase; anything else is worth a log line.
          if (codeOf(error) !== "not_found") {
            r2Failure = error;
            console.warn(`[storage] R2 read failed (${codeOf(error)}); trying Supabase.`);
          }
        }
      }
      try {
        return await fallback.download(path);
      } catch (error) {
        throw r2Failure ?? error;
      }
    },

    async remove(paths) {
      const list = [...new Set(paths.filter(Boolean))];
      if (!list.length) return;
      const failures: unknown[] = [];
      const inR2 = list.filter((p) => r2Ready(p));
      if (inR2.length) await r2Storage.remove("private", inR2.map(r2Path)).catch((error) => failures.push(error));
      await fallback.remove(list).catch((error) => failures.push(error));
      if (failures.length) throw failures[0];
    },
  };
}
