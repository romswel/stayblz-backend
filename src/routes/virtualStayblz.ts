import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { isUuid, type StableRequest } from "../middleware/stable";
import { supabase } from "../lib/supabase";
import { canSeeHorse, loadCommunityHorse, loadStats, ownerContext, type OwnerContext } from "../lib/communityHorses";
import { VirtualInputError, virtualEntryInput, virtualHorseInput } from "../lib/virtualInput";

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
 */

export const MAX_VIRTUAL_HORSES = 300;
export const MAX_VIRTUAL_ENTRIES = 2000;

type Mode = "personal" | "stable";
const HORSE_COLS =
  "id,user_id,stable_id,added_by,source,community_horse_id,racing_horse_id,name,breed,sex,foaled_year,color,sire,dam,trainer,owner_name,location,notes,created_at,updated_at";
const ENTRY_COLS =
  "id,virtual_horse_id,author_id,kind,entry_date,title,track,distance,surface,time_text,finish,field_size,result,hip_number,amount_cents,notes,created_at,updated_at";

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
    createdAt: h.created_at,
    updatedAt: h.updated_at,
    ...extra,
  });

  const entryView = (req: Request, e: any, authors: Map<string, string>) => ({
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
    canEdit: canManage(req, e.author_id),
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  });

  /* ------------------------------ The list ------------------------------ */

  router.get(
    "/",
    asyncRoute(async (req, res) => {
      const viewer = me(req).id;
      const { data, error } = await scoped(supabase.from("virtual_horses").select(HORSE_COLS), req)
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

  /** Is this community / racing horse already in this list? Drives the "Add to Virtual Stayblz" buttons. */
  router.get(
    "/state",
    asyncRoute(async (req, res) => {
      const { communityHorseId, racingHorseId } = req.query;
      const column = isUuid(communityHorseId) ? "community_horse_id" : isUuid(racingHorseId) ? "racing_horse_id" : null;
      if (!column) return res.status(400).json({ error: "Choose a horse." });
      const target = (column === "community_horse_id" ? communityHorseId : racingHorseId) as string;
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
        } else {
          return res.status(400).json({ error: "Choose a Stayblz horse, a racing horse, or enter one by hand." });
        }
      } catch (err) {
        return unavailable(res, err as DbError);
      }

      const { count, error: countError } = await scoped(
        supabase.from("virtual_horses").select("id", { count: "exact", head: true }),
        req,
      );
      if (countError) return unavailable(res, countError);
      if ((count ?? 0) >= MAX_VIRTUAL_HORSES)
        return res.status(409).json({ error: `Virtual Stayblz holds up to ${MAX_VIRTUAL_HORSES} horses. Remove some first.` });

      const { data, error } = await supabase
        .from("virtual_horses")
        .insert({ ...fields, notes, ...owner(req), added_by: viewer })
        .select(HORSE_COLS)
        .single();
      if (error) {
        if (error.code === "23505") {
          const column = fields.source === "community" ? "community_horse_id" : "racing_horse_id";
          const target = (fields.community_horse_id ?? fields.racing_horse_id) as string;
          const { data: existing } = await scoped(supabase.from("virtual_horses").select("id").eq(column, target), req).maybeSingle();
          return res
            .status(409)
            .json({ error: "That horse is already in this Virtual Stayblz.", code: "already_added", id: existing?.id ?? null });
        }
        return unavailable(res, error);
      }
      res.status(201).json({ horse: horseView(req, data) });
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
        res.set("Cache-Control", "no-store");
        res.json({
          horse: horseView(req, horse, {
            addedByName: horse.added_by ? (authors.get(horse.added_by) ?? "Stayblz member") : null,
          }),
          entries: (entries.data ?? []).map((e: any) => entryView(req, e, authors)),
          live,
          liveUnavailable: horse.source !== "manual" && !live,
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
      res.json({ ok: true });
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
  async function loadEntry(req: Request, id: string) {
    const { data: entry, error } = await supabase.from("virtual_horse_entries").select(ENTRY_COLS).eq("id", id).maybeSingle();
    if (error) throw error;
    if (!entry) return null;
    const horse = await loadHorse(req, (entry as any).virtual_horse_id);
    return horse ? (entry as any) : null;
  }

  router.patch(
    "/entries/:entry",
    asyncRoute(async (req, res) => {
      let fields;
      try {
        fields = virtualEntryInput(req.body ?? {});
      } catch (error) {
        return bad(res, error);
      }
      let entry;
      try {
        entry = await loadEntry(req, req.params.entry);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!entry) return notFound(res, "That entry");
      if (!canManage(req, entry.author_id))
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
      res.json({ entry: entryView(req, data, authors) });
    }),
  );

  router.post(
    "/entries/:entry/remove",
    asyncRoute(async (req, res) => {
      let entry;
      try {
        entry = await loadEntry(req, req.params.entry);
      } catch (err) {
        return unavailable(res, err as DbError);
      }
      if (!entry) return notFound(res, "That entry");
      if (!canManage(req, entry.author_id))
        return res.status(403).json({ error: "Only the person who logged this entry, or a stable manager, can remove it." });
      const { error } = await supabase.from("virtual_horse_entries").delete().eq("id", entry.id);
      if (error) return unavailable(res, error);
      res.json({ ok: true });
    }),
  );

  return router;
}
