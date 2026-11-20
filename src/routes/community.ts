import express, { Router, type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { peek } from "../lib/streamPeek";
import { StorageError } from "../lib/r2Storage";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { isUuid } from "../middleware/stable";
import { supabase } from "../lib/supabase";
import { roleRank } from "../lib/accounts";
import {
  HORSE_COLUMNS,
  IMAGE_COLUMNS,
  accountActive,
  canSeeHorse,
  horseView,
  imageView,
  loadCommunityHorse,
  loadStats,
  ownerContext,
  recordView,
  type OwnerContext,
} from "../lib/communityHorses";
import {
  InputError,
  commentInput,
  horseInput,
  horseShareInput,
  postEditInput,
  postInput,
  readCursor,
  recordInput,
  searchText,
  settingsInput,
} from "../lib/communityInput";
import {
  IMAGE_TYPES,
  MAX_HORSE_IMAGES,
  MAX_HORSE_VIDEOS,
  MAX_IMAGE_BYTES,
  MAX_PENDING_POST_IMAGES,
  MAX_POSTER_BYTES,
  MAX_VIDEO_SECONDS,
  VIDEO_TYPES,
  communityStorage,
  communityVideos,
} from "../lib/communityStorage";

/**
 * Stayblz Community (mounted at /api/community, signed-in members only):
 *  - Horse profiles: each member's horses with photos and race records (performance history).
 *  - Members: directory, profiles with horse counts and earnings, follow / unfollow.
 *  - Feed: posts from everyone or from people you follow, with photos, likes and comments.
 *
 * Privacy: a member chooses who sees their horses (every member, followers, or only them),
 * each horse can override that, and earnings can be hidden. Every read checks this on the
 * server (SQL functions community_visible / community_people / community_feed).
 */
const router = Router();
router.use(requireAuth);

const me = (req: Request) => (req as AuthenticatedRequest).user;
type DbError = { code?: string; message?: string; hint?: string | null } | null | undefined;
/** 503 for members; the real Supabase error goes to the server log so setup problems are visible. */
const unavailable = (res: Response, ...errors: DbError[]) => {
  const err = errors.find(Boolean);
  const req = res.req;
  console.error(
    `[community] ${req?.method} ${req?.originalUrl} failed:`,
    err ? `${err.code ?? "?"} ${err.message ?? ""}${err.hint ? ` (hint: ${err.hint})` : ""}` : "no error detail",
  );
  res.status(503).json({ error: "The community is temporarily unavailable. Please try again." });
};
const notFound = (res: Response, what = "That page") => res.status(404).json({ error: `${what} isn't available.` });
const bad = (res: Response, error: unknown) =>
  res.status(400).json({ error: error instanceof InputError ? error.message : "Check the form and try again." });

// Development profiles (non-UUID ids) have no account row, so they can't take part.
router.use((req, res, next) => {
  const user = me(req);
  if (!isUuid(user.id)) return void res.status(409).json({ error: "Development profiles can't use the community." });
  if (req.method !== "GET" && user.passwordSetupRequired)
    return void res.status(403).json({ error: "Complete password setup before posting or adding horses." });
  next();
});

const perUser = (req: Request) => (req as Partial<AuthenticatedRequest>).user?.id ?? null;
const writeLimit = authLimit("community-write", 120, 10 * 60_000, perUser);
const postLimit = authLimit("community-post", 20, 10 * 60_000, perUser);
const followLimit = authLimit("community-follow", 60, 10 * 60_000, perUser);
const uploadLimit = authLimit("community-upload", 60, 10 * 60_000, perUser);
router.use((req, res, next) => (req.method === "GET" ? next() : writeLimit(req, res, next)));

router.param("id", (req, res, next, id) => (isUuid(id) ? next() : notFound(res)));
router.param("image", (req, res, next, id) => (isUuid(id) ? next() : notFound(res, "That photo")));

/* ============================== Shapes sent to the browser ============================== */

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
const centsOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function personView(r: any) {
  return {
    id: r.id,
    name: r.name || "Stayblz member",
    headline: r.headline ?? "",
    me: !!r.me,
    horses: num(r.horses),
    starts: num(r.starts),
    wins: num(r.wins),
    earningsCents: centsOrNull(r.earnings_cents),
    followers: num(r.followers),
    followingCount: num(r.following_count),
    posts: num(r.posts),
    isFollowing: !!r.following,
    followsYou: !!r.follows_me,
    inventoryOpen: !!r.inventory_open,
    lastActive: r.last_active ?? null,
    joinedAt: r.created_at ?? null,
  };
}

function postView(r: any) {
  return {
    id: r.id,
    kind: r.kind,
    body: r.body ?? "",
    result: r.result ?? null,
    visibility: r.visibility,
    createdAt: r.created_at,
    editedAt: r.edited_at ?? null,
    mine: !!r.mine,
    author: r.author,
    horse: r.horse ?? null,
    images: r.images ?? [],
    likes: num(r.likes),
    liked: !!r.liked,
    comments: num(r.comments),
  };
}

async function ownHorse(horseId: string, owner: string) {
  const { data, error } = await supabase.from("owner_horses").select(HORSE_COLUMNS).eq("id", horseId).eq("owner_id", owner).maybeSingle();
  if (error) throw error;
  return data;
}

/** One post as the viewer sees it (null when it doesn't exist or isn't visible to them). */
async function visiblePost(viewer: string, postId: string) {
  const { data, error } = await supabase.rpc("community_feed", {
    p_viewer: viewer,
    p_scope: "post",
    p_target: postId,
    p_before_time: null,
    p_before_id: null,
    p_after: null,
    p_limit: 1,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  return row ? postView(row) : null;
}

async function feedPage(viewer: string, scope: string, target: string | null, req: Request, limit = 20) {
  const cursor = readCursor(req.query.before);
  const { data, error } = await supabase.rpc("community_feed", {
    p_viewer: viewer,
    p_scope: scope,
    p_target: target,
    p_before_time: cursor?.time ?? null,
    p_before_id: cursor?.id ?? null,
    p_after: null,
    p_limit: limit + 1,
  });
  if (error) throw error;
  const rows = (Array.isArray(data) ? data : []).map(postView);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { posts: page, next: rows.length > limit && last ? `${last.createdAt}~${last.id}` : null };
}

/** Auto-post when a member adds a horse or a race result, if they chose to share it. */
async function sharePost(fields: { author_id: string; kind: string; body: string; horse_id: string; result?: unknown; visibility: string }) {
  const { error } = await supabase.from("community_posts").insert(fields);
  if (error) throw error;
}

/** A horse's audience as a post audience: horses visible to members post to members, else followers. */
async function shareAudience(owner: string, horseVisibility: string): Promise<"members" | "followers" | null> {
  let level = horseVisibility;
  if (level === "inherit") {
    const { data } = await supabase.from("community_profiles").select("inventory_visibility").eq("user_id", owner).maybeSingle();
    level = data?.inventory_visibility ?? "members";
  }
  return level === "private" ? null : (level as "members" | "followers");
}

/* ============================== Uploads ============================== */

const rawImage = express.raw({ type: () => true, limit: MAX_IMAGE_BYTES });
function readImage(req: Request, res: Response, next: NextFunction) {
  rawImage(req, res, (error?: any) => {
    if (error?.type === "entity.too.large")
      return res.status(413).json({ error: "Photos can be up to 6 MB.", code: "file_too_large" });
    if (error) return next(error);
    next();
  });
}
/** Checks the uploaded bytes; answers the request and returns null when they aren't a usable photo. */
function checkedImage(req: Request, res: Response) {
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const magic = IMAGE_TYPES[type];
  const file = req.body;
  if (!magic) {
    res.status(415).json({ error: "Upload a JPG, PNG, WebP or GIF photo.", code: "file_type" });
    return null;
  }
  if (!Buffer.isBuffer(file) || !file.length) {
    res.status(400).json({ error: "That photo couldn't be read." });
    return null;
  }
  if (!magic(file)) {
    res.status(415).json({ error: "That file doesn't look like the type of photo it claims to be.", code: "file_type" });
    return null;
  }
  const dim = (v: unknown) => (typeof v === "string" && /^\d{1,5}$/.test(v) && Number(v) > 0 ? Number(v) : null);
  return { file, type, width: dim(req.query.width), height: dim(req.query.height) };
}

/* ============================== My settings ============================== */

router.get(
  "/me",
  asyncRoute(async (req, res) => {
    const user = me(req);
    const [profile, people] = await Promise.all([
      supabase.from("community_profiles").select("headline,inventory_visibility,show_earnings,listed").eq("user_id", user.id).maybeSingle(),
      supabase.rpc("community_people", { p_viewer: user.id, p_query: null, p_sort: null, p_limit: 1, p_offset: 0, p_only: user.id }),
    ]);
    if (profile.error || people.error) return unavailable(res, profile.error, people.error);
    const row = Array.isArray(people.data) ? people.data[0] : null;
    res.json({
      settings: {
        headline: profile.data?.headline ?? "",
        inventoryVisibility: profile.data?.inventory_visibility ?? "members",
        showEarnings: profile.data?.show_earnings ?? true,
        listed: profile.data?.listed ?? true,
      },
      person: row ? personView(row) : null,
    });
  }),
);

router.patch(
  "/me/settings",
  asyncRoute(async (req, res) => {
    let changes;
    try {
      changes = settingsInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const { data, error } = await supabase
      .from("community_profiles")
      .upsert({ user_id: me(req).id, ...changes, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
      .select("headline,inventory_visibility,show_earnings,listed")
      .single();
    if (error || !data) return unavailable(res, error);
    res.json({
      settings: {
        headline: data.headline,
        inventoryVisibility: data.inventory_visibility,
        showEarnings: data.show_earnings,
        listed: data.listed,
      },
    });
  }),
);

/* ============================== Members ============================== */

const PEOPLE_PAGE = 30;
/** Members directory pages (Feeds → Members). */
const DIRECTORY_PAGE = 15;
const DIRECTORY_MAX_PAGE = 500;
/** The community_people RPC returns at most 61 rows per call. */
const DIRECTORY_CHUNK = 60;
const SORTS = ["active", "horses", "earnings", "followers", "new"];
/** Placeholder accounts kept out of the Members list: any name containing the word admin, test or user (any case). */
const HIDDEN_MEMBER_WORDS = /\b(admin|test|user)\b/i;
const listedMember = (r: any) => !HIDDEN_MEMBER_WORDS.test(String(r?.name ?? ""));

router.get(
  "/people",
  asyncRoute(async (req, res) => {
    const sort = typeof req.query.sort === "string" && SORTS.includes(req.query.sort) ? req.query.sort : "active";
    const query = searchText(req.query.q) || null;

    // Numbered pages of 15, counted after hiding placeholders so every page is full.
    if (req.query.page !== undefined) {
      const page = Number(req.query.page);
      if (!Number.isSafeInteger(page) || page < 1 || page > DIRECTORY_MAX_PAGE) return res.status(400).json({ error: "Invalid page." });
      const need = page * DIRECTORY_PAGE + 1; // one extra tells us whether a next page exists
      const kept: any[] = [];
      for (let raw = 0; kept.length < need && raw <= 10_000; raw += DIRECTORY_CHUNK) {
        const { data, error } = await supabase.rpc("community_people", {
          p_viewer: me(req).id,
          p_query: query,
          p_sort: sort,
          p_limit: DIRECTORY_CHUNK,
          p_offset: raw,
          p_only: null,
        });
        if (error) return unavailable(res, error);
        const rows = Array.isArray(data) ? data : [];
        kept.push(...rows.filter(listedMember));
        if (rows.length < DIRECTORY_CHUNK) break;
      }
      const start = (page - 1) * DIRECTORY_PAGE;
      return res.json({
        people: kept.slice(start, start + DIRECTORY_PAGE).map(personView),
        page,
        hasNext: kept.length > start + DIRECTORY_PAGE,
      });
    }

    // Older clients page by raw offset.
    const offset = Number(req.query.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) return res.status(400).json({ error: "Invalid page." });
    const { data, error } = await supabase.rpc("community_people", {
      p_viewer: me(req).id,
      p_query: query,
      p_sort: sort,
      p_limit: PEOPLE_PAGE + 1,
      p_offset: offset,
      p_only: null,
    });
    if (error) return unavailable(res, error);
    const rows = Array.isArray(data) ? data : [];
    res.json({
      // Paging still counts the raw rows, so hiding placeholders never skips anyone.
      people: rows.slice(0, PEOPLE_PAGE).filter(listedMember).map(personView),
      nextOffset: rows.length > PEOPLE_PAGE ? offset + PEOPLE_PAGE : null,
    });
  }),
);

router.get(
  "/people/:id",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.rpc("community_people", {
      p_viewer: me(req).id,
      p_query: null,
      p_sort: null,
      p_limit: 1,
      p_offset: 0,
      p_only: req.params.id,
    });
    if (error) return unavailable(res, error);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return notFound(res, "That member");
    res.json({ person: personView(row) });
  }),
);

router.get(
  "/people/:id/horses",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const owner = req.params.id;
    if (!(await accountActive(owner))) return notFound(res, "That member");
    const ctx = await ownerContext(viewer, owner);
    const { data, error } = await supabase
      .from("owner_horses")
      .select(HORSE_COLUMNS)
      .eq("owner_id", owner)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return unavailable(res, error);
    const horses = (data ?? []).filter((h) => canSeeHorse(viewer, h, ctx));
    const ids = horses.map((h) => h.id);
    const [stats, images] = await Promise.all([
      loadStats(ids),
      ids.length
        ? supabase.from("owner_horse_images").select("horse_id").in("horse_id", ids)
        : Promise.resolve({ data: [] as { horse_id: string }[], error: null }),
    ]);
    if (images.error) return unavailable(res, images.error);
    const counts = new Map<string, number>();
    for (const i of images.data ?? []) counts.set(i.horse_id, (counts.get(i.horse_id) ?? 0) + 1);
    const mine = viewer === owner;
    res.json({
      horses: horses.map((h) => horseView(h, stats.get(h.id), { mine, showEarnings: ctx.showEarnings, imageCount: counts.get(h.id) ?? 0 })),
      // Tells the page whether horses are missing because of privacy rather than because there are none.
      restricted: !mine && (data ?? []).length > horses.length,
    });
  }),
);

router.get(
  "/people/:id/posts",
  asyncRoute(async (req, res) => {
    try {
      res.json(await feedPage(me(req).id, "author", req.params.id, req));
    } catch (err) {
      unavailable(res, err as DbError);
    }
  }),
);

async function followList(req: Request, res: Response, direction: "followers" | "following") {
  const viewer = me(req).id;
  const offset = Number(req.query.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10_000) return res.status(400).json({ error: "Invalid page." });
  const mineCol = direction === "followers" ? "followee_id" : "follower_id";
  const otherCol = direction === "followers" ? "follower_id" : "followee_id";
  const { data, error } = await supabase
    .from("community_follows")
    .select(`${otherCol},created_at`)
    .eq(mineCol, req.params.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + 60);
  if (error) return unavailable(res, error);
  const ids = (data ?? []).map((r: any) => r[otherCol] as string);
  if (!ids.length) return res.json({ people: [], nextOffset: null });
  const [accounts, mineFollows, profiles] = await Promise.all([
    supabase.from("accounts").select("id,first_name,last_name,status").in("id", ids),
    supabase.from("community_follows").select("followee_id").eq("follower_id", viewer).in("followee_id", ids),
    supabase.from("community_profiles").select("user_id,headline").in("user_id", ids),
  ]);
  if (accounts.error || mineFollows.error || profiles.error) return unavailable(res, accounts.error, mineFollows.error, profiles.error);
  const byId = new Map((accounts.data ?? []).filter((a: any) => a.status === "active").map((a: any) => [a.id, a]));
  const following = new Set((mineFollows.data ?? []).map((r: any) => r.followee_id));
  const headlines = new Map((profiles.data ?? []).map((p: any) => [p.user_id, p.headline]));
  const people = ids
    .filter((id) => byId.has(id))
    .slice(0, 60)
    .map((id) => {
      const a: any = byId.get(id);
      return {
        id,
        name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Stayblz member",
        headline: headlines.get(id) ?? "",
        isFollowing: following.has(id),
        me: id === viewer,
      };
    });
  res.json({ people, nextOffset: ids.length > 60 ? offset + 60 : null });
}
router.get("/people/:id/followers", asyncRoute((req, res) => followList(req, res, "followers")));
router.get("/people/:id/following", asyncRoute((req, res) => followList(req, res, "following")));

for (const action of ["follow", "unfollow"] as const)
  router.post(
    `/people/:id/${action}`,
    followLimit,
    asyncRoute(async (req, res) => {
      const viewer = me(req).id;
      const target = req.params.id;
      if (target === viewer) return res.status(400).json({ error: "You can't follow yourself." });
      if (action === "follow") {
        if (!(await accountActive(target))) return notFound(res, "That member");
        const { error } = await supabase.from("community_follows").insert({ follower_id: viewer, followee_id: target });
        if (error && error.code !== "23505") return unavailable(res, error);
      } else {
        const { error } = await supabase.from("community_follows").delete().eq("follower_id", viewer).eq("followee_id", target);
        if (error) return unavailable(res, error);
      }
      const { count, error } = await supabase
        .from("community_follows")
        .select("follower_id", { count: "exact", head: true })
        .eq("followee_id", target);
      if (error) return unavailable(res, error);
      res.json({ isFollowing: action === "follow", followers: count ?? 0 });
    }),
  );

/* ============================== Horses ============================== */

/** Community horses every member can see (Virtual Stayblz "Public horses"), by name, 24 a page. */
const PUBLIC_PAGE = 24;
const PUBLIC_SEXES = ["colt", "filly", "mare", "stallion", "gelding", "ridgling"];
const PUBLIC_STATUSES = ["racing", "training", "resting", "injured", "retired", "for_sale", "breeding"];
/** Breeds among the public horses, for the Public horses filter. */
router.get(
  "/public-horses/breeds",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.rpc("community_public_horse_breeds", { p_viewer: me(req).id });
    if (error) return unavailable(res, error);
    res.set("Cache-Control", "no-store");
    res.json({ breeds: Array.isArray(data) ? data : [] });
  }),
);
router.get(
  "/public-horses",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 60) : "";
    const pick = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const breed = pick(req.query.breed).slice(0, 60);
    const sex = pick(req.query.sex);
    const status = pick(req.query.status);
    const year = (v: unknown) => {
      const t = pick(v);
      if (!t) return null;
      const n = Number(t);
      return Number.isInteger(n) && n >= 1980 && n <= 2100 ? n : NaN;
    };
    const yearFrom = year(req.query.foaledFrom);
    const yearTo = year(req.query.foaledTo);
    if (
      (sex && !PUBLIC_SEXES.includes(sex)) ||
      (status && !PUBLIC_STATUSES.includes(status)) ||
      Number.isNaN(yearFrom) ||
      Number.isNaN(yearTo)
    )
      return res.status(400).json({ error: "Those filters aren't valid." });
    let before: { name: string; id: string } | null = null;
    if (typeof req.query.before === "string" && req.query.before) {
      try {
        const c = JSON.parse(Buffer.from(req.query.before, "base64url").toString("utf8"));
        if (typeof c?.name !== "string" || !isUuid(c?.id)) throw new Error("bad");
        before = { name: c.name, id: c.id };
      } catch {
        return res.status(400).json({ error: "That page link isn't valid." });
      }
    }
    const { data, error } = await supabase.rpc("community_public_horses", {
      p_viewer: viewer,
      p_query: q,
      p_breed: breed || null,
      p_sex: sex || null,
      p_status: status || null,
      p_year_from: yearFrom,
      p_year_to: yearTo,
      p_raced: req.query.raced === "1" || req.query.raced === "true",
      p_before_name: before?.name ?? null,
      p_before_id: before?.id ?? null,
      p_limit: PUBLIC_PAGE + 1,
    });
    if (error) return unavailable(res, error);
    const rows: any[] = (Array.isArray(data) ? data : []).slice(0, PUBLIC_PAGE);
    const owners = [...new Set(rows.map((h) => h.owner_id))];
    let stats, profiles, names;
    try {
      [stats, profiles, names] = await Promise.all([
        loadStats(rows.map((h) => h.id)),
        owners.length
          ? supabase.from("community_profiles").select("user_id,show_earnings").in("user_id", owners)
          : Promise.resolve({ data: [], error: null }),
        owners.length
          ? supabase.from("accounts").select("id,first_name,last_name").in("id", owners)
          : Promise.resolve({ data: [], error: null }),
      ]);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    if (profiles.error || names.error) return unavailable(res, profiles.error, names.error);
    const hidden = new Set((profiles.data ?? []).filter((p: any) => p.show_earnings === false).map((p: any) => p.user_id));
    const ownerName = new Map(
      (names.data ?? []).map((a: any) => [a.id, `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Stayblz member"]),
    );
    const last = rows[rows.length - 1];
    res.set("Cache-Control", "no-store");
    res.json({
      horses: rows.map((h) => ({
        ...horseView(h, stats.get(h.id), { mine: false, showEarnings: !hidden.has(h.owner_id) }),
        owner: { id: h.owner_id, name: ownerName.get(h.owner_id) ?? "Stayblz member" },
      })),
      next:
        Array.isArray(data) && data.length > PUBLIC_PAGE && last
          ? Buffer.from(JSON.stringify({ name: String(last.sort_name), id: last.id })).toString("base64url")
          : null,
    });
  }),
);

router.get(
  "/horses/:id",
  asyncRoute(async (req, res) => {
    let horse;
    try {
      horse = await loadCommunityHorse(me(req).id, req.params.id);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    if (!horse) return notFound(res, "That horse");
    res.json({ horse });
  }),
);

router.get(
  "/horses/:id/posts",
  asyncRoute(async (req, res) => {
    try {
      res.json(await feedPage(me(req).id, "horse", req.params.id, req));
    } catch (err) {
      unavailable(res, err as DbError);
    }
  }),
);

router.post(
  "/horses",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = horseInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const owner = me(req).id;
    const { count, error: countError } = await supabase
      .from("owner_horses")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", owner);
    if (countError) return unavailable(res, countError);
    if ((count ?? 0) >= 500) return res.status(409).json({ error: "You can register up to 500 horses." });
    const { data, error } = await supabase.from("owner_horses").insert({ ...input, owner_id: owner }).select(HORSE_COLUMNS).single();
    if (error || !data) return unavailable(res, error);
    let shared = false;
    if (req.body?.share === true) {
      const audience = await shareAudience(owner, data.visibility);
      if (audience) {
        const note = typeof req.body.shareText === "string" ? req.body.shareText.trim().slice(0, 2000) : "";
        await sharePost({ author_id: owner, kind: "new_horse", body: note, horse_id: data.id, visibility: audience }).catch(() => undefined);
        shared = true;
      }
    }
    res.status(201).json({ horse: horseView(data, undefined, { mine: true, showEarnings: true, imageCount: 0 }), shared });
  }),
);

router.patch(
  "/horses/:id",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = horseInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const { data, error } = await supabase
      .from("owner_horses")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("owner_id", me(req).id)
      .select(HORSE_COLUMNS)
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That horse");
    const stats = await loadStats([data.id]);
    res.json({ horse: horseView(data, stats.get(data.id), { mine: true, showEarnings: true }) });
  }),
);

router.post(
  "/horses/:id/remove",
  asyncRoute(async (req, res) => {
    const owner = me(req).id;
    const horse = await ownHorse(req.params.id, owner);
    if (!horse) return notFound(res, "That horse");
    const { data: images, error: imagesError } = await supabase.from("owner_horse_images").select("path,poster_path").eq("horse_id", horse.id);
    if (imagesError) return unavailable(res, imagesError);
    const { error } = await supabase.from("owner_horses").delete().eq("id", horse.id).eq("owner_id", owner);
    if (error) return unavailable(res, error);
    await communityStorage.remove((images ?? []).flatMap((i) => [i.path, i.poster_path]).filter(Boolean)).catch(() => undefined);
    res.json({ ok: true });
  }),
);

/* ----- Horse photos ----- */

router.post(
  "/horses/:id/images",
  uploadLimit,
  readImage,
  asyncRoute(async (req, res) => {
    const owner = me(req).id;
    const image = checkedImage(req, res);
    if (!image) return;
    const horse = await ownHorse(req.params.id, owner);
    if (!horse) return notFound(res, "That horse");
    const { count, error: countError } = await supabase
      .from("owner_horse_images")
      .select("id", { count: "exact", head: true })
      .eq("horse_id", horse.id)
      .eq("kind", "photo");
    if (countError) return unavailable(res, countError);
    if ((count ?? 0) >= MAX_HORSE_IMAGES)
      return res.status(409).json({ error: `A horse can have up to ${MAX_HORSE_IMAGES} photos. Remove one first.` });
    const path = `horses/${owner}/${horse.id}/${randomUUID()}`;
    try {
      await communityStorage.upload(path, image.file, image.type);
    } catch {
      return res.status(503).json({ error: "Photo storage is busy. Try again in a moment." });
    }
    const caption = typeof req.query.caption === "string" ? req.query.caption.trim().slice(0, 200) : "";
    const { data, error } = await supabase
      .from("owner_horse_images")
      .insert({
        horse_id: horse.id,
        owner_id: owner,
        path,
        content_type: image.type,
        size_bytes: image.file.length,
        width: image.width,
        height: image.height,
        caption,
        position: await nextPosition(horse.id),
      })
      .select(IMAGE_COLUMNS)
      .single();
    if (error || !data) {
      await communityStorage.remove([path]).catch(() => undefined);
      return unavailable(res, error);
    }
    if (!horse.cover_image_id)
      await supabase.from("owner_horses").update({ cover_image_id: data.id }).eq("id", horse.id).eq("owner_id", owner);
    res.status(201).json({ image: imageView(data), coverImageId: horse.cover_image_id ?? data.id });
  }),
);

router.post(
  "/horses/:id/images/:image/remove",
  asyncRoute(async (req, res) => {
    const owner = me(req).id;
    const horse = await ownHorse(req.params.id, owner);
    if (!horse) return notFound(res, "That horse");
    const { data, error } = await supabase
      .from("owner_horse_images")
      .delete()
      .eq("id", req.params.image)
      .eq("horse_id", horse.id)
      .select("path,poster_path")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That photo");
    await communityStorage.remove([data.path, data.poster_path].filter(Boolean)).catch(() => undefined);
    let cover = horse.cover_image_id === req.params.image ? null : horse.cover_image_id;
    if (!cover) {
      const { data: first } = await supabase
        .from("owner_horse_images")
        .select("id")
        .eq("horse_id", horse.id)
        .eq("kind", "photo")
        .order("position")
        .limit(1)
        .maybeSingle();
      cover = first?.id ?? null;
      await supabase.from("owner_horses").update({ cover_image_id: cover }).eq("id", horse.id).eq("owner_id", owner);
    }
    res.json({ ok: true, coverImageId: cover });
  }),
);

router.post(
  "/horses/:id/images/order",
  asyncRoute(async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_HORSE_IMAGES + MAX_HORSE_VIDEOS || !ids.every(isUuid))
      return res.status(400).json({ error: "That order couldn't be saved." });
    const owner = me(req).id;
    const horse = await ownHorse(req.params.id, owner);
    if (!horse) return notFound(res, "That horse");
    const results = await Promise.all(
      (ids as string[]).map((id, position) =>
        supabase.from("owner_horse_images").update({ position }).eq("id", id).eq("horse_id", horse.id).eq("owner_id", owner),
      ),
    );
    if (results.some((r) => r.error)) return unavailable(res, ...results.map((r) => r.error));
    res.json({ ok: true });
  }),
);

router.post(
  "/horses/:id/cover",
  asyncRoute(async (req, res) => {
    const imageId = req.body?.imageId;
    if (!isUuid(imageId)) return res.status(400).json({ error: "Choose one of this horse's photos." });
    const owner = me(req).id;
    const { data: image, error: imageError } = await supabase
      .from("owner_horse_images")
      .select("id,kind")
      .eq("id", imageId)
      .eq("horse_id", req.params.id)
      .eq("owner_id", owner)
      .maybeSingle();
    if (imageError) return unavailable(res, imageError);
    if (!image) return notFound(res, "That photo");
    if (image.kind === "video") return res.status(400).json({ error: "Choose a photo for the main picture." });
    const { error } = await supabase.from("owner_horses").update({ cover_image_id: imageId }).eq("id", req.params.id).eq("owner_id", owner);
    if (error) return unavailable(res, error);
    res.json({ coverImageId: imageId });
  }),
);

/** New photos and videos go after the horse's existing ones. */
async function nextPosition(horseId: string) {
  const { data } = await supabase
    .from("owner_horse_images")
    .select("position")
    .eq("horse_id", horseId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? Number(data.position) + 1 : 0;
}

/* ----- Horse videos ----- */

const whole = (v: unknown) => (typeof v === "string" && /^\d{1,5}$/.test(v) && Number(v) > 0 ? Number(v) : null);
/** Without R2 a video is read into memory before it goes to Supabase, so only a couple at once. */
let bufferedVideoUploads = 0;
const MAX_BUFFERED_VIDEO_UPLOADS = 2;

/**
 * POST /horses/:id/videos?duration=…&width=…&height=…   (body: the video, with Content-Length)
 * MP4 / MOV / WebM, up to 100 MB (50 MB while files are kept in Supabase) and 3 minutes; 3 per horse.
 */
router.post(
  "/horses/:id/videos",
  uploadLimit,
  asyncRoute(async (req, res) => {
    const owner = me(req).id;
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const spec = VIDEO_TYPES[type];
    const drop = () => req.resume();
    if (!spec) {
      drop();
      return res.status(415).json({ error: "Videos must be MP4, MOV or WebM.", code: "file_type" });
    }
    const length = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(length) || length <= 0) {
      drop();
      return res.status(411).json({ error: "That video couldn't be read." });
    }
    const max = communityVideos.maxBytes();
    if (length > max) {
      drop();
      return res.status(413).json({ error: `Videos can be up to ${Math.round(max / 1024 / 1024)} MB.`, code: "file_too_large" });
    }
    const duration = whole(req.query.duration);
    if (duration !== null && duration > MAX_VIDEO_SECONDS) {
      drop();
      return res.status(400).json({ error: "Videos can be up to 3 minutes long.", code: "too_long" });
    }
    const horse = await ownHorse(req.params.id, owner);
    if (!horse) {
      drop();
      return notFound(res, "That horse");
    }
    const { count, error: countError } = await supabase
      .from("owner_horse_images")
      .select("id", { count: "exact", head: true })
      .eq("horse_id", horse.id)
      .eq("kind", "video");
    if (countError) {
      drop();
      return unavailable(res, countError);
    }
    if ((count ?? 0) >= MAX_HORSE_VIDEOS) {
      drop();
      return res.status(409).json({ error: `A horse can have up to ${MAX_HORSE_VIDEOS} videos. Remove one first.` });
    }
    const buffered = communityVideos.backend() === "supabase";
    if (buffered) {
      if (bufferedVideoUploads >= MAX_BUFFERED_VIDEO_UPLOADS) {
        drop();
        return res.status(503).json({ error: "Other videos are uploading right now. Try again in a minute." });
      }
      bufferedVideoUploads++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          bufferedVideoUploads--;
        }
      };
      res.on("finish", release);
      res.on("close", release);
    }

    const { head, body } = await peek(req, 16);
    if (!spec.looksRight(head)) {
      drop();
      return res.status(415).json({ error: "That file doesn't look like the type of video it claims to be.", code: "file_type" });
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
    const path = `horses/${owner}/${horse.id}/${randomUUID()}.${spec.extension}`;
    try {
      await communityVideos.putStream(path, limited, length, type);
    } catch (e) {
      drop();
      const tooBig = e instanceof StorageError && e.code === "too_large";
      return res
        .status(tooBig ? 413 : 503)
        .json({ error: tooBig ? "That video is too large." : "Video storage is busy. Try again in a moment." });
    }
    const { data, error } = await supabase
      .from("owner_horse_images")
      .insert({
        horse_id: horse.id,
        owner_id: owner,
        kind: "video",
        path,
        content_type: type,
        size_bytes: length,
        width: whole(req.query.width),
        height: whole(req.query.height),
        duration_seconds: duration,
        position: await nextPosition(horse.id),
      })
      .select(IMAGE_COLUMNS)
      .single();
    if (error || !data) {
      await communityStorage.remove([path]).catch(() => undefined);
      return unavailable(res, error);
    }
    res.status(201).json({ image: imageView(data), coverImageId: horse.cover_image_id });
  }),
);

/** POST /horses/:id/images/:image/poster   (body: a JPEG frame from the video, captured in the browser) */
router.post(
  "/horses/:id/images/:image/poster",
  uploadLimit,
  readImage,
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.image)) return notFound(res, "That video");
    const owner = me(req).id;
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const file = req.body;
    if (type !== "image/jpeg" || !Buffer.isBuffer(file) || !IMAGE_TYPES["image/jpeg"](file))
      return res.status(415).json({ error: "The video's cover frame must be a JPG." });
    if (file.length > MAX_POSTER_BYTES) return res.status(413).json({ error: "That cover frame is too large." });
    const { data: video, error } = await supabase
      .from("owner_horse_images")
      .select("id,kind,path,poster_path")
      .eq("id", req.params.image)
      .eq("horse_id", req.params.id)
      .eq("owner_id", owner)
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!video || video.kind !== "video") return notFound(res, "That video");
    const path = `${video.path}.poster-${randomUUID().slice(0, 8)}.jpg`;
    try {
      await communityStorage.upload(path, file, "image/jpeg");
    } catch {
      return res.status(503).json({ error: "Photo storage is busy. Try again in a moment." });
    }
    const { data, error: saveError } = await supabase
      .from("owner_horse_images")
      .update({ poster_path: path })
      .eq("id", video.id)
      .eq("owner_id", owner)
      .select(IMAGE_COLUMNS)
      .single();
    if (saveError || !data) {
      await communityStorage.remove([path]).catch(() => undefined);
      return unavailable(res, saveError);
    }
    if (video.poster_path) await communityStorage.remove([video.poster_path]).catch(() => undefined);
    res.json({ image: imageView(data) });
  }),
);

/* ----- Share a horse to the Feed ----- */

/**
 * POST /horses/:id/share  { body?, visibility?: "members" | "followers", makeVisible?: true }
 * Posts the owner's horse to the Feed. The post shows the horse's current photos and videos.
 * A private horse can't be shared unless the owner agrees to make it visible to everyone
 * (makeVisible); a followers-only horse is always shared to followers.
 */
router.post(
  "/horses/:id/share",
  postLimit,
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = horseShareInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const owner = me(req).id;
    const horse = await ownHorse(req.params.id, owner);
    if (!horse) return notFound(res, "That horse");
    let audience = await shareAudience(owner, horse.visibility);
    if (!audience) {
      if (!input.makeVisible)
        return res.status(409).json({ error: "Only you can see this horse. Make it visible to share it.", code: "horse_private" });
      const { error } = await supabase
        .from("owner_horses")
        .update({ visibility: "members", updated_at: new Date().toISOString() })
        .eq("id", horse.id)
        .eq("owner_id", owner);
      if (error) return unavailable(res, error);
      audience = "members";
    }
    const visibility = audience === "followers" ? "followers" : input.visibility;
    const { data: post, error } = await supabase
      .from("community_posts")
      .insert({ author_id: owner, kind: "horse_share", body: input.body, horse_id: horse.id, visibility })
      .select("id")
      .single();
    if (error || !post) return unavailable(res, error);
    const view = await visiblePost(owner, post.id).catch(() => null);
    res.status(201).json({ post: view });
  }),
);

/* ----- Race records ----- */

const RECORD_COLUMNS = "id,horse_id,race_date,track,race_name,distance,surface,finish,field_size,earnings_cents,notes";

router.post(
  "/horses/:id/records",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = recordInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const owner = me(req).id;
    const horse = await ownHorse(req.params.id, owner);
    if (!horse) return notFound(res, "That horse");
    const { data, error } = await supabase
      .from("owner_horse_records")
      .insert({ ...input, horse_id: horse.id, owner_id: owner })
      .select(RECORD_COLUMNS)
      .single();
    if (error || !data) return unavailable(res, error);
    let shared = false;
    if (req.body?.share === true) {
      const audience = await shareAudience(owner, horse.visibility);
      if (audience) {
        const { data: profile } = await supabase.from("community_profiles").select("show_earnings").eq("user_id", owner).maybeSingle();
        const showEarnings = profile?.show_earnings ?? true;
        const note = typeof req.body.shareText === "string" ? req.body.shareText.trim().slice(0, 2000) : "";
        await sharePost({
          author_id: owner,
          kind: data.finish === 1 ? "achievement" : "result",
          body: note,
          horse_id: horse.id,
          visibility: audience,
          result: {
            raceDate: data.race_date,
            track: data.track,
            raceName: data.race_name,
            distance: data.distance,
            surface: data.surface,
            finish: data.finish,
            fieldSize: data.field_size,
            ...(showEarnings ? { earningsCents: Number(data.earnings_cents) } : {}),
          },
        }).catch(() => undefined);
        shared = true;
      }
    }
    const stats = await loadStats([horse.id]);
    res.status(201).json({ record: recordView(data, true), stats: horseView(horse, stats.get(horse.id), { mine: true, showEarnings: true }).stats, shared });
  }),
);

router.patch(
  "/records/:id",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = recordInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const owner = me(req).id;
    const { data, error } = await supabase
      .from("owner_horse_records")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("owner_id", owner)
      .select(RECORD_COLUMNS)
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That race record");
    const horse = await ownHorse(data.horse_id, owner);
    const stats = await loadStats([data.horse_id]);
    res.json({
      record: recordView(data, true),
      stats: horse ? horseView(horse, stats.get(data.horse_id), { mine: true, showEarnings: true }).stats : null,
    });
  }),
);

router.post(
  "/records/:id/remove",
  asyncRoute(async (req, res) => {
    const owner = me(req).id;
    const { data, error } = await supabase
      .from("owner_horse_records")
      .delete()
      .eq("id", req.params.id)
      .eq("owner_id", owner)
      .select("horse_id")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That race record");
    const horse = await ownHorse(data.horse_id, owner);
    const stats = await loadStats([data.horse_id]);
    res.json({ ok: true, stats: horse ? horseView(horse, stats.get(data.horse_id), { mine: true, showEarnings: true }).stats : null });
  }),
);

/* ============================== Setup check (admins) ============================== */

/**
 * GET /api/community/setup-check — admins only. Probes every table, function and the
 * storage bucket the community needs, so a missing migration shows up by name.
 */
router.get(
  "/setup-check",
  asyncRoute(async (req, res) => {
    if (roleRank(me(req).role) < roleRank("admin")) return notFound(res);
    const viewer = me(req).id;
    const tables = [
      "community_profiles", "owner_horses", "owner_horse_images", "owner_horse_records",
      "community_follows", "community_posts", "community_post_images", "community_likes",
      "community_comments", "owner_horse_stats",
    ];
    const describe = (error: DbError) => (error ? `${error.code ?? "?"} ${error.message ?? ""}`.trim() : "ok");
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    for (const t of tables) {
      const { error } = await supabase.from(t).select("*").limit(0);
      checks.push({ name: `table ${t}`, ok: !error, detail: describe(error) });
    }
    const rpcs: [string, Record<string, unknown>][] = [
      ["community_people", { p_viewer: viewer, p_query: null, p_sort: null, p_limit: 1, p_offset: 0, p_only: viewer }],
      ["community_feed", { p_viewer: viewer, p_scope: "all", p_target: null, p_before_time: null, p_before_id: null, p_after: null, p_limit: 1 }],
    ];
    for (const [fn, args] of rpcs) {
      const { error } = await supabase.rpc(fn, args);
      checks.push({ name: `function ${fn}`, ok: !error, detail: describe(error) });
    }
    const bucket = await supabase.storage.getBucket("community-media");
    checks.push({ name: "storage bucket community-media", ok: !bucket.error, detail: bucket.error ? bucket.error.message : "ok" });
    res.json({ ok: checks.every((c) => c.ok), checks });
  }),
);

/* ============================== Quick search (header search box) ============================== */

/**
 * Suggestions while typing in the site search: members and horses whose name matches.
 * Horses only appear when the viewer may see them; suspended accounts never appear.
 */
router.get(
  "/search",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const q = searchText(req.query.q);
    if (q.replace(/\\/g, "").length < 2) return res.json({ people: [], horses: [] });
    const [people, horses] = await Promise.all([
      supabase.rpc("community_people", { p_viewer: viewer, p_query: q, p_sort: "horses", p_limit: 6, p_offset: 0, p_only: null }),
      supabase
        .from("owner_horses")
        .select("id,owner_id,name,breed,status,visibility,cover_image_id")
        .ilike("name", `%${q}%`)
        .order("name")
        .limit(40),
    ]);
    if (people.error || horses.error) return unavailable(res, people.error, horses.error);

    // Keep only horses this viewer may see: active owner, then the owner's and the horse's privacy.
    const rows = horses.data ?? [];
    const owners = [...new Set(rows.map((h) => h.owner_id))];
    let visible: typeof rows = [];
    const names = new Map<string, string>();
    if (owners.length) {
      const [accounts, profiles, follows] = await Promise.all([
        supabase.from("accounts").select("id,first_name,last_name,status").in("id", owners),
        supabase.from("community_profiles").select("user_id,inventory_visibility").in("user_id", owners),
        supabase.from("community_follows").select("followee_id").eq("follower_id", viewer).in("followee_id", owners),
      ]);
      if (accounts.error || profiles.error || follows.error) return unavailable(res, accounts.error, profiles.error, follows.error);
      for (const a of accounts.data ?? [])
        if (a.status === "active") names.set(a.id, `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Stayblz member");
      const levels = new Map((profiles.data ?? []).map((p) => [p.user_id, p.inventory_visibility as OwnerContext["level"]]));
      const followed = new Set((follows.data ?? []).map((f) => f.followee_id));
      visible = rows.filter(
        (h) =>
          names.has(h.owner_id) &&
          canSeeHorse(viewer, h, { level: levels.get(h.owner_id) ?? "members", follows: followed.has(h.owner_id), showEarnings: true, headline: "" }),
      );
    }
    // Names that start with the search come first.
    const lower = q.replace(/\\/g, "").toLowerCase();
    visible.sort((a, b) => Number(!a.name.toLowerCase().startsWith(lower)) - Number(!b.name.toLowerCase().startsWith(lower)));

    res.json({
      people: (Array.isArray(people.data) ? people.data : []).map((r: any) => ({
        id: r.id,
        name: r.name || "Stayblz member",
        headline: r.headline ?? "",
        horses: num(r.horses),
        me: !!r.me,
      })),
      horses: visible.slice(0, 6).map((h) => ({
        id: h.id,
        name: h.name,
        breed: h.breed,
        status: h.status,
        coverImageId: h.cover_image_id,
        owner: { id: h.owner_id, name: names.get(h.owner_id) ?? "Stayblz member" },
        mine: h.owner_id === viewer,
      })),
    });
  }),
);

