import express, { Router, type NextFunction, type Request, type Response } from "express";
import { Readable, Transform } from "node:stream";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { supabase } from "../lib/supabase";
import { roleRank } from "../lib/accounts";
import { listingFilters, listingInput, mediaInput, MediaInputError } from "../lib/marketplaceInput";
import {
  FILE_TYPES,
  MAX_DOCUMENTS,
  MAX_FALLBACK_VIDEO_BYTES,
  MAX_PENDING_FILES,
  MAX_PHOTOS,
  MAX_POSTER_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
  MAX_VIDEOS,
  MIN_MEDIA,
  PENDING_TTL_MS,
  documentName,
  logStorageFailure,
  marketplaceFiles,
  storageProblems,
  type FileKind,
} from "../lib/marketplaceMedia";

// Horse marketplace: every signed-in member can browse; sellers add, edit and remove
// their own listings. Admins can also remove any listing (moderation).
//
// Photos (up to 8) and videos (up to 3) — at least one of either — and PDF documents (up to 5,
// optional) are stored in R2 (private bucket). The seller uploads them while filling in the form,
// and they are attached when the listing is published or saved, so Cancel leaves the listing as it was.
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.method !== "GET" && (req as AuthenticatedRequest).user.passwordSetupRequired) {
    res.status(403).json({ error: "Complete password setup before listing a horse." });
    return;
  }
  next();
});

const PAGE = 60;
const COLUMNS =
  "id,seller_id,seller_name,name,price,breed,discipline,horse_type,gender,color,age,height_in,location,created_at,updated_at";
const FILE_COLUMNS =
  "id,listing_id,seller_id,kind,storage_key,poster_key,content_type,size_bytes,width,height,duration_seconds,file_name,position,created_at";
const user = (req: Request) => (req as AuthenticatedRequest).user;
/** The photo/video table or its columns are missing: the marketplace migrations haven't been run. */
const needsMigration = (error?: { code?: string; message?: string } | null) =>
  !!error && ["PGRST205", "PGRST204", "42P01", "42703"].includes(error.code ?? "") && /marketplace_files|poster_key|duration_seconds/.test(error.message ?? "");
const MIGRATION_HELP =
  "Photo and video uploads aren't set up yet: run migrations 202611150002_marketplace_media.sql and 202611150003_marketplace_video.sql in the Supabase SQL Editor.";
const unavailable = (res: Response, error?: { code?: string; message?: string } | null) => {
  if (error) console.error(`[marketplace] ${res.req?.method} ${res.req?.originalUrl} failed: ${error.code ?? "?"} ${error.message ?? ""}`);
  if (needsMigration(error)) {
    console.error(`[marketplace] ${MIGRATION_HELP}`);
    return res.status(503).json({ error: MIGRATION_HELP, code: "setup_database" });
  }
  return res.status(503).json({ error: "The marketplace is temporarily unavailable. Please try again." });
};
const storageDown = (res: Response, where: string, error: unknown) => {
  const code = logStorageFailure(where, error);
  const admin = roleRank(user(res.req).role) >= roleRank("admin");
  let message = "File storage is busy. Try again in a moment.";
  if (code === "not_configured")
    // Admins see which settings the server is missing (names only), so they can fix it.
    message = admin
      ? `R2 storage isn't set up on this server: ${storageProblems().join("; ") || "check the R2_* settings"}.`
      : "File storage isn't set up yet. Ask a Stayblz admin.";
  else if (code === "access_denied")
    message = admin ? "R2 refused the request: check R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY." : message;
  else if (code === "no_such_bucket")
    message = admin ? "R2 can't find the bucket in R2_BUCKET_PRIVATE." : message;
  return res.status(503).json({ error: message, code: `storage_${code}` });
};
const notFound = (res: Response) => res.status(404).json({ error: "Listing not found." });
const badListing = (res: Response) =>
  res.status(400).json({
    error:
      "Check the listing: name, price, breed, discipline, type, gender, colour, age, height and location are all required.",
  });

const perUser = (req: Request) => (req as Partial<AuthenticatedRequest>).user?.id ?? null;
const uploadLimit = authLimit("marketplace-upload", 60, 10 * 60_000, perUser);

/* ---------- Shapes sent to the browser ---------- */

