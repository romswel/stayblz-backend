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
import { LOCKED_COLUMNS, LinkError, bustFollowerCounts, linkColumns, resolveRacingHorse } from "../lib/formFavLink";
import { syncLinkedHorse } from "../lib/formFavSync";
import {
  HORSE_COLUMNS,
  IMAGE_COLUMNS,
  accountActive,
  canSeeHorse,
  coOwnedIds,
  coOwnerCounts,
  horseRole,
  horseView,
  imageView,
  loadCommunityHorse,
  loadOwners,
  loadStats,
  ownerContext,
  ownerIds,
  recordView,
  type HorseRole,
  type OwnerContext,
} from "../lib/communityHorses";
import { horseAlert } from "../lib/horseAlerts";
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
router.param("account", (req, res, next, id) => (isUuid(id) ? next() : notFound(res, "That member")));
router.param("change", (req, res, next, id) => (isUuid(id) ? next() : notFound(res, "That change")));

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

/** A horse this member is the lead owner of (only the lead deletes it, manages owners and links race data). */
async function ownHorse(horseId: string, owner: string) {
  const { data, error } = await supabase.from("owner_horses").select(HORSE_COLUMNS).eq("id", horseId).eq("owner_id", owner).maybeSingle();
  if (error) throw error;
  return data;
}

