import { Router } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { text } from "../lib/workspace";
import { accountActive, coOwnedIds } from "../lib/communityHorses";
import * as idx from "../lib/formFavIndex";
import { historyHorse } from "../lib/formFavHistory";
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (
    req.method !== "GET" &&
    (req as AuthenticatedRequest).user.passwordSetupRequired
  ) {
    res
      .status(403)
      .json({
        error: "Complete password setup before saving your racing information.",
      });
    return;
  }
  next();
});
const userId = (req: any) => (req as AuthenticatedRequest).user.id;
const unavailable = (res: any) =>
  res
    .status(503)
    .json({
      error:
        "Your racing notebook is temporarily unavailable. Please try again.",
    });
router.get(
  "/summary",
  asyncRoute(async (req, res) => {
    const id = userId(req);
    const results = await Promise.all([
      supabase
        .from("member_watchlist")
        .select("record_id", { count: "exact", head: true })
        .eq("user_id", id),
      supabase
        .from("racing_notes")
        .select("id", { count: "exact", head: true })
        .eq("user_id", id),
      supabase
        .from("personal_conversations")
        .select("id", { count: "exact", head: true })
        .contains("member_ids", [id]),
      supabase
        .from("racing_follows")
        .select("id", { count: "exact", head: true })
        .eq("user_id", id),
    ]);
    if (results.some((r) => r.error)) return unavailable(res);
    res.json({
      // Earlier flat-record follows + follows on the linked racing data.
      following: (results[0].count ?? 0) + (results[3].count ?? 0),
      notes: results[1].count ?? 0,
      conversations: results[2].count ?? 0,
    });
  }),
);
/**
 * GET /race-watch — the dashboard's "Your horses": horses in the member's Virtual Stayblz (personal and every stable
 * they belong to) that are linked to race data, plus the horses they own or co-own (Account → My horses), linked or
 * not. Linked ones carry what the FormFav index has on them now (entries and latest results; no FormFav calls).
 * One racing horse in several lists is one row with every list it's in. Entered first (soonest), then the latest
 * results (newest), then the rest A–Z.
 */
/** Per list: a Virtual Stayblz list holds at most 300 horses + 300 racing horses. */
const WATCH_LIMIT = 600;
type WatchList =
  | { kind: "personal"; id: string; source: string }
  | { kind: "stable"; id: string; source: string; stableId: string; stableName: string }
  | { kind: "owned"; id: string; role: "lead" | "coowner" };
/**
 * A linked horse's race status: the 30-day window, and when it hasn't run there, its latest runs from the Stayblz
 * race history (lastStart and up to 3 finishes; starts/wins/places stay the window's, i.e. 0).
 */
async function raceWithHistory(name: string, code: string) {
  const now = idx.raceStatus(name, code);
  if (now?.lastStart) return now;
  const older = await historyHorse(idx.horseKey(name, code), null).catch(() => null);
  const runs = older?.starts ?? [];
  if (!runs.length) return now;
  const last = runs[0];
  return {
    starts: now?.starts ?? 0,
    wins: now?.wins ?? 0,
    places: now?.places ?? 0,
    nextEntry: now?.nextEntry ?? null,
    trainer: now?.trainer ?? last.trainer,
    jockey: now?.jockey ?? last.jockey,
    lastStart: {
      date: last.date,
      track: last.track,
      slug: last.slug,
      position: last.position,
      raceNumber: last.raceNumber,
      code: last.code,
      country: last.country,
      timezone: "America/New_York",
      fieldSize: last.fieldSize,
    },
    recent: runs.slice(0, 3).map((x) => ({ date: x.date, position: x.position, track: x.track, fieldSize: x.fieldSize })),
    fromHistory: true,
  };
}

