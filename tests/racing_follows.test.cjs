const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "false";
const { app } = require("../dist/app");
const { supabase } = require("../dist/lib/supabase");
const { identity } = require("../dist/lib/identity");
const { racingAlertsSettled, racingPushes } = require("../dist/lib/racingAlerts");
const { installDatabase } = require("./support/pgrest.cjs");

// Fixture names are obviously fictional and exist only inside this in-memory test database.
const fan = "31111111-1111-4111-8111-111111111111", // follows the horse Alpha Fixture
  breeder = "32222222-2222-4222-8222-222222222222", // follows Alpha Fixture's family
  punter = "33333333-3333-4333-8333-333333333333", // follows the trainer
  admin = "34444444-4444-4444-8444-444444444444";
const providerUsers = new Map();
let database, db, server, origin;
const originals = {};
const token = (id) => "h." + Buffer.from(JSON.stringify({ sub: id, aal: "aal1" })).toString("base64url") + ".s";
const subject = (value) => JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()).sub;

async function call(id, path, { body, method } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(id ? { Cookie: "stayblz_access=" + token(id) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = { status: response.status, data: await response.json() };
  await racingAlertsSettled();
  return result;
}
const row = (race, program, horse, extra = {}) => ({
  race: String(race),
  postTime: "13:00",
  raceType: "maiden",
  distance: "6",
  unit: "furlongs",
  surface: "dirt",
  purse: "40000",
  program,
  post: String(parseInt(program, 10)),
  horse,
  jockey: "Jo Rider",
  trainer: race === 1 ? "Tess Trainer" : "Other Trainer",
  owner: "Fixture Stable",
  weight: "122",
  ml: "5-2",
  ...extra,
});
const card = [
  row(1, "1", "Alpha Fixture", { sire: "Fixture Sire", dam: "Fixture Dam" }),
  row(1, "2", "Beta Fixture", { sire: "Other Sire", dam: "Fixture Dam" }), // Alpha's half-sister (same dam)
  row(2, "1", "Gamma Fixture", { sire: "Other Sire", dam: "Other Dam" }), // not family, other trainer
];
const ids = {};
const alertsOf = async (id, racing = true) =>
  (await call(id, `/api/notifications/alerts${racing ? "?racing=1" : ""}`)).data.items.filter((a) => a.kind !== "message");
async function makeDay(date, rows) {
  const day = await call(admin, "/api/admin/racing/days", { body: { trackId: ids.track, date } });
  assert.equal(day.status, 201, JSON.stringify(day.data));
  const imported = await call(admin, `/api/admin/racing/days/${day.data.day.id}/import`, { body: { rows } });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  return imported.data.day;
}
const runnerOf = (day, horse) => {
  for (const race of day.races) for (const r of race.runners) if (r.horse.name === horse) return { race, runner: r };
  throw new Error("no runner " + horse);
};

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, email] of [
    [fan, "fan@example.test"],
    [breeder, "breeder@example.test"],
    [punter, "punter@example.test"],
    [admin, "admin@example.test"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    await db.query("select public.ensure_account($1)", [id]);
    providerUsers.set(id, { id, email, email_confirmed_at: "2026-11-01T00:00:00Z", app_metadata: {}, user_metadata: {}, factors: [] });
  }
  await db.query("select public.set_platform_role('admin@example.test','admin')");
  originals.user = identity.user;
  identity.user = async (value) => {
    const user = providerUsers.get(subject(value));
    return user ? { data: { user }, error: null } : { data: { user: null }, error: { status: 401 } };
  };
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  const track = await call(admin, "/api/admin/racing/tracks", { body: { code: "FX", name: "Fixture Downs", country: "US" } });
  ids.track = track.data.track.id;
});
after(async () => {
  identity.user = originals.user;
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

test("follows need a sign-in and only reach horses and people on public racing pages", async () => {
  assert.equal((await call(null, "/api/my-racing/follows")).status, 401);
  const draft = await makeDay("2099-06-01", card);
  ids.firstDay = draft.id;
  const alpha = runnerOf(draft, "Alpha Fixture").runner;
  ids.alpha = alpha.horse.id;
  ids.beta = runnerOf(draft, "Beta Fixture").runner.horse.id;
  ids.trainer = alpha.trainer.id;

  const hidden = await call(fan, "/api/my-racing/follows", { body: { kind: "horse", id: ids.alpha, on: true } });
  assert.equal(hidden.status, 404, "a horse on a draft card can't be followed yet");
  for (const bad of [{ kind: "stable", id: ids.alpha, on: true }, { kind: "horse", id: "nope", on: true }, { kind: "horse", id: ids.alpha }])
    assert.equal((await call(fan, "/api/my-racing/follows", { body: bad })).status, 400);

  assert.equal((await call(admin, `/api/admin/racing/days/${ids.firstDay}/publish`, { body: {} })).status, 200);
  assert.deepEqual(await alertsOf(fan), [], "nobody follows anything yet, so nobody hears");

  const followed = await call(fan, "/api/my-racing/follows", { body: { kind: "horse", id: ids.alpha, on: true } });
  assert.equal(followed.status, 200, JSON.stringify(followed.data));
  assert.equal(followed.data.state.horse, true);
  assert.equal(followed.data.state.family, false);
  assert.equal(followed.data.state.relatives, 1, "Beta Fixture shares Alpha Fixture's dam");
  assert.equal((await call(fan, "/api/my-racing/follows", { body: { kind: "horse", id: ids.alpha, on: true } })).data.state.total, 1, "following twice is one follow");
  assert.equal((await call(breeder, "/api/my-racing/follows", { body: { kind: "family", id: ids.alpha, on: true } })).status, 200);
  assert.equal((await call(punter, "/api/my-racing/follows", { body: { kind: "person", id: ids.trainer, on: true } })).status, 200);
  assert.equal((await call(punter, `/api/my-racing/follows/state?id=${ids.trainer}`)).data.state.person, true);
  assert.equal((await call(fan, `/api/my-racing/follows/state?id=${ids.trainer}`)).data.state.person, false, "follows are per person");

  const list = await call(fan, "/api/my-racing/follows");
  assert.equal(list.data.follows.length, 1);
  assert.equal(list.data.follows[0].horse.name, "Alpha Fixture");
  assert.equal(list.data.follows[0].next.date, "2099-06-01", "the next published entry");
  assert.equal(list.data.follows[0].last, null);
  const family = (await call(breeder, "/api/my-racing/follows")).data.follows[0];
  assert.equal(family.kind, "family");
  assert.equal(family.relatives, 1);
  assert.equal(family.next.horse.name, "Beta Fixture", "a family follow shows the relatives' next start");
});

test("publishing a card alerts each follower once, with the closest reason", async () => {
  const day = await makeDay("2099-06-08", card);
  ids.day = day.id;
  assert.deepEqual(await alertsOf(fan), [], "a draft card alerts nobody");
  assert.equal((await call(admin, `/api/admin/racing/days/${ids.day}/publish`, { body: {} })).status, 200);

  const fanAlerts = await alertsOf(fan);
  assert.equal(fanAlerts.length, 1);
  assert.equal(fanAlerts[0].kind, "race_entry");
  assert.equal(fanAlerts[0].title, "Alpha Fixture is entered");
  assert.match(fanAlerts[0].body, /^Race 1 · Fixture Downs · Mon, Jun 8 · post 13:00$/);
  assert.match(fanAlerts[0].link, /^\/racing\/races\/[0-9a-f-]{36}$/);
  assert.equal(fanAlerts[0].read, false);

  const breederAlerts = await alertsOf(breeder);
  assert.deepEqual(breederAlerts.map((a) => a.title), ["Beta Fixture is entered"], "the family, not the horse itself");
  assert.match(breederAlerts[0].body, /Family of Alpha Fixture$/);

  const punterAlerts = await alertsOf(punter);
  assert.deepEqual(punterAlerts.map((a) => a.title).sort(), ["Alpha Fixture is entered", "Beta Fixture is entered"]);
  assert.match(punterAlerts[0].body, /Tess Trainer \(trainer\)$/);

  assert.deepEqual(await alertsOf(fan, false), [], "older apps never get kinds they can't show");
  const unread = await call(fan, `/api/messages/unread?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&racing=1`);
  assert.equal(unread.data.alerts.length, 1, "the menu poll carries racing alerts to on-screen and device notifications");

  // Unpublish + publish again, and adding more of the card, never repeat an alert.
  assert.equal((await call(admin, `/api/admin/racing/days/${ids.day}/unpublish`, { body: {} })).status, 200);
  assert.equal((await call(admin, `/api/admin/racing/days/${ids.day}/publish`, { body: {} })).status, 200);
  assert.equal((await call(admin, `/api/admin/racing/days/${ids.day}/import`, { body: { rows: card } })).status, 200);
  assert.equal((await alertsOf(fan)).length, 1);
  assert.equal((await alertsOf(punter)).length, 2);
});

test("scratches, official results and workouts alert followers; history and switched-off kinds don't", async () => {
  const day = (await call(admin, `/api/admin/racing/days/${ids.day}`)).data.day;
  const beta = runnerOf(day, "Beta Fixture");
  const scratched = await call(admin, `/api/admin/racing/runners/${beta.runner.id}`, {
    method: "PUT",
    body: { horseId: ids.beta, program: "2", scratched: true, scratchReason: "Vet" },
  });
  assert.equal(scratched.status, 200, JSON.stringify(scratched.data));
  const breederAlerts = await alertsOf(breeder);
  assert.equal(breederAlerts[0].kind, "race_scratch");
  assert.equal(breederAlerts[0].title, "Beta Fixture was scratched");
  assert.match(breederAlerts[0].body, /· Vet · Family of Alpha Fixture$/);

  const alpha = runnerOf(day, "Alpha Fixture");
  const results = (status) =>
    call(admin, `/api/admin/racing/races/${alpha.race.id}/results`, {
      method: "PUT",
      body: { status, runners: [{ id: alpha.runner.id, finish: 1, odds: 3.1, earnings: 24000 }] },
    });
  assert.equal((await results("scheduled")).status, 200);
  assert.equal((await alertsOf(fan)).length, 1, "results that aren't official yet alert nobody");
  assert.equal((await results("official")).status, 200);
  const won = (await alertsOf(fan))[0];
  assert.equal(won.kind, "race_result");
  assert.equal(won.title, "Alpha Fixture won");
  assert.match(won.body, /· 1 ran$/, "the scratched runner isn't counted");
  assert.equal((await results("official")).status, 200);
  assert.equal((await alertsOf(fan)).length, 2, "saving the result again doesn't repeat it");

  const today = new Date().toISOString().slice(0, 10);
  const workout = { horseId: ids.alpha, trackId: ids.track, date: today, distance: "4", time: "48.2", rank: 2, rankOf: 30, status: "published" };
  assert.equal((await call(admin, "/api/admin/racing/workouts", { body: workout })).status, 201);
  const worked = (await alertsOf(fan))[0];
  assert.equal(worked.kind, "workout");
  assert.match(worked.title, /^Alpha Fixture worked 4 f in 48\.20?$/);
  assert.match(worked.body, /· 2 of 30$/);
  assert.equal(worked.link, `/racing/horses/${ids.alpha}`);

  // Switched off in My racing → Alert settings: no more workout alerts.
  const prefs = await call(fan, "/api/my-racing/preferences");
  assert.equal(prefs.data.deliveryAvailable, true);
  assert.deepEqual(prefs.data.preferences, { entry_alerts: true, workout_alerts: true, result_alerts: true, email_enabled: false }, "no saved choice = alerts on, email off");
  assert.equal((await call(fan, "/api/my-racing/preferences", { method: "PATCH", body: { ...prefs.data.preferences, workout_alerts: false } })).status, 200);
  const older = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  assert.equal((await call(admin, "/api/admin/racing/workouts", { body: { ...workout, date: older } })).status, 201);
  assert.equal((await alertsOf(fan)).filter((a) => a.kind === "workout").length, 1);

  // A backfill of old cards (e.g. a data feed loading history) alerts nobody.
  const before = (await alertsOf(punter)).length;
  const past = await makeDay("2020-03-01", card);
  assert.equal((await call(admin, `/api/admin/racing/days/${past.id}/publish`, { body: {} })).status, 200);
  assert.equal((await alertsOf(punter)).length, before);
  assert.equal((await alertsOf(fan)).filter((a) => a.kind === "race_entry").length, 1);
});

test("marking read, unfollowing, and one push per person", async () => {
  const mine = await alertsOf(fan);
  const read = await call(fan, "/api/notifications/alerts/read", { body: { ids: [mine[0].id] } });
  assert.equal(read.status, 200);
  assert.equal((await alertsOf(fan))[0].read, true);
  const others = await alertsOf(breeder);
  assert.equal((await call(fan, "/api/notifications/alerts/read", { body: { ids: [others[0].id] } })).status, 200);
  assert.equal((await alertsOf(breeder))[0].read, false, "nobody can mark someone else's alerts");

  assert.equal((await call(fan, "/api/my-racing/summary")).data.following, 1, "the summary counts linked follows");
  const off = await call(fan, "/api/my-racing/follows", { body: { kind: "horse", id: ids.alpha, on: false } });
  assert.equal(off.data.state.horse, false);
  assert.deepEqual((await call(fan, "/api/my-racing/follows")).data.follows, []);
  const { rows } = await db.query(
    "select bool_or(has_table_privilege('anon','public.racing_follows','select') or has_table_privilege('authenticated','public.racing_follows','select')) any_browser",
  );
  assert.equal(rows[0].any_browser, false, "browsers can't read follows directly");

  const pushes = racingPushes("day", "d1", [
    { id: "a1", userId: "u1", kind: "race_entry", title: "Alpha Fixture is entered", body: "Race 1", link: "/racing/races/r1" },
    { id: "a2", userId: "u2", kind: "race_entry", title: "Beta Fixture is entered", body: "Race 1", link: "/racing/races/r1" },
    { id: "a3", userId: "u2", kind: "race_entry", title: "Gamma Fixture is entered", body: "Race 2", link: "/racing/races/r2" },
  ]);
  assert.equal(pushes.get("u1").title, "Alpha Fixture is entered");
  assert.equal(pushes.get("u1").url, "/racing/races/r1");
  assert.equal(pushes.get("u2").title, "2 updates on racing you follow");
  assert.equal(pushes.get("u2").url, "/racing/days/d1");
  assert.equal(pushes.get("u2").kind, "racing");
});
