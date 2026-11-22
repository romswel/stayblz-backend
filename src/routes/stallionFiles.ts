import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { Transform } from "node:stream";
import type { AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { supabase } from "../lib/supabase";
import { peek } from "../lib/streamPeek";
import { newKey } from "../lib/r2Storage";
import { roleRank } from "../lib/accounts";
import {
  FILE_TYPES,
  MAX_BUFFERED_VIDEO_UPLOADS,
  MAX_DOCUMENTS,
  MAX_FALLBACK_VIDEO_BYTES,
  MAX_PHOTOS,
  MAX_POSTER_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  MAX_VIDEOS,
  PENDING_TTL_MS,
  documentName,
  logStorageFailure,
  marketplaceFiles,
} from "../lib/marketplaceMedia";

/**
 * Stayblz Stallions: photos (up to 8), videos (up to 3) and PDFs (up to 5) on a stallion's page. Same file rules and
 * storage as Marketplace files (R2 when the server has the R2 settings, else the private Supabase bucket), with keys
 * in their own folder: stallions/<owner>/<uuid>.<ext>. Files are uploaded while the form is open and attached when
 * the stallion is saved. Files on a published stallion are public (his page is); others only for their owner.
 */
export const STALLION_FILE_LIMITS = { photos: MAX_PHOTOS, videos: MAX_VIDEOS, documents: MAX_DOCUMENTS };
const MAX_PENDING = 20;
const MAX_OWNER_BYTES_SUPABASE = 300 * 1024 * 1024;
const MAX_OWNER_BYTES_R2 = 2 * 1024 * 1024 * 1024;
export const FILE_COLUMNS =
  "id,stallion_id,owner_id,kind,storage_key,poster_key,content_type,size_bytes,width,height,duration_seconds,file_name,position,created_at";

type FileRow = {
  id: string;
  stallion_id: string | null;
  owner_id: string;
  kind: "photo" | "video" | "document";
  storage_key: string;
  poster_key: string | null;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  file_name: string;
};

const me = (req: Request) => (req as AuthenticatedRequest).user;
const viewer = (req: Request) => (req as Partial<AuthenticatedRequest>).user;
const perUser = (req: Request) => viewer(req)?.id ?? null;
const uploadLimit = authLimit("stallion-upload", 60, 10 * 60_000, perUser);
const dim = (v: unknown) => (typeof v === "string" && /^\d{1,5}$/.test(v) && Number(v) > 0 ? Number(v) : null);
const fileView = (f: FileRow) => ({
  id: f.id,
  kind: f.kind,
  width: f.width,
  height: f.height,
  duration: f.duration_seconds,
  poster: !!f.poster_key,
  name: f.kind === "document" ? f.file_name : "",
  size: f.size_bytes,
});
const busy = (res: Response, error?: unknown) => {
  if (error) console.error(`[stallions] files: ${(error as any)?.code ?? "?"} ${(error as any)?.message ?? ""}`);
  return res.status(503).json({ error: "Stallion files are temporarily unavailable. Please try again." });
};
const storageDown = (res: Response, where: string, error: unknown) => {
  logStorageFailure(`stallions ${where}`, error);
  return res.status(503).json({ error: "File storage is busy. Try again in a moment." });
};
const keysOf = (rows: { storage_key: string; poster_key?: string | null }[]) =>
  rows.flatMap((r) => (r.poster_key ? [r.storage_key, r.poster_key] : [r.storage_key]));

/** Deletes file rows, then their stored files (storage failures are logged, never shown). */
export async function dropFiles(rows: { id: string; storage_key: string; poster_key: string | null }[]) {
  if (!rows.length) return;
  const { error } = await supabase.from("stallion_files").delete().in("id", rows.map((r) => r.id));
  if (error) throw error;
  await marketplaceFiles.remove(keysOf(rows)).catch((e) => logStorageFailure("stallions remove", e));
}

/** The storage keys of every file on a stallion. Read them before deleting his row (the file rows go with it). */
export async function storedKeys(stallionId: string) {
  const { data, error } = await supabase.from("stallion_files").select("storage_key,poster_key").eq("stallion_id", stallionId);
  if (error) throw error;
  return keysOf(data ?? []);
}

/** Removes stored files once their rows are gone (failures are logged; the files are no longer reachable). */
export const removeStoredKeys = (keys: string[]) =>
  keys.length ? marketplaceFiles.remove(keys).catch((e) => logStorageFailure("stallions remove", e)) : Promise.resolve();

/**
 * Checks that every id is a file this owner may put on this stallion (their own unsaved upload, or a file already on
 * it), then puts them in the given order and drops files that were removed from the form.
 */
export async function claimAndAttach(ownerId: string, stallionId: string, mediaIds: string[], documentIds: string[], dropMissing: boolean) {
  const ids = [...mediaIds, ...documentIds];
  if (ids.length) {
    const { data, error } = await supabase.from("stallion_files").select(FILE_COLUMNS).in("id", ids).eq("owner_id", ownerId);
    if (error) throw error;
    const byId = new Map(((data ?? []) as FileRow[]).map((f) => [f.id, f]));
    const usable = (id: string, kinds: string[]) => {
      const f = byId.get(id);
      return !!f && kinds.includes(f.kind) && (f.stallion_id === null || f.stallion_id === stallionId);
    };
    if (!mediaIds.every((id) => usable(id, ["photo", "video"])) || !documentIds.every((id) => usable(id, ["document"])))
      return "Some photos, videos or documents are no longer available. Remove them and add them again.";
    const photos = mediaIds.filter((id) => byId.get(id)!.kind === "photo").length;
    if (photos > MAX_PHOTOS) return `Up to ${MAX_PHOTOS} photos.`;
    if (mediaIds.length - photos > MAX_VIDEOS) return `Up to ${MAX_VIDEOS} videos.`;
    const results = await Promise.all(
      [...mediaIds.map((id, position) => ({ id, position })), ...documentIds.map((id, position) => ({ id, position }))].map(({ id, position }) =>
        supabase
          .from("stallion_files")
          .update({ stallion_id: stallionId, position })
          .eq("id", id)
          .eq("owner_id", ownerId)
          .or(`stallion_id.is.null,stallion_id.eq.${stallionId}`),
      ),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) throw failed.error;
  }
  if (dropMissing) {
    const keep = new Set(ids);
    const { data: current, error } = await supabase.from("stallion_files").select("id,storage_key,poster_key").eq("stallion_id", stallionId);
    if (error) throw error;
    await dropFiles((current ?? []).filter((f) => !keep.has(f.id)));
  }
  return null;
}

/**
 * Reads {mediaIds, documentIds} from a form. `given` is true only when both lists were sent: an edit without them
 * leaves the stallion's files as they are (never "remove everything").
 */
export function fileIds(body: any): { mediaIds: string[]; documentIds: string[]; given: boolean } | string {
  const hasMedia = Array.isArray(body?.mediaIds);
  const hasDocuments = Array.isArray(body?.documentIds);
  if (hasMedia !== hasDocuments) return "Send the photo list and the document list together.";
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const mediaIds = list(body?.mediaIds);
  const documentIds = list(body?.documentIds);
  if (![...mediaIds, ...documentIds].every((id) => isUuid(id))) return "Check the photos and try again.";
  if (new Set([...mediaIds, ...documentIds]).size !== mediaIds.length + documentIds.length) return "A file is listed twice.";
  if (mediaIds.length > MAX_PHOTOS + MAX_VIDEOS) return `Up to ${MAX_PHOTOS} photos and ${MAX_VIDEOS} videos.`;
  if (documentIds.length > MAX_DOCUMENTS) return `Up to ${MAX_DOCUMENTS} documents.`;
  return { mediaIds: mediaIds as string[], documentIds: documentIds as string[], given: hasMedia };
}

/* ---------- Uploads (signed in) ---------- */

async function roomForUpload(res: Response, ownerId: string, incoming: number) {
  const stale = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  const { data: old } = await supabase
    .from("stallion_files")
    .select("id,storage_key,poster_key")
    .eq("owner_id", ownerId)
    .is("stallion_id", null)
    .lt("created_at", stale)
    .limit(50);
  await dropFiles(old ?? []).catch(() => undefined);
  const { data: mine, error } = await supabase.from("stallion_files").select("stallion_id,size_bytes").eq("owner_id", ownerId).limit(2000);
  if (error) {
    busy(res, error);
    return false;
  }
  if ((mine ?? []).filter((f) => f.stallion_id === null).length >= MAX_PENDING) {
    res.status(409).json({ error: "Save or cancel the stallion you're working on before adding more files." });
    return false;
  }
  const cap = marketplaceFiles.backend() === "r2" ? MAX_OWNER_BYTES_R2 : MAX_OWNER_BYTES_SUPABASE;
  const used = (mine ?? []).reduce((sum, f) => sum + (Number(f.size_bytes) || 0), 0);
  if (used + incoming > cap) {
    res.status(409).json({ error: `Your stallion files are full (${cap >= 1024 ** 3 ? `${cap / 1024 ** 3} GB` : `${cap / 1024 ** 2} MB`} in all). Remove a video to add more.` });
    return false;
  }
  return true;
}

let bufferedVideos = 0;

async function uploadVideo(req: Request, res: Response) {
  const owner = me(req);
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const spec = FILE_TYPES[type];
  if (!spec || spec.kind !== "video") return res.status(415).json({ error: "Videos must be MP4, MOV or WebM." });
  const length = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(length) || length <= 0) return res.status(411).json({ error: "That video couldn't be read." });
  const buffered = marketplaceFiles.backend() === "supabase";
  const max = buffered ? MAX_FALLBACK_VIDEO_BYTES : MAX_VIDEO_BYTES;
  if (length > max) return res.status(413).json({ error: `Videos can be up to ${Math.round(max / 1024 / 1024)} MB for now.` });
  const duration = dim(req.query.duration);
  if (duration !== null && duration > MAX_VIDEO_SECONDS) return res.status(400).json({ error: "Videos can be up to 3 minutes long." });
  if (buffered) {
    if (bufferedVideos >= MAX_BUFFERED_VIDEO_UPLOADS) return res.status(503).json({ error: "Other videos are uploading right now. Try again in a minute." });
    bufferedVideos++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        bufferedVideos--;
      }
    };
    res.on("finish", release);
    res.on("close", release);
  }
  if (!(await roomForUpload(res, owner.id, length))) return;
  const { head, body } = await peek(req, 16);
  if (!spec.looksRight(head)) {
    req.resume();
    return res.status(415).json({ error: "That file doesn't look like the type of video it claims to be." });
  }
  let seen = 0;
  const limited = body.pipe(
    new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen > length) return done(new Error("too_long"));
        done(null, chunk);
      },
    }),
  );
  const key = newKey(`stallions/${owner.id}`, spec.extension);
  try {
    await marketplaceFiles.putStream(key, limited, length, type);
  } catch (e) {
    req.resume();
    return storageDown(res, "video upload", e);
  }
  const { data, error } = await supabase
    .from("stallion_files")
    .insert({ owner_id: owner.id, kind: "video", storage_key: key, content_type: type, size_bytes: length,
      width: dim(req.query.width), height: dim(req.query.height), duration_seconds: duration })
    .select(FILE_COLUMNS)
    .single();
  if (error || !data) {
    await marketplaceFiles.remove([key]).catch(() => undefined);
    return busy(res, error);
  }
  res.status(201).json({ file: fileView(data as FileRow) });
}

