// Dashboard race data: GET /api/stayblz-data/formfav/overview (next races, results, stakes, leaders, in form — from
// the A–Z index only) and GET /api/my-racing/race-watch ("Your horses": linked Virtual Stayblz horses from the personal
// list and every stable the member is in, plus owned / co-owned horses). Real SQL (PGlite), a fake FormFav.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.FORMFAV_API_KEY = "fk_test_only_overview_key";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const formFav = require("../dist/lib/formFav");
const index = require("../dist/lib/formFavIndex");

const ann = "a1111111-1111-4111-8111-111111111111", // owns horses, personal list, member of Bishop Racing
  ben = "b2222222-2222-4222-8222-222222222222", // Bishop Racing owner; lead owner of a horse Ann co-owns
  cat = "c3333333-3333-4333-8333-333333333333"; // owner of Carter Stable (Ann isn't in it)
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Bishop"], [cat]: ["Cat", "Carter"] };
const tokens = new Map();
let db, database, server, origin;

const nyDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const shift = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const TODAY = nyDate(new Date());
const YESTERDAY = shift(TODAY, -1);
const TOMORROW = shift(TODAY, 1);
const EARLIER = shift(TODAY, -6);
const IN_ONE_HOUR = new Date(Date.now() + 3600_000).toISOString();
const IN_TWO_HOURS = new Date(Date.now() + 7200_000).toISOString();

