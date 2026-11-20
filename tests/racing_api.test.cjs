const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "false";
delete process.env.RACING_FEED_LICENSED;
delete process.env.RACING_API_REGIONS;
const { app } = require("../dist/app");
const { supabase } = require("../dist/lib/supabase");
const { identity } = require("../dist/lib/identity");
const { racingAlertsSettled } = require("../dist/lib/racingAlerts");
const api = require("../dist/lib/racingFeed/theRacingApi");
const { pullSettled, racingToday, shiftISO } = require("../dist/lib/racingFeed/pull");
const { sourceLicensed } = require("../dist/lib/racingFeed/licence");
const { cardInput } = require("../dist/lib/racingFeed/card");
const { importCards } = require("../dist/lib/racingFeed/importCards");
const { installDatabase } = require("./support/pgrest.cjs");

// Fictional records in the shape of The Racing API's answers; the network is stubbed, nothing leaves this process.
const fan = "41111111-1111-4111-8111-111111111111",
  admin = "44444444-4444-4444-8444-444444444444";
const providerUsers = new Map();
let database, db, server, origin;
const originals = {};
const token = (id) => "h." + Buffer.from(JSON.stringify({ sub: id, aal: "aal1" })).toString("base64url") + ".s";
const subject = (value) => JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()).sub;
async function call(id, path, { body, method } = {}) {
  const response = await realFetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(id ? { Cookie: "stayblz_access=" + token(id) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = { status: response.status, data: await response.json() };
  await racingAlertsSettled();
  return result;
}

const D = shiftISO(racingToday(), -1);
const runner = (number, horse, id, extra = {}) => ({
  horse_id: id, horse, dob: "2024-03-01", sex: "colt", sex_code: "C", region: "GB", breeder: "Fixture Stud",
  sire: "Sire Fixture", sire_id: "sir_1", dam: `${horse} Dam`, dam_id: `dam_${id}`, damsire: "Damsire Fixture",
  trainer: "T Fixture", trainer_id: "trn_1", owner: "O Fixture", owner_id: "own_1", jockey: "J Fixture(3)", jockey_id: "jky_1",
  number, draw: number === "NR" ? "0" : number, headgear: "p", lbs: "130", ofr: "-", rpr: "88", ts: "70",
  comment: "secret comment", spotlight: "spotlight prose", silk_url: "https://silks.example.test/x", odds: [{ bookmaker: "Fixture Bet", decimal: "3.5" }],
  ...extra,
});
const racecard = (id, off, name, runners, extra = {}) => ({
  race_id: id, course: "Fixture Park", course_id: "crs_1", date: D, off_time: "1:00", off_dt: `${D}T${off}:00+00:00`,
  race_name: name, distance: "6f", distance_f: "6.0", region: "GB", pattern: "", race_class: "Class 4", type: "Flat",
  age_band: "2yo", rating_band: "", prize: "£5,000", prize_currency: "GBP", going: "Good To Soft", surface: "Turf",
  is_abandoned: false, tip: "a tip", verdict: "a verdict", runners, ...extra,
});
const cardsV1 = () => [
  racecard("rac_1", "13:00", "Fixture Maiden Stakes", [
    runner("1", "Alpha Fixture", "hrs_1"),
    runner("2", "Beta Fixture", "hrs_2"),
    runner("3", "Gone Fixture", "hrs_3"),
  ]),
  racecard("rac_2", "13:30", "Fixture Handicap", [runner("1", "Gamma Fixture", "hrs_4"), runner("2", "Delta Fixture", "hrs_5")], { prize: "£8,000" }),
];
const cardsV2 = () => {
  const cards = cardsV1();
  cards[0].runners[2].number = "NR";
  return cards;
};
const result = () => ({
  race_id: "rac_1", date: D, region: "GB", course: "Fixture Park", course_id: "crs_1", off: "1:00", off_dt: `${D}T13:00:00+00:00`,
  race_name: "Fixture Maiden Stakes", type: "Flat", class: "Class 4", pattern: "", dist: "6f", dist_f: "6f", going: "Good To Soft",
  surface: "Turf", winning_time_detail: "1m 12.50s", comments: "", non_runners: "Gone Fixture, Spare Fixture (reserve)",
  tote_win: "£3.20", tote_pl: "£1.50 £1.20", tote_ex: "£6.40", tote_csf: "£5.10", tote_tricast: "", tote_trifecta: "",
  runners: [
    { horse_id: "hrs_2", horse: "Beta Fixture (GB)", sp: "5/2", sp_dec: "3.50", number: "2", position: "1", draw: "2", weight_lbs: "130",
      time: "1:12.50", prize: "3000.00", prize_currency: "GBP", jockey: "J Fixture(3)", jockey_id: "jky_1", trainer: "T Fixture", trainer_id: "trn_1",
      owner: "O Fixture", owner_id: "own_1", sire: "Sire Fixture (GB)", dam: "Beta Fixture Dam (GB)", damsire: "Damsire Fixture (IRE)",
      rpr: "91", tsr: "77", comment: "led final furlong", performance_rating: "90", speed_rating: "80" },
    { horse_id: "hrs_1", horse: "Alpha Fixture (GB)", sp: "Evs", sp_dec: "2.00", number: "1", position: "2", draw: "1", weight_lbs: "130",
      time: "1:12.70", prize: "1000.00", prize_currency: "GBP", jockey: "J Fixture(3)", jockey_id: "jky_1", trainer: "T Fixture", trainer_id: "trn_1",
      owner: "O Fixture", owner_id: "own_1", sire: "Sire Fixture (GB)", dam: "Alpha Fixture Dam (GB)", damsire: "Damsire Fixture (IRE)",
      rpr: "89", tsr: "75", comment: "ran on", performance_rating: "88", speed_rating: "79" },
  ],
});
const horseResults = {
  hrs_1: [
    { ...result(), runners: result().runners }, // today's race: already a Stayblz start, never listed twice
    {
      race_id: "rac_old", date: shiftISO(D, -30), region: "IRE", course: "Old Course (IRE)", course_id: "crs_9", off_dt: `${shiftISO(D, -30)}T15:00:00+00:00`,
      race_name: "Old Maiden", type: "Flat", class: "", pattern: "", dist_f: "7f", going: "Soft", surface: "Turf",
      runners: Array.from({ length: 8 }, (_, i) => ({ horse_id: i === 2 ? "hrs_1" : `hrs_x${i}`, horse: i === 2 ? "Alpha Fixture (GB)" : `Other ${i}`,
        position: String(i + 1), sp_dec: i === 2 ? "6.00" : "9.00", jockey: "J Fixture(3)", sire: "Sire Fixture (GB)", dam: "Alpha Fixture Dam (GB)", rpr: "70" })),
    },
  ],
};

const state = { cards: cardsV1(), results: [], calls: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.host !== "api.theracingapi.com") return realFetch(input, init);
  state.calls.push(url.pathname + url.search);
  assert.match(String(init?.headers?.Authorization ?? ""), /^Basic /);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/v1/courses/regions") return json([{ region: "Great Britain", region_code: "gb" }]);
  if (url.pathname === "/v1/north-america/meets") return json({ detail: "Unauthorized - North American racing add-on required" }, 401);
  if (url.pathname === "/v1/racecards/pro") return json({ racecards: url.searchParams.get("date") === D ? state.cards : [], total: state.cards.length });
  if (url.pathname === "/v1/results") return json({ results: state.results, total: state.results.length });
  const horse = /^\/v1\/horses\/([^/]+)\/results$/.exec(url.pathname);
  if (horse) {
    const list = horseResults[horse[1]] ?? [];
    return json({ results: list, total: list.length });
  }
  return json({ detail: "Not found" }, 404);
};

before(async () => {
  process.env.RACING_API_IN_TESTS = "1";
  process.env.RACING_API_USERNAME = "fixture-user";
  process.env.RACING_API_PASSWORD = "fixture-pass";
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, email] of [[fan, "fan@example.test"], [admin, "admin@example.test"]]) {
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
});
after(async () => {
  delete process.env.RACING_API_IN_TESTS;
  delete process.env.RACING_FEED_LICENSED;
  identity.user = originals.user;
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

test("the adapter reads the provider's names, tracks, times and going, and keeps none of its ratings or prose", () => {
  assert.deepEqual(api.splitSuffix("Dust Fixture (GB)"), { name: "Dust Fixture", country: "GB" });
  assert.deepEqual(api.splitSuffix("Plain Fixture"), { name: "Plain Fixture", country: "" });
  assert.equal(api.trackName("Dundalk (AW) (IRE)"), "Dundalk (AW)");
  assert.equal(api.trackCode("Kempton (AW)"), "KEMPAW");
  assert.equal(api.trackCode("Happy Valley"), "HAVA");
  assert.equal(api.trackCode("Newmarket (July)"), "NEWMJ");
  assert.equal(api.trackCode("Saint-Cloud"), "SACL");
  assert.equal(api.regionCountry("IRE"), "IE");
  assert.equal(api.localTime("2026-11-18T20:30:00+00:00", "GB"), "20:30");
  assert.equal(api.localTime("2026-11-18T10:42:00+00:00", "FR"), "11:42");
  assert.equal(api.localTime("2026-11-18T10:40:00+00:00", "HK"), "18:40");
  assert.equal(api.goingOf("Good To Soft"), "yielding");
  assert.equal(api.goingOf("Standard / Slow"), "standard");
  assert.equal(api.goingOf("Good To Firm"), "firm");
  assert.equal(api.goingOf("Heavy"), "heavy");
  assert.equal(api.surfaceOf("AW"), "all_weather");
  assert.deepEqual(api.raceTypeOf("Fixture Stakes", "Group 1"), { type: "stakes", grade: 1 });
  assert.deepEqual(api.raceTypeOf("Fixture Selling Stakes", ""), { type: "claiming", grade: null });
  assert.deepEqual(api.raceTypeOf("Fixture Nursery Handicap", ""), { type: "handicap", grade: null });
  const long = api.raceName("Fixture Sponsor British Stallion Studs EBF Restricted Novice Stakes (For Horses In Bands B, C And D) (Rider Restricted Race)");
  assert.ok(long.length <= 100 && long.endsWith("…") && !long.includes("(Rider R…"), long);

  const cards = api.cardsFromRacingApi(cardsV2(), [result()]);
  assert.equal(cards.length, 1);
  const parsed = cardInput(cards[0]);
  assert.ok("value" in parsed, JSON.stringify(parsed));
  const card = parsed.value;
  assert.equal(card.source, "theracingapi");
  assert.deepEqual(card.track, { code: "FIPA", name: "Fixture Park", country: "GB", breed: "thoroughbred", ref: "crs_1" });
  const [first, second] = card.races;
  assert.equal(first.ref, "rac_1");
  assert.equal(first.number, 1);
  assert.equal(second.number, 2, "races are numbered in post-time order");
  assert.equal(first.status, "official");
  assert.equal(first.purse, 5000);
  assert.equal(first.currency, "GBP");
  assert.equal(first.condition, "yielding");
  assert.match(first.conditions, /Flat · Class 4 · 2yo · 6f · Going: Good To Soft/);
  const beta = first.runners.find((r) => r.horse.ref === "hrs_2");
  assert.equal(beta.finish, 1);
  assert.equal(beta.odds, 2.5, "starting price 5/2 (decimal 3.50) = 2.5 to 1");
  assert.equal(beta.earnings, 3000);
  assert.equal(beta.jockey, "J Fixture", "the claim allowance isn't part of the name");
  assert.equal(beta.horse.sire, "Sire Fixture");
  const gone = first.runners.find((r) => r.horse.ref === "hrs_3");
  assert.equal(gone.scratched, true);
  assert.equal(gone.program, "");
  assert.deepEqual(first.payouts.map((p) => `${p.pool} ${p.combination} ${p.amount}`), [
    "Win 2 3.2", "Place 2 1.5", "Place 1 1.2", "Exacta 2-1 6.4", "Straight forecast 2-1 5.1",
  ]);
  assert.equal(first.winningTime, "1:12.50");
  const text = JSON.stringify(card);
  for (const word of ["secret comment", "spotlight", "led final furlong", "silks", "Fixture Bet", "a tip", "a verdict", "rpr", "88", "91"])
    assert.ok(!text.includes(word), `nothing from "${word}" is kept`);

  const history = api.historyFromRacingApi("hrs_1", horseResults.hrs_1);
  assert.equal(history.horse.name, "Alpha Fixture");
  assert.equal(history.history[1].trackName, "Old Course");
  assert.equal(history.history[1].fieldSize, 8);
  assert.equal(history.history[1].finish, 3);
  assert.equal(history.history[1].odds, 5);
  assert.equal(history.history[1].rider, "J Fixture");
});

test("only sources whose terms allow it are published", () => {
  assert.equal(sourceLicensed(""), true, "hand-entered");
  assert.equal(sourceLicensed("theracingapi"), true);
  assert.equal(sourceLicensed("equibase"), false);
  process.env.RACING_FEED_LICENSED = "equibase, other";
  assert.equal(sourceLicensed("equibase"), true);
  process.env.RACING_FEED_LICENSED = "yes";
  assert.equal(sourceLicensed("anything"), true);
  delete process.env.RACING_FEED_LICENSED;
});

test("an admin pull publishes the day; results, non-runners and alerts follow on the next pull", async () => {
  assert.equal((await call(fan, "/api/admin/racing/feed/pull", { body: { date: D } })).status, 403);
  const status = await call(admin, "/api/admin/racing/feed?check=1");
  assert.equal(status.status, 200);
  assert.equal(status.data.provider.configured, true);
  assert.equal(status.data.provider.connected, true);
  assert.equal(status.data.provider.northAmerica, false, "the plan has no North America add-on");
  assert.equal((await call(admin, "/api/admin/racing/feed/pull", { body: { date: "1999-01-01" } })).status, 400);

  const started = await call(admin, "/api/admin/racing/feed/pull", { body: { date: D, days: 1 } });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal((await call(admin, "/api/admin/racing/feed/pull", { body: { date: D } })).status, 409, "one pull at a time");
  await pullSettled();
  await racingAlertsSettled();
  const job = (await call(admin, "/api/admin/racing/feed")).data.pull.recent[0];
  assert.equal(job.error, null, JSON.stringify(job));
  assert.equal(job.days[0].imported, 1, JSON.stringify(job.days));
  assert.equal(job.days[0].published, true);

  const { rows: [track] } = await db.query("select id, code, country, source, source_ref from racing_tracks where source_ref = 'crs_1'");
  assert.deepEqual({ ...track, id: undefined }, { id: undefined, code: "FIPA", country: "GB", source: "theracingapi", source_ref: "crs_1" });
  const { rows: [day] } = await db.query("select id, status, source from racing_days where track_id = $1", [track.id]);
  assert.equal(day.status, "published");
  const card = (await call(null, `/api/public/racing/days/${day.id}`)).data.day;
  assert.equal(card.source, "theracingapi");
  assert.equal(card.races.length, 2);
  assert.equal(card.races[0].postTime, api.localTime(`${D}T13:00:00+00:00`, "GB"));
  assert.equal(card.races[0].purse, 5000);
  assert.equal(card.races[0].runners.length, 3);
  assert.ok(!JSON.stringify(card).includes("secret comment"));

  // The fan follows Beta; results come in and Gone Fixture is now a non-runner.
  const beta = card.races[0].runners.find((r) => r.program === "2").horse;
  assert.equal((await call(fan, "/api/my-racing/follows", { body: { kind: "horse", id: beta.id, on: true } })).status, 200);
  state.cards = cardsV2();
  state.results = [result()];
  assert.equal((await call(admin, "/api/admin/racing/feed/pull", { body: { date: D, days: 1, histories: 50 } })).status, 202);
  await pullSettled();
  await racingAlertsSettled();
  const after = (await call(null, `/api/public/racing/days/${day.id}`)).data.day;
  const race = after.races[0];
  assert.equal(race.status, "official");
  assert.equal(race.purse, 5000, "a result never wipes what the racecard said");
  assert.equal(race.runners.find((r) => r.program === "2").finish, 1);
  assert.equal(race.runners.find((r) => r.program === "3").scratched, true, "the non-runner is scratched on the card");
  assert.equal(after.races[1].number, 2);
  assert.equal(after.races[1].status, "scheduled");
  const alerts = (await call(fan, "/api/notifications/alerts?racing=1")).data.items;
  assert.ok(alerts.some((a) => a.kind === "race_result" && a.title === "Beta Fixture won"), JSON.stringify(alerts.map((a) => a.title)));

  // Earlier starts were read for the horses running around today.
  const pulled = (await call(admin, "/api/admin/racing/feed")).data.pull.recent[0];
  assert.ok(pulled.histories.horses >= 5, JSON.stringify(pulled));
  const alpha = race.runners.find((r) => r.program === "1").horse;
  const page = (await call(null, `/api/public/racing/horses/${alpha.id}`)).data;
  assert.deepEqual(page.history.map((h) => h.track), ["Old Course"], "today's start is already on Stayblz");
  assert.equal(page.history[0].fieldSize, 8);
  assert.equal(page.history[0].finish, 3);
  assert.equal(page.history[0].distance, "7 f");
  assert.equal(page.history[0].rider, "J Fixture");
  assert.equal(page.history[0].race, null);
  assert.equal(page.horse.sire, "Sire Fixture");
  assert.equal(page.stats.currency, "GBP", "prize money keeps its currency");
  assert.equal(page.starts[0].currency, "GBP");
  const leaders = await db.query("select public.racing_leaders('trainer', null, null, 5) as l");
  assert.equal(leaders.rows[0].l[0].currency, "GBP");
  const due = await db.query("select public.racing_feed_history_due('theracingapi', 50) as due");
  assert.deepEqual(due.rows[0].due, [], "read this week: not asked for again");
});

test("a provider track never takes over another track's code, and automatic imports need no admin", async () => {
  await db.query("insert into racing_tracks (code, name, country) values ('COLL', 'Other Place', 'US')");
  const card = {
    source: "theracingapi", date: D, track: { code: "COLL", name: "Coll Park", country: "GB", breed: "thoroughbred", ref: "crs_77" },
    races: [{ number: 1, ref: "rac_77", name: "Fixture Race", runners: [{ program: "1", horse: { ref: "hrs_77", name: "Coll Fixture" } }] }],
    horses: [],
  };
  const [first] = await importCards(null, [card], true);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.track, "COLL2", "COLL belongs to another track");
  const again = await importCards(null, [card], true);
  assert.equal(again[0].ok, true);
  const { rows } = await db.query("select code, name, source_ref from racing_tracks where code like 'COLL%' order by code");
  assert.deepEqual(rows, [
    { code: "COLL", name: "Other Place", source_ref: null },
    { code: "COLL2", name: "Coll Park", source_ref: "crs_77" },
  ]);
  const runs = await db.query("select actor_id from racing_feed_runs where track_code = 'COLL2'");
  assert.equal(runs.rows.length, 2);
  assert.equal(runs.rows[0].actor_id, null);
});
