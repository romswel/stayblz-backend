const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "false";
const { app } = require("../dist/app");
const { supabase } = require("../dist/lib/supabase");
const { identity } = require("../dist/lib/identity");
const { installDatabase } = require("./support/pgrest.cjs");

// Fixture names are obviously fictional and exist only inside this in-memory test database.
const customer = "11111111-1111-4111-8111-111111111111",
  admin = "22222222-2222-4222-8222-222222222222";
const providerUsers = new Map();
let database, db, server, origin;
const originals = {};
const token = (id) => "h." + Buffer.from(JSON.stringify({ sub: id, aal: "aal1" })).toString("base64url") + ".s";
const subject = (value) => JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()).sub;
const RACE_DAY = "2099-05-01";

async function call(id, path, { body, method } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(id ? { Cookie: "stayblz_access=" + token(id) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
const row = (race, program, horse, jockey, extra = {}) => ({
  race: String(race),
  postTime: race === 1 ? "13:00" : "13:30",
  raceName: race === 2 ? "Test Fixture Stakes" : "",
  raceType: race === 2 ? "stakes" : "maiden",
  grade: race === 2 ? "2" : "",
  distance: race === 2 ? "1 1/16" : "6",
  unit: race === 2 ? "miles" : "furlongs",
  surface: "dirt",
  purse: "50000",
  program,
  post: String(parseInt(program, 10)),
  horse,
  sire: "Fixture Sire",
  jockey,
  trainer: "Tess Trainer",
  owner: "Fixture Stable",
  weight: "122",
  ml: "5-2",
  ...extra,
});
const ids = {};

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, email] of [
    [customer, "customer@example.test"],
    [admin, "admin@example.test"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    providerUsers.set(id, { id, email, email_confirmed_at: "2026-11-01T00:00:00Z", app_metadata: {}, user_metadata: {}, factors: [] });
  }
  await db.query("select public.ensure_account($1)", [admin]);
  await db.query("select public.set_platform_role('admin@example.test','admin')");
  originals.user = identity.user;
  identity.user = async (value) => {
    const user = providerUsers.get(subject(value));
    return user ? { data: { user }, error: null } : { data: { user: null }, error: { status: 401 } };
  };
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  identity.user = originals.user;
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

test("the unused Bulletin column is gone", async () => {
  const { rows } = await db.query(
    "select column_name from information_schema.columns where table_name='accounts' and column_name like 'bulletin%'",
  );
  assert.deepEqual(rows, []);
});

test("only admins reach the publishing tool, and browsers can't read racing tables", async () => {
  assert.equal((await call(null, "/api/admin/racing/tracks")).status, 401);
  assert.equal((await call(customer, "/api/admin/racing/tracks")).status, 403);
  assert.equal((await call(admin, "/api/admin/racing/tracks")).status, 200);
  const { rows } = await db.query(
    "select bool_or(has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')) any_browser from unnest(array['racing_tracks','racing_days','racing_races','racing_runners','racing_horses','racing_people','racing_workouts']) t",
  );
  assert.equal(rows[0].any_browser, false);
});

test("admins build a race day by import; it stays private until published", async () => {
  for (const bad of [{ code: "x", name: "Test Park" }, { code: "TP", name: "" }, { code: "TP", name: "Test <b>Park</b>" }])
    assert.equal((await call(admin, "/api/admin/racing/tracks", { body: bad })).status, 400);
  const track = await call(admin, "/api/admin/racing/tracks", { body: { code: "tp", name: "Test Park", country: "US" } });
  assert.equal(track.status, 201);
  assert.equal(track.data.track.code, "TP");
  ids.track = track.data.track.id;
  assert.equal((await call(admin, "/api/admin/racing/tracks", { body: { code: "TP", name: "Other" } })).status, 409);

  const day = await call(admin, "/api/admin/racing/days", { body: { trackId: ids.track, date: RACE_DAY } });
  assert.equal(day.status, 201);
  ids.day = day.data.day.id;
  assert.equal(day.data.day.status, "draft");
  assert.equal((await call(admin, "/api/admin/racing/days", { body: { trackId: ids.track, date: RACE_DAY } })).status, 409);

  const badImport = await call(admin, `/api/admin/racing/days/${ids.day}/import`, {
    body: { rows: [row(1, "1", "Alpha Fixture", "Jo Rider"), row(1, "2", "Beta Fixture", "Jo Rider", { ml: "lots" })] },
  });
  assert.equal(badImport.status, 400);
  assert.match(badImport.data.error, /^Row 3: morning line/i);

  const imported = await call(admin, `/api/admin/racing/days/${ids.day}/import`, {
    body: {
      rows: [
        row(1, "1", "Alpha Fixture", "Jo Rider"),
        row(1, "2", "Beta Fixture", "Kim Rider"),
        row(1, "3", "Gamma Fixture", "Lee Rider"),
        row(2, "1", "Delta Fixture", "Jo Rider"),
        row(2, "1A", "Echo Fixture", "Kim Rider"),
      ],
    },
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.deepEqual(imported.data.summary, { runners: 5, racesCreated: 2, horsesCreated: 5, peopleCreated: 5 });
  const races = imported.data.day.races;
  assert.equal(races.length, 2);
  assert.equal(races[1].distance, "1.06 mi");
  assert.equal(races[1].grade, 2);
  ids.race1 = races[0].id;
  ids.race2 = races[1].id;
  ids.runners = Object.fromEntries(races[0].runners.map((r) => [r.horse.name, r.id]));
  ids.alpha = races[0].runners.find((r) => r.horse.name === "Alpha Fixture").horse.id;
  ids.jo = races[0].runners.find((r) => r.horse.name === "Alpha Fixture").jockey.id;

  // Re-importing updates runners instead of duplicating them.
  const again = await call(admin, `/api/admin/racing/days/${ids.day}/import`, {
    body: { rows: [row(1, "1", "alpha fixture", "Jo Rider", { ml: "3-1" })] },
  });
  assert.deepEqual(again.data.summary, { runners: 1, racesCreated: 0, horsesCreated: 0, peopleCreated: 0 });
  assert.equal(again.data.day.races[0].runners.find((r) => r.program === "1").morningLine, "3-1");

  assert.deepEqual((await call(null, `/api/public/racing/days?date=${RACE_DAY}`)).data.days, []);
  assert.equal((await call(null, `/api/public/racing/days/${ids.day}`)).status, 404);
  assert.equal((await call(null, "/api/public/racing-overview")).data.sections.racecards.length, 0);
});

test("publishing shows the card everywhere, without results before they're official", async () => {
  const published = await call(admin, `/api/admin/racing/days/${ids.day}/publish`, { body: {} });
  assert.equal(published.status, 200);
  assert.equal(published.data.day.status, "published");
  const list = await call(null, `/api/public/racing/days?date=${RACE_DAY}`);
  assert.equal(list.data.days.length, 1);
  assert.equal(list.data.days[0].races, 2);
  assert.equal(list.data.days[0].firstPost, "13:00");
  const calendar = await call(null, `/api/public/racing/calendar?from=2099-04-20&to=2099-05-10`);
  assert.deepEqual(calendar.data.days, [{ date: RACE_DAY, tracks: 1, races: 2, official: 0 }]);
  const card = await call(null, `/api/public/racing/days/${ids.day}`);
  assert.equal(card.data.day.races[0].runners.length, 3);
  assert.equal(card.data.day.races[0].runners[0].finish, undefined, "no result fields before the race is official");
  const overview = await call(null, "/api/public/racing-overview");
  assert.deepEqual(
    overview.data.sections.racecards.map((r) => [r.race, r.track, r.runners, r.distance]),
    [["Race 1", "Test Park", 3, "6 f"], ["Race 2", "Test Park", 2, "1.06 mi"]],
  );
  assert.equal(overview.data.sections.stakes[0].detail, "Grade 2 · USD 50,000");
  const stakes = await call(null, "/api/public/racing/stakes?from=2099-04-01&to=2099-06-01");
  assert.equal(stakes.data.races[0].name, "Test Fixture Stakes");
  assert.equal((await call(admin, `/api/admin/racing/days/${ids.day}`, { method: "DELETE" })).status, 409, "published days can't be deleted");
});

test("results are checked, saved together, and feed charts, profiles and leaders", async () => {
  const runners = (finishes) =>
    Object.entries(finishes).map(([horse, finish]) => ({ id: ids.runners[horse], finish, odds: finish === 1 ? 4.2 : 8, lengths: finish === 2 ? 1.5 : null, earnings: finish === 1 ? 30000 : 5000 }));
  const dup = await call(admin, `/api/admin/racing/races/${ids.race1}/results`, {
    method: "PUT",
    body: { status: "official", runners: runners({ "Alpha Fixture": 1, "Beta Fixture": 1, "Gamma Fixture": 3 }) },
  });
  assert.equal(dup.status, 400);
  assert.match(dup.data.error, /same finish position/);
  const noWinner = await call(admin, `/api/admin/racing/races/${ids.race1}/results`, {
    method: "PUT",
    body: { status: "official", runners: runners({ "Alpha Fixture": 2, "Beta Fixture": 3, "Gamma Fixture": 4 }) },
  });
  assert.equal(noWinner.status, 400);
  const before = await call(null, `/api/public/racing/races/${ids.race1}`);
  assert.equal(before.data.race.status, "scheduled", "a failed save changes nothing");
  assert.equal(before.data.race.runners.every((r) => r.finish === undefined), true);

  const saved = await call(admin, `/api/admin/racing/races/${ids.race1}/results`, {
    method: "PUT",
    body: {
      status: "official",
      winningTime: "1:10.45",
      condition: "fast",
      payouts: [{ pool: "Win", combination: "1", amount: "10.40" }],
      runners: runners({ "Alpha Fixture": 1, "Beta Fixture": 2, "Gamma Fixture": 3 }),
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const chart = await call(null, `/api/public/racing/races/${ids.race1}`);
  assert.deepEqual(chart.data.race.runners.map((r) => [r.horse.name, r.finish]), [
    ["Alpha Fixture", 1],
    ["Beta Fixture", 2],
    ["Gamma Fixture", 3],
  ]);
  assert.deepEqual(chart.data.race.payouts, [{ pool: "Win", combination: "1", amount: 10.4 }]);
  assert.equal(chart.data.next.number, 2);
  const results = (await call(null, "/api/public/racing-overview")).data.sections.results;
  assert.equal(results[0].name, "Alpha Fixture");
  assert.equal(results[0].margin, "1.5 lengths");
  assert.match(results[0].detail, /Jockey Jo Rider · Trainer Tess Trainer · 4.2-1/);

  const horse = await call(null, `/api/public/racing/horses/${ids.alpha}`);
  assert.deepEqual(horse.data.stats, { starts: 1, wins: 1, places: 0, shows: 0, earnings: 30000 });
  const person = await call(null, `/api/public/racing/people/${ids.jo}`);
  assert.equal(person.data.person.kind, "jockey");
  assert.equal(person.data.stats.wins, 1);
  assert.equal(person.data.upcoming.length, 1, "Jo also rides in the stakes, which isn't run yet");
  const leaders = await call(null, "/api/public/racing/leaders?role=jockey&year=2099");
  assert.deepEqual(leaders.data.leaders.map((l) => [l.name, l.wins, l.starts]), [
    ["Jo Rider", 1, 1],
    ["Kim Rider", 0, 1],
    ["Lee Rider", 0, 1],
  ]);
  assert.equal((await call(null, "/api/public/racing/leaders?role=cook")).status, 400);
  const search = await call(null, "/api/public/racing/search?q=alpha");
  assert.deepEqual(search.data.horses.map((h) => h.name), ["Alpha Fixture"]);
  assert.deepEqual((await call(null, "/api/public/racing/search?q=%25")).data.horses, [], "wildcards are plain text");
});

test("runners are validated: right roles, unique program numbers, scratches clear results", async () => {
  const lookup = await call(admin, "/api/admin/racing/lookup?kind=trainer&q=tess");
  const trainer = lookup.data.results[0];
  assert.equal(trainer.name, "Tess Trainer");
  const horse = await call(admin, "/api/admin/racing/horses", { body: { name: "Foxtrot Fixture", country: "us", sex: "filly" } });
  assert.equal(horse.status, 201);
  const wrongRole = await call(admin, `/api/admin/racing/races/${ids.race2}/runners`, {
    body: { horseId: horse.data.record.id, program: "3", jockeyId: trainer.id },
  });
  assert.equal(wrongRole.status, 400);
  assert.match(wrongRole.data.error, /jockey or driver/);
  const dupProgram = await call(admin, `/api/admin/racing/races/${ids.race2}/runners`, {
    body: { horseId: horse.data.record.id, program: "1A" },
  });
  assert.equal(dupProgram.status, 409);
  const added = await call(admin, `/api/admin/racing/races/${ids.race2}/runners`, {
    body: { horseId: horse.data.record.id, program: "3", trainerId: trainer.id, morningLine: "10-1" },
  });
  assert.equal(added.status, 201);
  const runner = added.data.day.races[1].runners.find((r) => r.program === "3");
  const scratched = await call(admin, `/api/admin/racing/runners/${runner.id}`, {
    method: "PUT",
    body: { horseId: horse.data.record.id, program: "3", scratched: true, scratchReason: "Vet" },
  });
  assert.equal(scratched.status, 200);
  const after = scratched.data.day.races[1].runners.find((r) => r.program === "3");
  assert.equal(after.scratched, true);
  assert.equal(after.scratchReason, "Vet");
  assert.equal(scratched.data.day.races[1].runnerCount, 2, "scratched runners don't count in the field");
});

test("workouts publish separately and show on the horse page", async () => {
  const body = { horseId: ids.alpha, trackId: ids.track, date: "2099-04-25", distance: "4", time: "48.2", rank: 3, rankOf: 20, note: "B" };
  assert.equal((await call(admin, "/api/admin/racing/workouts", { body: { ...body, rank: 30 } })).status, 400);
  const draft = await call(admin, "/api/admin/racing/workouts", { body });
  assert.equal(draft.status, 201);
  const pub = (path) => call(null, path);
  assert.equal((await pub("/api/public/racing/workouts?from=2099-04-20&to=2099-04-30")).data.workouts.length, 0);
  const published = await call(admin, `/api/admin/racing/workouts/${draft.data.workout.id}`, {
    method: "PUT",
    body: { ...body, time: "1:12.4", distance: "6", status: "published" },
  });
  assert.equal(published.status, 200);
  const list = await pub("/api/public/racing/workouts?from=2099-04-20&to=2099-04-30&track=tp");
  assert.equal(list.data.workouts[0].time, "1:12.40");
  assert.equal(list.data.workouts[0].distance, "6 f");
  const horse = await pub(`/api/public/racing/horses/${ids.alpha}`);
  assert.equal(horse.data.workouts.length, 1);
});

test("unpublishing hides the day again; drafts can then be deleted with their races", async () => {
  assert.equal((await call(admin, `/api/admin/racing/days/${ids.day}/unpublish`, { body: {} })).status, 200);
  assert.equal((await call(null, `/api/public/racing/races/${ids.race1}`)).status, 404);
  assert.equal((await call(null, "/api/public/racing-overview")).data.sections.results.length, 0);
  assert.equal((await call(null, `/api/public/racing/people/${ids.jo}`)).status, 404, "people with no published racing stay hidden");
  assert.equal((await call(admin, `/api/admin/racing/days/${ids.day}`, { method: "DELETE" })).status, 200);
  const { rows } = await db.query("select count(*)::int n from public.racing_runners");
  assert.equal(rows[0].n, 0);
  const events = await db.query("select event from public.account_events where event like 'racing.%'");
  assert.ok(events.rows.some((r) => r.event === "racing.card_imported") && events.rows.some((r) => r.event === "racing.results_saved"));
});

test("large bodies are only read after the admin check", async () => {
  const big = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ race: "1", program: String(i % 90), horse: "Padding horse name " + i, jockey: "Padding rider name", trainer: "Padding trainer name", owner: "Padding owner name for size" })) });
  assert.ok(big.length > 40_000);
  const anonymous = await fetch(origin + "/api/admin/racing/days/00000000-0000-4000-8000-000000000000/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: big });
  assert.equal(anonymous.status, 401, "anonymous uploads are refused before the body is read");
  const asAdmin = await fetch(origin + "/api/admin/racing/days/00000000-0000-4000-8000-000000000000/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "stayblz_access=" + token(admin) },
    body: big,
  });
  assert.equal(asAdmin.status, 404, "an admin's large import is read and processed (unknown day), not refused as too large");
  const tooBigElsewhere = await fetch(origin + "/api/my-racing/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "stayblz_access=" + token(customer) },
    body: big,
  });
  assert.equal(tooBigElsewhere.status, 413, "other endpoints keep the small limit");
});