const rawFile = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });
function readFile(req: Request, res: Response, next: NextFunction) {
  rawFile(req, res, (error?: any) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "That file is too big. Photos can be up to 8 MB and documents up to 10 MB." });
    if (error) return next(error);
    next();
  });
}

/** POST /uploads?kind=photo|document|video …, POST /uploads/:file/poster, POST /uploads/:file/remove, GET /limits */
export function uploadRoutes(router: Router) {
  router.get("/limits", (_req, res) => {
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json({
      videoBytes: marketplaceFiles.backend() === "r2" ? MAX_VIDEO_BYTES : MAX_FALLBACK_VIDEO_BYTES,
      videoSeconds: MAX_VIDEO_SECONDS,
      ...STALLION_FILE_LIMITS,
    });
  });

  router.post(
    "/uploads",
    uploadLimit,
    (req, res, next) => (req.query.kind === "video" ? void uploadVideo(req, res).catch(next) : next()),
    readFile,
    asyncRoute(async (req, res) => {
      const owner = me(req);
      const kind = req.query.kind === "document" ? "document" : req.query.kind === "photo" ? "photo" : null;
      const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      const spec = FILE_TYPES[type];
      const file = req.body;
      if (!kind || !spec || spec.kind !== kind)
        return res.status(415).json({ error: kind === "document" ? "Documents must be PDF files." : "Photos must be JPG, PNG or WebP." });
      if (!Buffer.isBuffer(file) || !file.length) return res.status(400).json({ error: "That file couldn't be read." });
      if (file.length > spec.maxBytes) return res.status(413).json({ error: kind === "photo" ? "Photos can be up to 8 MB." : "Documents can be up to 10 MB." });
      if (!spec.looksRight(file)) return res.status(415).json({ error: "That file doesn't look like the type it claims to be." });
      if (!(await roomForUpload(res, owner.id, file.length))) return;
      const key = newKey(`stallions/${owner.id}`, spec.extension);
      try {
        await marketplaceFiles.put(key, file, type);
      } catch (e) {
        return storageDown(res, "upload", e);
      }
      const { data, error } = await supabase
        .from("stallion_files")
        .insert({ owner_id: owner.id, kind, storage_key: key, content_type: type, size_bytes: file.length,
          width: kind === "photo" ? dim(req.query.width) : null, height: kind === "photo" ? dim(req.query.height) : null,
          file_name: kind === "document" ? documentName(req.query.name) : "" })
        .select(FILE_COLUMNS)
        .single();
      if (error || !data) {
        await marketplaceFiles.remove([key]).catch(() => undefined);
        return busy(res, error);
      }
      res.status(201).json({ file: fileView(data as FileRow) });
    }),
  );

  router.post(
    "/uploads/:file/poster",
    uploadLimit,
    readFile,
    asyncRoute(async (req, res) => {
      if (!isUuid(req.params.file)) return res.status(404).json({ error: "File not found." });
      const owner = me(req);
      const file = req.body;
      const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "image/jpeg" || !Buffer.isBuffer(file) || !FILE_TYPES["image/jpeg"].looksRight(file))
        return res.status(415).json({ error: "The poster must be a JPG image." });
      if (file.length > MAX_POSTER_BYTES) return res.status(413).json({ error: "The poster is too big." });
      const { data: video, error } = await supabase
        .from("stallion_files")
        .select(FILE_COLUMNS)
        .eq("id", req.params.file)
        .eq("owner_id", owner.id)
        .eq("kind", "video")
        .is("stallion_id", null)
        .maybeSingle();
      if (error) return busy(res, error);
      if (!video) return res.status(404).json({ error: "File not found." });
      if (video.poster_key) return res.json({ ok: true });
      const key = marketplaceFiles.posterKey(video.storage_key);
      try {
        await marketplaceFiles.put(key, file, "image/jpeg");
      } catch (e) {
        return storageDown(res, "poster upload", e);
      }
      const { error: saveError } = await supabase.from("stallion_files").update({ poster_key: key }).eq("id", video.id).eq("owner_id", owner.id);
      if (saveError) {
        await marketplaceFiles.remove([key]).catch(() => undefined);
        return busy(res, saveError);
      }
      res.json({ ok: true });
    }),
  );

  router.post(
    "/uploads/:file/remove",
    asyncRoute(async (req, res) => {
      if (!isUuid(req.params.file)) return res.json({ ok: true });
      const { data, error } = await supabase
        .from("stallion_files")
        .select("id,storage_key,poster_key")
        .eq("id", req.params.file)
        .eq("owner_id", me(req).id)
        .is("stallion_id", null)
        .maybeSingle();
      if (error) return busy(res, error);
      if (data) await dropFiles([data]).catch((e) => busy(res, e));
      if (!res.headersSent) res.json({ ok: true });
    }),
  );
}