/* ============================== Feed & posts ============================== */

router.get(
  "/feed",
  asyncRoute(async (req, res) => {
    const scope = req.query.scope === "following" ? "following" : "all";
    try {
      res.json(await feedPage(me(req).id, scope, null, req));
    } catch (err) {
      unavailable(res, err as DbError);
    }
  }),
);

/** How many newer posts exist since `since` (for the "New posts" button). */
router.get(
  "/feed/new",
  asyncRoute(async (req, res) => {
    const since = typeof req.query.since === "string" && Number.isFinite(Date.parse(req.query.since)) ? req.query.since : null;
    if (!since) return res.status(400).json({ error: "Invalid request." });
    const { data, error } = await supabase.rpc("community_feed", {
      p_viewer: me(req).id,
      p_scope: req.query.scope === "following" ? "following" : "all",
      p_target: null,
      p_before_time: null,
      p_before_id: null,
      p_after: since,
      p_limit: 50,
    });
    if (error) return unavailable(res, error);
    const posts = (Array.isArray(data) ? data : []).filter((p: any) => p.author?.id !== me(req).id);
    res.json({ count: posts.length });
  }),
);

router.get(
  "/posts/:id",
  asyncRoute(async (req, res) => {
    let failure: DbError;
    const post = await visiblePost(me(req).id, req.params.id).catch((err) => { failure = err as DbError; return undefined; });
    if (post === undefined) return unavailable(res, failure);
    if (!post) return notFound(res, "That post");
    res.json({ post });
  }),
);

