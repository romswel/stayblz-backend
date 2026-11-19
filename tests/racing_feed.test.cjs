const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "false";
delete process.env.RACING_FEED_LICENSED;
const { app } = require("../dist/app");
const { supabase } = require("../dist/lib/supabase");
const { identity } = require("../dist/lib/identity");
const { racingAlertsSettled } = require("../dist/lib/racingAlerts");
const feed = require("../dist/lib/racingFeed/apifyEquibase");
const { cardInput } = require("../dist/lib/racingFeed/card");
const { installDatabase } = require("./support/pgrest.cjs");

// Fictional records in the shape of the co-dev's collected files; they exist only in this in-memory database.
const fan = "41111111-1111-4111-8111-111111111111",
  admin = "44444444-4444-4444-8444-444444444444";
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
const TODAY = new Date().toISOString().slice(0, 10);
const entry = (program, name, refno, extra = {}) => ({
  age: 4, age_sex: "4/G", claim_price_usd: 5000, coupled_group: program, dead_heat: false, finish_position: null,
  horse_name: name, horse_refno: refno, horse_registry: "T", is_scratched: false, jockey: "Jo Rider", live_odds: "5/2",
  medication: "L", ml_odds: "3/1", post_position: Number(program), program_number: program, sex: "G", state_bred: "KY",
  trainer: "Tess Trainer", weight_lbs: 122, ...extra,
});
function collectedFile({ official = true, alphaName = "Alpha Fixture (KY)" } = {}) {
  const race = (n, entries, done) => ({
    record_type: "race", race_id: `FXD-${TODAY}-R${n}`, race_date: TODAY, track_code: "FXD", track_name: "FXD", race_number: n,
    race_name: n === 2 ? "Fixture Stakes" : "Claiming", race_type: n === 2 ? "Stakes" : "Claiming", distance: "Six Furlongs",
    distance_furlongs: n === 2 ? 8 : 6, surface: n === 2 ? "Turf" : "Dirt", purse_usd: 40000, track_condition: null,
    post_time: n === 1 ? "1:05 PM" : "1:35 PM", age_sex_restriction: null, entries_count: entries.length, entries: "ignored",
    entries_detail: entries, race_cancelled: false, results_available: done, live_odds_final: done,
    finish_order_detail: [], payouts_by_horse: done ? [{ finish_position: 1, program_number: "1", win_payout: 7.4, place_payout: 3.2, show_payout: 2.6 }] : [],
    exotic_payouts_by_type: done ? { exacta: { raw_label: "$2 Exacta", payoff: 21.2, winning_numbers: "1-2", payoffs: [{ payoff: 21.2, winning_numbers: "1-2" }] } } : {},
    entry_url: "https://example.test/entry", result_url: "https://example.test/chart", scraped_at: "2026-11-18T22:00:00Z",
  });
  return {
    race_date: TODAY,
    source: "fixture",
    races: [
      race(1, [
        entry("1", alphaName, "90000001", official ? { finish_position: 1 } : {}),
        entry("2", "Beta Fixture (IRE)", "90000002", official ? { finish_position: 2, sex: "F", age_sex: "3/F" } : { sex: "F", age_sex: "3/F" }),
        entry(null, "Gone Fixture (KY)", "90000003", { is_scratched: true, program_number: null }),
      ], official),
      race(2, [entry("1", "Gamma Fixture (KY)", "90000004"), entry("1A", "Delta Fixture (KY)", "90000005", { horse_registry: "Q" })], false),
    ],
    horses: [
      {
        record_type: "horse", horse_name: alphaName, horse_refno: "90000001", horse_registry: "T", entered_race_ids: [`FXD-${TODAY}-R1`],
        profile_url: "https://example.test/horse",
        past_starts: [
          { race_id: "OLD-2026-10-01-R3", track_code: "OLD", track_name: "Old Park", race_date: "2026-10-01", race_number: 3, race_type: "Maiden Claiming", breed: "TB", finish_position: 2, speed_figure: 77 },
          { race_id: `FXD-${TODAY}-R1`, track_code: "FXD", track_name: "Fixture Downs", race_date: TODAY, race_number: 1, race_type: "Claiming", breed: "TB", finish_position: 1, speed_figure: 80 },
        ],
        workouts: [
          { track_code: "FXD", track_name: "Fixture Downs", workout_date: TODAY, surface: "Dirt", distance: "4F", time: "48.20", note: "Breezing", rank: "3/20" },
          { track_code: "FXD", track_name: "Fixture Downs", workout_date: "2026-11-01", surface: "Dirt", distance: "weird", time: "?", note: "", rank: "" },
        ],
      },
    ],
  };
}