type FileRow = {
  id: string;
  listing_id: string | null;
  seller_id: string;
  kind: FileKind;
  storage_key: string;
  poster_key: string | null;
  content_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  file_name: string;
  position: number;
  created_at: string;
};

/** A photo or video as the gallery shows it. Videos say whether they have a poster image. */
const mediaView = (f: FileRow) => ({
  id: f.id,
  kind: f.kind as "photo" | "video",
  width: f.width,
  height: f.height,
  ...(f.kind === "video" ? { duration: f.duration_seconds, poster: !!f.poster_key } : {}),
});
const documentView = (f: FileRow) => ({ id: f.id, name: f.file_name || "Document.pdf", size: f.size_bytes });
const fileView = (f: FileRow) => ({
  ...mediaView(f),
  kind: f.kind,
  name: f.kind === "document" ? f.file_name : "",
  size: f.size_bytes,
});

/** media: photos and videos in display order (item 0 is the cover). */
type Media = { media: FileRow[]; documents: FileRow[] };
const noMedia: Media = { media: [], documents: [] };

/** The seller's account id stays on the server; the page only learns whether it is yours. */
function view(row: any, viewer: string, media: Media = noMedia, full = false) {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    breed: row.breed,
    discipline: row.discipline,
    type: row.horse_type,
    gender: row.gender,
    color: row.color,
    age: row.age,
    heightIn: row.height_in,
    location: row.location,
    sellerName: row.seller_name,
    mine: row.seller_id === viewer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // The card's picture: the first photo or video (a video shows its poster).
    cover: media.media[0] ? mediaView(media.media[0]) : null,
    photoCount: media.media.filter((f) => f.kind === "photo").length,
    videoCount: media.media.filter((f) => f.kind === "video").length,
    documentCount: media.documents.length,
    ...(full ? { media: media.media.map(mediaView), documents: media.documents.map(documentView) } : {}),
  };
}

/** Photos, videos and documents for these listings, in display order. */
async function loadMedia(listingIds: string[]) {
  const map = new Map<string, Media>();
  if (!listingIds.length) return map;
  const { data, error } = await supabase
    .from("marketplace_files")
    .select(FILE_COLUMNS)
    .in("listing_id", listingIds)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  for (const f of (data ?? []) as FileRow[]) {
    const media = map.get(f.listing_id!) ?? { media: [], documents: [] };
    (f.kind === "document" ? media.documents : media.media).push(f);
    map.set(f.listing_id!, media);
  }
  return map;
}

/**
 * Checks that every id is a file this seller may put on this listing: one of its own uploads that
 * isn't on a listing yet, or (when editing) a file already on this listing. Returns the rows, or a
 * message for the seller.
 */
async function claimFiles(sellerId: string, listingId: string | null, mediaIds: string[], documentIds: string[]) {
  const ids = [...mediaIds, ...documentIds];
  const { data, error } = await supabase.from("marketplace_files").select(FILE_COLUMNS).in("id", ids).eq("seller_id", sellerId);
  if (error) throw error;
  const byId = new Map(((data ?? []) as FileRow[]).map((f) => [f.id, f]));
  const usable = (id: string, kinds: FileKind[]) => {
    const f = byId.get(id);
    return !!f && kinds.includes(f.kind) && (f.listing_id === null || f.listing_id === listingId);
  };
  if (!mediaIds.every((id) => usable(id, ["photo", "video"])) || !documentIds.every((id) => usable(id, ["document"])))
    return { problem: "Some photos, videos or documents are no longer available. Remove them and add them again." };
  const photos = mediaIds.filter((id) => byId.get(id)!.kind === "photo").length;
  const videos = mediaIds.length - photos;
  if (photos > MAX_PHOTOS) return { problem: `A listing can have up to ${MAX_PHOTOS} photos.` };
  if (videos > MAX_VIDEOS) return { problem: `A listing can have up to ${MAX_VIDEOS} videos.` };
  return { rows: byId };
}

/** Puts the files on the listing in the order given (photo 0 is the cover). */
async function attachFiles(listingId: string, sellerId: string, mediaIds: string[], documentIds: string[]) {
  const updates = [
    ...mediaIds.map((id, position) => ({ id, position })),
    ...documentIds.map((id, position) => ({ id, position })),
  ];
  const results = await Promise.all(
    updates.map(({ id, position }) =>
      supabase
        .from("marketplace_files")
        .update({ listing_id: listingId, position })
        .eq("id", id)
        .eq("seller_id", sellerId)
        .or(`listing_id.is.null,listing_id.eq.${listingId}`),
    ),
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) throw failed.error;
}

