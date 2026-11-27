// Race history (lib/formFavHistory.ts, migration 202611280001): finished days archived from the index and backfilled
// from saved days; /horse with older runs; /older (history, then FormFav's search); jockey/trainer stats for older
// people; tracking a horse that hasn't raced in 30 days (history or FormFav search) and its alert when it's entered;
// "Your horses" falling back to its last stored run; prune. Real SQL (PGlite), a fake FormFav, the real clock.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.FORMFAV_API_KEY = "fk_test_only_history_key";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const formFav = require("../dist/lib/formFav");
const index = require("../dist/lib/formFavIndex");
const hist = require("../dist/lib/formFavHistory");
const sync = require("../dist/lib/formFavSync");

const ann = "a1111111-1111-4111-8111-111111111111";
const tokens = new Map();
let db, database, server, origin;

const nyDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const shift = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const TODAY = nyDate(new Date());
const RECENT = shift(TODAY, -5);
const TOMORROW = shift(TODAY, 1);
const OLD = shift(TODAY, -30); // before the window (today−29), after the history's first day (2026-10-26)

const r = (name, jockey, trainer, position = null, extra = {}) => ({ name, jockey, trainer, number: 1, position, scratched: false, ...extra });
// world[`${code}|${date}|${slug}`] = races served by the fake FormFav for days in the window.
const world = {
  [`gallops|${RECENT}|parx`]: {
    track: "Parx",
    country: "us",
    races: [
      { raceNumber: 1, raceName: "Allowance", distance: "1609m", startTime: `${RECENT}T18:00:00Z`, resultStatus: "final", placings: [r("Fresh Horse", "A. Rider", "T. One", 1), r("Both Ways", "B. Rider", "T. Two", 2), r("Scratchy", "A. Rider", "T. One", null, { scratched: true })] },
      // Never shows final: not archived (the day still counts as finished: it's older than 3 days).
      { raceNumber: 2, raceName: "Claiming", distance: "1207m", startTime: `${RECENT}T18:30:00Z`, resultStatus: "interim", placings: [r("Interim Ida", "A. Rider", "T. One", 1)] },
    ],
  },
  [`gallops|${TOMORROW}|parx`]: {
    track: "Parx",
    country: "us",
    races: [{ raceNumber: 3, raceName: "Maiden", distance: "1408m", startTime: `${TOMORROW}T18:00:00Z`, resultStatus: "pending", placings: [r("Fresh Horse", "A. Rider", "T. One")] }],
  },
};
// The day saved to R2 before the window (backfilled into the history).
const oldDay = {
  v: 1,
  date: OLD,
  code: "gallops",
  complete: true,
  meetings: [
    {
      track: "Aqueduct",
      slug: "aqueduct",
      country: "us",
      races: [
        { number: 7, name: "Old Stakes", distance: "1700m", raceClass: "STAKES", startTime: `${OLD}T20:00:00Z`, status: "final", abandoned: false, runners: [
          { name: "Old Timer", jockey: "Old Jockey", trainer: "Old Trainer", number: 1, position: 1, scratched: false },
          { name: "Both Ways", jockey: "B. Rider", trainer: "T. Two", number: 2, position: 3, scratched: false },
        ] },
      ],
    },
  ],
};

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function fakeFormFav(url) {
  const u = new URL(url);
  const p = Object.fromEntries(u.searchParams);
  const path = decodeURIComponent(u.pathname);
  if (path === "/v1/form/meetings") {
    const meetings = Object.entries(world)
      .filter(([k]) => k.startsWith(`${p.race_code}|${p.date}|`))
      .map(([k, m]) => ({ track: m.track, slug: k.split("|")[2], country: m.country, abandoned: false, races: m.races.map((x) => ({ raceNumber: x.raceNumber })) }));
    return reply(200, { date: p.date, raceType: p.race_code, meetings });
  }
  if (path === "/v1/results/meeting") {
    const m = world[`${p.race_code}|${p.date}|${p.track}`];
    return m ? reply(200, { date: p.date, track: p.track, races: m.races.map((x) => ({ abandoned: false, ...x })) }) : reply(404, { detail: "Not Found" });
  }
  if (path === "/v1/stats/runner/search") {
    const q = String(p.q).toLowerCase();
    if (p.race_code && p.race_code !== "gallops") return reply(200, { query: p.q, results: [] });
    const results =
      q === "kissin perfect" || q === "kiss"
        ? [
            { runnerId: 999, name: "Kissin Perfect", country: "AUS", lastRaceDate: "2026-06-01" },
            { runnerId: 315182, name: "Kissin Perfect", country: "USA", lastRaceDate: "2026-01-12", sire: "Kiss My Hocks", dam: "Perfect Practice" },
          ]
        : q === "aussie only"
          ? [{ runnerId: 5, name: "Aussie Only", country: "AUS" }]
          : q === "old timer" || q === "old"
            ? [{ runnerId: 77, name: "Old Timer", country: "USA", lastRaceDate: OLD }]
            : [];
    return reply(200, { query: p.q, results });
  }
  if (path === "/v1/stats/jockey/search") {
    const q = String(p.q).toLowerCase();
    return reply(200, { query: p.q, results: q.includes("canales") ? [{ name: "Jesus Canales", totalStarts: 6 }] : q.includes("old") ? [{ name: "Old Jockey", totalStarts: 40 }] : [] });
  }
  return reply(404, { detail: "Not Found" });
}