/** Photos for a new post are uploaded first, then attached when the post is published. */
router.post(
  "/uploads",
  uploadLimit,
  readImage,
  asyncRoute(async (req, res) => {
    const author = me(req).id;
    const image = checkedImage(req, res);
    if (!image) return;
    const { count, error: countError } = await supabase
      .from("community_post_images")
      .select("id", { count: "exact", head: true })
      .eq("author_id", author)
      .is("post_id", null);
    if (countError) return unavailable(res, countError);
    if ((count ?? 0) >= MAX_PENDING_POST_IMAGES)
      return res.status(409).json({ error: "Publish or remove the photos you've already added first." });
    const path = `posts/${author}/${randomUUID()}`;
    try {
      await communityStorage.upload(path, image.file, image.type);
    } catch {
      return res.status(503).json({ error: "Photo storage is busy. Try again in a moment." });
    }
    const { data, error } = await supabase
      .from("community_post_images")
      .insert({ author_id: author, path, content_type: image.type, size_bytes: image.file.length, width: image.width, height: image.height })
      .select("id,width,height")
      .single();
    if (error || !data) {
      await communityStorage.remove([path]).catch(() => undefined);
      return unavailable(res, error);
    }
    res.status(201).json({ image: data });
  }),
);

router.post(
  "/uploads/:image/remove",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("community_post_images")
      .delete()
      .eq("id", req.params.image)
      .eq("author_id", me(req).id)
      .is("post_id", null)
      .select("path")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (data) await communityStorage.remove([data.path]).catch(() => undefined);
    res.json({ ok: true });
  }),
);