const r = (name, jockey, trainer, position = null, extra = {}) => ({ name, jockey, trainer, number: 1, position, scratched: false, ...extra });
// world[`${code}|${date}|${slug}`] = { track, country, classes: {raceNumber: class} (listing only), races }
const world = {
  [`gallops|${EARLIER}|aqueduct`]: {
    track: "Aqueduct",
    country: "us",
    races: [
      { raceNumber: 3, raceName: "Maiden Claiming", startTime: `${EARLIER}T18:00:00Z`, resultStatus: "final", placings: [r("Fast Fox", "J. Ortiz", "T. Pletcher", 1), r("Slow Joe", "K. Lee", "B. Cox", 2), r("Third Wheel", "J. Ortiz", "B. Cox", 3), r("Back Marker", "K. Lee", "B. Cox", 4)] },
      { raceNumber: 8, raceName: "Gotham Stakes (G3)", startTime: `${EARLIER}T21:00:00Z`, resultStatus: "final", placings: [r("Fast Fox", "J. Ortiz", "T. Pletcher", 1), r("Back Marker", "K. Lee", "B. Cox", 2), r("Slow Joe", "I. Ortiz", "B. Cox", 3)] },
    ],
  },
  [`gallops|${YESTERDAY}|aqueduct`]: {
    track: "Aqueduct",
    country: "us",
    races: [
      { raceNumber: 1, raceName: "Allowance", startTime: `${YESTERDAY}T18:00:00Z`, resultStatus: "final", placings: [r("Slow Joe", "K. Lee", "B. Cox", 1), r("Fast Fox", "J. Ortiz", "T. Pletcher", 2), r("Scratch Cat", "K. Lee", "B. Cox", null, { scratched: true })] },
    ],
  },
  [`gallops|${TODAY}|woodbine`]: {
    track: "Woodbine",
    country: "ca",
    classes: { 5: "Stakes" },
    races: [
      { raceNumber: 5, raceName: "Autumn Mile", startTime: IN_TWO_HOURS, resultStatus: "pending", placings: [r("Fast Fox", "J. Ortiz", "T. Pletcher"), r("Northern Star", "P. Husbands", "M. Casse")] },
      { raceNumber: 2, raceName: "Claiming", startTime: IN_ONE_HOUR, resultStatus: "pending", placings: [r("Slow Joe", "K. Lee", "B. Cox")] },
    ],
  },
  [`gallops|${TOMORROW}|aqueduct`]: {
    track: "Aqueduct",
    country: "us",
    races: [{ raceNumber: 1, raceName: "Starter Allowance", startTime: `${TOMORROW}T18:00:00Z`, resultStatus: "pending", placings: [r("Back Marker", "K. Lee", "B. Cox")] }],
  },
  [`harness|${YESTERDAY}|mohawk`]: {
    track: "Mohawk",
    country: "ca",
    races: [{ raceNumber: 1, raceName: "Pace", startTime: `${YESTERDAY}T23:00:00Z`, resultStatus: "final", placings: [r("Pacer Uno", "D. McNair", "R. Moreau", 1), r("Pacer Dos", "D. McNair", "R. Moreau", 2)] }],
  },
};

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function fakeFormFav(url) {
  const u = new URL(url);
  const p = Object.fromEntries(u.searchParams);
  if (u.pathname === "/v1/form/meetings") {
    const meetings = Object.entries(world)
      .filter(([k]) => k.startsWith(`${p.race_code}|${p.date}|`))
      .map(([k, m]) => ({
        track: m.track,
        slug: k.split("|")[2],
        country: m.country,
        abandoned: false,
        races: m.races.map((x) => ({ raceNumber: x.raceNumber, raceName: x.raceName, raceClass: m.classes?.[x.raceNumber] ?? null })),
      }));
    return reply(200, { date: p.date, raceType: p.race_code, meetings });
  }
  if (u.pathname === "/v1/results/meeting") {
    const m = world[`${p.race_code}|${p.date}|${p.track}`];
    return m ? reply(200, { date: p.date, track: p.track, races: m.races.map((x) => ({ abandoned: false, distance: "1609m", ...x })) }) : reply(404, { detail: "Not Found" });
  }
  return reply(404, { detail: "Not Found" });
}

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, [first, last]] of Object.entries(people)) {
    const email = first.toLowerCase() + "@example.test";
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    await db.query("update accounts set email=$2, first_name=$3, last_name=$4 where id=$1", [id, email, first, last]);
    tokens.set(id, auth.createSession({ id, username: email, displayName: `${first} ${last}`, role: "member", email }));
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  formFav.setFormFavFetch(async (url) => fakeFormFav(url));
  index.setIndexStore(null);
  index.resetIndex();
  await index.refreshIndex();
});
after(async () => {
  formFav.setFormFavFetch(null);
  index.setIndexStore(undefined);
  index.resetIndex();
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(user, path, { body, team } = {}) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens.get(user), "Content-Type": "application/json", ...(team ? { "X-Stayblz-Stable": team } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {}
  return { status: response.status, data };
}
const OV = "/api/stayblz-data/formfav/overview";

test("isStakes: by FormFav's class or by the race's name", () => {
  assert.equal(index.isStakes({ raceClass: "Stakes", name: "Autumn Mile" }), true);
  assert.equal(index.isStakes({ raceClass: "G1", name: null }), true);
  assert.equal(index.isStakes({ raceClass: null, name: "Gotham Stakes (G3)" }), true);
  assert.equal(index.isStakes({ raceClass: null, name: "Kentucky Derby" }), true);
  assert.equal(index.isStakes({ raceClass: "Allowance", name: "Allowance Optional Claiming" }), false);
  assert.equal(index.isStakes({ raceClass: "Maiden Special Weight", name: "Maiden Claiming" }), false);
});

test("overview: next races soonest first, latest results with the top three, stakes, today's tracks and counts", async () => {
  const res = await call(ann, OV);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const o = res.data;
  assert.equal(o.building, false);
  assert.equal(o.today, TODAY);
  assert.deepEqual(o.tracks.map((t) => [t.slug, t.country]), [["woodbine", "ca"]]);
  assert.deepEqual(o.counts, { meetingsToday: 1, racesToday: 2, resultsToday: 0, stakesAhead: 1 });

  assert.deepEqual(o.upcoming.map((x) => [x.slug, x.raceNumber, x.date]), [["woodbine", 2, TODAY], ["woodbine", 5, TODAY], ["aqueduct", 1, TOMORROW]]);
  const mile = o.upcoming[1];
  assert.equal(mile.raceClass, "Stakes", "class from the meetings listing is kept");
  assert.equal(mile.stakes, true);
  assert.equal(mile.runners, 2);
  assert.equal(mile.timezone, "America/New_York");

  assert.deepEqual(o.results.map((x) => [x.slug, x.date, x.raceNumber]), [["mohawk", YESTERDAY, 1], ["aqueduct", YESTERDAY, 1], ["aqueduct", EARLIER, 8], ["aqueduct", EARLIER, 3]]);
  assert.deepEqual(o.results[1].placings.map((p) => [p.position, p.name]), [[1, "Slow Joe"], [2, "Fast Fox"]], "scratched runners left out");
  assert.equal(o.results[3].placings.length, 3, "top three only");

  assert.deepEqual(o.stakes.upcoming.map((x) => x.raceName), ["Autumn Mile"]);
  assert.deepEqual(o.stakes.results.map((x) => x.raceName), ["Gotham Stakes (G3)"]);
});

test("overview: leaders by wins and horses in form with their last runs", async () => {
  const o = (await call(ann, OV)).data;
  assert.deepEqual(o.leaders.horses.slice(0, 3).map((h) => [h.name, h.wins, h.starts]), [["Fast Fox", 2, 3], ["Pacer Uno", 1, 1], ["Slow Joe", 1, 3]]);
  const fox = o.leaders.horses[0];
  assert.equal(fox.form, "2-1-1", "newest first");
  assert.equal(Math.round(fox.winRate * 100), 67);
  assert.deepEqual(
    [fox.lastStart.slug, fox.lastStart.raceNumber, fox.lastStart.position, fox.lastStart.fieldSize, fox.lastStart.code, fox.lastStart.country],
    ["aqueduct", 1, 2, 2, "gallops", "us"],
  );
  assert.equal(fox.nextEntry.slug, "woodbine");
  assert.deepEqual(o.leaders.jockeys.slice(0, 2).map((p) => [p.name, p.wins]), [["J. Ortiz", 2], ["D. McNair", 1]]);
  assert.equal(o.leaders.trainers[0].name, "T. Pletcher");
  // In form: two or more runs with a top-three finish; Pacer Uno (one run) isn't in it.
  assert.deepEqual(o.inForm.map((h) => h.name), ["Fast Fox", "Slow Joe", "Back Marker"]);
});

test("overview: filters by code, country and track; bad values are refused", async () => {
  const harness = (await call(ann, `${OV}?codes=harness`)).data;
  assert.deepEqual(harness.results.map((x) => x.slug), ["mohawk"]);
  assert.deepEqual(harness.upcoming, []);
  const us = (await call(ann, `${OV}?countries=us`)).data;
  assert.ok(us.upcoming.every((x) => x.country === "us"));
  assert.deepEqual(us.tracks, []);
  const wb = (await call(ann, `${OV}?track=woodbine`)).data;
  assert.deepEqual(wb.upcoming.map((x) => x.raceNumber), [2, 5]);
  assert.deepEqual(wb.results, []);
  assert.ok(wb.leaders.horses.length > 1, "leaders stay window-wide");
  assert.equal((await call(ann, `${OV}?track=Bad Slug!`)).status, 400);
  assert.equal((await call(ann, `${OV}?countries=au`)).status, 400);
  assert.equal((await fetch(origin + OV)).status, 401);
});

test("an older saved day without race classes still loads", async () => {
  const saved = new Map();
  const day = { v: 1, date: shift(TODAY, -10), code: "gallops", complete: true, meetings: [{ track: "Parx", slug: "parx", country: "us", races: [{ number: 1, name: "Pennsylvania Derby", distance: null, startTime: null, status: "final", abandoned: false, runners: [{ name: "Old Timer", jockey: "A", trainer: "B", number: 1, position: 1, scratched: false }] }] }] };
  saved.set(`gallops/${day.date}`, JSON.stringify(day));
  index.setIndexStore({ get: async (k) => saved.get(k) ?? null, put: async () => {} });
  index.resetIndex();
  await index.refreshIndex();
  try {
    const o = (await call(ann, OV)).data;
    const derby = o.results.find((x) => x.slug === "parx");
    assert.equal(derby.raceClass, null);
    assert.equal(derby.stakes, true, "detected by name");
  } finally {
    index.setIndexStore(null);
    index.resetIndex();
    await index.refreshIndex();
  }
});

test("race-watch: personal, every stable the member is in, owned and co-owned; one row per racing horse; entered first", async () => {
  const bishop = (await call(ben, "/api/workspaces", { body: { name: "Bishop Racing" } })).data.stable.id;
  const carter = (await call(cat, "/api/workspaces", { body: { name: "Carter Stable" } })).data.stable.id;
  await db.query("insert into stable_memberships(stable_id,user_id,display_name,role) values($1,$2,'Ann Archer','member')", [bishop, ann]);

  const track = (user, name, team) =>
    call(user, team ? "/api/workspace/virtual" : "/api/my-racing/virtual", { team, body: { source: "formfav", formfavName: name, formfavCode: "gallops" } });
  assert.equal((await track(ann, "Fast Fox")).status, 201);
  assert.equal((await track(ann, "Fast Fox", bishop)).status, 201);
  assert.equal((await track(ann, "Slow Joe", bishop)).status, 201);
  assert.equal((await track(cat, "Northern Star", carter)).status, 201, "a stable Ann isn't in");
  // Unlinked hand-typed horse in the personal list: no race data, not shown.
  assert.equal((await call(ann, "/api/my-racing/virtual", { body: { source: "manual", name: "Paper Horse" } })).status, 201);

  const link = "insert into owner_horses(owner_id,name,visibility,formfav_name,formfav_code,formfav_key,formfav_linked_at) values($1,$2,'members',$3,'gallops',$4,now()) returning id";
  const owned = (await db.query(link, [ann, "Back Marker (mine)", "Back Marker", "gallops|back marker"])).rows[0].id;
  const unlinked = (await db.query("insert into owner_horses(owner_id,name,visibility) values($1,'Yearling','members') returning id", [ann])).rows[0].id;
  const shared = (await db.query(link, [ben, "Third Wheel", "Third Wheel", "gallops|third wheel"])).rows[0].id;
  await db.query("insert into owner_horse_members(horse_id,account_id,status,accepted_at) values($1,$2,'accepted',now())", [shared, ann]);

  const res = await call(ann, "/api/my-racing/race-watch");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const rows = res.data.horses;
  assert.deepEqual(
    rows.map((h) => h.name),
    ["Slow Joe", "Fast Fox", "Back Marker (mine)", "Third Wheel", "Yearling"],
    "entered soonest first (Slow Joe in an hour, Fast Fox in two, Back Marker tomorrow), then latest result, then A–Z",
  );
  const fox = rows.find((h) => h.name === "Fast Fox");
  assert.deepEqual(fox.lists.map((l) => [l.kind, l.source, l.stableName ?? null]), [["personal", "formfav", null], ["stable", "formfav", "Bishop Racing"]]);
  assert.equal(fox.linked, true);
  assert.equal(fox.race.nextEntry.slug, "woodbine");
  assert.equal(fox.race.lastStart.position, 2);
  assert.deepEqual(fox.race.recent.map((x) => x.position), [2, 1, 1]);
  const mine = rows.find((h) => h.name === "Back Marker (mine)");
  assert.deepEqual(mine.lists, [{ kind: "owned", id: owned, role: "lead" }]);
  assert.deepEqual(rows.find((h) => h.name === "Third Wheel").lists, [{ kind: "owned", id: shared, role: "coowner" }]);
  const yearling = rows.find((h) => h.name === "Yearling");
  assert.equal(yearling.linked, false);
  assert.equal(yearling.race, null);
  assert.deepEqual(yearling.lists, [{ kind: "owned", id: unlinked, role: "lead" }]);
  assert.ok(!rows.some((h) => h.name === "Northern Star" || h.name === "Paper Horse"));

  // Ben sees his stable's horses and his owned one, not Ann's personal list.
  const benRows = (await call(ben, "/api/my-racing/race-watch")).data.horses;
  assert.deepEqual(benRows.map((h) => h.name).sort(), ["Fast Fox", "Slow Joe", "Third Wheel"]);
  assert.deepEqual(benRows.find((h) => h.name === "Fast Fox").lists.map((l) => l.kind), ["stable"]);
  assert.equal((await fetch(origin + "/api/my-racing/race-watch")).status, 401);
});