/** Every R2 key a file uses (a video's poster too). */
const keysOf = (rows: { storage_key: string; poster_key?: string | null }[]) =>
  rows.flatMap((r) => (r.poster_key ? [r.storage_key, r.poster_key] : [r.storage_key]));

/** Deletes file rows, then their R2 files. Storage failures are logged, never shown. */
async function dropFiles(rows: Pick<FileRow, "id" | "storage_key" | "poster_key">[]) {
  if (!rows.length) return;
  const { error } = await supabase.from("marketplace_files").delete().in("id", rows.map((r) => r.id));
  if (error) throw error;
  await marketplaceFiles.remove(keysOf(rows)).catch((e) => logStorageFailure("remove", e));
}

function readMedia(body: any) {
  return mediaInput(body, { minMedia: MIN_MEDIA, maxMedia: MAX_PHOTOS + MAX_VIDEOS, maxDocuments: MAX_DOCUMENTS });
}

/* ---------- Listings ---------- */

router.get(
  "/listings",
  asyncRoute(async (req, res) => {
    let f;
    try {
      f = listingFilters(req.query as Record<string, unknown>);
    } catch {
      return res.status(400).json({ error: "Those filters aren't valid. Clear them and try again." });
    }
    const me = user(req).id;
    let query = supabase.from("marketplace_listings").select(COLUMNS);
    if (f.mine) query = query.eq("seller_id", me);
    if (f.breed) query = query.eq("breed", f.breed);
    if (f.discipline) query = query.eq("discipline", f.discipline);
    if (f.type) query = query.eq("horse_type", f.type);
    if (f.gender) query = query.eq("gender", f.gender);
    if (f.color) query = query.eq("color", f.color);
    if (f.priceMin !== undefined) query = query.gte("price", f.priceMin);
    if (f.priceMax !== undefined) query = query.lte("price", f.priceMax);
    if (f.ageMin !== undefined) query = query.gte("age", f.ageMin);
    if (f.ageMax !== undefined) query = query.lte("age", f.ageMax);
    if (f.heightMin !== undefined) query = query.gte("height_in", f.heightMin);
    if (f.heightMax !== undefined) query = query.lte("height_in", f.heightMax);
    if (f.location) query = query.ilike("location", `%${f.location}%`);
    if (f.sort === "price-asc" || f.sort === "price-desc")
      query = query.order("price", { ascending: f.sort === "price-asc" });
    else if (f.sort === "age-asc") query = query.order("age", { ascending: true });
    query = query.order("created_at", { ascending: false }).order("id", { ascending: false });
    // One extra row tells the page there are more than it shows.
    const { data, error } = await query.limit(PAGE + 1);
    if (error) return unavailable(res, error);
    const rows = (data ?? []).slice(0, PAGE);
    // Browsing must keep working even if photos can't be loaded (e.g. the media migrations aren't run yet).
    let media = new Map<string, Media>();
    try {
      media = await loadMedia(rows.map((r) => r.id));
    } catch (e) {
      const err = e as { code?: string; message?: string };
      console.error(`[marketplace] photos couldn't be loaded: ${err.code ?? "?"} ${err.message ?? ""}${needsMigration(err) ? ` — ${MIGRATION_HELP}` : ""}`);
    }
    res.json({ listings: rows.map((row) => view(row, me, media.get(row.id))), more: (data ?? []).length > PAGE });
  }),
);

/** One listing with all its photos and documents. */
router.get(
  "/listings/:id",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return notFound(res);
    const me = user(req).id;
    const { data, error } = await supabase.from("marketplace_listings").select(COLUMNS).eq("id", req.params.id).maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res);
    try {
      const media = await loadMedia([data.id]);
      res.json({ listing: view(data, me, media.get(data.id), true) });
    } catch (e) {
      unavailable(res, e as any);
    }
  }),
);

/**
 * GET /setup-check — admins only. Says what photo/video uploads still need: the database
 * migrations and the R2 settings (setting names only, never values), and whether R2 answers.
 */
