import { Router, type Request, type Response } from "express";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { supabase } from "../lib/supabase";
import { roleRank } from "../lib/accounts";
import { horseName, mareInput, pedigreeInput, searchInput, StallionInputError } from "../lib/stallionInput";
import { matingReport, quickMatch, type MareForMating, type StallionForMating } from "../lib/stallionMating";
import { MARE_DEPTH, STALLION_DEPTH, nameKey, type Pedigree } from "../lib/stallionPedigree";
import { cleanGenetics } from "../lib/stallionGenetics";
import { mediaRoutes } from "./stallionFiles";

/**
 * Stayblz Stallions, public side (/api/public/stallions): the directory, a stallion's page, compare, the mating check
 * and the files on published stallions. No sign-in needed, so owners can share their stallion's page anywhere; signed-in
 * visitors also see what they saved. Breeding requests, saves and listing live in routes/stallions.ts (signed in).
 */
const router = Router();
router.use(optionalAuth);

const viewer = (req: Request) => (req as Partial<AuthenticatedRequest>).user ?? null;
const staff = (req: Request) => {
  const u = viewer(req);
  return !!u && roleRank(u.role) >= roleRank("admin");
};
// Signed-in people are counted by account, guests by address (a null key would skip the limit altogether).
const perPerson = (req: Request) => viewer(req)?.id ?? `ip:${req.ip ?? "unknown"}`;
const readLimit = authLimit("stallions-read", 300, 60_000);
const checkLimit = authLimit("stallions-check", 40, 5 * 60_000, perPerson);

export const STALLIONS_SETUP =
  "Stayblz Stallions isn't set up on this database yet: run migration 202611220001_stallions.sql in the Supabase SQL Editor.";
/** Missing tables/functions = the migration hasn't been run; anything else is a temporary problem. */
export function stallionsDown(res: Response, error?: { code?: string; message?: string } | null) {
  if (error) console.error(`[stallions] ${res.req?.method} ${res.req?.originalUrl}: ${error.code ?? "?"} ${error.message ?? ""}`);
  if (error && ["PGRST202", "PGRST205", "42883", "42P01"].includes(error.code ?? "")) {
    console.error(`[stallions] ${STALLIONS_SETUP}`);
    return res.status(503).json({ error: STALLIONS_SETUP, code: "setup_database" });
  }
  // A link to a record that's gone (e.g. a racing record picked before an admin removed it): the form can fix that.
  if (error?.code === "23503")
    return res.status(400).json({ error: "A racing record you picked is no longer in Stayblz. Pick it again or clear it." });
  return res.status(503).json({ error: "Stayblz Stallions is temporarily unavailable. Please try again." });
}

async function rpc<T = any>(name: string, args: Record<string, unknown>): Promise<{ data: T | null; error: any }> {
  const { data, error } = await supabase.rpc(name, args);
  return { data: (data ?? null) as T | null, error };
}

export async function loadProfile(id: string, viewerId: string | null, isStaff: boolean) {
  return rpc<any>("stallion_profile", { p_id: id, p_viewer: viewerId, p_staff: isStaff });
}

/* ---------- Directory ---------- */

router.get(
  "/",
  readLimit,
  asyncRoute(async (req, res) => {
    const q = searchInput(req.query as Record<string, unknown>);
    const [found, facets] = await Promise.all([
      rpc("stallions_search", { p_viewer: viewer(req)?.id ?? null, p_q: q }),
      q.page === "0" ? rpc("stallions_facets", {}) : Promise.resolve({ data: null, error: null }),
    ]);
    if (found.error) return stallionsDown(res, found.error);
    res.json({ ...(found.data ?? { stallions: [], total: 0, more: false }), facets: facets.data ?? undefined });
  }),
);

/** GET /compare?ids=a,b,c — up to three stallions side by side. */
router.get(
  "/compare",
  readLimit,
  asyncRoute(async (req, res) => {
    const ids = [...new Set(String(req.query.ids ?? "").split(",").map((s) => s.trim()).filter(isUuid))].slice(0, 3);
    if (!ids.length) return res.status(400).json({ error: "Choose up to three stallions to compare." });
    const results = await Promise.all(ids.map((id) => loadProfile(id, viewer(req)?.id ?? null, staff(req))));
    const failed = results.find((r) => r.error);
    if (failed) return stallionsDown(res, failed.error);
    res.json({ stallions: results.map((r) => r.data).filter(Boolean) });
  }),
);