router.post(
  "/posts",
  postLimit,
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = postInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const user = me(req);
    if (input.kind === "announcement" && roleRank(user.role) < roleRank("admin"))
      return res.status(403).json({ error: "Only Stayblz staff can post announcements." });
    if (input.horse_id && !(await ownHorse(input.horse_id, user.id)))
      return res.status(400).json({ error: "You can only tag your own horses." });
    if (input.imageIds.length) {
      const { data: pending, error } = await supabase
        .from("community_post_images")
        .select("id")
        .in("id", input.imageIds)
        .eq("author_id", user.id)
        .is("post_id", null);
      if (error) return unavailable(res, error);
      if ((pending ?? []).length !== input.imageIds.length)
        return res.status(400).json({ error: "Some photos are no longer available. Add them again." });
    }
    const { data: post, error } = await supabase
      .from("community_posts")
      .insert({
        author_id: user.id,
        kind: input.horse_id && input.kind === "update" ? "horse_update" : input.kind,
        body: input.body,
        horse_id: input.horse_id,
        visibility: input.visibility,
      })
      .select("id")
      .single();
    if (error || !post) return unavailable(res, error);
    const attached = await Promise.all(
      input.imageIds.map((id, position) =>
        supabase.from("community_post_images").update({ post_id: post.id, position }).eq("id", id).eq("author_id", user.id).is("post_id", null),
      ),
    );
    if (attached.some((r) => r.error)) {
      await supabase.from("community_posts").delete().eq("id", post.id);
      return unavailable(res, ...attached.map((r) => r.error));
    }
    const view = await visiblePost(user.id, post.id).catch(() => null);
    res.status(201).json({ post: view });
  }),
);

