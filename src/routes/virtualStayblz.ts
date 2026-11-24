import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { isUuid, type StableRequest } from "../middleware/stable";
import { supabase } from "../lib/supabase";
import { canSeeHorse, loadCommunityHorse, loadStats, ownerContext, type OwnerContext } from "../lib/communityHorses";
import { VirtualInputError, entryNotesInput, virtualEntryInput, virtualHorseInput } from "../lib/virtualInput";
import * as ff from "../lib/formFav";
import * as idx from "../lib/formFavIndex";
import {
  LOCKED_COLUMNS,
  LinkError,
  breedFor,
  bustFollowerCounts,
  followerCounts,
  linkColumns,
  linkView,
  liveRaceData,
  resolveRacingHorse,
} from "../lib/formFavLink";
import { syncLinkedHorse } from "../lib/formFavSync";

/**
 * Virtual Stayblz: horses someone tracks without owning them, plus what they log about them.
 *
 *   personal  mounted at /api/my-racing/virtual — the signed-in person's private list (virtual_horses.user_id).
 *   stable    mounted at /api/workspace/virtual behind requireStable — the active stable's shared list (stable_id).
 *
 * Every query is filtered by `scoped()`, so one list can never read or change another. In a stable any member
 * may add horses and log entries; removing (or editing) is for whoever added it, or the stable's owner/managers.
 *
 * Live data is read per request and per viewer: community horses go through the same visibility check as their
 * profile page, so a list shared with a team never shows a teammate more than they could already see.
 *
 * Race data (FormFav, lib/formFavLink.ts + lib/formFavSync.ts): horses added from the "Racing horses" tab
 * (source 'formfav') live in that tab, not in the list; a horse typed in by hand can be linked to one. Linked horses
 * keep trainer/sire/dam/sex/foaling year/breed from race data (locked here), get every final result in their log
 * (rows with formfav_ref: notes only, removable once unlinked) and send alerts; each person can mute a horse.
 */

export const MAX_VIRTUAL_HORSES = 300;
export const MAX_VIRTUAL_ENTRIES = 2000;
/** Horses from the Racing horses tab have their own allowance, so they never crowd out the list. */
export const MAX_RACING_HORSES = 300;

type Mode = "personal" | "stable";
const HORSE_COLS =
  "id,user_id,stable_id,added_by,source,community_horse_id,racing_horse_id,name,breed,sex,foaled_year,color,sire,dam,trainer,owner_name,location,notes,created_at,updated_at,formfav_name,formfav_code,formfav_key,formfav_runner_id,formfav_linked_at,formfav_synced_at";
const ENTRY_COLS =
  "id,virtual_horse_id,author_id,kind,entry_date,title,track,distance,surface,time_text,finish,field_size,result,hip_number,amount_cents,notes,created_at,updated_at,formfav_ref";

/** Dates as YYYY-MM-DD whatever the driver hands back. */
const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);

type DbError = { code?: string; message?: string } | null | undefined;