/* ---------- Files on a page (public for published stallions) ---------- */

async function visibleFile(req: Request, res: Response): Promise<FileRow | null> {
  if (!isUuid(req.params.file)) {
    res.status(404).json({ error: "File not found." });
    return null;
  }
  const { data, error } = await supabase.from("stallion_files").select(FILE_COLUMNS).eq("id", req.params.file).maybeSingle();
  if (error) {
    busy(res, error);
    return null;
  }
  const f = data as FileRow | null;
  const who = viewer(req);
  let allowed = !!f && !!who && f.owner_id === who.id;
  if (f && !allowed && f.stallion_id) {
    const { data: s } = await supabase.from("stallions").select("id,status").eq("id", f.stallion_id).maybeSingle();
    allowed = s?.status === "published" || (!!who && roleRank(who.role) >= roleRank("admin"));
  }
  if (!f || !allowed) {
    res.status(404).json({ error: "File not found." });
    return null;
  }
  return f;
}

async function sendWhole(res: Response, key: string, contentType: string, cache: string) {
  let stored;
  try {
    stored = await marketplaceFiles.get(key);
  } catch (e) {
    if (logStorageFailure("stallions download", e) === "not_found") return res.status(404).json({ error: "File not found." });
    return res.status(503).json({ error: "File storage is busy. Try again in a moment." });
  }
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", cache);
  res.setHeader("Content-Length", String(stored.body.length));
  res.end(stored.body);
}