before(async () => {
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
  delete process.env.RACING_FEED_LICENSED;
  identity.user = originals.user;
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

test("the collected-file adapter reads names, times, odds and distances, and drops ratings and links", () => {
  assert.deepEqual(feed.splitName("Zara's Empire (KY)"), { name: "Zara's Empire", country: "" });
  assert.deepEqual(feed.splitName("Sea Fixture (IRE)"), { name: "Sea Fixture", country: "IRE" });
  assert.equal(feed.clock("1:05 PM"), "13:05");
  assert.equal(feed.clock("12:30 AM"), "00:30");
  assert.equal(feed.oddsValue("3/5"), 0.6);
  assert.deepEqual(feed.distance(8), { distanceValue: 1, distanceUnit: "miles" });
  assert.deepEqual(feed.distance(8.5), { distanceValue: 8.5, distanceUnit: "furlongs" });
  assert.deepEqual(feed.workDistance("300Y"), { distanceValue: 300, distanceUnit: "yards" });
  assert.equal(feed.seconds("1:00.20"), 60.2);
  assert.equal(feed.raceType("Starter Optional Claiming"), "optional_claiming");
  assert.equal(feed.raceType("Maiden Special Weight"), "maiden");

  const { cards } = feed.cardsFromApifyEquibase(collectedFile());
  assert.equal(cards.length, 1);
  const parsed = cardInput(cards[0]);
  assert.ok("value" in parsed);
  const card = parsed.value;
  assert.equal(card.source, "equibase");
  assert.equal(card.track.name, "FXD", "an unknown code stays a code; names are never invented");
  assert.equal(card.races[0].runners.length, 3, "a scratched entry without a program number only scratches");
  assert.equal(card.races[0].runners[2].program, "");
  assert.equal(card.races[0].runners[2].scratched, true);
  assert.equal(parsed.skipped, 0, "an unreadable workout is already dropped by the adapter");
  assert.equal(card.horses[0].workouts.length, 1);
  assert.equal(card.races[0].runners[0].horse.ref, "T:90000001");
  assert.equal(card.races[0].runners[1].horse.country, "IRE");
  assert.equal(card.races[0].runners[0].morningLine, "3-1");
  assert.equal(card.races[0].runners[0].odds, 2.5);
  assert.equal(card.races[1].name, "Fixture Stakes");
  assert.equal(card.races[1].type, "stakes");
  assert.equal(card.races[1].surface, "turf");
  assert.deepEqual(card.races[0].payouts.map((p) => p.pool), ["Win", "Place", "Show", "$2 Exacta"]);
  const text = JSON.stringify(card);
  assert.ok(!text.includes("speed") && !text.includes("example.test/"), "no speed figures, no links back to the source");
});

test("admins import a collected file as drafts; nothing is public until the licence switch allows it", async () => {
  assert.equal((await call(fan, "/api/admin/racing/feed")).status, 403);
  assert.equal((await call(fan, "/api/admin/racing/feed/import", { body: { data: collectedFile() } })).status, 403);
  const status = await call(admin, "/api/admin/racing/feed");
  assert.equal(status.status, 200);
  assert.equal(status.data.licensed, false);
  assert.deepEqual(status.data.licences, { equibase: false, theracingapi: true }, "The Racing API's terms allow websites; collected files don't");
  assert.equal(status.data.provider.name, "The Racing API");
  assert.equal(status.data.provider.configured, false, "no login in tests: nothing is called");
  assert.equal((await call(admin, "/api/admin/racing/feed/pull", { body: { date: "2099-01-01" } })).status, 503);
  assert.equal((await call(admin, "/api/admin/racing/feed/import", { body: { data: { nope: true } } })).status, 400);

  const refused = await call(admin, "/api/admin/racing/feed/import", { body: { data: collectedFile(), publish: true } });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, "feed_not_licensed");

  const imported = await call(admin, "/api/admin/racing/feed/import", { body: { data: collectedFile() } });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.equal(imported.data.format, "collected-equibase");
  const [result] = imported.data.results;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.races, 2);
  assert.equal(result.runners, 4);
  assert.equal(result.officialRaces, 1);
  assert.equal(result.history, 2);
  assert.equal(result.workouts, 1);
  assert.equal(result.horsesCreated, 4);
  assert.equal(result.published, false);

  const day = (await call(admin, `/api/admin/racing/days/${result.dayId}`)).data.day;
  assert.equal(day.status, "draft");
  assert.equal(day.source, "equibase");
  assert.equal(day.races[0].postTime, "13:05");
  assert.equal(day.races[0].status, "official");
  assert.equal(day.races[0].runners[0].finish, 1);
  assert.equal(day.races[1].breed, "thoroughbred");
  assert.equal((await call(null, `/api/public/racing/days/${result.dayId}`)).status, 404, "drafts stay private");
  const { rows } = await db.query("select count(*)::int n from information_schema.columns where table_name = 'racing_horse_history' and column_name like '%speed%'");
  assert.equal(rows[0].n, 0, "speed figures have nowhere to go");

  const published = await call(admin, `/api/admin/racing/days/${result.dayId}/publish`, { body: {} });
  assert.equal(published.status, 409, "feed cards can't be published by hand either until the licence is confirmed");
  assert.equal(published.data.code, "feed_not_licensed");
  const runs = (await call(admin, "/api/admin/racing/feed")).data.recent;
  assert.equal(runs[0].track, "FXD");
  assert.equal(runs[0].summary.runners, 4);
});