router.get(
  "/setup-check",
  asyncRoute(async (req, res) => {
    if (roleRank(user(req).role) < roleRank("admin")) return notFound(res);
    const table = await supabase.from("marketplace_files").select("id").limit(0);
    const video = await supabase.from("marketplace_files").select("poster_key,duration_seconds").limit(0);
    const missing = storageProblems();
    const backend = marketplaceFiles.backend();
    // Ask the store for a file that can't exist: "not found" means it answered.
    let reach = "ok";
    try {
      await marketplaceFiles.get(`marketplace/_check/${Date.now()}`);
    } catch (e) {
      const code = logStorageFailure("setup-check", e);
      if (code !== "not_found") reach = code;
    }
    const checks = [
      { name: "migration 202611150002_marketplace_media.sql", ok: !table.error, detail: table.error ? `${table.error.code} ${table.error.message}` : "ok" },
      { name: "migration 202611150003_marketplace_video.sql", ok: !video.error, detail: video.error ? `${video.error.code} ${video.error.message}` : "ok" },
      {
        name: "file storage in use",
        ok: reach === "ok",
        detail: `${backend === "r2" ? "Cloudflare R2" : "Supabase Storage (R2 not set up on this server)"}: ${reach}`,
      },
      { name: "R2 settings on this server (optional)", ok: true, detail: missing.join("; ") || "all set" },
    ];
    res.json({ ok: checks.every((c) => c.ok), checks });
  }),
);

router.post(
  "/listings",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = listingInput(req.body);
    } catch {
      return badListing(res);
    }
    let files;
    try {
      files = readMedia(req.body);
    } catch (e) {
      return res.status(400).json({ error: e instanceof MediaInputError ? e.message : "Check the photos and try again." });
    }
    const me = user(req);
    const claimed = await claimFiles(me.id, null, files.mediaIds, files.documentIds).catch((e) => ({ error: e }));
    if ("error" in claimed) return unavailable(res, claimed.error);
    if ("problem" in claimed) return res.status(400).json({ error: claimed.problem });
    const { data, error } = await supabase
      .from("marketplace_listings")
      .insert({ ...input, seller_id: me.id, seller_name: me.displayName.slice(0, 120) || "Stayblz member" })
      .select(COLUMNS)
      .single();
    if (error || !data) return unavailable(res, error);
    try {
      await attachFiles(data.id, me.id, files.mediaIds, files.documentIds);
      const media = await loadMedia([data.id]);
      res.status(201).json({ listing: view(data, me.id, media.get(data.id), true) });
    } catch (e) {
      // Without its photos the listing isn't complete: take it down again. The uploads stay pending.
      await supabase.from("marketplace_files").update({ listing_id: null }).eq("listing_id", data.id);
      await supabase.from("marketplace_listings").delete().eq("id", data.id);
      unavailable(res, e as any);
    }
  }),
);

router.patch(
  "/listings/:id",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return notFound(res);
    let input;
    try {
      input = listingInput(req.body);
    } catch {
      return badListing(res);
    }
    let files;
    try {
      files = readMedia(req.body);
    } catch (e) {
      return res.status(400).json({ error: e instanceof MediaInputError ? e.message : "Check the photos and try again." });
    }
    const me = user(req);
    const { data: own, error: ownError } = await supabase
      .from("marketplace_listings")
      .select("id")
      .eq("id", req.params.id)
      .eq("seller_id", me.id)
      .maybeSingle();
    if (ownError) return unavailable(res, ownError);
    if (!own) return notFound(res);
    const claimed = await claimFiles(me.id, own.id, files.mediaIds, files.documentIds).catch((e) => ({ error: e }));
    if ("error" in claimed) return unavailable(res, claimed.error);
    if ("problem" in claimed) return res.status(400).json({ error: claimed.problem });

    const { data, error } = await supabase
      .from("marketplace_listings")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", own.id)
      .eq("seller_id", me.id)
      .select(COLUMNS)
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res);
    try {
      await attachFiles(own.id, me.id, files.mediaIds, files.documentIds);
      // Files that were on the listing but aren't in the saved form any more.
      const keep = new Set([...files.mediaIds, ...files.documentIds]);
      const { data: current, error: currentError } = await supabase
        .from("marketplace_files")
        .select("id,storage_key,poster_key")
        .eq("listing_id", own.id);
      if (currentError) throw currentError;
      await dropFiles((current ?? []).filter((f) => !keep.has(f.id)));
      const media = await loadMedia([own.id]);
      res.json({ listing: view(data, me.id, media.get(own.id), true) });
    } catch (e) {
      unavailable(res, e as any);
    }
  }),
);