/** GET /lookup?q=&sex=female|male — horses on public Stayblz racing pages (pick a mare, link a record). */
router.get(
  "/lookup",
  readLimit,
  asyncRoute(async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    const sex = req.query.sex === "female" || req.query.sex === "male" ? req.query.sex : "";
    if (q.length < 2) return res.json({ horses: [] });
    const { data, error } = await rpc("stallion_racing_lookup", { p_query: q, p_sex: sex });
    if (error) return stallionsDown(res, error);
    res.json({ horses: data ?? [] });
  }),
);

/**
 * Fills a pedigree from what Stayblz already knows: published stallions' pedigrees and the sire / dam / dam's sire of
 * horses on public racing pages. Never overwrites a name that was typed.
 */
export async function fillPedigree(name: string, start: Pedigree, depth: number) {
  const out: Pedigree = { ...start };
  if (name) out[""] = name;
  const filled: string[] = [];
  const sources = new Set<string>();
  for (let round = 0; round < depth; round++) {
    const wanted = [...new Set(Object.entries(out).filter(([p]) => p.length < depth && (!out[`${p}s`] || !out[`${p}d`])).map(([, n]) => n))].slice(0, 40);
    if (!wanted.length) break;
    const { data, error } = await rpc<any[]>("stallion_known_parents", { p_names: wanted });
    if (error) throw error;
    const known = new Map<string, { pedigree: Pedigree; source: string }>();
    for (const row of data ?? []) {
      const prev = known.get(row.key);
      // A published stallion's own pedigree goes deeper than racing data.
      if (!prev || (prev.source === "racing" && row.source === "stallion")) known.set(row.key, { pedigree: row.pedigree ?? {}, source: row.source });
    }
    let changed = false;
    for (const [path, horse] of Object.entries({ ...out })) {
      if (path.length >= depth) continue;
      const info = known.get(nameKey(horse));
      if (!info) continue;
      for (const [sub, ancestor] of Object.entries(info.pedigree)) {
        const target = `${path}${sub}`;
        if (target.length > depth || out[target] || typeof ancestor !== "string" || !ancestor.trim()) continue;
        out[target] = ancestor.trim().slice(0, 40);
        filled.push(target);
        sources.add(info.source);
        changed = true;
      }
    }
    if (!changed) break;
  }
  delete out[""];
  return { pedigree: out, filled, sources: [...sources] };
}

/** POST /pedigree-fill {name?, pedigree, depth: 4 (stallion) | 3 (mare)} */
router.post(
  "/pedigree-fill",
  checkLimit,
  asyncRoute(async (req, res) => {
    const depth = req.body?.depth === MARE_DEPTH ? MARE_DEPTH : STALLION_DEPTH;
    let start: Pedigree;
    let name = "";
    try {
      start = pedigreeInput(req.body?.pedigree ?? {}, depth);
      name = horseName(req.body?.name ?? "");
    } catch (e) {
      return res.status(400).json({ error: e instanceof StallionInputError ? e.message : "Check the names." });
    }
    if (!name && !Object.keys(start).length) return res.status(400).json({ error: "Type a name first." });
    try {
      res.json(await fillPedigree(name, start, depth));
    } catch (e) {
      stallionsDown(res, e as any);
    }
  }),
);

/* ---------- Mating check ---------- */

/** The mare from the request: a saved one (signed in) or the details typed in. */
async function mareFrom(req: Request, res: Response): Promise<MareForMating | null> {
  const body = req.body ?? {};
  if (body.mareId !== undefined) {
    const me = viewer(req);
    if (!me) {
      res.status(401).json({ error: "Log in to use your saved mares." });
      return null;
    }
    if (!isUuid(body.mareId)) {
      res.status(404).json({ error: "That mare isn't saved any more." });
      return null;
    }
    const { data, error } = await supabase.from("stallion_mares").select("*").eq("id", body.mareId).eq("account_id", me.id).maybeSingle();
    if (error) {
      stallionsDown(res, error);
      return null;
    }
    if (!data) {
      res.status(404).json({ error: "That mare isn't saved any more." });
      return null;
    }
    return { name: data.name, breed: data.breed, pedigree: data.pedigree ?? {}, genetics: cleanGenetics(data.genetics) };
  }
  try {
    const m = mareInput(body.mare ?? {}, { needName: false });
    if (!m.pedigree.s && !m.pedigree.d) {
      res.status(400).json({ error: "Add at least the mare's sire or dam." });
      return null;
    }
    return { name: m.name, breed: m.breed, pedigree: m.pedigree, genetics: m.genetics };
  } catch (e) {
    res.status(400).json({ error: e instanceof StallionInputError ? e.message : "Check the mare's details." });
    return null;
  }
}

