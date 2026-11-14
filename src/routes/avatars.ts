import express, { Router, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { isUuid } from "../middleware/stable";
import { supabase } from "../lib/supabase";
import { IMAGE_TYPES, communityStorage } from "../lib/communityStorage";

/**
 * Profile pictures (mounted at /api/avatars, signed-in members only). One per account; the file is
 * kept by communityStorage (Cloudflare R2 when set up, else Supabase) and the row in account_avatars.
 *
 *  GET  /lookup?ids=a,b,c   which of these people have a picture: { avatars: { id: version } }
 *  GET  /me                 { avatar: version | null }
 *  GET  /:id/:version       the picture (versioned address, so browsers may cache it)
 *  POST /me                 upload or replace yours (raw JPG, PNG or WebP body, up to 2 MB)
 *  POST /me/remove          remove yours
 *
 * Pictures are visible to every signed-in member, like names. Suspended accounts never show one.
 */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
const LOOKUP_MAX = 100;

const router = Router();
router.use(requireAuth);

const me = (req: Request) => (req as AuthenticatedRequest).user;
const versionOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const unavailable = (res: Response, error?: { code?: string; message?: string } | null) => {
  console.error(`[avatars] ${res.req?.method} ${res.req?.originalUrl} failed:`, error ? `${error.code ?? "?"} ${error.message ?? ""}` : "no detail");
  res.status(503).json({ error: "Profile pictures are temporarily unavailable. Please try again." });
};
const uploadLimit = authLimit("avatar-upload", 20, 10 * 60_000, (req) => (req as Partial<AuthenticatedRequest>).user?.id ?? null);

/** Changing your picture needs a real (non-development) account with its password set. */
function canChange(req: Request, res: Response, next: NextFunction) {
  const user = me(req);
  if (!isUuid(user.id)) return void res.status(409).json({ error: "Development profiles can't have a profile picture." });
  if (user.passwordSetupRequired) return void res.status(403).json({ error: "Complete password setup first." });
  next();
}

router.get(
  "/lookup",
  asyncRoute(async (req, res) => {
    const raw = typeof req.query.ids === "string" ? req.query.ids.split(",") : [];
    const ids = [...new Set(raw.map((id) => id.trim().toLowerCase()).filter(Boolean))];
    if (ids.length > LOOKUP_MAX || !ids.every(isUuid)) return res.status(400).json({ error: "Invalid request." });
    if (!ids.length) return res.json({ avatars: {} });
    const [avatars, accounts] = await Promise.all([
      supabase.from("account_avatars").select("account_id,path").in("account_id", ids),
      supabase.from("accounts").select("id,status").in("id", ids),
    ]);
    if (avatars.error || accounts.error) return unavailable(res, avatars.error ?? accounts.error);
    const active = new Set((accounts.data ?? []).filter((a: any) => a.status === "active").map((a: any) => a.id));
    const out: Record<string, string> = {};
    for (const row of avatars.data ?? []) if (active.has(row.account_id)) out[row.account_id] = versionOf(row.path);
    // Short private cache: a changed picture shows up within a minute everywhere.
    res.setHeader("Cache-Control", "private, max-age=60");
    res.json({ avatars: out });
  }),
);

router.get(
  "/me",
  asyncRoute(async (req, res) => {
    const id = me(req).id;
    if (!isUuid(id)) return res.json({ avatar: null });
    const { data, error } = await supabase.from("account_avatars").select("path").eq("account_id", id).maybeSingle();
    if (error) return unavailable(res, error);
    res.json({ avatar: data ? versionOf(data.path) : null });
  }),
);

const rawImage = express.raw({ type: () => true, limit: MAX_AVATAR_BYTES });
function readImage(req: Request, res: Response, next: NextFunction) {
  rawImage(req, res, (error?: any) => {
    if (error?.type === "entity.too.large")
      return res.status(413).json({ error: "Profile pictures can be up to 2 MB.", code: "file_too_large" });
    if (error) return next(error);
    next();
  });
}

router.post(
  "/me",
  canChange,
  uploadLimit,
  readImage,
  asyncRoute(async (req, res) => {
    const user = me(req);
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const file = req.body;
    if (!AVATAR_TYPES.includes(type)) return res.status(415).json({ error: "Upload a JPG, PNG or WebP photo.", code: "file_type" });
    if (!Buffer.isBuffer(file) || !file.length) return res.status(400).json({ error: "That photo couldn't be read." });
    if (!IMAGE_TYPES[type](file))
      return res.status(415).json({ error: "That file doesn't look like the type of photo it claims to be.", code: "file_type" });
    const dim = (v: unknown) => (typeof v === "string" && /^\d{1,4}$/.test(v) && Number(v) > 0 && Number(v) <= 4000 ? Number(v) : null);

    const { data: previous, error: previousError } = await supabase
      .from("account_avatars")
      .select("path")
      .eq("account_id", user.id)
      .maybeSingle();
    if (previousError) return unavailable(res, previousError);

    const path = `avatars/${user.id}/${randomUUID()}`;
    try {
      await communityStorage.upload(path, file, type);
    } catch {
      return res.status(503).json({ error: "Photo storage is busy. Try again in a moment." });
    }
    const { error } = await supabase.from("account_avatars").upsert(
      {
        account_id: user.id,
        path,
        content_type: type,
        size_bytes: file.length,
        width: dim(req.query.width),
        height: dim(req.query.height),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "account_id" },
    );
    if (error) {
      await communityStorage.remove([path]).catch(() => undefined);
      return unavailable(res, error);
    }
    if (previous?.path && previous.path !== path) await communityStorage.remove([previous.path]).catch(() => undefined);
    res.status(201).json({ avatar: versionOf(path) });
  }),
);

router.post(
  "/me/remove",
  canChange,
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("account_avatars")
      .delete()
      .eq("account_id", me(req).id)
      .select("path")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (data?.path) await communityStorage.remove([data.path]).catch(() => undefined);
    res.json({ avatar: null });
  }),
);

router.get(
  "/:id/:version",
  asyncRoute(async (req, res) => {
    const { id, version } = req.params;
    const missing = () => res.status(404).json({ error: "That picture isn't available." });
    if (!isUuid(id) || !isUuid(version)) return missing();
    const [avatar, account] = await Promise.all([
      supabase.from("account_avatars").select("path,content_type").eq("account_id", id).maybeSingle(),
      supabase.from("accounts").select("status").eq("id", id).maybeSingle(),
    ]);
    if (avatar.error || account.error) return unavailable(res, avatar.error ?? account.error);
    if (!avatar.data || versionOf(avatar.data.path) !== version || account.data?.status !== "active") return missing();
    let file: Buffer;
    try {
      file = await communityStorage.download(avatar.data.path);
    } catch {
      return missing();
    }
    res.setHeader("Content-Type", AVATAR_TYPES.includes(avatar.data.content_type) ? avatar.data.content_type : "application/octet-stream");
    res.setHeader("Content-Length", String(file.length));
    res.setHeader("Content-Disposition", "inline");
    // The address changes with every new picture, so this exact file may be kept for a day.
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.end(file);
  }),
);

export default router;
