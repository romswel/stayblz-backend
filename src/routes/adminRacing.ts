import express, { Router, type Request, type Response } from "express";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { isUuid } from "../middleware/stable";
import { supabase } from "../lib/supabase";
import { accountStore } from "../lib/accounts";
import {
  dateRange,
  dayInput,
  horseInput,
  importInput,
  personInput,
  raceInput,
  resultsInput,
  runnerInput,
  trackInput,
  workoutInput,
} from "../lib/racingInput";

/**
 * Racing publishing tool (admins and superadmins). Race days stay drafts until published;
 * every change is recorded in the account activity log.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole("admin"));
router.use(authLimit("admin-racing", 240, 60_000));

type DbError = { code?: string; message?: string } | null;
const failures: Record<string, [number, string]> = {
  not_allowed: [403, "Only admins can publish racing data."],
  duplicate_finish: [400, "Two runners can't share the same finish position."],
  winner_required: [400, "Enter a winner (finish position 1) before marking the race official."],
  unknown_race: [404, "That race no longer exists."],
  unknown_runner: [404, "One of those runners is no longer in this race."],
  unknown_day: [404, "That race day no longer exists."],
  invalid_rows: [400, "The import needs between 1 and 400 rows."],
};
function sendDbError(res: Response, error: DbError, duplicate = "That already exists.") {
  const message = String(error?.message ?? "");
  const known = Object.keys(failures).find((key) => message.includes(key));
  if (known) return res.status(failures[known][0]).json({ error: failures[known][1] });
  if (error?.code === "23505") return res.status(409).json({ error: duplicate });
  if (error?.code === "23503")
    return res.status(409).json({ error: "It's still used elsewhere (a race, runner or workout). Remove that first." });
  if (error?.code === "23514" || error?.code === "22P02" || error?.code === "22003")
    return res.status(400).json({ error: "Some of those values aren't valid. Check the form and try again." });
  return res.status(503).json({ error: "Racing data could not be saved. Try again." });
}
const actor = (req: Request) => (req as AuthenticatedRequest).user.id;
const audit = (req: Request, event: string, detail: Record<string, unknown>) =>
  accountStore.record(event, actor(req), actor(req), detail);
const idParam = (req: Request, res: Response) => {
  const value = String(req.params.id);
  if (!isUuid(value)) {
    res.status(404).json({ error: "That record no longer exists." });
    return null;
  }
  return value;
};
const stamp = () => new Date().toISOString();

async function dayJson(dayId: string) {
  const { data, error } = await supabase.rpc("racing_day", { p_id: dayId, p_admin: true });
  if (error) throw error;
  return data;
}
async function dayOfRace(raceId: string): Promise<string | null> {
  const { data } = await supabase.from("racing_races").select("day_id").eq("id", raceId).maybeSingle();
  return (data as { day_id?: string } | null)?.day_id ?? null;
}

// ----- Tracks -----
router.get(
  "/tracks",
  asyncRoute(async (_req, res) => {
    const { data, error } = await supabase.from("racing_tracks").select("*").order("name", { ascending: true }).limit(500);
    if (error) return sendDbError(res, error);
    res.json({ tracks: data ?? [] });
  }),
);
for (const method of ["post", "put"] as const)
  router[method](
    method === "post" ? "/tracks" : "/tracks/:id",
    asyncRoute(async (req, res) => {
      const parsed = trackInput(req.body ?? {});
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      let query;
      if (method === "post") query = supabase.from("racing_tracks").insert(parsed.value).select().single();
      else {
        const id = idParam(req, res);
        if (!id) return;
        query = supabase.from("racing_tracks").update({ ...parsed.value, updated_at: stamp() }).eq("id", id).select().single();
      }
      const { data, error } = await query;
      if (error) return sendDbError(res, error, "Another track already uses that code.");
      if (!data) return res.status(404).json({ error: "That track no longer exists." });
      await audit(req, method === "post" ? "racing.track_created" : "racing.track_edited", { track: data.id });
      res.status(method === "post" ? 201 : 200).json({ track: data });
    }),
  );

// ----- Lookup, horses and people -----
router.get(
  "/lookup",
  asyncRoute(async (req, res) => {
    const kind = String(req.query.kind ?? "");
    if (!["horse", "track", "jockey", "driver", "trainer", "owner"].includes(kind))
      return res.status(400).json({ error: "Choose what to look up." });
    const { data, error } = await supabase.rpc("racing_lookup", {
      p_kind: kind,
      p_query: typeof req.query.q === "string" ? req.query.q.slice(0, 60) : "",
    });
    if (error) return sendDbError(res, error);
    res.json({ results: data ?? [] });
  }),
);
const saveEntity = (table: "racing_horses" | "racing_people", parse: typeof horseInput | typeof personInput, key: string) => {
  for (const method of ["post", "put"] as const)
    router[method](
      method === "post" ? `/${key}` : `/${key}/:id`,
      asyncRoute(async (req, res) => {
        const parsed = parse(req.body ?? {});
        if ("error" in parsed) return res.status(400).json({ error: parsed.error });
        let query;
        const row = parsed.value as Record<string, unknown>;
        if (method === "post") query = supabase.from(table).insert(row).select().single();
        else {
          const id = idParam(req, res);
          if (!id) return;
          query = supabase.from(table).update({ ...row, updated_at: stamp() }).eq("id", id).select().single();
        }
        const { data, error } = await query;
        if (error)
          return sendDbError(
            res,
            error,
            key === "horses" ? "A horse with that name and country already exists." : "Someone with that name and role already exists.",
          );
        if (!data) return res.status(404).json({ error: "That record no longer exists." });
        await audit(req, `racing.${key === "horses" ? "horse" : "person"}_${method === "post" ? "created" : "edited"}`, {
          id: data.id,
        });
        res.status(method === "post" ? 201 : 200).json({ record: data });
      }),
    );
};
saveEntity("racing_horses", horseInput, "horses");
saveEntity("racing_people", personInput, "people");

// ----- Race days -----
router.get(
  "/days",
  asyncRoute(async (req, res) => {
    const today = Date.now();
    const range = dateRange(
      req.query.from ?? new Date(today - 60 * 864e5).toISOString().slice(0, 10),
      req.query.to ?? new Date(today + 60 * 864e5).toISOString().slice(0, 10),
      120,
      800,
    );
    if (!range) return res.status(400).json({ error: "Choose a valid date range (up to about two years)." });
    const { data, error } = await supabase.rpc("racing_admin_days", { p_from: range.from, p_to: range.to });
    if (error) return sendDbError(res, error);
    res.json({ days: data ?? [], ...range });
  }),
);
router.post(
  "/days",
  asyncRoute(async (req, res) => {
    const parsed = dayInput(req.body ?? {});
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { data, error } = await supabase
      .from("racing_days")
      .insert({ ...parsed.value, created_by: actor(req), updated_by: actor(req) })
      .select()
      .single();
    if (error) return sendDbError(res, error, "That track already has a race day on that date.");
    await audit(req, "racing.day_created", { day: data.id });
    res.status(201).json({ day: await dayJson(data.id) });
  }),
);
router.get(
  "/days/:id",
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const day = await dayJson(id).catch(() => undefined);
    if (day === undefined) return res.status(503).json({ error: "Racing data is unavailable. Try again." });
    if (!day) return res.status(404).json({ error: "That race day no longer exists." });
    res.json({ day });
  }),
);
router.put(
  "/days/:id",
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const notes = req.body?.notes;
    if (typeof notes !== "string" || notes.length > 1000 || /[<>\u0000-\u0008]/.test(notes))
      return res.status(400).json({ error: "Notes can be up to 1,000 characters, without < or >." });
    const { data, error } = await supabase
      .from("racing_days")
      .update({ notes: notes.trim(), updated_at: stamp(), updated_by: actor(req) })
      .eq("id", id)
      .select()
      .single();
    if (error) return sendDbError(res, error);
    if (!data) return res.status(404).json({ error: "That race day no longer exists." });
    res.json({ day: await dayJson(id) });
  }),
);
for (const action of ["publish", "unpublish"] as const)
  router.post(
    `/days/:id/${action}`,
    asyncRoute(async (req, res) => {
      const id = idParam(req, res);
      if (!id) return;
      if (action === "publish") {
        const races = await supabase.from("racing_races").select("id").eq("day_id", id).limit(1);
        if (races.error) return sendDbError(res, races.error);
        if (!races.data?.length) return res.status(400).json({ error: "Add at least one race before publishing." });
      }
      const { data, error } = await supabase
        .from("racing_days")
        .update({
          status: action === "publish" ? "published" : "draft",
          published_at: action === "publish" ? stamp() : null,
          updated_at: stamp(),
          updated_by: actor(req),
        })
        .eq("id", id)
        .select()
        .single();
      if (error) return sendDbError(res, error);
      if (!data) return res.status(404).json({ error: "That race day no longer exists." });
      await audit(req, `racing.day_${action}ed`, { day: id });
      res.json({ day: await dayJson(id) });
    }),
  );
router.delete(
  "/days/:id",
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const current = await supabase.from("racing_days").select("status").eq("id", id).maybeSingle();
    if (current.error) return sendDbError(res, current.error);
    if (!current.data) return res.status(404).json({ error: "That race day no longer exists." });
    if ((current.data as { status: string }).status !== "draft")
      return res.status(409).json({ error: "Unpublish the race day before deleting it." });
    const { error } = await supabase.from("racing_days").delete().eq("id", id);
    if (error) return sendDbError(res, error);
    await audit(req, "racing.day_deleted", { day: id });
    res.json({ deleted: true });
  }),
);
router.post(
  "/days/:id/import",
  // A whole card (up to 400 runners) needs more room; the admin check above has already run.
  express.json({ limit: "512kb" }),
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const parsed = importInput(req.body ?? {});
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { data, error } = await supabase.rpc("racing_import_card", { p_actor: actor(req), p_day: id, p_rows: parsed.value });
    if (error) return sendDbError(res, error, "Two rows use the same program number in one race.");
    res.json({ summary: data, day: await dayJson(id) });
  }),
);

// ----- Races -----
router.post(
  "/days/:id/races",
  asyncRoute(async (req, res) => {
    const dayId = idParam(req, res);
    if (!dayId) return;
    const body = { ...(req.body ?? {}) };
    if (body.breed === undefined) {
      const day = await supabase.from("racing_days").select("track_id").eq("id", dayId).maybeSingle();
      if (!day.data) return res.status(404).json({ error: "That race day no longer exists." });
      const track = await supabase.from("racing_tracks").select("breed").eq("id", (day.data as { track_id: string }).track_id).maybeSingle();
      body.breed = (track.data as { breed?: string } | null)?.breed ?? "thoroughbred";
    }
    const parsed = raceInput(body);
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { error } = await supabase.from("racing_races").insert({ ...parsed.value, day_id: dayId }).select().single();
    if (error) return sendDbError(res, error, "This race day already has a race with that number.");
    await audit(req, "racing.race_created", { day: dayId, race: parsed.value.race_number });
    res.status(201).json({ day: await dayJson(dayId) });
  }),
);
router.put(
  "/races/:id",
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const dayId = await dayOfRace(id);
    if (!dayId) return res.status(404).json({ error: "That race no longer exists." });
    const parsed = raceInput(req.body ?? {});
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { error } = await supabase.from("racing_races").update({ ...parsed.value, updated_at: stamp() }).eq("id", id).select().single();
    if (error) return sendDbError(res, error, "This race day already has a race with that number.");
    await audit(req, "racing.race_edited", { race: id });
    res.json({ day: await dayJson(dayId) });
  }),
);
router.delete(
  "/races/:id",
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const dayId = await dayOfRace(id);
    if (!dayId) return res.status(404).json({ error: "That race no longer exists." });
    const { error } = await supabase.from("racing_races").delete().eq("id", id);
    if (error) return sendDbError(res, error);
    await audit(req, "racing.race_deleted", { race: id, day: dayId });
    res.json({ day: await dayJson(dayId) });
  }),
);
router.put(
  "/races/:id/results",
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const parsed = resultsInput(req.body ?? {});
    if ("error" in parsed) return res.status(400).json({ error: parsed.error });
    const { data, error } = await supabase.rpc("racing_save_results", { p_actor: actor(req), p_race: id, p_data: parsed.value });
    if (error) return sendDbError(res, error);
    res.json({ day: data });
  }),
);

// ----- Runners -----
async function checkPeople(value: { jockey_id: string | null; trainer_id: string | null; owner_id: string | null }) {
  const ids = [value.jockey_id, value.trainer_id, value.owner_id].filter(Boolean) as string[];
  if (!ids.length) return null;
  const { data, error } = await supabase.from("racing_people").select("id,kind").in("id", ids);
  if (error) throw error;
  const kinds = new Map((data ?? []).map((row: { id: string; kind: string }) => [row.id, row.kind]));
  if (value.jockey_id && !["jockey", "driver"].includes(kinds.get(value.jockey_id) ?? "")) return "Choose a jockey or driver for the rider.";
  if (value.trainer_id && kinds.get(value.trainer_id) !== "trainer") return "Choose a trainer for the trainer field.";
  if (value.owner_id && kinds.get(value.owner_id) !== "owner") return "Choose an owner for the owner field.";
  return null;
}
for (const method of ["post", "put"] as const)
  router[method](
    method === "post" ? "/races/:id/runners" : "/runners/:id",
    asyncRoute(async (req, res) => {
      const id = idParam(req, res);
      if (!id) return;
      const parsed = runnerInput(req.body ?? {});
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const problem = await checkPeople(parsed.value);
      if (problem) return res.status(400).json({ error: problem });
      let raceId = id;
      if (method === "put") {
        const current = await supabase.from("racing_runners").select("race_id").eq("id", id).maybeSingle();
        if (!current.data) return res.status(404).json({ error: "That runner no longer exists." });
        raceId = (current.data as { race_id: string }).race_id;
      }
      const dayId = await dayOfRace(raceId);
      if (!dayId) return res.status(404).json({ error: "That race no longer exists." });
      const write = { ...parsed.value, ...(parsed.value.scratched ? { finish_position: null } : {}) };
      const { error } =
        method === "post"
          ? await supabase.from("racing_runners").insert({ ...write, race_id: raceId }).select().single()
          : await supabase.from("racing_runners").update({ ...write, updated_at: stamp() }).eq("id", id).select().single();
      if (error) return sendDbError(res, error, "That horse or program number is already in this race.");
      await audit(req, method === "post" ? "racing.runner_added" : "racing.runner_edited", { race: raceId });
      res.status(method === "post" ? 201 : 200).json({ day: await dayJson(dayId) });
    }),
  );
router.delete(
  "/runners/:id",
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const current = await supabase.from("racing_runners").select("race_id").eq("id", id).maybeSingle();
    if (!current.data) return res.status(404).json({ error: "That runner no longer exists." });
    const raceId = (current.data as { race_id: string }).race_id;
    const dayId = await dayOfRace(raceId);
    const { error } = await supabase.from("racing_runners").delete().eq("id", id);
    if (error) return sendDbError(res, error);
    await audit(req, "racing.runner_removed", { race: raceId });
    res.json({ day: dayId ? await dayJson(dayId) : null });
  }),
);

// ----- Workouts -----
router.get(
  "/workouts",
  asyncRoute(async (req, res) => {
    const range = dateRange(
      req.query.from ?? new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10),
      req.query.to ?? new Date().toISOString().slice(0, 10),
      30,
      100,
    );
    if (!range) return res.status(400).json({ error: "Choose a valid date range (up to 100 days)." });
    const { data, error } = await supabase.rpc("racing_workouts_list", {
      p_from: range.from,
      p_to: range.to,
      p_track: null,
      p_admin: true,
    });
    if (error) return sendDbError(res, error);
    res.json({ workouts: data ?? [], ...range });
  }),
);
for (const method of ["post", "put"] as const)
  router[method](
    method === "post" ? "/workouts" : "/workouts/:id",
    asyncRoute(async (req, res) => {
      const parsed = workoutInput(req.body ?? {});
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const row = {
        ...parsed.value,
        published_at: parsed.value.status === "published" ? stamp() : null,
      };
      let query;
      if (method === "post") query = supabase.from("racing_workouts").insert(row).select().single();
      else {
        const id = idParam(req, res);
        if (!id) return;
        query = supabase.from("racing_workouts").update({ ...row, updated_at: stamp() }).eq("id", id).select().single();
      }
      const { data, error } = await query;
      if (error) return sendDbError(res, error, "That horse already has a workout at that track on that date.");
      if (!data) return res.status(404).json({ error: "That workout no longer exists." });
      await audit(req, method === "post" ? "racing.workout_created" : "racing.workout_edited", { workout: data.id });
      res.status(method === "post" ? 201 : 200).json({ workout: data });
    }),
  );
router.delete(
  "/workouts/:id",
  asyncRoute(async (req, res) => {
    const id = idParam(req, res);
    if (!id) return;
    const { data, error } = await supabase.from("racing_workouts").delete().eq("id", id).select();
    if (error) return sendDbError(res, error);
    if (!data?.length) return res.status(404).json({ error: "That workout no longer exists." });
    await audit(req, "racing.workout_deleted", { workout: id });
    res.json({ deleted: true });
  }),
);

export default router;