const saved = new Map([[`gallops/${OLD}`, JSON.stringify(oldDay)]]);
const memoryStore = { get: async (k) => saved.get(k) ?? null, put: async (k, body) => void (saved.has(k) || saved.set(k, body)) };

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  const email = "ann@example.test";
  await db.query("insert into auth.users(id,email) values($1,$2)", [ann, email]);
  await db.query("update accounts set email=$2, first_name='Ann', last_name='Archer' where id=$1", [ann, email]);
  tokens.set(ann, auth.createSession({ id: ann, username: email, displayName: "Ann Archer", role: "member", email }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  formFav.setFormFavFetch(async (url) => fakeFormFav(url));
  hist.setHistoryEnabled(true);
  hist.resetHistory();
  index.setIndexStore(memoryStore);
  index.resetIndex();
  await index.refreshIndex();
});
after(async () => {
  formFav.setFormFavFetch(null);
  hist.setHistoryEnabled(undefined);
  hist.resetHistory();
  index.setIndexStore(undefined);
  index.resetIndex();
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(path, body) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens.get(ann), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {}
  return { status: response.status, data };
}
const FF = "/api/stayblz-data/formfav";
const count = async (sql, args = []) => Number((await db.query(sql, args)).rows[0].n);

test("archive: finished days once, final races only, no scratchings; the saved day before the window is backfilled", async () => {
  const first = await hist.archiveDays();
  assert.equal(first.failed, 0, JSON.stringify(first));
  const finished = index.finishedDays().length;
  assert.equal(first.saved, finished, "every finished window day (empty ones too, so they aren't re-read)");
  assert.equal(first.backfilled, 1, "the saved day before the window");
  assert.equal(first.pruned, true);
  assert.deepEqual(
    (await db.query("select race_date::text d, runners from formfav_history_days where runners > 0 order by race_date")).rows.map((x) => [x.d, x.runners]),
    [[OLD, 2], [RECENT, 2]],
  );
  assert.equal(await count("select count(*) n from formfav_horses where horse_name in ('Scratchy','Interim Ida')"), 0);
  assert.equal(await count("select count(*) n from formfav_races where race_name = 'Old Stakes' and race_class = 'STAKES'"), 1);
  const again = await hist.archiveDays();
  assert.deepEqual([again.saved, again.backfilled, again.pruned], [0, 0, false], "nothing twice; prune at most daily");
});

test("/horse: window runs then older ones; a horse only in the history is still found", async () => {
  const both = await call(`${FF}/horse?name=Both%20Ways&code=gallops`);
  assert.equal(both.status, 200, JSON.stringify(both.data));
  assert.equal(both.data.inWindow, true);
  assert.deepEqual(both.data.history.map((s) => [s.date, s.position]), [[RECENT, 2], [OLD, 3]]);
  assert.deepEqual(both.data.archive && [both.data.archive.since, both.data.archive.starts, both.data.archive.places], ["2026-10-26", 2, 2]);

  const old = await call(`${FF}/horse?name=old%20timer&code=gallops`);
  assert.equal(old.status, 200, JSON.stringify(old.data));
  assert.equal(old.data.inWindow, false);
  assert.equal(old.data.name, "Old Timer");
  assert.deepEqual([old.data.lastStart.date, old.data.lastStart.position, old.data.lastStart.track, old.data.lastStart.raceNumber], [OLD, 1, "Aqueduct", 7]);
  assert.equal(old.data.trainer, "Old Trainer");
  assert.equal(old.data.nextEntry, null);
  assert.equal(old.data.history[0].status, "final");

  const fresh = await call(`${FF}/horse?name=Fresh%20Horse&code=gallops`);
  assert.equal(fresh.data.archive, null, "no older runs: no history block");
  assert.equal((await call(`${FF}/horse?name=Nobody&code=gallops`)).status, 404);
});

test("/older: history first (not in the window), then FormFav's US/Canada horses; people marked unconfirmed", async () => {
  const horses = await call(`${FF}/older?kind=horse&q=old`);
  assert.equal(horses.status, 200, JSON.stringify(horses.data));
  assert.deepEqual(horses.data.records.map((h) => [h.name, h.source]), [["Old Timer", "history"]], "Both Ways is in the window; FormFav's Old Timer is a duplicate");
  assert.deepEqual([horses.data.records[0].starts, horses.data.records[0].wins, horses.data.records[0].lastDate], [1, 1, OLD]);

  const kiss = await call(`${FF}/older?kind=horse&q=kiss&codes=gallops`);
  assert.deepEqual(kiss.data.records.map((h) => [h.name, h.source, h.runnerId, h.lastDate, h.sire]), [["Kissin Perfect", "formfav", 315182, "2026-01-12", "Kiss My Hocks"]], "the Australian one is left out");

  const jockeys = await call(`${FF}/older?kind=jockey&q=old`);
  assert.deepEqual(jockeys.data.records.map((p) => [p.name, p.source, p.countryConfirmed, p.rides]), [["Old Jockey", "history", true, 1]]);
  const canales = await call(`${FF}/older?kind=jockey&q=canales`);
  assert.deepEqual(canales.data.records.map((p) => [p.name, p.source, p.countryConfirmed]), [["Jesus Canales", "formfav", false]]);

  assert.equal((await call(`${FF}/older?kind=horse&q=ab`)).status, 400);
  assert.equal((await call(`${FF}/older?kind=dog&q=abc`)).status, 400);
});

test("jockey stats: history people and ?older=1 people answer even without FormFav stats", async () => {
  const old = await call(`${FF}/jockey/Old%20Jockey`);
  assert.equal(old.status, 200, JSON.stringify(old.data));
  assert.equal(old.data.noStats, true);
  assert.equal(old.data.countryConfirmed, true);
  assert.deepEqual([old.data.history.rides, old.data.history.wins, old.data.history.lastRide], [1, 1, OLD]);

  assert.equal((await call(`${FF}/jockey/Jesus%20Canales`)).status, 404, "unknown to Stayblz without ?older=1");
  const canales = await call(`${FF}/jockey/Jesus%20Canales?older=1`);
  assert.equal(canales.status, 200);
  assert.deepEqual([canales.data.noStats, canales.data.countryConfirmed, canales.data.history], [true, false, null]);
  // In the window and FormFav has nothing: still a 404, as before.
  assert.equal((await call(`${FF}/jockey/A.%20Rider`)).status, 404);
});

test("tracking older horses: from the history or FormFav's search (US/Canada only); entered alert when it races again", async () => {
  const add = (name, extra = {}) => call("/api/my-racing/virtual", { source: "formfav", formfavName: name, formfavCode: "gallops", ...extra });
  const old = await add("Old Timer");
  assert.equal(old.status, 201, JSON.stringify(old.data));
  assert.equal(old.data.horse.name, "Old Timer");
  assert.equal(old.data.horse.trainer, "Old Trainer");

  const kiss = await add("kissin perfect");
  assert.equal(kiss.status, 201, JSON.stringify(kiss.data));
  assert.equal(kiss.data.horse.name, "Kissin Perfect", "FormFav's spelling");
  assert.equal(kiss.data.horse.formfav.runnerId, 315182, "the US one, not the Australian");
  assert.equal((await add("Aussie Only")).status, 404);
  assert.equal((await add("Aussie Only")).data.error, "FormFav has no US or Canada horse by that name.");
  assert.equal((await add("Kissin Perfect", { formfavRunnerId: 999 })).status, 404, "runner 999 is the Australian one");
  assert.equal((await add("Kissin Perfect")).status, 409, "already added");

  // Your horses: Old Timer's last run comes from the history.
  const watch = await call("/api/my-racing/race-watch");
  const timer = watch.data.horses.find((h) => h.name === "Old Timer");
  assert.deepEqual([timer.race.lastStart.date, timer.race.lastStart.position, timer.race.fromHistory], [OLD, 1, true]);
  assert.equal(watch.data.horses.find((h) => h.name === "Kissin Perfect").race, null);

  // Kissin Perfect is entered tomorrow: the index picks it up and the sync sends "is entered".
  world[`gallops|${TOMORROW}|parx`].races[0].placings.push(r("Kissin Perfect", "J. Canales", "T. Three"));
  await index.refreshIndex();
  await sync.syncFormFav();
  const alerts = (await db.query("select kind, chat_title from chat_alerts where user_id=$1 and kind='race_entry'", [ann])).rows;
  assert.ok(alerts.some((a) => /Kissin Perfect/.test(a.chat_title)), JSON.stringify(alerts));
});

test("prune drops races older than the keep limit and the horses/people left with no runs", async () => {
  const ancient = shift(TODAY, -400);
  const { error } = await supabase.rpc("formfav_history_save_day", {
    p_code: "harness",
    p_date: ancient,
    p_races: [{ slug: "mohawk", track: "Mohawk", country: "ca", number: 1, name: "Pace", runners: [{ key: "harness|ghost", name: "Ghost", position: 1, jockey: "Gone Driver", jockeyKey: "gone driver" }] }],
  });
  assert.equal(error, null);
  assert.equal(await count("select count(*) n from formfav_horses where horse_name='Ghost'"), 1);
  const { data } = await supabase.rpc("formfav_history_prune", { p_keep_days: 365 });
  assert.deepEqual([data.races, data.horses, data.people], [1, 1, 1]);
  assert.equal(await count("select count(*) n from formfav_history_days where race_date < $1", [shift(TODAY, -365)]), 0);
  assert.equal(await count("select count(*) n from formfav_horses where horse_name='Old Timer'"), 1, "inside the year stays");
});

test("writing is off unless switched on (FORMFAV_HISTORY / production)", async () => {
  hist.setHistoryEnabled(undefined);
  const before = process.env.FORMFAV_HISTORY;
  try {
    delete process.env.FORMFAV_HISTORY;
    assert.equal(hist.historyEnabled(), false, "test/dev default");
    process.env.FORMFAV_HISTORY = "on";
    assert.equal(hist.historyEnabled(), true);
    process.env.FORMFAV_HISTORY = "off";
    assert.equal(hist.historyEnabled(), false);
  } finally {
    if (before === undefined) delete process.env.FORMFAV_HISTORY;
    else process.env.FORMFAV_HISTORY = before;
    hist.setHistoryEnabled(true);
  }
});