router.post(
  "/listings/:id/remove",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return notFound(res);
    const me = user(req);
    // Read the file keys first: deleting the listing removes their rows.
    const { data: stored, error: storedError } = await supabase
      .from("marketplace_files")
      .select("storage_key,poster_key")
      .eq("listing_id", req.params.id);
    if (storedError) return unavailable(res, storedError);
    let query = supabase.from("marketplace_listings").delete().eq("id", req.params.id);
    // Sellers remove their own listings; admins (acting as admin) can remove any.
    if (roleRank(me.role) < roleRank("admin")) query = query.eq("seller_id", me.id);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res);
    await marketplaceFiles.remove(keysOf(stored ?? [])).catch((e) => logStorageFailure("remove listing", e));
    res.json({ ok: true });
  }),
);

/* ---------- Uploads (before the listing is saved) ---------- */

const rawFile = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });
function readFile(req: Request, res: Response, next: NextFunction) {
  rawFile(req, res, (error?: any) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "That file is too big. Photos can be up to 8 MB and documents up to 10 MB." });
    if (error) return next(error);
    next();
  });
}

/**
 * Before a new upload: clean up this seller's old unsaved uploads (an abandoned form), then
 * check they don't already have too many waiting. Answers the request and returns false if not.
 */
async function roomForUpload(res: Response, sellerId: string) {
  const stale = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  const { data: old } = await supabase
    .from("marketplace_files")
    .select("id,storage_key,poster_key")
    .eq("seller_id", sellerId)
    .is("listing_id", null)
    .lt("created_at", stale)
    .limit(50);
  await dropFiles(old ?? []).catch(() => undefined);
  const { count, error } = await supabase
    .from("marketplace_files")
    // Not a HEAD request: those come back without the error detail the setup message needs.
    .select("id", { count: "exact" })
    .eq("seller_id", sellerId)
    .is("listing_id", null)
    .limit(1);
  if (error) {
    unavailable(res, error);
    return false;
  }
  if ((count ?? 0) >= MAX_PENDING_FILES) {
    res.status(409).json({ error: "Save or cancel the listing you're working on before adding more files." });
    return false;
  }
  return true;
}

const dim = (v: unknown) => (typeof v === "string" && /^\d{1,5}$/.test(v) && Number(v) > 0 ? Number(v) : null);

/** Reads the first bytes of a request (to check the file type) and returns a stream of the whole body. */
async function peek(req: Request, bytes: number): Promise<{ head: Buffer; body: Readable }> {
  const iterator = (req as Readable)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const chunks: Buffer[] = [];
  let have = 0;
  while (have < bytes) {
    const { value, done } = await iterator.next();
    if (done) break;
    chunks.push(value);
    have += value.length;
  }
  const head = Buffer.concat(chunks);
  const body = Readable.from(
    (async function* () {
      if (head.length) yield head;
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) return;
        yield value;
      }
    })(),
  );
  return { head, body };
}

/**
 * POST /uploads?kind=video&duration=…&width=…&height=…   (body: the video, with Content-Length)
 * Streamed straight to R2 (never held in memory), so it's handled before the photo parser.
 */
async function uploadVideo(req: Request, res: Response) {
  const me = user(req);
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const spec = FILE_TYPES[type];
  if (!spec || spec.kind !== "video") return res.status(415).json({ error: "Videos must be MP4, MOV or WebM." });
  const length = Number(req.headers["content-length"]);
  if (!Number.isSafeInteger(length) || length <= 0) return res.status(411).json({ error: "That video couldn't be read." });
  if (length > MAX_VIDEO_BYTES) return res.status(413).json({ error: "Videos can be up to 100 MB." });
  if (marketplaceFiles.backend() === "supabase" && length > MAX_FALLBACK_VIDEO_BYTES)
    return res.status(413).json({ error: "Videos can be up to 50 MB for now." });
  const duration = dim(req.query.duration);
  if (duration !== null && duration > MAX_VIDEO_SECONDS) return res.status(400).json({ error: "Videos can be up to 3 minutes long." });
  if (!(await roomForUpload(res, me.id))) return;

  const { head, body } = await peek(req, 16);
  if (!spec.looksRight(head)) {
    req.resume();
    return res.status(415).json({ error: "That file doesn't look like the type of video it claims to be." });
  }
  // Stop at the declared length: a body that runs longer is cut off and the upload fails.
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
  const key = marketplaceFiles.key(me.id, type);
  try {
    await marketplaceFiles.putStream(key, limited, length, type);
  } catch (e) {
    req.resume();
    return storageDown(res, "video upload", e);
  }
  const { data, error } = await supabase
    .from("marketplace_files")
    .insert({
      seller_id: me.id,
      kind: "video",
      storage_key: key,
      content_type: type,
      size_bytes: length,
      width: dim(req.query.width),
      height: dim(req.query.height),
      duration_seconds: duration,
    })
    .select(FILE_COLUMNS)
    .single();
  if (error || !data) {
    await marketplaceFiles.remove([key]).catch(() => undefined);
    return unavailable(res, error);
  }
  res.status(201).json({ file: fileView(data as FileRow) });
}