router.patch(
  "/posts/:id",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = postEditInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const user = me(req);
    const { data: images } = await supabase.from("community_post_images").select("id").eq("post_id", req.params.id).limit(1);
    if (!input.body && !(images ?? []).length) return res.status(400).json({ error: "Write something or add a photo." });
    const { data, error } = await supabase
      .from("community_posts")
      .update({ body: input.body, edited_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("author_id", user.id)
      .select("id")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That post");
    res.json({ post: await visiblePost(user.id, data.id) });
  }),
);

router.post(
  "/posts/:id/remove",
  asyncRoute(async (req, res) => {
    const user = me(req);
    const { data: post, error: postError } = await supabase.from("community_posts").select("id,author_id").eq("id", req.params.id).maybeSingle();
    if (postError) return unavailable(res, postError);
    if (!post) return notFound(res, "That post");
    const staff = roleRank(user.role) >= roleRank("admin");
    if (post.author_id !== user.id && !staff) return res.status(403).json({ error: "You can only remove your own posts." });
    const { data: images } = await supabase.from("community_post_images").select("path").eq("post_id", post.id);
    const { error } = await supabase.from("community_posts").delete().eq("id", post.id);
    if (error) return unavailable(res, error);
    await communityStorage.remove((images ?? []).map((i) => i.path)).catch(() => undefined);
    res.json({ ok: true });
  }),
);