/** A horse this member may edit: its lead owner or an accepted co-owner, with their role. */
async function editableHorse(horseId: string, viewer: string): Promise<{ horse: any; role: HorseRole } | null> {
  const { data, error } = await supabase.from("owner_horses").select(HORSE_COLUMNS).eq("id", horseId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const role = await horseRole(data, viewer);
  return role ? { horse: data, role } : null;
}

/** Edit access, or the right answer: 404 for strangers. Answers 503 itself on database errors. */
async function editable(req: Request, res: Response, horseId = req.params.id) {
  try {
    const found = await editableHorse(horseId, me(req).id);
    if (!found) notFound(res, "That horse");
    return found;
  } catch (err) {
    unavailable(res, err as DbError);
    return null;
  }
}

/** Lead-owner access: co-owners hear why they can't (403), strangers get 404. */
async function leadOnly(req: Request, res: Response, what: string) {
  const found = await editable(req, res);
  if (!found) return null;
  if (found.role !== "lead") {
    res.status(403).json({ error: `Only the lead owner can ${what}.`, code: "lead_only" });
    return null;
  }
  return found.horse;
}

const horseLink = (id: string, tab?: string) => `/account/horses?edit=${id}${tab ? `&tab=${tab}` : ""}`;

/** Tell the horse's other owners (fire and forget; never throws). */
function tellOwners(horse: { id: string; owner_id: string; name: string }, actor: string, title: string, body: string, link?: string, collapse = false) {
  ownerIds(horse)
    .then((ids) => horseAlert(ids, actor, horse.id, { title, body, link: link ?? `/community/horses/${horse.id}` }, collapse))
    .catch(() => undefined);
}

const clipName = (name: string) => (name.length > 60 ? name.slice(0, 59) + "…" : name);


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
    const self = viewer === owner;
    let coOwned: Set<string>;
    try {
      coOwned = new Set(await coOwnedIds(viewer));
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    const { data, error } = await supabase
      .from("owner_horses")
      .select(HORSE_COLUMNS)
      .eq("owner_id", owner)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return unavailable(res, error);
    const horses = (data ?? []).filter((h) => canSeeHorse(viewer, h, ctx, coOwned.has(h.id)));
    // My horses: the horses I co-own with other members are mine too.
    if (self && coOwned.size) {
      const shared = await supabase.from("owner_horses").select(HORSE_COLUMNS).in("id", [...coOwned]).neq("owner_id", viewer);
      if (shared.error) return unavailable(res, shared.error);
      const active = await Promise.all((shared.data ?? []).map((h) => accountActive(h.owner_id)));
      horses.push(...(shared.data ?? []).filter((_, i) => active[i]));
      horses.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    }
    const ids = horses.map((h) => h.id);
    let coCounts: Map<string, number>;
    try {
      coCounts = await coOwnerCounts(ids);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    const [stats, images, changes] = await Promise.all([
      loadStats(ids),
      ids.length
        ? supabase.from("owner_horse_images").select("horse_id").in("horse_id", ids)
        : Promise.resolve({ data: [] as { horse_id: string }[], error: null }),
      self && ids.length
        ? supabase.from("owner_horse_changes").select("horse_id").in("horse_id", ids).eq("status", "pending")
        : Promise.resolve({ data: [] as { horse_id: string }[], error: null }),
    ]);
    if (images.error || changes.error) return unavailable(res, images.error, changes.error);
    const counts = new Map<string, number>();
    for (const i of images.data ?? []) counts.set(i.horse_id, (counts.get(i.horse_id) ?? 0) + 1);
    const waiting = new Map<string, number>();
    for (const c of changes.data ?? []) waiting.set(c.horse_id, (waiting.get(c.horse_id) ?? 0) + 1);
    res.json({
      horses: horses.map((h) => {
        const role: HorseRole | null = h.owner_id === viewer ? "lead" : coOwned.has(h.id) ? "coowner" : null;
        const mine = role !== null;
        return {
          ...horseView(h, stats.get(h.id), {
            mine,
            role,
            coOwners: coCounts.get(h.id) ?? 0,
            showEarnings: ctx.showEarnings,
            imageCount: counts.get(h.id) ?? 0,
          }),
          pendingChanges: mine ? (waiting.get(h.id) ?? 0) : undefined,
        };
      }),
      // Tells the page whether horses are missing because of privacy rather than because there are none.
      restricted: !self && (data ?? []).length > horses.length,
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
    // Most followed first (distinct people tracking it in Virtual Stayblz), then A–Z; the cursor holds all three.
    let before: { followers: number; name: string; id: string } | null = null;
    if (typeof req.query.before === "string" && req.query.before) {
      try {
        const c = JSON.parse(Buffer.from(req.query.before, "base64url").toString("utf8"));
        if (typeof c?.name !== "string" || !isUuid(c?.id) || !Number.isInteger(c?.f) || c.f < 0) throw new Error("bad");
        before = { followers: c.f, name: c.name, id: c.id };
      } catch {
        return res.status(400).json({ error: "That page link isn't valid." });
      }
    }
    const { data, error } = await supabase.rpc("community_public_horses_v2", {
      p_viewer: viewer,
      p_query: q,
      p_breed: breed || null,
      p_sex: sex || null,
      p_status: status || null,
      p_year_from: yearFrom,
      p_year_to: yearTo,
      p_raced: req.query.raced === "1" || req.query.raced === "true",
      p_before_followers: before?.followers ?? null,
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
        followers: Number(h.followers ?? 0),
      })),
      next:
        Array.isArray(data) && data.length > PUBLIC_PAGE && last
          ? Buffer.from(JSON.stringify({ f: Number(last.followers ?? 0), name: String(last.sort_name), id: last.id })).toString("base64url")
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
    const found = await editable(req, res);
    if (!found) return;
    const { horse: current, role } = found;
    const viewer = me(req).id;
    // Linked to race data: what race data keeps up to date stays as it is.
    const update: Record<string, unknown> = { ...input };
    if (current.formfav_key) for (const column of LOCKED_COLUMNS) update[column] = (current as any)[column];
    // Who can see the horse is the lead owner's choice.
    if (role !== "lead") update.visibility = current.visibility;
    const coOwners = (await coOwnerCounts([current.id]).catch(() => new Map<string, number>())).get(current.id) ?? 0;
    const view = async (row: any) =>
      horseView(row, (await loadStats([row.id])).get(row.id), { mine: true, showEarnings: true, role, coOwners });

    if (role === "coowner" && current.require_approval) {
      const fields = changedFields(current, update);
      if (!Object.keys(fields).length) return res.json({ horse: await view(current) });
      // One open proposal per owner: a newer edit replaces the earlier one.
      await supabase
        .from("owner_horse_changes")
        .update({ status: "withdrawn", decided_at: new Date().toISOString() })
        .eq("horse_id", current.id)
        .eq("proposed_by", viewer)
        .eq("kind", "details")
        .eq("status", "pending");
      const change = await proposeChange(current, viewer, "details", null, { fields });
      if (!change) return unavailable(res);
      return res.status(202).json({ horse: await view(current), pending: change });
    }

    const data = await applyDetails(current, update);
    if (!data) return unavailable(res);
    tellOwners(current, viewer, `${clipName(current.name)} was updated`, "Details changed by a co-owner. Tap to see the horse.", undefined, true);
    res.json({ horse: await view(data) });
  }),
);

router.post(
  "/horses/:id/remove",
  asyncRoute(async (req, res) => {
    const owner = me(req).id;
    const horse = await leadOnly(req, res, "remove this horse");
    if (!horse) return;
    const { data: images, error: imagesError } = await supabase.from("owner_horse_images").select("path,poster_path").eq("horse_id", horse.id);
    if (imagesError) return unavailable(res, imagesError);
    const owners = await ownerIds(horse).catch(() => [] as string[]);
    const { error } = await supabase.from("owner_horses").delete().eq("id", horse.id).eq("owner_id", owner);
    if (error) return unavailable(res, error);
    await communityStorage.remove((images ?? []).flatMap((i) => [i.path, i.poster_path]).filter(Boolean)).catch(() => undefined);
    horseAlert(owners, owner, horse.id, {
      title: `${clipName(horse.name)} was removed`,
      body: "The lead owner removed this horse from Stayblz.",
      link: "/account/horses",
    });
    res.json({ ok: true });
  }),
);

/* ----- Race data (lib/formFavLink.ts): link an owned horse to a race-data horse ----- */

/** POST /horses/:id/formfav {name, code} — one owner per race-data horse (409 formfav_claimed). */
router.post(
  "/horses/:id/formfav",
  asyncRoute(async (req, res) => {
    const owner = me(req).id;
    const horse = await leadOnly(req, res, "link race data");
    if (!horse) return;
    if (horse.formfav_key) return res.status(409).json({ error: "This horse is already linked. Unlink it first.", code: "already_linked" });
    let target;
    try {
      target = await resolveRacingHorse({ name: req.body?.name, code: req.body?.code, runnerId: req.body?.runnerId });
    } catch (error) {
      if (error instanceof LinkError) return void res.status(error.status).json({ error: error.message });
      throw error;
    }
    const { error } = await supabase
      .from("owner_horses")
      .update({ ...linkColumns(target), formfav_alerts: true, updated_at: new Date().toISOString() })
      .eq("id", horse.id)
      .eq("owner_id", owner);
    if (error) {
      if (error.code === "23505")
        return res
          .status(409)
          .json({ error: "Another member has already linked that racing horse to their horse.", code: "formfav_claimed" });
      return unavailable(res, error);
    }
    bustFollowerCounts();
    await syncLinkedHorse("owned", horse.id, target);
    let fresh;
    try {
      fresh = await loadCommunityHorse(owner, horse.id);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    res.json({ horse: fresh });
  }),
);

/** POST /horses/:id/formfav/remove — unlink: details stay, race-data records become ordinary records. */
router.post(
  "/horses/:id/formfav/remove",
  asyncRoute(async (req, res) => {
    const owner = me(req).id;
    const horse = await leadOnly(req, res, "unlink race data");
    if (!horse) return;
    if (!horse.formfav_key) return res.status(400).json({ error: "This horse isn't linked to race data." });
    const { error } = await supabase.rpc("formfav_unlink", { p_kind: "owned", p_id: horse.id });
    if (error) return unavailable(res, error);
    bustFollowerCounts();
    let fresh;
    try {
      fresh = await loadCommunityHorse(owner, horse.id);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    res.json({ horse: fresh });
  }),
);

/** POST /horses/:id/formfav/alerts {on} — the owner's alerts for their linked horse. */
router.post(
  "/horses/:id/formfav/alerts",
  asyncRoute(async (req, res) => {
    const on = req.body?.on;
    if (typeof on !== "boolean") return res.status(400).json({ error: "Choose on or off." });
    const owner = me(req).id;
    if (!(await leadOnly(req, res, "change race alerts for this horse"))) return;
    const { data, error } = await supabase
      .from("owner_horses")
      .update({ formfav_alerts: on })
      .eq("id", req.params.id)
      .eq("owner_id", owner)
      .select("id,formfav_key")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That horse");
    res.json({ alertsOn: on });
  }),
);

/* ----- Horse photos ----- */

router.post(
  "/horses/:id/images",
  uploadLimit,
  readImage,
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const image = checkedImage(req, res);
    if (!image) return;
    const found = await editable(req, res);
    if (!found) return;
    const { horse } = found;
    // Files and rows stay under the lead owner, whoever adds them.
    const owner = horse.owner_id as string;
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
    tellOwners(horse, viewer, `New photos of ${clipName(horse.name)}`, "A co-owner added photos. Tap to see them.", undefined, true);
    res.status(201).json({ image: imageView(data), coverImageId: horse.cover_image_id ?? data.id });
  }),
);

router.post(
  "/horses/:id/images/:image/remove",
  asyncRoute(async (req, res) => {
    const found = await editable(req, res);
    if (!found) return;
    const { horse } = found;
    const owner = horse.owner_id as string;
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
    const found = await editable(req, res);
    if (!found) return;
    const { horse } = found;
    const owner = horse.owner_id as string;
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
    const found = await editable(req, res);
    if (!found) return;
    const owner = found.horse.owner_id as string;
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
    const viewer = me(req).id;
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
    let found;
    try {
      found = await editableHorse(req.params.id, viewer);
    } catch (err) {
      drop();
      return unavailable(res, err as DbError);
    }
    if (!found) {
      drop();
      return notFound(res, "That horse");
    }
    const { horse } = found;
    const owner = horse.owner_id as string;
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
    tellOwners(horse, viewer, `New video of ${clipName(horse.name)}`, "A co-owner added a video. Tap to watch it.", undefined, true);
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
    const found = await editable(req, res);
    if (!found) return;
    const owner = found.horse.owner_id as string;
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
    const author = me(req).id;
    const found = await editable(req, res);
    if (!found) return;
    const { horse, role } = found;
    const owner = horse.owner_id as string;
    let audience = await shareAudience(owner, horse.visibility);
    if (!audience) {
      if (role !== "lead")
        return res.status(409).json({ error: "Only the owners can see this horse. Ask the lead owner to make it visible to share it.", code: "horse_private" });
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
      .insert({ author_id: author, kind: "horse_share", body: input.body, horse_id: horse.id, visibility })
      .select("id")
      .single();
    if (error || !post) return unavailable(res, error);
    const view = await visiblePost(author, post.id).catch(() => null);
    res.status(201).json({ post: view });
  }),
);

/* ----- Race records ----- */

const RECORD_COLUMNS = "id,horse_id,race_date,track,race_name,distance,surface,finish,field_size,earnings_cents,notes,formfav_ref";

/** A race record this member may edit (as an owner of its horse), with its horse and whether it's linked to race data. */
async function editableRecord(id: string, viewer: string) {
  const { data, error } = await supabase.from("owner_horse_records").select(RECORD_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const found = await editableHorse(data.horse_id, viewer);
  if (!found) return null;
  return { record: data, horse: found.horse, role: found.role, linked: !!found.horse.formfav_key };
}

async function statsOf(horse: any) {
  const stats = await loadStats([horse.id]);
  return horseView(horse, stats.get(horse.id), { mine: true, showEarnings: true }).stats;
}

/** Adds a race record, and shares it to the Feed when asked. Null on a database error. */
async function addRecord(horse: any, input: Record<string, unknown>, author: string, share: boolean, shareText: string) {
  const { data, error } = await supabase
    .from("owner_horse_records")
    .insert({ ...input, horse_id: horse.id, owner_id: horse.owner_id })
    .select(RECORD_COLUMNS)
    .single();
  if (error || !data) return null;
  let shared = false;
  if (share) {
    const audience = await shareAudience(horse.owner_id, horse.visibility);
    if (audience) {
      const { data: profile } = await supabase.from("community_profiles").select("show_earnings").eq("user_id", horse.owner_id).maybeSingle();
      const showEarnings = profile?.show_earnings ?? true;
      await sharePost({
        author_id: author,
        kind: data.finish === 1 ? "achievement" : "result",
        body: shareText.trim().slice(0, 2000),
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
  return { record: data, shared };
}

/** A race from race data keeps its race details while the horse is linked; its notes and earnings are the owners'. */
function recordUpdate(record: any, linked: boolean, input: Record<string, unknown>) {
  return record.formfav_ref && linked ? { notes: input.notes, earnings_cents: input.earnings_cents } : input;
}

const raceWords = (r: any) => [r.track, r.race_date].filter(Boolean).join(" · ");

router.post(
  "/horses/:id/records",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = recordInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const viewer = me(req).id;
    const found = await editable(req, res);
    if (!found) return;
    const { horse, role } = found;
    const share = req.body?.share === true;
    const shareText = typeof req.body?.shareText === "string" ? req.body.shareText : "";
    if (role === "coowner" && horse.require_approval) {
      const change = await proposeChange(horse, viewer, "record_add", null, { input, share, shareText });
      if (!change) return unavailable(res);
      return res.status(202).json({ pending: change });
    }
    const added = await addRecord(horse, input, viewer, share, shareText);
    if (!added) return unavailable(res);
    tellOwners(horse, viewer, `New race for ${clipName(horse.name)}`, raceWords(added.record) || "A race was added.");
    res.status(201).json({ record: recordView(added.record, true), stats: await statsOf(horse), shared: added.shared });
  }),
);

router.patch(
  "/records/:id",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    let found;
    try {
      found = await editableRecord(req.params.id, viewer);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    if (!found) return notFound(res, "That race record");
    let input: Record<string, unknown>;
    try {
      input = recordInput(req.body ?? {});
    } catch (error) {
      return bad(res, error);
    }
    const update = recordUpdate(found.record, found.linked, input);
    if (found.role === "coowner" && found.horse.require_approval) {
      await supabase
        .from("owner_horse_changes")
        .update({ status: "withdrawn", decided_at: new Date().toISOString() })
        .eq("horse_id", found.horse.id)
        .eq("proposed_by", viewer)
        .eq("kind", "record_update")
        .eq("target_id", found.record.id)
        .eq("status", "pending");
      const change = await proposeChange(found.horse, viewer, "record_update", found.record.id, { input: update });
      if (!change) return unavailable(res);
      return res.status(202).json({ pending: change });
    }
    const { data, error } = await supabase
      .from("owner_horse_records")
      .update({ ...update, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("horse_id", found.horse.id)
      .select(RECORD_COLUMNS)
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That race record");
    tellOwners(found.horse, viewer, `${clipName(found.horse.name)}: race updated`, raceWords(data) || "A race record was changed.", undefined, true);
    res.json({ record: recordView(data, true), stats: await statsOf(found.horse) });
  }),
);

router.post(
  "/records/:id/remove",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    let found;
    try {
      found = await editableRecord(req.params.id, viewer);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    if (!found) return notFound(res, "That race record");
    if (found.record.formfav_ref && found.linked)
      return res.status(409).json({ error: "This race comes from race data. Unlink the horse to remove it.", code: "from_race_data" });
    if (found.role === "coowner" && found.horse.require_approval) {
      const change = await proposeChange(found.horse, viewer, "record_remove", found.record.id, {});
      if (!change) return unavailable(res);
      return res.status(202).json({ pending: change });
    }
    const { data, error } = await supabase
      .from("owner_horse_records")
      .delete()
      .eq("id", req.params.id)
      .eq("horse_id", found.horse.id)
      .select("horse_id")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That race record");
    tellOwners(found.horse, viewer, `${clipName(found.horse.name)}: race removed`, raceWords(found.record) || "A race record was removed.");
    res.json({ ok: true, stats: await statsOf(found.horse) });
  }),
);

/* ============================== Co-owners (My racing → My horses) ============================== */

/**
 * A horse has one lead owner (who added it) and any number of co-owners, invited from My horses. Every owner sees
 * and edits the same horse, so changes and race-data updates reach them all. With "changes need approval" on, a
 * co-owner's edits to details and race records wait (owner_horse_changes) until another owner accepts them.
 * Migration 202611250001_horse_coowners.sql.
 */
const MAX_COOWNERS = 20;

/** Horse columns a co-owner can propose changes to, with the name the browser uses. */
const DETAIL_FIELDS: Record<string, string> = {
  name: "name",
  breed: "breed",
  sex: "sex",
  foaled_year: "foaledYear",
  color: "color",
  sire: "sire",
  dam: "dam",
  status: "status",
  trainer: "trainer",
  location: "location",
  description: "description",
};

/** The detail columns `update` would change. */
function changedFields(current: any, update: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const column of Object.keys(DETAIL_FIELDS))
    if (column in update && (update[column] ?? null) !== (current[column] ?? null)) out[column] = update[column];
  return out;
}

/** Writes horse details (race-data columns stay while linked). The saved row, or null on a database error. */
async function applyDetails(horse: any, fields: Record<string, unknown>) {
  const update: Record<string, unknown> = { ...fields };
  if (horse.formfav_key) for (const column of LOCKED_COLUMNS) delete update[column];
  const { data, error } = await supabase
    .from("owner_horses")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", horse.id)
    .select(HORSE_COLUMNS)
    .maybeSingle();
  if (error) console.error("[community] horse update failed:", error.code, error.message);
  return error ? null : data;
}

const CHANGE_WORDS: Record<string, string> = {
  details: "Details",
  record_add: "New race",
  record_update: "Race change",
  record_remove: "Remove a race",
};

/** Saves a co-owner's change for approval and tells the other owners. */
async function proposeChange(horse: any, proposer: string, kind: string, targetId: string | null, payload: Record<string, unknown>) {
  const { data, error } = await supabase
    .from("owner_horse_changes")
    .insert({ horse_id: horse.id, proposed_by: proposer, kind, target_id: targetId, payload })
    .select("id,kind,created_at")
    .single();
  if (error || !data) return null;
  tellOwners(
    horse,
    proposer,
    `${clipName(horse.name)}: change to approve`,
    `${CHANGE_WORDS[kind] ?? "A change"} is waiting for your OK.`,
    horseLink(horse.id, "owners"),
  );
  return { id: data.id, kind: data.kind, createdAt: data.created_at };
}

async function changeViews(horse: any, rows: any[], viewer: string) {
  const people = [...new Set(rows.map((r) => r.proposed_by as string))];
  const targets = [...new Set(rows.map((r) => r.target_id).filter(Boolean) as string[])];
  const [accounts, records] = await Promise.all([
    people.length ? supabase.from("accounts").select("id,first_name,last_name").in("id", people) : Promise.resolve({ data: [], error: null }),
    targets.length
      ? supabase.from("owner_horse_records").select(RECORD_COLUMNS).in("id", targets)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (accounts.error || records.error) throw accounts.error ?? records.error;
  const names = new Map((accounts.data ?? []).map((a: any) => [a.id, `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Stayblz member"]));
  const byId = new Map((records.data ?? []).map((r: any) => [r.id, r]));
  return rows.map((r) => {
    const target = r.target_id ? byId.get(r.target_id) : null;
    return {
      id: r.id,
      kind: r.kind,
      createdAt: r.created_at,
      mine: r.proposed_by === viewer,
      proposedBy: { id: r.proposed_by, name: names.get(r.proposed_by) ?? "Stayblz member" },
      fields:
        r.kind === "details"
          ? Object.entries((r.payload?.fields ?? {}) as Record<string, unknown>)
              .filter(([column]) => column in DETAIL_FIELDS)
              .map(([column, to]) => ({ field: DETAIL_FIELDS[column], from: horse[column] ?? null, to: to ?? null }))
          : undefined,
      record: target ? recordView(target, true) : null,
      proposed: r.payload?.input ? recordView(r.payload.input, true) : null,
    };
  });
}

async function ownersView(horse: any, viewer: string) {
  return (await loadOwners(horse)).map((o) => ({ ...o, me: o.id === viewer }));
}

function shareInput(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 10000) throw new InputError("Enter a share between 0.01% and 100%.");
  return v;
}

/** GET /horses/:id/owners — the lead owner, co-owners and invites (owners only). */
router.get(
  "/horses/:id/owners",
  asyncRoute(async (req, res) => {
    const found = await editable(req, res);
    if (!found) return;
    try {
      res.json({ owners: await ownersView(found.horse, me(req).id), role: found.role, requireApproval: !!found.horse.require_approval });
    } catch (err) {
      unavailable(res, err as DbError);
    }
  }),
);

/** POST /horses/:id/owners {accountId, shareBps?} — the lead owner invites a member to co-own the horse. */
router.post(
  "/horses/:id/owners",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const accountId = req.body?.accountId;
    if (!isUuid(accountId)) return res.status(400).json({ error: "Choose a member to invite." });
    let shareBps;
    try {
      shareBps = shareInput(req.body?.shareBps);
    } catch (error) {
      return bad(res, error);
    }
    const horse = await leadOnly(req, res, "invite co-owners");
    if (!horse) return;
    if (accountId === viewer) return res.status(400).json({ error: "You already own this horse." });
    if (!(await accountActive(accountId))) return notFound(res, "That member");
    const { count, error: countError } = await supabase
      .from("owner_horse_members")
      .select("account_id", { count: "exact", head: true })
      .eq("horse_id", horse.id);
    if (countError) return unavailable(res, countError);
    if ((count ?? 0) >= MAX_COOWNERS) return res.status(409).json({ error: `A horse can have up to ${MAX_COOWNERS} co-owners.` });
    const { error } = await supabase
      .from("owner_horse_members")
      .insert({ horse_id: horse.id, account_id: accountId, status: "pending", share_bps: shareBps, invited_by: viewer });
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "That member already owns this horse or has been invited." });
      return unavailable(res, error);
    }
    horseAlert([accountId], viewer, horse.id, {
      title: `Co-own ${clipName(horse.name)}?`,
      body: "You've been invited to co-own this horse. Accept or decline in My horses.",
      link: "/account/horses#invites",
    });
    try {
      res.status(201).json({ owners: await ownersView(horse, viewer) });
    } catch (err) {
      unavailable(res, err as DbError);
    }
  }),
);

/** PATCH /horses/:id/owners/:account {shareBps} — the lead owner sets an owner's share (only owners see shares). */
router.patch(
  "/horses/:id/owners/:account",
  asyncRoute(async (req, res) => {
    let shareBps;
    try {
      shareBps = shareInput(req.body?.shareBps);
    } catch (error) {
      return bad(res, error);
    }
    const horse = await leadOnly(req, res, "change ownership shares");
    if (!horse) return;
    const account = req.params.account;
    let owners;
    try {
      owners = await loadOwners(horse);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    if (!owners.some((o) => o.id === account)) return notFound(res, "That owner");
    const others = owners.filter((o) => o.id !== account).reduce((sum, o) => sum + (o.shareBps ?? 0), 0);
    if (others + (shareBps ?? 0) > 10000) return res.status(400).json({ error: "Shares can't add up to more than 100%." });
    const { error } =
      account === horse.owner_id
        ? await supabase.from("owner_horses").update({ owner_share_bps: shareBps }).eq("id", horse.id)
        : await supabase.from("owner_horse_members").update({ share_bps: shareBps }).eq("horse_id", horse.id).eq("account_id", account);
    if (error) return unavailable(res, error);
    try {
      res.json({ owners: await ownersView({ ...horse, owner_share_bps: account === horse.owner_id ? shareBps : horse.owner_share_bps }, me(req).id) });
    } catch (err) {
      unavailable(res, err as DbError);
    }
  }),
);

/** POST /horses/:id/owners/:account/remove — the lead owner removes a co-owner (or cancels an invite); a co-owner leaves. */
router.post(
  "/horses/:id/owners/:account/remove",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const account = req.params.account;
    const found = await editable(req, res);
    if (!found) return;
    const { horse, role } = found;
    if (account === horse.owner_id) return res.status(400).json({ error: "The lead owner can't be removed." });
    const leaving = account === viewer;
    if (!leaving && role !== "lead") return res.status(403).json({ error: "Only the lead owner can remove co-owners.", code: "lead_only" });
    const { data, error } = await supabase
      .from("owner_horse_members")
      .delete()
      .eq("horse_id", horse.id)
      .eq("account_id", account)
      .select("status")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That owner");
    await supabase
      .from("owner_horse_changes")
      .update({ status: "withdrawn", decided_at: new Date().toISOString() })
      .eq("horse_id", horse.id)
      .eq("proposed_by", account)
      .eq("status", "pending");
    if (leaving) tellOwners(horse, viewer, `${clipName(horse.name)}: a co-owner left`, "They no longer co-own this horse.", horseLink(horse.id, "owners"));
    else if (data.status === "accepted")
      horseAlert([account], viewer, horse.id, {
        title: `${clipName(horse.name)}`,
        body: "You're no longer a co-owner of this horse.",
        link: "/account/horses",
      });
    if (leaving) return res.json({ ok: true });
    try {
      res.json({ owners: await ownersView(horse, viewer) });
    } catch (err) {
      unavailable(res, err as DbError);
    }
  }),
);

/** PATCH /horses/:id/approval {requireApproval} — the lead owner chooses whether co-owners' edits need approval. */
router.patch(
  "/horses/:id/approval",
  asyncRoute(async (req, res) => {
    const on = req.body?.requireApproval;
    if (typeof on !== "boolean") return res.status(400).json({ error: "Choose on or off." });
    const horse = await leadOnly(req, res, "change who approves edits");
    if (!horse) return;
    const { error } = await supabase.from("owner_horses").update({ require_approval: on }).eq("id", horse.id);
    if (error) return unavailable(res, error);
    if (on !== !!horse.require_approval)
      tellOwners(
        horse,
        me(req).id,
        `${clipName(horse.name)}: ${on ? "edits need approval" : "edits go straight in"}`,
        on ? "Co-owners' changes now wait for another owner to accept them." : "Co-owners' changes now show straight away.",
        horseLink(horse.id, "owners"),
      );
    res.json({ requireApproval: on });
  }),
);

/** GET /horse-invites — horses this member has been invited to co-own. */
router.get(
  "/horse-invites",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const { data: rows, error } = await supabase
      .from("owner_horse_members")
      .select("horse_id,share_bps,invited_by,invited_at")
      .eq("account_id", viewer)
      .eq("status", "pending")
      .order("invited_at", { ascending: false })
      .limit(50);
    if (error) return unavailable(res, error);
    const ids = (rows ?? []).map((r) => r.horse_id as string);
    if (!ids.length) return res.json({ invites: [] });
    const { data: horses, error: horsesError } = await supabase.from("owner_horses").select("id,name,breed,owner_id,cover_image_id").in("id", ids);
    if (horsesError) return unavailable(res, horsesError);
    const leads = [...new Set((horses ?? []).map((h) => h.owner_id as string))];
    const { data: accounts, error: accountsError } = await supabase
      .from("accounts")
      .select("id,first_name,last_name,status")
      .in("id", leads);
    if (accountsError) return unavailable(res, accountsError);
    const lead = new Map((accounts ?? []).map((a) => [a.id, a]));
    const byId = new Map((horses ?? []).map((h) => [h.id, h]));
    res.json({
      invites: (rows ?? []).flatMap((r) => {
        const h = byId.get(r.horse_id);
        const a = h && lead.get(h.owner_id);
        if (!h || !a || a.status !== "active") return [];
        return [
          {
            horse: { id: h.id, name: h.name, breed: h.breed, coverImageId: h.cover_image_id },
            invitedBy: { id: a.id, name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Stayblz member" },
            invitedAt: r.invited_at,
            shareBps: r.share_bps ?? null,
          },
        ];
      }),
    });
  }),
);

/** POST /horse-invites/:id/accept — become a co-owner (`:id` is the horse). */
router.post(
  "/horse-invites/:id/accept",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const { data, error } = await supabase
      .from("owner_horse_members")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("horse_id", req.params.id)
      .eq("account_id", viewer)
      .eq("status", "pending")
      .select("horse_id")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That invitation");
    let horse;
    try {
      horse = await loadCommunityHorse(viewer, req.params.id);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    if (!horse) return notFound(res, "That horse");
    tellOwners(
      { id: horse.id, owner_id: horse.ownerId, name: horse.name },
      viewer,
      `New co-owner of ${clipName(horse.name)}`,
      "An invitation to co-own this horse was accepted.",
      horseLink(horse.id, "owners"),
    );
    res.json({ horse });
  }),
);

/** POST /horse-invites/:id/decline */
router.post(
  "/horse-invites/:id/decline",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const { data, error } = await supabase
      .from("owner_horse_members")
      .delete()
      .eq("horse_id", req.params.id)
      .eq("account_id", viewer)
      .eq("status", "pending")
      .select("horse_id,invited_by")
      .maybeSingle();
    if (error) return unavailable(res, error);
    if (!data) return notFound(res, "That invitation");
    const { data: horse } = await supabase.from("owner_horses").select("id,name,owner_id").eq("id", req.params.id).maybeSingle();
    if (horse)
      horseAlert([horse.owner_id], viewer, horse.id, {
        title: `${clipName(horse.name)}: invitation declined`,
        body: "Your invitation to co-own this horse was declined.",
        link: horseLink(horse.id, "owners"),
      });
    res.json({ ok: true });
  }),
);

/** GET /horses/:id/changes — co-owners' changes waiting for approval (owners only). */
router.get(
  "/horses/:id/changes",
  asyncRoute(async (req, res) => {
    const found = await editable(req, res);
    if (!found) return;
    const { data, error } = await supabase
      .from("owner_horse_changes")
      .select("id,kind,target_id,payload,proposed_by,created_at")
      .eq("horse_id", found.horse.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return unavailable(res, error);
    try {
      res.json({ changes: await changeViews(found.horse, data ?? [], me(req).id) });
    } catch (err) {
      unavailable(res, err as DbError);
    }
  }),
);

/** A pending change and the viewer's access to its horse (answers 404/409 itself otherwise). */
async function openChange(req: Request, res: Response) {
  const viewer = me(req).id;
  const { data: change, error } = await supabase.from("owner_horse_changes").select("*").eq("id", req.params.change).maybeSingle();
  if (error) return void unavailable(res, error);
  const found = change ? await editableHorse(change.horse_id, viewer).catch(() => null) : null;
  if (!change || !found) return void notFound(res, "That change");
  if (change.status !== "pending") return void res.status(409).json({ error: "This change has already been answered.", code: "answered" });
  return { change, horse: found.horse };
}

/** Marks a change answered, once: false when someone else answered it first. */
async function claimChange(id: string, status: string, viewer: string) {
  const { data } = await supabase
    .from("owner_horse_changes")
    .update({ status, decided_by: viewer, decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  return !!data;
}

/** POST /changes/:change/accept — another owner accepts a co-owner's change, which is then made. */
router.post(
  "/changes/:change/accept",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const open = await openChange(req, res);
    if (!open) return;
    const { change, horse } = open;
    if (change.proposed_by === viewer) return res.status(403).json({ error: "Another owner needs to accept your change." });
    if (!(await claimChange(change.id, "accepted", viewer)))
      return res.status(409).json({ error: "This change has already been answered.", code: "answered" });
    const payload = change.payload ?? {};
    const gone = async () => {
      await supabase.from("owner_horse_changes").update({ status: "withdrawn" }).eq("id", change.id);
      res.status(409).json({ error: "That race record no longer exists, so the change couldn't be made.", code: "gone" });
    };
    if (change.kind === "details") {
      if (!(await applyDetails(horse, payload.fields ?? {}))) return unavailable(res);
    } else if (change.kind === "record_add") {
      if (!(await addRecord(horse, payload.input ?? {}, change.proposed_by, payload.share === true, String(payload.shareText ?? ""))))
        return unavailable(res);
    } else {
      const { data: record, error } = await supabase
        .from("owner_horse_records")
        .select(RECORD_COLUMNS)
        .eq("id", change.target_id)
        .eq("horse_id", horse.id)
        .maybeSingle();
      if (error) return unavailable(res, error);
      if (!record) return gone();
      const linked = !!horse.formfav_key;
      if (change.kind === "record_update") {
        const { error: saveError } = await supabase
          .from("owner_horse_records")
          .update({ ...recordUpdate(record, linked, payload.input ?? {}), updated_at: new Date().toISOString() })
          .eq("id", record.id);
        if (saveError) return unavailable(res, saveError);
      } else {
        if (record.formfav_ref && linked) return gone();
        const { error: removeError } = await supabase.from("owner_horse_records").delete().eq("id", record.id);
        if (removeError) return unavailable(res, removeError);
      }
    }
    horseAlert([change.proposed_by], viewer, horse.id, {
      title: `${clipName(horse.name)}: change accepted`,
      body: `${CHANGE_WORDS[change.kind] ?? "Your change"} is now on the horse's profile.`,
      link: `/community/horses/${horse.id}`,
    });
    let fresh;
    try {
      fresh = await loadCommunityHorse(viewer, horse.id);
    } catch (err) {
      return unavailable(res, err as DbError);
    }
    res.json({ ok: true, horse: fresh });
  }),
);

/** POST /changes/:change/decline — another owner declines it; the co-owner who proposed it withdraws it. */
router.post(
  "/changes/:change/decline",
  asyncRoute(async (req, res) => {
    const viewer = me(req).id;
    const open = await openChange(req, res);
    if (!open) return;
    const { change, horse } = open;
    const withdraw = change.proposed_by === viewer;
    if (!(await claimChange(change.id, withdraw ? "withdrawn" : "declined", viewer)))
      return res.status(409).json({ error: "This change has already been answered.", code: "answered" });
    if (!withdraw)
      horseAlert([change.proposed_by], viewer, horse.id, {
        title: `${clipName(horse.name)}: change declined`,
        body: `${CHANGE_WORDS[change.kind] ?? "Your change"} wasn't accepted.`,
        link: horseLink(horse.id, "owners"),
      });
    res.json({ ok: true });
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
      "community_comments", "owner_horse_stats", "owner_horse_members", "owner_horse_changes",
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
    if (input.horse_id && !(await editableHorse(input.horse_id, user.id)))
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
    const [ctx, role] = await Promise.all([ownerContext(viewer, horse.owner_id), horseRole({ id: image.horse_id, owner_id: horse.owner_id }, viewer)]);
    if (!canSeeHorse(viewer, horse, ctx, role === "coowner")) return void notFound(res, "That photo");
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