/**
 * POST /uploads?kind=photo&width=…&height=…   (body: the image bytes)
 * POST /uploads?kind=document&name=…          (body: the PDF bytes)
 * POST /uploads?kind=video&duration=…         (body: the video; see uploadVideo)
 */
router.post(
  "/uploads",
  uploadLimit,
  (req, res, next) => (req.query.kind === "video" ? void uploadVideo(req, res).catch(next) : next()),
  readFile,
  asyncRoute(async (req, res) => {
    const me = user(req);
    const kind = req.query.kind === "document" ? "document" : req.query.kind === "photo" ? "photo" : null;
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const spec = FILE_TYPES[type];
    const file = req.body;
    if (!kind || !spec || spec.kind !== kind)
      return res.status(415).json({ error: kind === "document" ? "Documents must be PDF files." : "Photos must be JPG, PNG or WebP." });
    if (!Buffer.isBuffer(file) || !file.length) return res.status(400).json({ error: "That file couldn't be read." });
    if (file.length > spec.maxBytes)
      return res.status(413).json({ error: kind === "photo" ? "Photos can be up to 8 MB." : "Documents can be up to 10 MB." });
    if (!spec.looksRight(file)) return res.status(415).json({ error: "That file doesn't look like the type it claims to be." });

    if (!(await roomForUpload(res, me.id))) return;
    const key = marketplaceFiles.key(me.id, type);
    try {
      await marketplaceFiles.put(key, file, type);
    } catch (e) {
      return storageDown(res, "upload", e);
    }
    const { data, error } = await supabase
      .from("marketplace_files")
      .insert({
        seller_id: me.id,
        kind,
        storage_key: key,
        content_type: type,
        size_bytes: file.length,
        width: kind === "photo" ? dim(req.query.width) : null,
        height: kind === "photo" ? dim(req.query.height) : null,
        file_name: kind === "document" ? documentName(req.query.name) : "",
      })
      .select(FILE_COLUMNS)
      .single();
    if (error || !data) {
      await marketplaceFiles.remove([key]).catch(() => undefined);
      return unavailable(res, error);
    }
    res.status(201).json({ file: fileView(data as FileRow) });
  }),
);

/**
 * POST /uploads/:file/poster   (body: a JPEG frame from the video, captured in the browser)
 * Only for the seller's own video that isn't saved with a listing yet.
 */
router.post(
  "/uploads/:file/poster",
  uploadLimit,
  readFile,
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.file)) return res.status(404).json({ error: "File not found." });
    const me = user(req);
    const file = req.body;
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "image/jpeg" || !Buffer.isBuffer(file) || !FILE_TYPES["image/jpeg"].looksRight(file))
      return res.status(415).json({ error: "The poster must be a JPG image." });
    if (file.length > MAX_POSTER_BYTES) return res.status(413).json({ error: "The poster is too big." });
    const { data: video, error } = await supabase
      .from("marketplace_files")
      .select("id,storage_key,poster_key")
      .eq("id", req.params.file)
      .eq("seller_id", me.id)
      .eq("kind", "video")
      .is("listing_id", null)
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!video) return res.status(404).json({ error: "File not found." });
    if (video.poster_key) return res.json({ ok: true });
    const key = marketplaceFiles.posterKey(video.storage_key);
    try {
      await marketplaceFiles.put(key, file, "image/jpeg");
    } catch (e) {
      return storageDown(res, "poster upload", e);
    }
    const { error: saveError } = await supabase.from("marketplace_files").update({ poster_key: key }).eq("id", video.id).eq("seller_id", me.id);
    if (saveError) {
      await marketplaceFiles.remove([key]).catch(() => undefined);
      return unavailable(res, saveError);
    }
    res.json({ ok: true });
  }),
);