router.post(
  "/posts/:id/like",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const on = req.body?.on !== false;
    const post = await visiblePost(viewer, req.params.id).catch(() => undefined);
    if (post === undefined) return unavailable(res);
    if (!post) return notFound(res, "That post");
    const { error } = on
      ? await supabase.from("community_likes").upsert({ post_id: post.id, user_id: viewer }, { onConflict: "post_id,user_id", ignoreDuplicates: true })
      : await supabase.from("community_likes").delete().eq("post_id", post.id).eq("user_id", viewer);
    if (error) return unavailable(res, error);
    const { count } = await supabase.from("community_likes").select("user_id", { count: "exact", head: true }).eq("post_id", post.id);
    res.json({ liked: on, likes: count ?? 0 });
  }),
);

router.get(
  "/posts/:id/comments",
  asyncRoute(async (req, res) => {
    const viewer = me(req);
    const post = await visiblePost(viewer.id, req.params.id).catch(() => undefined);
    if (post === undefined) return unavailable(res);
    if (!post) return notFound(res, "That post");
    const { data, error } = await supabase
      .from("community_comments")
      .select("id,author_id,body,created_at")
      .eq("post_id", post.id)
      .order("created_at", { ascending: true })
      .limit(300);
    if (error) return unavailable(res, error);
    const ids = [...new Set((data ?? []).map((c) => c.author_id))];
    const { data: authors, error: authorError } = ids.length
      ? await supabase.from("accounts").select("id,first_name,last_name,status").in("id", ids)
      : { data: [], error: null };
    if (authorError) return unavailable(res, authorError);
    const names = new Map(
      (authors ?? []).filter((a: any) => a.status === "active").map((a: any) => [a.id, `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim()]),
    );
    const staff = roleRank(viewer.role) >= roleRank("admin");
    res.json({
      comments: (data ?? [])
        .filter((c) => names.has(c.author_id))
        .map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.created_at,
          author: { id: c.author_id, name: names.get(c.author_id) || "Stayblz member" },
          canRemove: c.author_id === viewer.id || post.mine || staff,
        })),
    });
  }),
);

router.post(
  "/posts/:id/comments",
  postLimit,
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = commentInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const viewer = me(req);
    const post = await visiblePost(viewer.id, req.params.id).catch(() => undefined);
    if (post === undefined) return unavailable(res);
    if (!post) return notFound(res, "That post");
    const { data, error } = await supabase
      .from("community_comments")
      .insert({ post_id: post.id, author_id: viewer.id, body: input.body })
      .select("id,body,created_at")
      .single();
    if (error || !data) return unavailable(res, error);
    res.status(201).json({
      comment: {
        id: data.id,
        body: data.body,
        createdAt: data.created_at,
        author: { id: viewer.id, name: viewer.displayName || "Stayblz member" },
        canRemove: true,
      },
    });
  }),
);

router.post(
  "/comments/:id/remove",
  asyncRoute(async (req, res) => {
    const viewer = me(req);
    const { data: comment, error } = await supabase.from("community_comments").select("id,author_id,post_id").eq("id", req.params.id).maybeSingle();
    if (error) return unavailable(res, error);
    if (!comment) return notFound(res, "That comment");
    let allowed = comment.author_id === viewer.id || roleRank(viewer.role) >= roleRank("admin");
    if (!allowed) {
      const { data: post } = await supabase.from("community_posts").select("author_id").eq("id", comment.post_id).maybeSingle();
      allowed = post?.author_id === viewer.id;
    }
    if (!allowed) return res.status(403).json({ error: "You can't remove that comment." });
    const { error: deleteError } = await supabase.from("community_comments").delete().eq("id", comment.id);
    if (deleteError) return unavailable(res, deleteError);
    res.json({ ok: true });
  }),
);

/* ============================== Photos (streamed after a visibility check) ============================== */

async function sendImage(res: Response, path: string, type: string) {
  let file: Buffer;
  try {
    file = await communityStorage.download(path);
  } catch {
    return notFound(res, "That photo");
  }
  res.setHeader("Content-Type", IMAGE_TYPES[type] ? type : "application/octet-stream");
  res.setHeader("Content-Length", String(file.length));
  res.setHeader("Content-Disposition", "inline");
  // Private: only this browser may cache it, briefly, so privacy changes take effect.
  res.setHeader("Cache-Control", "private, max-age=600");
  res.end(file);
}

/** A horse photo or video row, when this viewer may see the horse (answers 404/503 itself otherwise). */
async function visibleHorseMedia(req: Request, res: Response) {
  const viewer = me(req).id;
  const { data: image, error } = await supabase
    .from("owner_horse_images")
    .select("path,kind,content_type,size_bytes,poster_path,horse_id,owner_id")
    .eq("id", req.params.image)
    .maybeSingle();
  if (error) return void unavailable(res, error);
  if (!image) return void notFound(res, "That photo");
  const { data: horse, error: horseError } = await supabase.from("owner_horses").select("owner_id,visibility").eq("id", image.horse_id).maybeSingle();
  if (horseError) return void unavailable(res, horseError);
  if (!horse) return void notFound(res, "That photo");
  if (viewer !== horse.owner_id) {
    if (!(await accountActive(horse.owner_id))) return void notFound(res, "That photo");
    const ctx = await ownerContext(viewer, horse.owner_id);
    if (!canSeeHorse(viewer, horse, ctx)) return void notFound(res, "That photo");
  }
  return image;
}

/** GET /media/horse/:image — a horse photo, or a video streamed in parts (Range) so it can start and seek quickly. */
router.get(
  "/media/horse/:image",
  asyncRoute(async (req, res) => {
    const image = await visibleHorseMedia(req, res);
    if (!image) return;
    if (image.kind !== "video") return sendImage(res, image.path, image.content_type);
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    let file;
    try {
      file = await communityVideos.open(image.path, range);
    } catch (e) {
      if ((e as Error).message === "range_not_satisfiable") {
        res.setHeader("Content-Range", `bytes */${image.size_bytes}`);
        return res.status(416).end();
      }
      if (e instanceof StorageError && e.code === "not_found") return notFound(res, "That video");
      return res.status(503).json({ error: "Video storage is busy. Try again in a moment." });
    }
    res.status(file.partial ? 206 : 200);
    res.setHeader("Content-Type", VIDEO_TYPES[image.content_type] ? image.content_type : "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, max-age=600");
    if (file.size !== null) res.setHeader("Content-Length", String(file.size));
    if (file.partial && file.contentRange) res.setHeader("Content-Range", file.contentRange);
    // Stop reading from storage as soon as the viewer leaves or skips ahead.
    res.on("close", () => file.stream.destroy());
    file.stream.on("error", () => res.destroy());
    file.stream.pipe(res);
  }),
);

/** GET /media/horse/:image/poster — a horse video's cover frame. */
router.get(
  "/media/horse/:image/poster",
  asyncRoute(async (req, res) => {
    const image = await visibleHorseMedia(req, res);
    if (!image) return;
    if (image.kind !== "video" || !image.poster_path) return notFound(res, "That picture");
    await sendImage(res, image.poster_path, "image/jpeg");
  }),
);

router.get(
  "/media/post/:image",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const { data: image, error } = await supabase
      .from("community_post_images")
      .select("path,content_type,post_id,author_id")
      .eq("id", req.params.image)
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!image) return notFound(res, "That photo");
    if (!image.post_id) {
      // Not published yet: only the person who uploaded it.
      if (image.author_id !== viewer) return notFound(res, "That photo");
    } else {
      const post = await visiblePost(viewer, image.post_id).catch(() => undefined);
      if (post === undefined) return unavailable(res);
      if (!post) return notFound(res, "That photo");
    }
    await sendImage(res, image.path, image.content_type);
  }),
);

export default router;