test("re-importing matches horses by their provider id and never steps an official race back", async () => {
  const again = await call(admin, "/api/admin/racing/feed/import", {
    body: { data: collectedFile({ official: false, alphaName: "ALPHA FIXTURE II (KY)" }) },
  });
  const [result] = again.data.results;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.horsesCreated, 0, "same reference numbers = same horses, even with a different name");
  assert.equal(result.peopleCreated, 0);
  const day = (await call(admin, `/api/admin/racing/days/${result.dayId}`)).data.day;
  assert.equal(day.races[0].status, "official", "a lagging source can't undo a result");
  const { rows } = await db.query("select count(*)::int n from racing_horses where source = 'equibase' and source_ref = 'T:90000001'");
  assert.equal(rows[0].n, 1);
});

test("with the licence switch on, a feed card goes public: horse page history and follower alerts work", async () => {
  process.env.RACING_FEED_LICENSED = "yes";
  const imported = await call(admin, "/api/admin/racing/feed/import", { body: { data: collectedFile(), publish: true } });
  assert.equal(imported.status, 200);
  const [result] = imported.data.results;
  assert.equal(result.published, true);
  const publicDay = await call(null, `/api/public/racing/days/${result.dayId}`);
  assert.equal(publicDay.status, 200);
  assert.equal(publicDay.data.day.source, "equibase");
  const alpha = publicDay.data.day.races[0].runners.find((r) => r.program === "1").horse;

  const horse = await call(null, `/api/public/racing/horses/${alpha.id}`);
  assert.equal(horse.status, 200);
  assert.equal(horse.data.starts.length, 1);
  assert.deepEqual(horse.data.history.map((h) => h.trackCode), ["OLD"], "earlier starts already on Stayblz aren't listed twice");
  assert.equal(horse.data.history[0].finish, 2);
  assert.ok(!("speedFigure" in horse.data.history[0]));
  assert.equal(horse.data.workouts.length, 1);

  // A follower hears about the next official result from the feed.
  assert.equal((await call(fan, "/api/my-racing/follows", { body: { kind: "horse", id: alpha.id, on: true } })).status, 200);
  const file = collectedFile();
  file.races[1].results_available = true;
  file.races[1].live_odds_final = true;
  file.races[1].entries_detail[0].finish_position = 1;
  file.races[1].entries_detail[1].finish_position = 2;
  file.races[1].entries_detail[0].horse_refno = "90000001"; // Alpha runs again in race 2 (fixture only)
  file.races[1].entries_detail[0].horse_name = "Alpha Fixture (KY)";
  const second = await call(admin, "/api/admin/racing/feed/import", { body: { data: file, publish: true } });
  assert.equal(second.data.results[0].ok, true, JSON.stringify(second.data.results[0]));
  const alerts = (await call(fan, "/api/notifications/alerts?racing=1")).data.items;
  assert.ok(alerts.some((a) => a.kind === "race_result" && a.title === "Alpha Fixture won"), JSON.stringify(alerts.map((a) => a.title)));
  delete process.env.RACING_FEED_LICENSED;
});