/** Drop an upload that hasn't been saved with a listing yet. Saved files are removed by saving the form without them. */
router.post(
  "/uploads/:file/remove",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.file)) return res.json({ ok: true });
    const { data, error } = await supabase
      .from("marketplace_files")
      .select("id,storage_key,poster_key")
      .eq("id", req.params.file)
      .eq("seller_id", user(req).id)
      .is("listing_id", null)
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (data) await dropFiles([data]).catch((e) => unavailable(res, e));
    if (!res.headersSent) res.json({ ok: true });
  }),
);

/* ---------- Files (streamed after a sign-in check) ---------- */

/**
 * The file row if this member may see it: every signed-in member can browse the marketplace, so
 * files on published listings are visible to them; unsaved uploads only to their seller.
 */
async function visibleFile(req: Request, res: Response): Promise<FileRow | null> {
  if (!isUuid(req.params.file)) {
    res.status(404).json({ error: "File not found." });
    return null;
  }
  const { data, error } = await supabase.from("marketplace_files").select(FILE_COLUMNS).eq("id", req.params.file).maybeSingle();
  if (error) {
    unavailable(res, error);
    return null;
  }
  const f = data as FileRow | null;
  if (!f || (f.listing_id === null && f.seller_id !== user(req).id)) {
    res.status(404).json({ error: "File not found." });
    return null;
  }
  return f;
}

async function sendWhole(res: Response, key: string, contentType: string) {
  let stored;
  try {
    stored = await marketplaceFiles.get(key);
  } catch (e) {
    if (logStorageFailure("download", e) === "not_found") return res.status(404).json({ error: "File not found." });
    return res.status(503).json({ error: "File storage is busy. Try again in a moment." });
  }
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(stored.body.length));
  res.end(stored.body);
}

/** GET /media/:file — a listing's photo, video (streamed, seekable) or document. */
router.get(
  "/media/:file",
  asyncRoute(async (req, res) => {
    const f = await visibleFile(req, res);
    if (!f) return;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    const type = FILE_TYPES[f.content_type] ? f.content_type : "application/octet-stream";

    if (f.kind === "video") {
      // Browsers ask for parts of a video (Range) to start quickly and to seek.
      const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
      let file;
      try {
        file = await marketplaceFiles.open(f.storage_key, range);
      } catch (e) {
        if ((e as Error).message === "range_not_satisfiable") {
          res.setHeader("Content-Range", `bytes */${f.size_bytes}`);
          return res.status(416).end();
        }
        if (logStorageFailure("video", e) === "not_found") return res.status(404).json({ error: "File not found." });
        return res.status(503).json({ error: "File storage is busy. Try again in a moment." });
      }
      res.status(file.partial ? 206 : 200);
      res.setHeader("Content-Type", type);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Disposition", "inline");
      if (file.size !== null) res.setHeader("Content-Length", String(file.size));
      if (file.partial && file.contentRange) res.setHeader("Content-Range", file.contentRange);
      // Stop reading from R2 as soon as the viewer leaves or skips ahead.
      res.on("close", () => file.stream.destroy());
      file.stream.on("error", () => res.destroy());
      file.stream.pipe(res);
      return;
    }

    if (f.kind === "document") {
      // Always a download (never rendered on our origin). Plain ASCII name for the header.
      const ascii = documentName(f.file_name).replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "");
      res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.file_name)}`);
    } else res.setHeader("Content-Disposition", "inline");
    await sendWhole(res, f.storage_key, type);
  }),
);

/** GET /media/:file/poster — a video's poster image (cards and before playing). */
router.get(
  "/media/:file/poster",
  asyncRoute(async (req, res) => {
    const f = await visibleFile(req, res);
    if (!f) return;
    if (f.kind !== "video" || !f.poster_key) return res.status(404).json({ error: "File not found." });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", "inline");
    await sendWhole(res, f.poster_key, "image/jpeg");
  }),
);

export default router;