router.get(
  "/race-watch",
  asyncRoute(async (req, res) => {
    const id = userId(req);
    res.set("Cache-Control", "no-store");
    idx.ensureIndex();
    const status = idx.indexStatus();
    const meta = { building: status.building, updatedAt: status.updatedAt };
    if (!isUuid(id)) return void res.json({ horses: [], ...meta });
    try {
      const VCOLS = "id,user_id,stable_id,source,name,formfav_name,formfav_code,formfav_key";
      const OCOLS = "id,owner_id,name,breed,status,cover_image_id,formfav_name,formfav_code,formfav_key";
      const [memberships, personal, mine, coOwned] = await Promise.all([
        supabase.from("stable_memberships").select("stable_id,member_stables(id,name)").eq("user_id", id),
        supabase.from("virtual_horses").select(VCOLS).eq("user_id", id).limit(WATCH_LIMIT),
        supabase.from("owner_horses").select(OCOLS).eq("owner_id", id).limit(500),
        coOwnedIds(id),
      ]);
      if (memberships.error || personal.error || mine.error) return unavailable(res);
      const stables = new Map<string, string>(
        ((memberships.data ?? []) as any[])
          .filter((m) => m.member_stables)
          .map((m) => [m.stable_id as string, String(m.member_stables.name ?? "Stable")]),
      );
      const [stableHorses, shared] = await Promise.all([
        stables.size
          ? supabase.from("virtual_horses").select(VCOLS).in("stable_id", [...stables.keys()]).limit(Math.min(3000, WATCH_LIMIT * stables.size))
          : Promise.resolve({ data: [] as any[], error: null }),
        coOwned.length
          ? supabase.from("owner_horses").select(OCOLS).in("id", coOwned).neq("owner_id", id)
          : Promise.resolve({ data: [] as any[], error: null }),
      ]);
      if (stableHorses.error || shared.error) return unavailable(res);
      // Co-owned horses whose lead owner's account is no longer active are left out (as in My horses).
      const sharedRows = (shared.data ?? []) as any[];
      const active = await Promise.all(sharedRows.map((h) => accountActive(h.owner_id)));

      type Row = {
        key: string;
        name: string;
        linked: boolean;
        raceData: { name: string; code: string } | null;
        coverImageId: string | null;
        lists: WatchList[];
      };
      const rows = new Map<string, Row>();
      const add = (h: any, list: WatchList, extra: { coverImageId?: string | null } = {}) => {
        const key = h.formfav_key ? `race:${h.formfav_key}` : `owned:${h.id}`;
        let row = rows.get(key);
        if (!row)
          rows.set(
            key,
            (row = {
              key,
              name: String(h.name ?? h.formfav_name ?? ""),
              linked: !!h.formfav_key,
              raceData: h.formfav_key ? { name: String(h.formfav_name), code: String(h.formfav_code) } : null,
              coverImageId: null,
              lists: [],
            }),
          );
        if (extra.coverImageId && !row.coverImageId) row.coverImageId = extra.coverImageId;
        // Owned horses lead with their own name (the owner's spelling).
        if (list.kind === "owned") row.name = String(h.name ?? row.name);
        row.lists.push(list);
      };
      for (const h of (mine.data ?? []) as any[]) add(h, { kind: "owned", id: h.id, role: "lead" }, { coverImageId: h.cover_image_id });
      sharedRows.forEach((h, i) => active[i] && add(h, { kind: "owned", id: h.id, role: "coowner" }, { coverImageId: h.cover_image_id }));
      // Virtual horses only when linked to race data (otherwise there is nothing to show here).
      for (const h of (personal.data ?? []) as any[]) if (h.formfav_key) add(h, { kind: "personal", id: h.id, source: h.source });
      for (const h of (stableHorses.data ?? []) as any[])
        if (h.formfav_key) add(h, { kind: "stable", id: h.id, source: h.source, stableId: h.stable_id, stableName: stables.get(h.stable_id) ?? "Stable" });

      const order = { owned: 0, personal: 1, stable: 2 } as const;
      const horses = await Promise.all(
        [...rows.values()].map(async (r) => ({
          ...r,
          lists: r.lists.sort((a, b) => order[a.kind] - order[b.kind]),
          race: r.raceData ? await raceWithHistory(r.raceData.name, r.raceData.code) : null,
        })),
      );
      const nextAt = (h: (typeof horses)[number]) => {
        const n = h.race?.nextEntry;
        return n ? n.date + (n.startTime ?? "~") : null;
      };
      const lastAt = (h: (typeof horses)[number]) => h.race?.lastStart?.date ?? null;
      horses.sort((a, b) => {
        const na = nextAt(a);
        const nb = nextAt(b);
        if (na || nb) return !na ? 1 : !nb ? -1 : na.localeCompare(nb) || a.name.localeCompare(b.name);
        const la = lastAt(a);
        const lb = lastAt(b);
        if (la || lb) return !la ? 1 : !lb ? -1 : lb.localeCompare(la) || a.name.localeCompare(b.name);
        return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
      });
      res.json({ horses, ...meta });
    } catch {
      unavailable(res);
    }
  }),
);
router.get(
  "/notes",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("racing_notes")
      .select("id,title,body,updated_at")
      .eq("user_id", userId(req))
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) return unavailable(res);
    res.json({ notes: data ?? [] });
  }),
);
function noteInput(body: any) {
  if (typeof body?.body !== "string" || body.body.length > 4000)
    throw new Error("invalid_note");
  return { title: text(body?.title, 120), body: body.body };
}
router.post(
  "/notes",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = noteInput(req.body);
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a note title and up to 4,000 characters." });
    }
    const { data, error } = await supabase
      .from("racing_notes")
      .insert({ ...input, user_id: userId(req) })
      .select("id,title,body,updated_at")
      .single();
    if (error) return unavailable(res);
    res.status(201).json({ note: data });
  }),
);
router.patch(
  "/notes/:id",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id))
      return res.status(404).json({ error: "Note not found." });
    let input;
    try {
      input = noteInput(req.body);
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a note title and up to 4,000 characters." });
    }
    const { data, error } = await supabase
      .from("racing_notes")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("user_id", userId(req))
      .select("id,title,body,updated_at")
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data) return res.status(404).json({ error: "Note not found." });
    res.json({ note: data });
  }),
);
router.post(
  "/notes/:id/remove",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id))
      return res.status(404).json({ error: "Note not found." });
    const { data, error } = await supabase
      .from("racing_notes")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", userId(req))
      .select("id")
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data) return res.status(404).json({ error: "Note not found." });
    res.json({ ok: true });
  }),
);
/** Racing alerts reach the bell, on-screen cards and (with notifications on) devices; email isn't sent yet. */
const delivery = { deliveryAvailable: true, emailAvailable: false };
const keys = [
  "entry_alerts",
  "workout_alerts",
  "result_alerts",
  "email_enabled",
] as const;
router.get(
  "/preferences",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("racing_preferences")
      .select(keys.join(","))
      .eq("user_id", userId(req))
      .maybeSingle();
    if (error) return unavailable(res);
    const values = data as unknown as Record<string, unknown> | null;
    // No saved choice = racing alerts on (SQL racing_alert_wanted), email off.
    res.json({
      preferences: Object.fromEntries(
        keys.map((k) => [k, values ? values[k] === true : k !== "email_enabled"]),
      ),
      ...delivery,
    });
  }),
);
router.patch(
  "/preferences",
  asyncRoute(async (req, res) => {
    if (!keys.every((k) => typeof req.body?.[k] === "boolean"))
      return res.status(400).json({ error: "Choose valid alert preferences." });
    const preferences = Object.fromEntries(keys.map((k) => [k, req.body[k]]));
    const { error } = await supabase
      .from("racing_preferences")
      .upsert(
        {
          ...preferences,
          user_id: userId(req),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
    if (error) return unavailable(res);
    res.json({ preferences, ...delivery });
  }),
);

// ----- Following on the linked racing data (horses, people, a horse's family) -----
// Rows: racing_follows (202611190004_racing_follows.sql). Alerts are sent by lib/racingAlerts.ts.
const followKinds = ["horse", "family", "person"] as const;
const followFailures: Record<string, [number, string]> = {
  unknown_target: [404, "That horse or person isn't on Stayblz racing pages yet."],
  too_many_follows: [409, "You can follow up to 300 horses, people and families. Unfollow some first."],
  invalid_kind: [400, "Choose a horse, a family or a person to follow."],
};
router.get(
  "/follows",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.rpc("racing_follows_list", { p_user: userId(req) });
    if (error) return res.status(503).json({ error: "Your follows are temporarily unavailable. Please try again." });
    res.set("Cache-Control", "no-store");
    res.json({ follows: Array.isArray(data) ? data : [] });
  }),
);
router.get(
  "/follows/state",
  asyncRoute(async (req, res) => {
    const id = req.query.id;
    if (!isUuid(id)) return res.status(400).json({ error: "Choose a horse or person." });
    const { data, error } = await supabase.rpc("racing_follow_state", { p_user: userId(req), p_target: id });
    if (error) return res.status(503).json({ error: "Follow status is temporarily unavailable." });
    res.set("Cache-Control", "no-store");
    res.json({ state: data });
  }),
);
router.post(
  "/follows",
  asyncRoute(async (req, res) => {
    const { kind, id, on } = req.body ?? {};
    if (!followKinds.includes(kind) || !isUuid(id) || typeof on !== "boolean")
      return res.status(400).json({ error: "Choose a horse, a family or a person to follow." });
    const { data, error } = await supabase.rpc("racing_follow_set", { p_user: userId(req), p_kind: kind, p_target: id, p_on: on });
    if (error) {
      const message = String(error.message ?? "");
      const known = Object.keys(followFailures).find((key) => message.includes(key));
      if (known) return res.status(followFailures[known][0]).json({ error: followFailures[known][1] });
      return res.status(503).json({ error: "Your follow could not be saved. Please try again." });
    }
    res.json({ state: data });
  }),
);
export default router;