/** GET /media/:file and /media/:file/poster (use optionalAuth before these). */
export function mediaRoutes(router: Router) {
  router.get(
    "/media/:file",
    asyncRoute(async (req, res) => {
      const f = await visibleFile(req, res);
      if (!f) return;
      const cache = f.stallion_id ? "private, max-age=3600" : "private, max-age=600";
      res.setHeader("X-Content-Type-Options", "nosniff");
      const type = FILE_TYPES[f.content_type] ? f.content_type : "application/octet-stream";
      if (f.kind === "video") {
        const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
        let file;
        try {
          file = await marketplaceFiles.open(f.storage_key, range);
        } catch (e) {
          if ((e as Error).message === "range_not_satisfiable") {
            res.setHeader("Content-Range", `bytes */${f.size_bytes}`);
            return res.status(416).end();
          }
          if (logStorageFailure("stallions video", e) === "not_found") return res.status(404).json({ error: "File not found." });
          return res.status(503).json({ error: "File storage is busy. Try again in a moment." });
        }
        res.status(file.partial ? 206 : 200);
        res.setHeader("Content-Type", type);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Cache-Control", cache);
        if (file.size !== null) res.setHeader("Content-Length", String(file.size));
        if (file.partial && file.contentRange) res.setHeader("Content-Range", file.contentRange);
        res.on("close", () => file.stream.destroy());
        file.stream.on("error", () => res.destroy());
        file.stream.pipe(res);
        return;
      }
      if (f.kind === "document") {
        const ascii = documentName(f.file_name).replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "");
        res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
      } else res.setHeader("Content-Disposition", "inline");
      await sendWhole(res, f.storage_key, type, cache);
    }),
  );
  router.get(
    "/media/:file/poster",
    asyncRoute(async (req, res) => {
      const f = await visibleFile(req, res);
      if (!f) return;
      if (f.kind !== "video" || !f.poster_key) return res.status(404).json({ error: "File not found." });
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");
      await sendWhole(res, f.poster_key, "image/jpeg", f.stallion_id ? "private, max-age=3600" : "private, max-age=600");
    }),
  );
}