export function virtualRouter(mode: Mode) {
  const router = Router();
  if (mode === "personal") router.use(requireAuth);

  const me = (req: Request) => (req as AuthenticatedRequest).user;
  const stable = (req: Request) => (req as StableRequest).stable;
  const isManager = (req: Request) => mode === "stable" && ["owner", "manager"].includes(stable(req).role);
  /** Whoever added a horse or wrote an entry may change it; in a stable, so may the owner and managers. */
  const canManage = (req: Request, author: string | null) => mode === "personal" || author === me(req).id || isManager(req);
  // Supabase builder types are too deep to carry through a generic helper, hence `any`.
  const scoped = (q: any, req: Request): any =>
    mode === "personal" ? q.eq("user_id", me(req).id) : q.eq("stable_id", stable(req).id);
  const owner = (req: Request) => (mode === "personal" ? { user_id: me(req).id } : { stable_id: stable(req).id });

  const unavailable = (res: Response, ...errors: DbError[]) => {
    const err = errors.find(Boolean);
    console.error(`[virtual] ${res.req?.method} ${res.req?.originalUrl} failed:`, err ? `${err.code ?? "?"} ${err.message ?? ""}` : "no detail");
    res.status(503).json({ error: "Virtual Stayblz is temporarily unavailable. Please try again." });
  };
  const notFound = (res: Response, what = "That horse") => res.status(404).json({ error: `${what} isn't in this Virtual Stayblz.` });
  const bad = (res: Response, error: unknown) =>
    res.status(400).json({ error: error instanceof VirtualInputError ? error.message : "Check the form and try again." });
  const linkFailed = (res: Response, error: LinkError) =>
    res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });

  router.use((req, res, next) => {
    const user = me(req);
    if (!isUuid(user.id)) return void res.status(409).json({ error: "Development profiles can't use Virtual Stayblz." });
    if (req.method !== "GET" && user.passwordSetupRequired)
      return void res.status(403).json({ error: "Complete password setup before saving horses." });
    next();
  });
  router.param("id", (_req, res, next, id) => (isUuid(id) ? next() : notFound(res)));
  router.param("entry", (_req, res, next, id) => (isUuid(id) ? next() : notFound(res, "That entry")));

  async function loadHorse(req: Request, id: string) {
    const { data, error } = await scoped(supabase.from("virtual_horses").select(HORSE_COLS).eq("id", id), req).maybeSingle();
    if (error) throw error;
    return data as any;
  }

  async function names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((v): v is string => !!v))];
    if (!unique.length) return new Map<string, string>();
    const { data, error } = await supabase.from("accounts").select("id,first_name,last_name").in("id", unique);
    if (error) throw error;
    return new Map((data ?? []).map((a: any) => [a.id, `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Stayblz member"]));
  }

  const horseView = (req: Request, h: any, extra: Record<string, unknown> = {}) => ({
    id: h.id,
    source: h.source,
    communityHorseId: h.community_horse_id,
    racingHorseId: h.racing_horse_id,
    name: h.name,
    breed: h.breed,
    sex: h.sex,
    foaledYear: h.foaled_year,
    color: h.color,
    sire: h.sire,
    dam: h.dam,
    trainer: h.trainer,
    ownerName: h.owner_name,
    location: h.location,
    notes: h.notes,
    addedBy: h.added_by,
    canRemove: canManage(req, h.added_by),
    formfav: linkView(h),
    createdAt: h.created_at,
    updatedAt: h.updated_at,
    ...extra,
  });

  /** Rows from race data (formfav_ref) change notes only, by whoever may manage the horse, and go once unlinked. */
  const entryView = (req: Request, e: any, authors: Map<string, string>, horse?: any) => ({
    id: e.id,
    kind: e.kind,
    entryDate: day(e.entry_date),
    title: e.title,
    track: e.track,
    distance: e.distance,
    surface: e.surface,
    timeText: e.time_text,
    finish: e.finish,
    fieldSize: e.field_size,
    result: e.result,
    hipNumber: e.hip_number,
    amountCents: e.amount_cents === null || e.amount_cents === undefined ? null : Number(e.amount_cents),
    notes: e.notes,
    author: e.author_id ? { id: e.author_id, name: authors.get(e.author_id) ?? "Stayblz member" } : null,
    fromRaceData: !!e.formfav_ref,
    canEdit: e.formfav_ref ? canManage(req, horse?.added_by ?? null) : canManage(req, e.author_id),
    canRemove: e.formfav_ref ? !horse?.formfav_key && canManage(req, horse?.added_by ?? null) : canManage(req, e.author_id),
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  });

  /* ------------------------------ The list ------------------------------ */

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const viewer = me(req).id;
      const { data, error } = await scoped(supabase.from("virtual_horses").select(HORSE_COLS), req)
        .neq("source", "formfav")
        .order("created_at", { ascending: false })
        .limit(MAX_VIRTUAL_HORSES);
      if (error) return unavailable(res, error);
      const rows = (data ?? []) as any[];
      const ids = rows.map((r) => r.id);
      const communityIds = rows.map((r) => r.community_horse_id).filter(Boolean) as string[];
      try {
        const [counts, community] = await Promise.all([
          ids.length
            ? supabase.from("virtual_horse_entry_counts").select("*").in("virtual_horse_id", ids)
            : Promise.resolve({ data: [], error: null }),
          communityIds.length
            ? supabase.from("owner_horses").select("id,owner_id,visibility,cover_image_id,status").in("id", communityIds)
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (counts.error || community.error) return unavailable(res, counts.error, community.error);
        // Live cover and stats only for community horses this viewer can still see.
        const contexts = new Map<string, OwnerContext>();
        for (const o of new Set((community.data ?? []).map((h: any) => h.owner_id as string)))
          contexts.set(o, await ownerContext(viewer, o));
        const visible = new Map<string, any>();
        for (const h of (community.data ?? []) as any[]) {
          const ctx = contexts.get(h.owner_id)!;
          if (canSeeHorse(viewer, h, ctx)) visible.set(h.id, { ...h, showEarnings: ctx.showEarnings || h.owner_id === viewer });
        }
        const stats = await loadStats([...visible.keys()]);
        const countMap = new Map((counts.data ?? []).map((c: any) => [c.virtual_horse_id, c]));
        res.set("Cache-Control", "no-store");
        res.json({
          horses: rows.map((r) => {
            const c: any = countMap.get(r.id);
            const live = r.community_horse_id ? visible.get(r.community_horse_id) : null;
            const s: any = live ? stats.get(live.id) : null;
            return horseView(req, r, {
              counts: {
                workouts: c?.workouts ?? 0,
                races: c?.races ?? 0,
                sales: c?.sales ?? 0,
                notes: c?.notes ?? 0,
              },
              lastEntry: day(c?.last_entry),
              live: live
                ? {
                    coverImageId: live.cover_image_id,
                    status: live.status,
                    starts: Number(s?.starts ?? 0),
                    wins: Number(s?.wins ?? 0),
                    places: Number(s?.places ?? 0),
                    shows: Number(s?.shows ?? 0),
                    earningsCents: live.showEarnings ? Number(s?.earnings_cents ?? 0) : null,
                  }
                : null,
            });
          }),
          limit: MAX_VIRTUAL_HORSES,
        });
      } catch (err) {
        unavailable(res, err as DbError);
      }
    }),
  );

  /* ------------------------------ Racing horses (race data) ------------------------------ */

  /**
   * GET /racing-horses?offset&limit&q&codes&countries&tracking=1 — race-data horses (US/Canada, last 30 days … next
   * 2 days), most followed first, then A–Z. Each carries `followers` (distinct people tracking it on Stayblz) and
   * `trackingId` (this list's horse for it, or null). tracking=1: only this list's, including ones with no runs in
   * the window right now (`noRecentRuns`).
   */
  router.get(
    "/racing-horses",
    asyncRoute(async (req, res) => {
      const viewer = me(req).id;
      const one = (name: string) => {
        const v = req.query[name];
        return typeof v === "string" && v !== "" ? v : undefined;
      };
      const int = (v: string | undefined, min: number, max: number, fallback: number) => {
        if (v === undefined) return fallback;
        if (!/^\d{1,6}$/.test(v) || Number(v) < min || Number(v) > max) return NaN;
        return Number(v);
      };
      const some = <T extends string>(v: string | undefined, allowed: readonly T[]) => {
        if (v === undefined) return [...allowed];
        const picked = [...new Set(v.split(","))];
        return picked.every((p) => (allowed as readonly string[]).includes(p)) ? (picked as T[]) : null;
      };
      const offset = int(one("offset"), 0, 100_000, 0);
      const limit = int(one("limit"), 1, 50, 20);
      const codes = some(one("codes"), idx.INDEX_CODES);
      const countries = some(one("countries"), ff.COUNTRIES);
      const q = one("q")?.trim().slice(0, 60) || undefined;
      const tracking = one("tracking") === "1";
      if (Number.isNaN(offset) || Number.isNaN(limit) || !codes?.length || !countries?.length)
        return res.status(400).json({ error: "Those filters aren't valid." });
      if (!ff.formFavKey()) return res.status(503).json({ error: "Race data isn't available right now." });
      if (!ff.formFavAllowed(viewer)) return res.status(429).json({ error: "That's a lot of lookups. Wait a moment.", retryAfterSeconds: 60 });

      let rank: Map<string, number>;
      let rows: any[];
      try {
        const listed = await scoped(supabase.from("virtual_horses").select("id,source,formfav_key,formfav_name,formfav_code"), req).limit(
          MAX_VIRTUAL_HORSES + MAX_RACING_HORSES,
        );
        if (listed.error) return unavailable(res, listed.error);
        rows = (listed.data ?? []).filter((r: any) => r.formfav_key);
        rank = await followerCounts();
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      idx.ensureIndex();
      const mine = new Map(rows.map((r) => [r.formfav_key as string, r]));
      const withTracking = (r: any) => ({ ...r, trackingId: mine.get(idx.horseKey(r.name, r.code))?.id ?? null });
      res.set("Cache-Control", "no-store");
      if (!tracking) {
        const page = idx.listHorses({ offset, limit, q, codes, countries }, { rank });
        return void res.json({ ...page, records: page.records.map(withTracking) });
      }
      // This list's horses: the ones in the window (with their numbers), then the ones with no runs in it now.
      const inWindow = idx.listHorses({ offset: 0, limit: 1000, q, codes, countries }, { rank, only: new Set(mine.keys()) });
      const shown = new Set(inWindow.records.map((r) => idx.horseKey(r.name, r.code)));
      const needle = q?.toLowerCase();
      const quiet = rows
        .filter((r) => !shown.has(r.formfav_key) && (codes as string[]).includes(r.formfav_code) && (!needle || r.formfav_name.toLowerCase().includes(needle)))
        .map((r) => ({
          name: r.formfav_name,
          code: r.formfav_code,
          countries: [],
          starts: 0,
          wins: 0,
          places: 0,
          lastStart: null,
          nextEntry: null,
          jockey: null,
          trainer: null,
          followers: rank.get(r.formfav_key) ?? 0,
          noRecentRuns: true,
        }))
        .sort((a, b) => b.followers - a.followers || a.name.localeCompare(b.name));
      const all = [...inWindow.records, ...quiet];
      const { records: _r, nextOffset: _n, total: _t, ...status } = inWindow;
      res.json({
        ...status,
        records: all.slice(offset, offset + limit).map(withTracking),
        nextOffset: offset + limit < all.length ? offset + limit : null,
        total: all.length,
      });
    }),
  );

  /** Is this community / racing / race-data horse already in this list? Drives the "Add to Virtual Stayblz" buttons. */
  router.get(
    "/state",
    asyncRoute(async (req, res) => {
      const { communityHorseId, racingHorseId, formfavName, formfavCode } = req.query;
      const raceKey =
        typeof formfavName === "string" && formfavName.trim() && formfavName.length <= 100 && (idx.INDEX_CODES as readonly unknown[]).includes(formfavCode)
          ? idx.horseKey(formfavName, formfavCode as string)
          : null;
      const column = isUuid(communityHorseId)
        ? "community_horse_id"
        : isUuid(racingHorseId)
          ? "racing_horse_id"
          : raceKey
            ? "formfav_key"
            : null;
      if (!column) return res.status(400).json({ error: "Choose a horse." });
      const target = (column === "community_horse_id" ? communityHorseId : column === "racing_horse_id" ? racingHorseId : raceKey) as string;
      const { data, error } = await scoped(supabase.from("virtual_horses").select("id").eq(column, target), req).maybeSingle();
      if (error) return unavailable(res, error);
      res.set("Cache-Control", "no-store");
      res.json({ added: !!data, id: data?.id ?? null });
    }),
  );

  /* ------------------------------ Add / edit / remove a horse ------------------------------ */

  router.post(
    "/",
    asyncRoute(async (req, res) => {
      const viewer = me(req).id;
      const body = req.body ?? {};
      let fields: Record<string, unknown>;
      let notes = "";
      try {
        notes = (virtualHorseInput({ notes: body.notes }, { partial: true }).notes as string) ?? "";
      } catch (error) {
        return bad(res, error);
      }
      try {
        if (body.source === "community") {
          if (!isUuid(body.communityHorseId)) return res.status(400).json({ error: "Choose a horse." });
          const horse = await loadCommunityHorse(viewer, body.communityHorseId);
          if (!horse) return res.status(404).json({ error: "That horse isn't available." });
          if (horse.mine) return res.status(400).json({ error: "That's your own horse. You'll find it in My horses." });
          fields = {
            source: "community",
            community_horse_id: horse.id,
            name: horse.name,
            breed: horse.breed ?? "",
            sex: horse.sex ?? "",
            foaled_year: horse.foaledYear ?? null,
            color: horse.color ?? "",
            sire: horse.sire ?? "",
            dam: horse.dam ?? "",
            trainer: horse.trainer ?? "",
            owner_name: horse.owner.name,
            location: horse.location ?? "",
          };
        } else if (body.source === "racing") {
          if (!isUuid(body.racingHorseId)) return res.status(400).json({ error: "Choose a horse." });
          const { data: h, error } = await supabase
            .from("racing_horses")
            .select("id,name,breed,sex,foaled_year,color,sire,dam")
            .eq("id", body.racingHorseId)
            .maybeSingle();
          if (error) return unavailable(res, error);
          if (!h) return res.status(404).json({ error: "That horse isn't on Stayblz racing pages." });
          const year = Number.isInteger(h.foaled_year) && h.foaled_year >= 1900 && h.foaled_year <= 2100 ? h.foaled_year : null;
          fields = {
            source: "racing",
            racing_horse_id: h.id,
            name: String(h.name ?? "").slice(0, 80) || "Unnamed horse",
            breed: String(h.breed ?? "").slice(0, 60),
            sex: String(h.sex ?? "").slice(0, 20),
            foaled_year: year,
            color: String(h.color ?? "").slice(0, 40),
            sire: String(h.sire ?? "").slice(0, 80),
            dam: String(h.dam ?? "").slice(0, 80),
          };
        } else if (body.source === "manual") {
          try {
            fields = { source: "manual", ...virtualHorseInput(body) };
          } catch (error) {
            return bad(res, error);
          }
        } else if (body.source === "formfav") {
          let target;
          try {
            target = resolveRacingHorse({ name: body.formfavName, code: body.formfavCode });
          } catch (error) {
            if (error instanceof LinkError) return linkFailed(res, error);
            throw error;
          }
          fields = {
            source: "formfav",
            name: target.name.slice(0, 80),
            breed: breedFor(target.code),
            trainer: (target.horse.trainer ?? "").slice(0, 80),
            ...linkColumns(target),
            formfav_linked_by: viewer,
          };
        } else {
          return res.status(400).json({ error: "Choose a Stayblz horse, a racing horse, or enter one by hand." });
        }
      } catch (err) {
        return unavailable(res, err as DbError);
      }

      const racing = fields.source === "formfav";
      const counted = scoped(supabase.from("virtual_horses").select("id", { count: "exact", head: true }), req);
      const { count, error: countError } = await (racing ? counted.eq("source", "formfav") : counted.neq("source", "formfav"));
      if (countError) return unavailable(res, countError);
      if ((count ?? 0) >= (racing ? MAX_RACING_HORSES : MAX_VIRTUAL_HORSES))
        return res.status(409).json({
          error: racing
            ? `Racing horses holds up to ${MAX_RACING_HORSES} horses. Remove some first.`
            : `Virtual Stayblz holds up to ${MAX_VIRTUAL_HORSES} horses. Remove some first.`,
        });

      const { data, error } = await supabase
        .from("virtual_horses")
        .insert({ ...fields, notes, ...owner(req), added_by: viewer })
        .select(HORSE_COLS)
        .single();
      if (error) {
        if (error.code === "23505") {
          const column = fields.source === "community" ? "community_horse_id" : racing ? "formfav_key" : "racing_horse_id";
          const target = (fields.community_horse_id ?? fields.racing_horse_id ?? fields.formfav_key) as string;
          const { data: existing } = await scoped(supabase.from("virtual_horses").select("id").eq(column, target), req).maybeSingle();
          return res
            .status(409)
            .json({ error: "That horse is already in this Virtual Stayblz.", code: "already_added", id: existing?.id ?? null });
        }
        return unavailable(res, error);
      }
      if (!racing) return void res.status(201).json({ horse: horseView(req, data) });
      // Details and the window's results straight away; the next refresh takes it from there.
      bustFollowerCounts();
      await syncLinkedHorse("virtual", (data as any).id, { name: fields.formfav_name as string, code: fields.formfav_code as string });
      const fresh = await loadHorse(req, (data as any).id).catch(() => null);
      res.status(201).json({ horse: horseView(req, fresh ?? data) });
    }),
  );

  router.get(
    "/:id",
    asyncRoute(async (req, res) => {
      const viewer = me(req).id;
      try {
        const horse = await loadHorse(req, req.params.id);
        if (!horse) return notFound(res);
        const [entries, community, racing] = await Promise.all([
          supabase
            .from("virtual_horse_entries")
            .select(ENTRY_COLS)
            .eq("virtual_horse_id", horse.id)
            .order("entry_date", { ascending: false })
            .order("created_at", { ascending: false })
            .limit(MAX_VIRTUAL_ENTRIES),
          horse.community_horse_id ? loadCommunityHorse(viewer, horse.community_horse_id) : Promise.resolve(null),
          horse.racing_horse_id
            ? supabase.rpc("racing_horse", { p_id: horse.racing_horse_id })
            : Promise.resolve({ data: null, error: null }),
        ]);
        if (entries.error) return unavailable(res, entries.error);
        // Racing data being briefly unavailable shouldn't hide the team's own records.
        const racingLive = racing.error ? null : (racing.data ?? null);
        const authors = await names([...(entries.data ?? []).map((e: any) => e.author_id), horse.added_by]);
        const live = community ? { community } : racingLive ? { racing: racingLive } : null;
        // Race data: what the index has on it now (no FormFav call), who follows it, and the viewer's alerts.
        let raceData = null;
        const link = linkView(horse);
        if (link) {
          const [rank, muted] = await Promise.all([
            followerCounts().catch(() => new Map<string, number>()),
            supabase.from("virtual_horse_mutes").select("user_id").eq("horse_id", horse.id).eq("user_id", viewer).maybeSingle(),
          ]);
          if (muted.error) return unavailable(res, muted.error);
          const now = liveRaceData(link);
          raceData = {
            ...link,
            available: !!ff.formFavKey(),
            building: now.building,
            coverage: now.coverage,
            updatedAt: now.updatedAt,
            horse: now.horse,
            followers: rank.get(horse.formfav_key) ?? 0,
            alertsOn: !muted.data,
          };
        }
        res.set("Cache-Control", "no-store");
        res.json({
          horse: horseView(req, horse, {
            addedByName: horse.added_by ? (authors.get(horse.added_by) ?? "Stayblz member") : null,
          }),
          entries: (entries.data ?? []).map((e: any) => entryView(req, e, authors, horse)),
          live,
          liveUnavailable: (horse.source === "community" || horse.source === "racing") && !live,
          raceData,
        });
      } catch (err) {
        unavailable(res, err as DbError);
      }
    }),
  );

  router.patch(
    "/:id",
    asyncRoute(async (req, res) => {
      let horse;
      try {
        horse = await loadHorse(req, req.params.id);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!horse) return notFound(res);
      let input: Record<string, unknown>;
      try {
        input = virtualHorseInput(req.body ?? {}, { partial: true });
      } catch (error) {
        return bad(res, error);
      }
      // Linked horses keep the details copied from their source; only the notes are theirs to change.
      if (horse.source !== "manual") input = input.notes === undefined ? {} : { notes: input.notes };
      // A hand-typed horse linked to race data: what race data keeps up to date stays as it is.
      else if (horse.formfav_key) for (const column of LOCKED_COLUMNS) delete input[column];
      else if (Object.keys(input).some((k) => k !== "notes") && !canManage(req, horse.added_by))
        return res.status(403).json({ error: "Only the person who added this horse, or a stable manager, can change its details." });
      if (!Object.keys(input).length) return res.status(400).json({ error: "Nothing to change." });
      const { data, error } = await scoped(
        supabase.from("virtual_horses").update({ ...input, updated_at: new Date().toISOString() }).eq("id", horse.id),
        req,
      )
        .select(HORSE_COLS)
        .maybeSingle();
      if (error) return unavailable(res, error);
      if (!data) return notFound(res);
      res.json({ horse: horseView(req, data) });
    }),
  );

  router.post(
    "/:id/remove",
    asyncRoute(async (req, res) => {
      let horse;
      try {
        horse = await loadHorse(req, req.params.id);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!horse) return notFound(res);
      if (!canManage(req, horse.added_by))
        return res.status(403).json({ error: "Only the person who added this horse, or a stable manager, can remove it." });
      const { error } = await scoped(supabase.from("virtual_horses").delete().eq("id", horse.id), req);
      if (error) return unavailable(res, error);
      if (horse.formfav_key) bustFollowerCounts();
      res.json({ ok: true });
    }),
  );

  /* ------------------------------ Race-data link and alerts ------------------------------ */

  /** POST /:id/formfav {name, code} — link a horse typed in by hand to a race-data horse. */
  router.post(
    "/:id/formfav",
    asyncRoute(async (req, res) => {
      let horse;
      try {
        horse = await loadHorse(req, req.params.id);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!horse) return notFound(res);
      if (horse.source !== "manual")
        return res.status(400).json({ error: "Only a horse typed in by hand can be linked to race data." });
      if (!canManage(req, horse.added_by))
        return res.status(403).json({ error: "Only the person who added this horse, or a stable manager, can link it." });
      if (horse.formfav_key)
        return res.status(409).json({ error: "This horse is already linked. Unlink it first.", code: "already_linked" });
      let target;
      try {
        target = resolveRacingHorse({ name: req.body?.name, code: req.body?.code });
      } catch (error) {
        if (error instanceof LinkError) return linkFailed(res, error);
        throw error;
      }
      const { error } = await scoped(
        supabase
          .from("virtual_horses")
          .update({ ...linkColumns(target), formfav_linked_by: me(req).id, updated_at: new Date().toISOString() })
          .eq("id", horse.id),
        req,
      );
      if (error) {
        if (error.code === "23505")
          return res.status(409).json({ error: "That racing horse is already in this Virtual Stayblz.", code: "already_added" });
        return unavailable(res, error);
      }
      bustFollowerCounts();
      await syncLinkedHorse("virtual", horse.id, target);
      const fresh = await loadHorse(req, horse.id).catch(() => null);
      res.json({ horse: horseView(req, fresh ?? horse) });
    }),
  );

  /** POST /:id/formfav/remove — unlink: the details stay, race-data log rows become ordinary rows. */
  router.post(
    "/:id/formfav/remove",
    asyncRoute(async (req, res) => {
      let horse;
      try {
        horse = await loadHorse(req, req.params.id);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!horse) return notFound(res);
      if (!horse.formfav_key) return res.status(400).json({ error: "This horse isn't linked to race data." });
      if (horse.source === "formfav")
        return res.status(400).json({ error: "A horse added from Racing horses can't be unlinked. Remove it instead." });
      if (!canManage(req, horse.added_by))
        return res.status(403).json({ error: "Only the person who added this horse, or a stable manager, can unlink it." });
      const { error } = await supabase.rpc("formfav_unlink", { p_kind: "virtual", p_id: horse.id });
      if (error) return unavailable(res, error);
      bustFollowerCounts();
      const fresh = await loadHorse(req, horse.id).catch(() => null);
      res.json({ horse: horseView(req, fresh ?? horse) });
    }),
  );

  /** POST /:id/alerts {on} — the viewer's own alerts for a linked horse (everyone in a stable decides for themselves). */
  router.post(
    "/:id/alerts",
    asyncRoute(async (req, res) => {
      const on = req.body?.on;
      if (typeof on !== "boolean") return res.status(400).json({ error: "Choose on or off." });
      let horse;
      try {
        horse = await loadHorse(req, req.params.id);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!horse) return notFound(res);
      if (!horse.formfav_key) return res.status(400).json({ error: "Alerts are for horses linked to race data." });
      const viewer = me(req).id;
      const { error } = on
        ? await supabase.from("virtual_horse_mutes").delete().eq("horse_id", horse.id).eq("user_id", viewer)
        : await supabase.from("virtual_horse_mutes").insert({ horse_id: horse.id, user_id: viewer });
      if (error && error.code !== "23505") return unavailable(res, error);
      res.json({ alertsOn: on });
    }),
  );

  /* ------------------------------ Entries ------------------------------ */

  router.post(
    "/:id/entries",
    asyncRoute(async (req, res) => {
      let fields;
      try {
        fields = virtualEntryInput(req.body ?? {});
      } catch (error) {
        return bad(res, error);
      }
      let horse;
      try {
        horse = await loadHorse(req, req.params.id);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!horse) return notFound(res);
      const { count, error: countError } = await supabase
        .from("virtual_horse_entries")
        .select("id", { count: "exact", head: true })
        .eq("virtual_horse_id", horse.id);
      if (countError) return unavailable(res, countError);
      if ((count ?? 0) >= MAX_VIRTUAL_ENTRIES)
        return res.status(409).json({ error: `A horse can hold up to ${MAX_VIRTUAL_ENTRIES} entries. Remove some first.` });
      const author = me(req).id;
      const { data, error } = await supabase
        .from("virtual_horse_entries")
        .insert({ ...fields, virtual_horse_id: horse.id, author_id: author })
        .select(ENTRY_COLS)
        .single();
      if (error) return unavailable(res, error);
      await supabase.from("virtual_horses").update({ updated_at: new Date().toISOString() }).eq("id", horse.id);
      const authors = await names([author]).catch(() => new Map<string, string>());
      res.status(201).json({ entry: entryView(req, data, authors) });
    }),
  );

  /** An entry together with its horse, only when that horse is in this list. */
  async function loadEntry(req: Request, id: string): Promise<{ entry: any; horse: any } | null> {
    const { data: entry, error } = await supabase.from("virtual_horse_entries").select(ENTRY_COLS).eq("id", id).maybeSingle();
    if (error) throw error;
    if (!entry) return null;
    const horse = await loadHorse(req, (entry as any).virtual_horse_id);
    return horse ? { entry, horse } : null;
  }

  router.patch(
    "/entries/:entry",
    asyncRoute(async (req, res) => {
      let found;
      try {
        found = await loadEntry(req, req.params.entry);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!found) return notFound(res, "That entry");
      const { entry, horse } = found;
      // A race from race data keeps its race details; its notes are the list's.
      const fromRace = !!entry.formfav_ref;
      let fields;
      try {
        fields = fromRace ? entryNotesInput(req.body ?? {}) : virtualEntryInput(req.body ?? {});
      } catch (error) {
        return bad(res, error);
      }
      if (!canManage(req, fromRace ? horse.added_by : entry.author_id))
        return res.status(403).json({ error: "Only the person who logged this entry, or a stable manager, can change it." });
      const { data, error } = await supabase
        .from("virtual_horse_entries")
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq("id", entry.id)
        .select(ENTRY_COLS)
        .maybeSingle();
      if (error) return unavailable(res, error);
      if (!data) return notFound(res, "That entry");
      const authors = await names([(data as any).author_id]).catch(() => new Map<string, string>());
      res.json({ entry: entryView(req, data, authors, horse) });
    }),
  );

  router.post(
    "/entries/:entry/remove",
    asyncRoute(async (req, res) => {
      let found;
      try {
        found = await loadEntry(req, req.params.entry);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!found) return notFound(res, "That entry");
      const { entry, horse } = found;
      if (entry.formfav_ref && horse.formfav_key)
        return res
          .status(409)
          .json({ error: "This race comes from race data. Unlink the horse to remove it.", code: "from_race_data" });
      if (!canManage(req, entry.formfav_ref ? horse.added_by : entry.author_id))
        return res.status(403).json({ error: "Only the person who logged this entry, or a stable manager, can remove it." });
      const { error } = await supabase.from("virtual_horse_entries").delete().eq("id", entry.id);
      if (error) return unavailable(res, error);
      res.json({ ok: true });
    }),
  );

  return router;
}
