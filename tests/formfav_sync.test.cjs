// Race data (FormFav) in Virtual Stayblz and on owned horses: the Racing horses tab (most followed first), adding and
// linking horses, details kept up to date and locked, results added to the log, and alerts (entered, jockey change,
// scratched / abandoned, result) to the right people exactly once. Real SQL (PGlite with every migration), a fake
// FormFav, the A–Z index on the real clock (so "before the link" compares real times).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.FORMFAV_API_KEY = "fk_test_only_sync_key";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const formFav = require("../dist/lib/formFav");
const index = require("../dist/lib/formFavIndex");
const sync = require("../dist/lib/formFavSync");

const ann = "a1111111-1111-4111-8111-111111111111", // personal list; owns a horse
  ben = "b2222222-2222-4222-8222-222222222222", // stable owner
  cat = "c3333333-3333-4333-8333-333333333333", // stable member, also a personal list
  dan = "d4444444-4444-4444-8444-444444444444", // personal list
  eve = "e5555555-5555-4555-8555-555555555555"; // stable member who leaves
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Bishop"], [cat]: ["Cat", "Carter"], [dan]: ["Dan", "Diaz"], [eve]: ["Eve", "Evans"] };
const tokens = new Map();
let db, database, server, origin, stable;

// ── a small racing world around today (New York days, like the index) ───────────────────────────────────────────────
const nyDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const shift = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const TODAY = nyDate(new Date());
const YESTERDAY = shift(TODAY, -1);
const TOMORROW = shift(TODAY, 1);
const EARLIER = shift(TODAY, -5);
const LATER_TODAY = new Date(Date.now() + 3600_000).toISOString();