const forMating = (p: any): StallionForMating => ({
  id: p.id,
  name: p.name,
  breed: p.breed,
  methods: p.methods ?? [],
  pedigree: p.pedigree ?? {},
  genetics: cleanGenetics(p.genetics),
});

/** POST /matches {mare | mareId, sort?: inbreeding | cross | fee} — the mare against every published stallion. */
router.post(
  "/matches",
  checkLimit,
  asyncRoute(async (req, res) => {
    const mare = await mareFrom(req, res);
    if (!mare) return;
    const breed = req.body?.sameBreed === false ? "" : mare.breed === "other" ? "" : mare.breed;
    const [list, counts] = await Promise.all([
      rpc<any[]>("stallions_for_matching", { p_viewer: viewer(req)?.id ?? null, p_breed: breed }),
      mare.pedigree.s ? rpc<Record<string, any>>("stallion_cross_counts", { p_damsire: mare.pedigree.s }) : Promise.resolve({ data: {}, error: null }),
    ]);
    if (list.error || counts.error) return stallionsDown(res, list.error ?? counts.error);
    const sort = req.body?.sort === "cross" || req.body?.sort === "fee" ? req.body.sort : "inbreeding";
    const rows = (list.data ?? []).map((s) => {
      const { pedigree: _p, genetics: _g, ...card } = s;
      return { stallion: card, ...quickMatch(forMating(s), mare, counts.data ?? {}) };
    });
    rows.sort((a, b) => {
      if (sort === "cross") return (b.cross?.runners ?? 0) - (a.cross?.runners ?? 0) || a.inbreeding - b.inbreeding;
      if (sort === "fee") return (a.stallion.fee ?? Number.MAX_SAFE_INTEGER) - (b.stallion.fee ?? Number.MAX_SAFE_INTEGER);
      const risk = (r: typeof a) => (r.genetics?.level === "danger" ? 1 : 0);
      return risk(a) - risk(b) || a.inbreeding - b.inbreeding || (b.cross?.runners ?? 0) - (a.cross?.runners ?? 0);
    });
    res.json({ mare: { name: mare.name || "Your mare", breed: mare.breed, sire: mare.pedigree.s ?? "", dam: mare.pedigree.d ?? "" }, matches: rows.slice(0, 200), total: rows.length });
  }),
);

/* ---------- Files ---------- */
mediaRoutes(router);

/* ---------- One stallion ---------- */

// One counted view per person (account, or address when signed out) per stallion every 6 hours, so reloading or a
// script can't push a stallion up the "popular" order. Memory only: a restart just starts counting afresh.
const VIEW_WINDOW_MS = 6 * 60 * 60 * 1000;
const lastViews = new Map<string, number>();
function firstViewInWindow(stallionId: string, who: string) {
  const now = Date.now();
  const key = `${stallionId}:${who}`;
  const at = lastViews.get(key);
  if (at !== undefined && now - at < VIEW_WINDOW_MS) return false;
  if (lastViews.size >= 50_000) {
    for (const [k, t] of lastViews) if (now - t >= VIEW_WINDOW_MS) lastViews.delete(k);
    if (lastViews.size >= 50_000) lastViews.clear();
  }
  lastViews.set(key, now);
  return true;
}

router.get(
  "/:id",
  readLimit,
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "Stallion not found." });
    const me = viewer(req)?.id ?? null;
    const { data, error } = await loadProfile(req.params.id, me, staff(req));
    if (error) return stallionsDown(res, error);
    if (!data) return res.status(404).json({ error: "This stallion isn't listed any more." });
    // A page visit (the page asks once per visit with ?view=1); counting never slows the page down.
    if (req.query.view === "1" && data.status === "published" && !data.mine && firstViewInWindow(data.id, me ?? `ip:${req.ip ?? "unknown"}`))
      void supabase.rpc("stallion_seen", { p_id: data.id, p_viewer: me }).then(({ error: e }) => e && console.error(`[stallions] view not counted: ${e.code}`));
    res.json({ stallion: data });
  }),
);

/** POST /:id/mating {mare | mareId} — the full check of this stallion with one mare. */
router.post(
  "/:id/mating",
  checkLimit,
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "Stallion not found." });
    const mare = await mareFrom(req, res);
    if (!mare) return;
    const { data, error } = await loadProfile(req.params.id, viewer(req)?.id ?? null, staff(req));
    if (error) return stallionsDown(res, error);
    if (!data) return res.status(404).json({ error: "This stallion isn't listed any more." });
    try {
      res.json({ report: await matingReport(forMating(data), mare) });
    } catch (e) {
      stallionsDown(res, e as any);
    }
  }),
);

export default router;