const runner = (name, jockey, trainer, extra = {}) => ({ name, jockey, trainer, number: 1, position: null, scratched: false, ...extra });
// world[`${code}|${date}|${slug}`] = { track, country, races: [{ raceNumber, raceName, distance, startTime, resultStatus, abandoned, placings }] }
const world = {
  [`gallops|${EARLIER}|parx`]: {
    track: "Parx",
    country: "us",
    races: [
      {
        raceNumber: 2, raceName: "Maiden Special Weight", distance: "1609m", startTime: `${EARLIER}T20:00:00Z`, resultStatus: "final", abandoned: false,
        placings: [runner("Third Horse", "A. Rider", "T. One", { position: 1 }), runner("Lucky Star", "K. Lee", "Bob Smith", { position: 2 }), runner("Other One", "A. Rider", "T. Two", { position: 3 })],
      },
    ],
  },
  [`gallops|${TODAY}|parx`]: {
    track: "Parx",
    country: "us",
    races: [
      {
        raceNumber: 4, raceName: "Allowance", distance: "1308m", startTime: LATER_TODAY, resultStatus: "pending", abandoned: false,
        placings: [runner("Lucky Star", "J. Acosta", "Bob Smith"), runner("Other One", "A. Rider", "T. Two"), runner("Third Horse", "A. Rider", "T. One"), runner("Scratchy", "A. Rider", "T. One", { scratched: true })],
      },
    ],
  },
  [`gallops|${TOMORROW}|parx`]: {
    track: "Parx",
    country: "us",
    races: [
      { raceNumber: 1, raceName: "Claiming", distance: "1207m", startTime: `${TOMORROW}T18:00:00Z`, resultStatus: "pending", abandoned: false, placings: [runner("Lucky Star", "J. Acosta", "Bob Smith")] },
      { raceNumber: 2, raceName: "Starter Allowance", distance: "1408m", startTime: `${TOMORROW}T18:30:00Z`, resultStatus: "pending", abandoned: false, placings: [runner("Other One", "A. Rider", "T. Two")] },
    ],
  },
  [`harness|${YESTERDAY}|mohawk`]: {
    track: "Mohawk",
    country: "ca",
    races: [
      { raceNumber: 1, raceName: "Pace", distance: "1609m", startTime: `${YESTERDAY}T23:00:00Z`, resultStatus: "final", abandoned: false, placings: [runner("Pacer Uno", "D. McNair", "R. Moreau", { position: 1 }), runner("Pacer Dos", "D. McNair", "R. Moreau", { position: 2 })] },
    ],
  },
};
const CARDS = { "lucky star": { age: 3, sex: "Colt", sire: "Into Mischief", dam: "Star Dam" }, "pacer uno": { age: 4, sex: "G", sire: "Somebeachsomewhere", dam: "Uno Mom" } };
const race = (code, date, slug, n) => world[`${code}|${date}|${slug}`].races.find((r) => r.raceNumber === n);
const place = (code, date, slug, n, name) => race(code, date, slug, n).placings.find((p) => p.name === name);

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function fakeFormFav(url) {
  const u = new URL(url);
  const p = Object.fromEntries(u.searchParams);
  if (u.pathname === "/v1/form/meetings") {
    const meetings = Object.entries(world)
      .filter(([k]) => k.startsWith(`${p.race_code}|${p.date}|`))
      .map(([k, m]) => ({ track: m.track, slug: k.split("|")[2], country: m.country, abandoned: false }));
    return reply(200, { date: p.date, raceType: p.race_code, meetings });
  }
  if (u.pathname === "/v1/results/meeting") {
    const m = world[`${p.race_code}|${p.date}|${p.track}`];
    return m ? reply(200, { date: p.date, track: p.track, races: m.races }) : reply(404, { detail: "Not Found" });
  }
  if (u.pathname === "/v1/form") {
    const m = world[`${p.race_code}|${p.date}|${p.track}`];
    const r = m?.races.find((x) => x.raceNumber === Number(p.race));
    if (!r) return reply(404, { detail: "Not Found" });
    return reply(200, {
      date: p.date, track: m.track, raceNumber: r.raceNumber, raceName: r.raceName, distance: r.distance,
      runners: r.placings.map((x) => ({ name: x.name, jockey: x.jockey, trainer: x.trainer, ...(CARDS[x.name.toLowerCase()] ?? {}) })),
    });
  }
  if (u.pathname === "/v1/stats/runner/search") {
    const q = String(p.q).toLowerCase();
    // Worldwide, with FormFav's three-letter countries: only US/Canada runners are ever linked.
    const results =
      q === "lucky star"
        ? [{ runnerId: 778, name: "Lucky Star", country: "AUS", sire: "Someone", dam: "Aussie Dam" }, { runnerId: 777, name: "Lucky Star", country: "USA", sire: "Into Mischief", dam: "Star Dam", totalStarts: 4 }]
        : q === "pacer uno"
          ? [{ runnerId: 900, name: "Pacer Uno", country: "AUS" }]
          : [];
    return reply(200, { query: p.q, results });
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
  const created = await call(ben, "/api/workspaces", { body: { name: "Bishop Racing" } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  stable = created.data.stable.id;
  for (const [id, name] of [[cat, "Cat Carter"], [eve, "Eve Evans"]])
    await db.query("insert into stable_memberships(stable_id,user_id,display_name,role) values($1,$2,$3,'member')", [stable, id, name]);

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

async function call(user, path, { body, method, team } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { Authorization: "Bearer " + tokens.get(user), "Content-Type": "application/json", ...(team ? { "X-Stayblz-Stable": team } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {}
  return { status: response.status, data };
}
const mine = "/api/my-racing/virtual";
const team = "/api/workspace/virtual";
const refreshAndSync = async () => {
  await index.refreshIndex();
  return sync.syncFormFav();
};
async function alertsFor(user) {
  const { rows } = await db.query(
    "select kind, actor_name, chat_title as title, body, link from chat_alerts where user_id=$1 and kind in ('race_entry','race_scratch','race_result','race_change') order by created_at, chat_title",
    [user],
  );
  return rows;
}
const ids = {};

test("Racing horses: most followed first, distinct people counted, tracking badge; the list keeps them out", async () => {
  const add = (user, name, code = "gallops", teamId) =>
    call(user, teamId ? team : mine, { team: teamId, body: { source: "formfav", formfavName: name, formfavCode: code } });
  const a = await add(ann, "lucky star"); // any case: stored with race data's spelling
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.horse.source, "formfav");
  assert.equal(a.data.horse.name, "Lucky Star");
  assert.deepEqual(a.data.horse.formfav && [a.data.horse.formfav.name, a.data.horse.formfav.code, a.data.horse.formfav.runnerId], ["Lucky Star", "gallops", 777]);
  ids.annLucky = a.data.horse.id;
  // Details from race data straight away: race card (sex, age → foaled, pedigree), latest trainer, breed by code.
  assert.equal(a.data.horse.trainer, "Bob Smith");
  assert.equal(a.data.horse.sire, "Into Mischief");
  assert.equal(a.data.horse.dam, "Star Dam");
  assert.equal(a.data.horse.sex, "colt");
  assert.equal(a.data.horse.foaledYear, Number(TOMORROW.slice(0, 4)) - 3);
  assert.equal(a.data.horse.breed, "Thoroughbred");

  const t = await add(cat, "Lucky Star", "gallops", stable);
  assert.equal(t.status, 201, JSON.stringify(t.data));
  ids.teamLucky = t.data.horse.id;
  assert.equal((await add(cat, "Lucky Star")).status, 201, "cat also has it on her own list (still one person)");
  assert.equal((await add(dan, "Other One")).status, 201);
  assert.equal((await add(ann, "Lucky Star")).status, 409, "once per list");
  assert.equal((await add(ann, "Lucky Star")).data.code, "already_added");
  assert.equal((await add(ann, "Nobody Here")).status, 404);
  assert.equal((await add(ann, "Lucky Star", "greyhounds")).status, 400);

  const page = await call(ann, `${mine}/racing-horses`);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  const top = page.data.records.slice(0, 3).map((r) => [r.name, r.followers, !!r.trackingId]);
  // Lucky Star: ann + the stable's ben, cat, eve (cat's own copy doesn't count twice) = 4; Other One: dan = 1.
  assert.deepEqual(top, [["Lucky Star", 4, true], ["Other One", 1, false], ["Pacer Dos", 0, false]]);
  assert.equal(page.data.records[0].trackingId, ids.annLucky);
  const rest = page.data.records.slice(2).map((r) => r.name);
  assert.deepEqual(rest, [...rest].sort((x, y) => x.localeCompare(y)), "then A–Z");

  const tracking = await call(ann, `${mine}/racing-horses?tracking=1`);
  assert.deepEqual(tracking.data.records.map((r) => r.name), ["Lucky Star"]);
  const teamTracking = await call(ben, `${team}/racing-horses?tracking=1`, { team: stable });
  assert.equal(teamTracking.data.records[0].trackingId, ids.teamLucky);
  assert.equal((await call(ann, `${mine}/racing-horses?codes=greyhounds`)).status, 400);

  // The list has it too (the app shows racing horses in their own section), with its race-data numbers.
  const inList = (await call(ann, mine)).data.horses.find((h) => h.id === ids.annLucky);
  assert.equal(inList.source, "formfav");
  assert.equal(inList.race.nextEntry.raceNumber, 4);
  assert.deepEqual([inList.race.starts, inList.race.trainer], [1, "Bob Smith"]);
  const state = await call(ann, `${mine}/state?formfavName=LUCKY%20STAR&formfavCode=gallops`);
  assert.deepEqual(state.data, { added: true, id: ids.annLucky });

  const detail = await call(ann, `${mine}/${ids.annLucky}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.raceData.followers, 4);
  assert.equal(detail.data.raceData.alertsOn, true);
  assert.equal(detail.data.raceData.horse.nextEntry.raceNumber, 4);
  assert.equal(detail.data.liveUnavailable, false);
  // The earlier final result is in the log (not today's: it hasn't run).
  const runs = detail.data.entries.filter((e) => e.fromRaceData);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].entryDate, runs[0].track, runs[0].title, runs[0].finish, runs[0].fieldSize, runs[0].distance], [EARLIER, "Parx", "Maiden Special Weight", 2, 3, "8f (1,609 m)"]);
  // Only notes change; removing it isn't possible while linked.
  const noted = await call(ann, `${mine}/entries/${runs[0].id}`, { method: "PATCH", body: { kind: "race", entryDate: "2020-01-01", finish: 1, notes: "Closed well" } });
  assert.equal(noted.status, 200, JSON.stringify(noted.data));
  assert.deepEqual([noted.data.entry.notes, noted.data.entry.finish, noted.data.entry.entryDate], ["Closed well", 2, EARLIER]);
  assert.equal((await call(ann, `${mine}/entries/${runs[0].id}/remove`, { body: {} })).status, 409);
  // A horse from Racing horses keeps its details; it can't be unlinked, only removed.
  assert.equal((await call(ann, `${mine}/${ids.annLucky}`, { method: "PATCH", body: { sire: "Someone Else" } })).status, 400);
  assert.equal((await call(ann, `${mine}/${ids.annLucky}/formfav/remove`, { body: {} })).status, 400);
});

test("a hand-typed horse links to race data: its race row is completed, details lock, unlinking unlocks", async () => {
  const added = await call(dan, mine, { body: { source: "manual", name: "My Star", sire: "Guess" } });
  const id = added.data.horse.id;
  const mineRow = await call(dan, `${mine}/${id}/entries`, { body: { kind: "race", entryDate: EARLIER, track: "parx", notes: "Watched it live" } });
  assert.equal(mineRow.status, 201);
  assert.equal((await call(cat, `${mine}/${id}/formfav`, { body: { name: "Lucky Star", code: "gallops" } })).status, 404, "other lists can't touch it");

  const linked = await call(dan, `${mine}/${id}/formfav`, { body: { name: "Lucky Star", code: "gallops" } });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.equal(linked.data.horse.source, "manual");
  assert.equal(linked.data.horse.name, "My Star", "the name stays theirs");
  assert.equal(linked.data.horse.sire, "Into Mischief");
  assert.equal((await call(dan, `${mine}/${id}/formfav`, { body: { name: "Lucky Star", code: "gallops" } })).data.code, "already_linked");

  const detail = (await call(dan, `${mine}/${id}`)).data;
  assert.equal(detail.entries.length, 1, "the hand-written row is completed, not duplicated");
  const row = detail.entries[0];
  assert.deepEqual([row.fromRaceData, row.finish, row.fieldSize, row.title, row.notes], [true, 2, 3, "Maiden Special Weight", "Watched it live"]);
  // Locked while linked; other details and notes still change.
  const edited = await call(dan, `${mine}/${id}`, { method: "PATCH", body: { sire: "Guess", color: "Bay", notes: "linked" } });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.data.horse.sire, edited.data.horse.color], ["Into Mischief", "Bay"]);
  assert.equal((await call(dan, `${mine}/racing-horses`)).data.records[0].followers, 5, "a linked hand-typed horse counts as tracking it");

  const unlinked = await call(dan, `${mine}/${id}/formfav/remove`, { body: {} });
  assert.equal(unlinked.status, 200);
  assert.equal(unlinked.data.horse.formfav, null);
  assert.equal(unlinked.data.horse.sire, "Into Mischief", "values stay");
  assert.equal((await call(dan, `${mine}/${id}`, { method: "PATCH", body: { sire: "Guess" } })).data.horse.sire, "Guess");
  const after = (await call(dan, `${mine}/${id}`)).data;
  assert.equal(after.entries[0].fromRaceData, false);
  assert.equal((await call(dan, `${mine}/entries/${after.entries[0].id}/remove`, { body: {} })).status, 200);
  assert.equal((await call(dan, `${mine}/${id}/remove`, { body: {} })).status, 200);
});

test("owned horses: one owner per racing horse, locked details, records from race data, no alerts from before the link", async () => {
  const horse = await call(ann, "/api/community/horses", { body: { name: "Uno", breed: "", status: "racing" } });
  assert.equal(horse.status, 201);
  ids.annUno = horse.data.horse.id;
  const linked = await call(ann, `/api/community/horses/${ids.annUno}/formfav`, { body: { name: "Pacer Uno", code: "harness" } });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  const h = linked.data.horse;
  assert.equal(h.raceData.runnerId, null, "the only runner of that name is Australian: no career link");
  assert.deepEqual([h.breed, h.sex, h.sire, h.trainer, h.raceData.name, h.raceData.alertsOn], ["Standardbred", "gelding", "Somebeachsomewhere", "R. Moreau", "Pacer Uno", true]);
  assert.equal(h.records.length, 1);
  assert.deepEqual([String(h.records[0].raceDate).slice(0, 10), h.records[0].track, h.records[0].finish, h.records[0].fieldSize, h.records[0].fromRaceData], [YESTERDAY, "Mohawk", 1, 2, true]);

  const bens = await call(ben, "/api/community/horses", { body: { name: "Also Uno", status: "racing" } });
  const claimed = await call(ben, `/api/community/horses/${bens.data.horse.id}/formfav`, { body: { name: "Pacer Uno", code: "harness" } });
  assert.equal(claimed.status, 409);
  assert.equal(claimed.data.code, "formfav_claimed");
  assert.equal((await call(ben, `/api/community/horses/${ids.annUno}/formfav`, { body: { name: "Pacer Uno", code: "harness" } })).status, 404);

  const edit = await call(ann, `/api/community/horses/${ids.annUno}`, { method: "PATCH", body: { name: "Uno", sire: "Mine", sex: "mare", color: "Bay", status: "racing" } });
  assert.equal(edit.status, 200);
  assert.deepEqual([edit.data.horse.sire, edit.data.horse.sex, edit.data.horse.color], ["Somebeachsomewhere", "gelding", "Bay"]);
  const rec = h.records[0].id;
  const recEdit = await call(ann, `/api/community/records/${rec}`, { method: "PATCH", body: { raceDate: "2020-01-01", track: "Elsewhere", finish: 2, notes: "Easy", earnings: "1200" } });
  assert.equal(recEdit.status, 200, JSON.stringify(recEdit.data));
  assert.deepEqual([recEdit.data.record.track, recEdit.data.record.finish, recEdit.data.record.notes, recEdit.data.record.earningsCents], ["Mohawk", 1, "Easy", 120000]);
  assert.equal((await call(ann, `/api/community/records/${rec}/remove`, { body: {} })).status, 409);

  // Yesterday's win happened before the link: logged, but nobody is alerted about it.
  await refreshAndSync();
  assert.equal((await alertsFor(ann)).filter((x) => x.actor_name === "Pacer Uno").length, 0);
});

test("alerts: entered, rider change (once, spelling ignored), scratched, abandoned, result — to the right people, once", async () => {
  const first = await refreshAndSync();
  assert.equal(first.failed, 0, JSON.stringify(first));
  const entered = (u) => alertsFor(u).then((list) => list.filter((x) => x.kind === "race_entry" && x.actor_name === "Lucky Star"));
  for (const u of [ann, ben, cat, eve]) assert.equal((await entered(u)).length, 2, "today's and tomorrow's entries");
  assert.equal((await entered(dan)).length, 0, "dan unlinked his horse");
  const today = (await entered(ann)).find((x) => x.body.startsWith("Race 4"));
  assert.equal(today.title, "Lucky Star is entered");
  assert.match(today.body, /^Race 4 · Parx · \w{3}, \w{3} \d{1,2} · post \d{1,2}:\d{2} [AP]M ET · Jockey: J\. Acosta \(new, last time K\. Lee\)$/);
  assert.equal(today.link, `/my-racing?tab=virtual&vtab=racing&horse=${ids.annLucky}`);
  const teamLink = (await entered(ben))[0].link;
  assert.equal(teamLink, `/workspace/virtual?stable=${stable}&vtab=racing&horse=${ids.teamLucky}`);
  assert.equal((await entered(cat)).length, 2, "cat is on two lists with it: one alert per event");

  // Nothing new: nothing sent.
  const again = await refreshAndSync();
  assert.equal(again.saved, 0);

  // "J Acosta" is the same person as "J. Acosta"; Irad Ortiz is a change.
  place("gallops", TODAY, "parx", 4, "Lucky Star").jockey = "J Acosta";
  assert.equal((await refreshAndSync()).saved, 0);
  place("gallops", TODAY, "parx", 4, "Lucky Star").jockey = "Irad Ortiz";
  const changed = await refreshAndSync();
  assert.equal(changed.saved, 4, "ann, ben, cat, eve");
  const change = (await alertsFor(ann)).find((x) => x.kind === "race_change");
  assert.equal(change.title, "Jockey change for Lucky Star");
  assert.match(change.body, /· Jockey: Irad Ortiz \(was J\. Acosta\)$/, "the name as first seen");
  assert.equal((await refreshAndSync()).saved, 0, "a change is told once");

  // Scratched tomorrow; Other One's race abandoned (only dan follows it).
  place("gallops", TOMORROW, "parx", 1, "Lucky Star").scratched = true;
  Object.assign(race("gallops", TOMORROW, "parx", 2), { abandoned: true, resultStatus: "abandoned" });
  await refreshAndSync();
  assert.equal((await alertsFor(ann)).filter((x) => x.kind === "race_scratch").map((x) => x.title).join(), "Lucky Star was scratched");
  const dans = (await alertsFor(dan)).map((x) => x.title);
  assert.deepEqual([dans.filter((t) => t === "Other One is entered").length, dans.includes("Other One's race was abandoned")], [2, true]);

  // The result: cat muted the stable's copy and her own; ben turned result alerts off; eve left the stable.
  assert.equal((await call(cat, `${team}/${ids.teamLucky}/alerts`, { team: stable, body: { on: false } })).status, 200);
  const catOwn = (await call(cat, `${mine}/racing-horses?tracking=1`)).data.records[0].trackingId;
  assert.equal((await call(cat, `${mine}/${catOwn}/alerts`, { body: { on: false } })).status, 200);
  assert.equal((await call(cat, `${mine}/${catOwn}`)).data.raceData.alertsOn, false);
  await db.query("insert into racing_preferences(user_id, entry_alerts, workout_alerts, result_alerts) values($1, true, true, false)", [ben]);
  await db.query("delete from stable_memberships where stable_id=$1 and user_id=$2", [stable, eve]);
  const r4 = race("gallops", TODAY, "parx", 4);
  r4.resultStatus = "final";
  for (const [name, pos] of [["Lucky Star", 1], ["Other One", 2], ["Third Horse", 3]]) place("gallops", TODAY, "parx", 4, name).position = pos;
  await refreshAndSync();
  const result = (await alertsFor(ann)).find((x) => x.kind === "race_result");
  assert.equal(result.title, "Lucky Star won");
  assert.match(result.body, /^Race 4 · Parx · .+ · 3 ran$/);
  for (const u of [ben, cat, eve]) assert.equal((await alertsFor(u)).filter((x) => x.kind === "race_result").length, 0, u);
  assert.equal((await refreshAndSync()).saved, 0, "never twice");

  // Today's win joined the log of every list holding the horse.
  const log = (await call(ann, `${mine}/${ids.annLucky}`)).data.entries.filter((e) => e.fromRaceData);
  assert.deepEqual(log.map((e) => [e.entryDate, e.finish, e.fieldSize]), [[TODAY, 1, 3], [EARLIER, 2, 3]]);

  // Older apps never see the new kind; newer ones do.
  const { rows } = await db.query("select public.chat_alerts_list($1, null, 50, false) as a, public.chat_alerts_list($1, null, 50, true) as b", [ann]);
  assert.ok(!rows[0].a.items.some((x) => x.kind === "race_change"));
  assert.ok(rows[0].b.items.some((x) => x.kind === "race_change"));
});

test("Public horses: most followed first, then A–Z, across pages", async () => {
  // 30 members-visible horses of dan's; a few tracked by others.
  const { rows } = await db.query(
    "insert into owner_horses(owner_id,name,visibility) select $1, 'Public ' || lpad(g::text, 2, '0'), 'members' from generate_series(1, 30) g returning id, name",
    [dan],
  );
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.id]));
  const track = (user, name) => call(user, mine, { body: { source: "community", communityHorseId: byName[name] } });
  for (const u of [ann, ben, cat]) assert.equal((await track(u, "Public 30")).status, 201);
  for (const u of [ann, cat]) assert.equal((await track(u, "Public 07")).status, 201);
  assert.equal((await call(cat, team, { team: stable, body: { source: "community", communityHorseId: byName["Public 15"] } })).status, 201); // ben + cat
  const seen = [];
  let next = null;
  do {
    const page = await call(eve, `/api/community/public-horses${next ? `?before=${next}` : ""}`);
    assert.equal(page.status, 200, JSON.stringify(page.data));
    seen.push(...page.data.horses.filter((h) => h.name.startsWith("Public ")).map((h) => [h.name, h.followers]));
    next = page.data.next;
  } while (next);
  assert.equal(seen.length, 30, "every horse once");
  assert.deepEqual(seen.slice(0, 4), [["Public 30", 3], ["Public 07", 2], ["Public 15", 2], ["Public 01", 0]]);
  assert.equal((await call(eve, "/api/community/public-horses?before=e30")).status, 400);
});

test("Racing horses have their own 300-horse allowance, apart from the list's", async () => {
  await db.query(
    "insert into virtual_horses(user_id, added_by, source, name, formfav_name, formfav_code, formfav_key, formfav_linked_at) " +
      "select $1, $1, 'formfav', 'Filler ' || g, 'Filler ' || g, 'gallops', 'gallops|filler ' || g, now() from generate_series(1, 300) g",
    [eve],
  );
  const full = await call(eve, mine, { body: { source: "formfav", formfavName: "Third Horse", formfavCode: "gallops" } });
  assert.equal(full.status, 409);
  assert.match(full.data.error, /Racing horses holds up to 300/);
  assert.equal((await call(eve, mine, { body: { source: "manual", name: "Still Room" } })).status, 201, "the list is separate");
  const list = (await call(eve, mine)).data;
  assert.deepEqual([list.horses.filter((h) => h.source !== "formfav").length, list.horses.filter((h) => h.source === "formfav").length, list.racingLimit], [1, 300, 300]);
});
