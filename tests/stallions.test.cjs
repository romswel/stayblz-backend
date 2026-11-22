// Stayblz Stallions: listing, the public directory, saves, breeding requests (chat + tracking), mares, the mating
// check, offspring from racing data, moderation and featuring through Billing. Real SQL on an in-memory database.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");

const owner = "11111111-1111-4111-8111-111111111111",
  breeder = "22222222-2222-4222-8222-222222222222",
  other = "33333333-3333-4333-8333-333333333333",
  admin = "44444444-4444-4444-8444-444444444444";
const tokens = new Map();
let server, origin, database, db;

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, first, last, role] of [
    [owner, "Olive", "Owner", "member"],
    [breeder, "Bree", "Breeder", "member"],
    [other, "Otto", "Other", "member"],
    [admin, "Ada", "Admin", "admin"],
  ]) {
    const email = first.toLowerCase() + "@example.test";
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    await db.query("update accounts set email=$2, first_name=$3, last_name=$4 where id=$1", [id, email, first, last]);
    tokens.set(id, auth.createSession({ id, username: email, displayName: `${first} ${last}`, role, email }));
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(user, path, { body, method } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { ...(user ? { Authorization: "Bearer " + tokens.get(user) } : {}), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}
const season = new Date().getUTCFullYear();
const stallion = (over = {}) => ({
  name: "Ledger Line",
  breed: "thoroughbred",
  foaled: 2017,
  color: "Bay",
  heightIn: 65,
  farm: "Hillcrest Farm",
  location: "Versailles, Kentucky",
  region: "US-KY",
  seasonYear: season,
  fee: 7500,
  feeCurrency: "USD",
  feeTerms: "live_foal",
  availability: "open",
  methods: ["live_cover"],
  pedigree: { s: "Northern Ledger", d: "Quiet Line", ss: "Old Ledger", ds: "Big Sire", dds: "Founder" },
  raceRecord: { starts: 12, wins: 5, places: 3, shows: 1, earnings: 850000, currency: "USD" },
  highlights: ["Won a 9-furlong stakes on dirt"],
  genetics: { GBED: 0 },
  confirm: true,
  ...over,
});
const search = (user, query = "") => call(user, "/api/public/stallions" + (query ? "?" + query : ""));
const names = (r) => r.data.stallions.map((s) => s.name);
let ledger, sprinter, draft;

test("listing needs a signed-in owner who confirms the details are true", async () => {
  assert.equal((await call(null, "/api/stallions", { body: stallion() })).status, 401);
  const r = await call(owner, "/api/stallions", { body: stallion({ confirm: false }) });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Confirm/);
});

test("the form is checked: Thoroughbreds are live cover only, records add up, regions are real", async () => {
  const cases = [
    [stallion({ methods: ["live_cover", "cooled"] }), /live cover/],
    [stallion({ raceRecord: { starts: 3, wins: 2, places: 2 } }), /add up/],
    [stallion({ region: "XX-ZZ" }), /where he stands/],
    [stallion({ name: "  " }), /name/],
    [stallion({ name: "<b>Bold</b>" }), /< or >/],
    [stallion({ pedigree: { s: "Ledger Line", d: "X" } }), /own sire/],
    [stallion({ fee: 12.5 }), /fee/],
    [stallion({ seasonYear: 1999 }), /season/],
  ];
  for (const [body, message] of cases) {
    const r = await call(owner, "/api/stallions", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, message);
  }
});

test("owners save drafts (not public) and publish; publishing needs sire and dam", async () => {
  let r = await call(owner, "/api/stallions", { body: stallion({ name: "Draft Horse", pedigree: { s: "Someone" } }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  draft = r.data.stallion;
  assert.equal(draft.status, "draft");
  assert.equal(draft.mine, true);
  assert.equal((await call(null, `/api/public/stallions/${draft.id}`)).status, 404, "drafts aren't public");
  assert.equal((await call(owner, `/api/public/stallions/${draft.id}`)).status, 200, "the owner sees the draft");
  r = await call(owner, `/api/stallions/${draft.id}/publish`, { body: { publish: true } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /sire and dam/);

  r = await call(owner, "/api/stallions", { body: { ...stallion(), publish: true } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ledger = r.data.stallion;
  assert.equal(ledger.status, "published");
  assert.equal(ledger.fee, 750000, "fees are kept in cents");
  assert.equal(ledger.ownerName, "Olive Owner");
  assert.equal("owner_id" in ledger || "ownerId" in ledger, false, "the owner's account id never leaves the server");

  r = await call(other, "/api/stallions", {
    body: {
      ...stallion({ name: "Quick Sprinter", breed: "quarter_horse", region: "US-TX", location: "Weatherford, Texas", farm: "",
        fee: null, methods: ["cooled", "frozen"], pedigree: { s: "Fast Dad", d: "Swift Mom", ds: "Big Sire" }, genetics: { GBED: 1, HYPP: 0 },
        foaled: 2019, firstSeason: 2023 }),
      publish: true,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  sprinter = r.data.stallion;
  assert.equal(sprinter.fee, null, "a private fee");
});

test("guests browse the directory; filters and sorts work", async () => {
  let r = await search(null);
  assert.equal(r.status, 200);
  assert.deepEqual(names(r).sort(), ["Ledger Line", "Quick Sprinter"]);
  assert.equal(r.data.total, 2);
  assert.equal(r.data.facets.total, 2);
  assert.deepEqual(r.data.facets.regions.map((x) => x.value), ["US-KY", "US-TX"]);
  assert.equal(r.data.stallions[0].saved, false);

  assert.deepEqual(names(await search(null, "breed=quarter_horse")), ["Quick Sprinter"]);
  assert.deepEqual(names(await search(null, "region=US-KY")), ["Ledger Line"]);
  assert.deepEqual(names(await search(null, "region=US")).length, 2, "a country covers its states");
  assert.deepEqual(names(await search(null, "method=frozen")), ["Quick Sprinter"]);
  assert.deepEqual(names(await search(null, "feeMin=5000&feeMax=10000")), ["Ledger Line"]);
  assert.deepEqual(names(await search(null, "privateFee=1")), ["Quick Sprinter"]);
  assert.deepEqual(names(await search(null, "sire=northern%20ledger")), ["Ledger Line"]);
  assert.deepEqual(names(await search(null, "ancestor=Big%20Sire")).sort(), ["Ledger Line", "Quick Sprinter"]);
  assert.deepEqual(names(await search(null, "ancestor=Founder")), ["Ledger Line"]);
  assert.deepEqual(names(await search(null, "q=hillcrest")), ["Ledger Line"]);
  assert.deepEqual(names(await search(null, "q=_")), [], "_ and % are letters, not wildcards");
  assert.deepEqual(names(await search(null, "sort=fee-asc")), ["Ledger Line", "Quick Sprinter"], "private fees last");
  assert.deepEqual(names(await search(null, "sort=name")), ["Ledger Line", "Quick Sprinter"]);
  assert.deepEqual(names(await search(null, "breed=unicorn")).length, 2, "an unknown filter is ignored, not an error");
});

test("saves: signed in only; counted on cards; the 'saved' filter shows your shortlist", async () => {
  assert.equal((await call(null, `/api/stallions/${ledger.id}/save`, { body: { on: true } })).status, 401);
  let r = await call(breeder, `/api/stallions/${ledger.id}/save`, { body: { on: true } });
  assert.deepEqual(r.data, { saved: true, saves: 1 });
  await call(other, `/api/stallions/${ledger.id}/save`, { body: { on: true } });
  r = await search(breeder, "saved=1");
  assert.deepEqual(names(r), ["Ledger Line"]);
  assert.equal(r.data.stallions[0].saved, true);
  assert.equal(r.data.stallions[0].saves, 2);
  assert.deepEqual(names(await search(null, "sort=popular")), ["Ledger Line", "Quick Sprinter"], "most saved first");
  r = await call(other, `/api/stallions/${ledger.id}/save`, { body: { on: false } });
  assert.deepEqual(r.data, { saved: false, saves: 1 });
  assert.equal((await call(breeder, `/api/stallions/${draft.id}/save`, { body: { on: true } })).status, 404, "drafts can't be saved");
});

test("page views are counted once per visit, never the owner's own", async () => {
  await call(null, `/api/public/stallions/${ledger.id}?view=1`);
  await call(breeder, `/api/public/stallions/${ledger.id}?view=1`);
  await call(owner, `/api/public/stallions/${ledger.id}?view=1`);
  await call(breeder, `/api/public/stallions/${ledger.id}`);
  // Reloading doesn't count again (one view per person per stallion every few hours).
  await call(breeder, `/api/public/stallions/${ledger.id}?view=1`);
  await call(null, `/api/public/stallions/${ledger.id}?view=1`);
  await new Promise((r) => setTimeout(r, 50));
  const r = await call(owner, "/api/stallions/mine");
  const mine = r.data.stallions.find((s) => s.id === ledger.id);
  assert.equal(mine.views30, 2);
  assert.equal(mine.daily.length, 30);
  assert.equal(mine.daily[29], 2);
  assert.equal(r.data.access.allowed, true, "listing is open while no Stallion Showcase plan is on sale");
  assert.equal(r.data.writer, false, "writing help is off without an API key");
});

test("compare shows up to three stallions; drafts of others are left out", async () => {
  const r = await call(null, `/api/public/stallions/compare?ids=${ledger.id},${sprinter.id},${draft.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.stallions.map((s) => s.name), ["Ledger Line", "Quick Sprinter"]);
  assert.equal(r.data.stallions[0].pedigree.ss, "Old Ledger");
});

let requestId, conversationId;
test("a breeding request goes to the owner's chat with a stallion card and is tracked on both sides", async () => {
  const clientId = randomUUID();
  const body = { message: "Hi, I'd like to book a season for my mare.", clientId, seasonYear: season, method: "live_cover",
    mare: { name: "My Mare", sire: "Big Sire", dam: "Her Dam", foaled: 2015, status: "maiden" } };
  assert.equal((await call(null, `/api/stallions/${ledger.id}/request`, { body })).status, 401);
  assert.equal((await call(owner, `/api/stallions/${ledger.id}/request`, { body: { ...body, clientId: randomUUID() } })).status, 400, "not to your own stallion");
  assert.equal((await call(breeder, `/api/stallions/${ledger.id}/request`, { body: { ...body, method: "frozen", clientId: randomUUID() } })).status, 400, "only methods he's offered");
  let r = await call(breeder, `/api/stallions/${ledger.id}/request`, { body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  ({ requestId, conversationId } = r.data);
  r = await call(breeder, `/api/stallions/${ledger.id}/request`, { body });
  assert.equal(r.status, 200, "a retry returns the same request");
  assert.equal(r.data.requestId, requestId);

  const { rows } = await db.query("select body, listing from personal_messages where conversation_id = $1", [conversationId]);
  assert.equal(rows.length, 1, "one message, even after the retry");
  assert.match(rows[0].body, /book a season/);
  assert.match(rows[0].body, /Mare: My Mare by Big Sire out of Her Dam/);
  assert.equal(rows[0].listing.kind, "stallion");
  assert.equal(rows[0].listing.name, "Ledger Line");
  assert.match(rows[0].listing.fee, /\$7,500 · live foal/);
  const thread = await call(owner, `/api/messages/${conversationId}`);
  assert.equal(thread.status, 200, "straight into the owner's inbox (no message request)");

  const received = await call(owner, "/api/stallions/requests?side=received");
  assert.equal(received.data.requests.length, 1);
  assert.equal(received.data.requests[0].mare.name, "My Mare");
  assert.equal(received.data.requests[0].status, "new");
  assert.equal(received.data.requests[0].ownerNote, "");
  const sent = await call(breeder, "/api/stallions/requests?side=sent");
  assert.equal(sent.data.requests.length, 1);
  assert.equal("ownerNote" in sent.data.requests[0], false, "the owner's note stays private");
});

test("only the owner updates a request's status and private note", async () => {
  assert.equal((await call(breeder, `/api/stallions/requests/${requestId}`, { method: "PATCH", body: { status: "booked" } })).status, 404);
  assert.equal((await call(owner, `/api/stallions/requests/${requestId}`, { method: "PATCH", body: { status: "maybe" } })).status, 400);
  const r = await call(owner, `/api/stallions/requests/${requestId}`, { method: "PATCH", body: { status: "booked", ownerNote: "Deposit by March" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.request.status, "booked");
  const sent = await call(breeder, "/api/stallions/requests?side=sent");
  assert.equal(sent.data.requests[0].status, "booked", "the breeder sees the status");
  const mine = await call(owner, "/api/stallions/mine");
  assert.equal(mine.data.stallions.find((s) => s.id === ledger.id).requests, 1);
});

test("requests stop when the owner closes them", async () => {
  await db.query("update stallions set inquiries_open = false where id = $1", [sprinter.id]);
  const r = await call(breeder, `/api/stallions/${sprinter.id}/request`, { body: { message: "Hello", clientId: randomUUID(), mare: { name: "My Mare" } } });
  assert.equal(r.status, 409);
  await db.query("update stallions set inquiries_open = true where id = $1", [sprinter.id]);
});

let mareId;
test("my mares: saved per person, checked like the form", async () => {
  assert.equal((await call(breeder, "/api/stallions/mares", { body: { name: "" } })).status, 400);
  let r = await call(breeder, "/api/stallions/mares", { body: { name: "Carrier Mare", breed: "quarter_horse", pedigree: { s: "Fast Dad", d: "Other Dam" }, genetics: { GBED: 1 } } });
  assert.equal(r.status, 201);
  mareId = r.data.mare.id;
  r = await call(breeder, "/api/stallions/mares");
  assert.deepEqual(r.data.mares.map((m) => m.name), ["Carrier Mare"]);
  assert.deepEqual((await call(other, "/api/stallions/mares")).data.mares, [], "only your own");
  assert.equal((await call(other, `/api/stallions/mares/${mareId}`, { method: "PATCH", body: { name: "Mine now" } })).status, 404);
});

test("the mating check: shared ancestors, inbreeding and genetics", async () => {
  // A mare by Big Sire meets Ledger Line, whose dam is also by Big Sire.
  let r = await call(null, `/api/public/stallions/${ledger.id}/mating`, { body: { mare: { name: "Test Mare", breed: "thoroughbred", pedigree: { s: "Big Sire", d: "Some Dam" } } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const report = r.data.report;
  assert.equal(report.foal.s, "Ledger Line");
  assert.equal(report.foal.ds, "Big Sire");
  assert.equal(report.shared[0].name, "Big Sire");
  assert.equal(report.shared[0].notation, "3×2");
  assert.equal(report.inbreeding.percent, 6.25);
  assert.match(report.notes.join(" "), /live cover/);

  // A saved mare (GBED carrier, sire Fast Dad) against the carrier sprinter: half-siblings and a genetics warning.
  assert.equal((await call(null, `/api/public/stallions/${sprinter.id}/mating`, { body: { mareId } })).status, 401, "saved mares need sign-in");
  r = await call(breeder, `/api/public/stallions/${sprinter.id}/mating`, { body: { mareId } });
  assert.equal(r.status, 200);
  assert.equal(r.data.report.inbreeding.percent, 12.5);
  assert.equal(r.data.report.genetics[0].key, "GBED");
  assert.equal(r.data.report.genetics[0].level, "danger");
  assert.equal((await call(other, `/api/public/stallions/${sprinter.id}/mating`, { body: { mareId } })).status, 404, "someone else's mare");
  assert.equal((await call(null, `/api/public/stallions/${ledger.id}/mating`, { body: { mare: { name: "No pedigree" } } })).status, 400);
});

test("check a mare against every stallion", async () => {
  const r = await call(breeder, "/api/public/stallions/matches", { body: { mareId, sameBreed: false } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.total, 2);
  const byName = Object.fromEntries(r.data.matches.map((m) => [m.stallion.name, m]));
  assert.equal(byName["Quick Sprinter"].genetics.level, "danger");
  assert.equal(byName["Ledger Line"].inbreeding, 0);
  assert.equal(r.data.matches[0].stallion.name, "Ledger Line", "genetic risks sort last");
  const qh = await call(breeder, "/api/public/stallions/matches", { body: { mareId } });
  assert.deepEqual(qh.data.matches.map((m) => m.stallion.name), ["Quick Sprinter"], "same breed by default");
});

test("offspring, crosses and the stallion's own record come from public racing data only", async () => {
  const { rows: [track] } = await db.query("insert into racing_tracks(code,name,country) values('KEE','Keeneland','US') returning id");
  const { rows: [day] } = await db.query("insert into racing_days(track_id,race_date,status,published_at) values($1,'2026-10-10','published',now()) returning id", [track.id]);
  const { rows: [hidden] } = await db.query("insert into racing_days(track_id,race_date,status) values($1,'2026-10-11','draft') returning id", [track.id]);
  const race = async (dayId, n, type = "allowance") =>
    (await db.query("insert into racing_races(day_id,race_number,race_type,distance_value,surface,status,purse) values($1,$2,$3,8.5,'dirt','official',50000) returning id", [dayId, n, type])).rows[0].id;
  const r1 = await race(day.id, 1);
  const r2 = await race(day.id, 2, "stakes");
  const r3 = await race(hidden.id, 1);
  const horse = async (name, sire, damSire, sex = "colt") =>
    (await db.query("insert into racing_horses(name,sire,dam,dam_sire,sex,foaled_year) values($1,$2,$3,$4,$5,2022) returning id", [name, sire, name + " Dam", damSire, sex])).rows[0].id;
  const kidA = await horse("Ledger Kid", "Ledger Line", "Big Sire");
  const kidB = await horse("Ledger Lass", "Ledger Line (USA)", "Other Damsire", "filly");
  const secret = await horse("Draft Only Kid", "Ledger Line", "Big Sire");
  const self = await horse("Ledger Line", "Northern Ledger", "Big Sire", "horse");
  let n = 1;
  const run = (raceId, horseId, finish, earnings) =>
    db.query("insert into racing_runners(race_id,horse_id,program_number,finish_position,earnings) values($1,$2,$3,$4,$5)", [raceId, horseId, String(n++), finish, earnings]);
  await run(r1, kidA, 1, 30000);
  await run(r1, kidB, 3, 5000);
  await run(r2, kidA, 1, 60000);
  await run(r2, self, 2, 20000);
  await run(r3, secret, 1, 99999);

  await db.query("update stallions set racing_horse_id = $2 where id = $1", [ledger.id, self]);
  const r = await call(null, `/api/public/stallions/${ledger.id}`);
  const o = r.data.stallion.offspring;
  assert.equal(o.named, 2, "the draft-only horse isn't counted");
  assert.equal(o.runners, 2);
  assert.equal(o.winners, 1);
  assert.equal(o.stakesWinners, 1);
  assert.equal(o.starts, 3);
  assert.equal(o.wins, 2);
  assert.deepEqual(o.earnings, [{ currency: "USD", amount: 95000 }]);
  assert.equal(o.top[0].name, "Ledger Kid");
  assert.equal(o.top[0].stakesWins, 1);
  assert.deepEqual(o.crosses.map((c) => c.damSire).sort(), ["Big Sire", "Other Damsire"]);
  assert.equal(o.winDistance.average, 8.5);
  assert.equal(r.data.stallion.racing.starts, 1);
  assert.equal(r.data.stallion.racing.places, 1);

  const cross = await call(null, `/api/public/stallions/${ledger.id}/mating`, { body: { mare: { pedigree: { s: "Big Sire" } } } });
  assert.equal(cross.data.report.crosses.exact.runners, 1, "Ledger Line out of Big Sire mares");
  assert.equal(cross.data.report.crosses.exact.top[0].name, "Ledger Kid");

  const sorted = await search(null, "sort=runners");
  assert.equal(sorted.data.stallions[0].name, "Ledger Line");
  assert.equal(sorted.data.stallions[0].runners, 2);
  assert.deepEqual(names(await search(null, "inData=1")), ["Ledger Line"]);

  const look = await call(null, "/api/public/stallions/lookup?q=ledger&sex=female");
  assert.deepEqual(look.data.horses.map((h) => h.name), ["Ledger Lass"], "public horses only, mares and fillies");
  assert.equal(look.data.horses[0].damSire, "Other Damsire");
});

test("pedigrees fill in from racing data and from other stallions", async () => {
  const r = await call(null, "/api/public/stallions/pedigree-fill", { body: { name: "Ledger Kid", pedigree: {}, depth: 3 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Ledger Kid's sire (Ledger Line) is a published stallion, so his whole pedigree comes along.
  assert.equal(r.data.pedigree.s, "Ledger Line");
  assert.equal(r.data.pedigree.ds, "Big Sire");
  assert.equal(r.data.pedigree.ss, "Northern Ledger");
  assert.equal(r.data.pedigree.sss, "Old Ledger");
  assert.ok(r.data.sources.includes("stallion"));
  const typed = await call(null, "/api/public/stallions/pedigree-fill", { body: { name: "Ledger Kid", pedigree: { s: "Typed Sire" }, depth: 3 } });
  assert.equal(typed.data.pedigree.s, "Typed Sire", "never overwrites what was typed");
});

test("an edit without the file lists leaves his photos alone; half a list is refused", async () => {
  const fileId = randomUUID();
  await db.query(
    "insert into stallion_files (id, stallion_id, owner_id, kind, storage_key, content_type, size_bytes, width, height) values ($1, $2, $3, 'photo', $4, 'image/jpeg', 1000, 800, 600)",
    [fileId, ledger.id, owner, `stallions/${owner}/${fileId}.jpg`],
  );
  let r = await call(owner, `/api/stallions/${ledger.id}`, { method: "PATCH", body: stallion({ fee: 8000 }) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.stallion.media.map((m) => m.id), [fileId], "no lists sent = files kept");
  r = await call(owner, `/api/stallions/${ledger.id}`, { method: "PATCH", body: stallion({ mediaIds: [] }) });
  assert.equal(r.status, 400);
  r = await call(owner, `/api/stallions/${ledger.id}`, { method: "PATCH", body: stallion({ racingHorseId: randomUUID() }) });
  assert.equal(r.status, 400, "a racing record that's gone is a form problem, not an outage");
  assert.match(r.data.error, /Pick it again/);
  await db.query("delete from stallion_files where id = $1", [fileId]);
});

test("admins hide a stallion (the owner sees why and can't republish); owners and admins remove", async () => {
  // "Unhide" on a listed stallion changes nothing: it never takes him out of the directory.
  const same = await call(admin, `/api/stallions/${ledger.id}/moderate`, { body: { hidden: false } });
  assert.equal(same.status, 200);
  assert.equal(same.data.stallion.status, "published");
  assert.equal((await call(breeder, `/api/stallions/${sprinter.id}/moderate`, { body: { hidden: true, reason: "Spam" } })).status, 404);
  assert.equal((await call(admin, `/api/stallions/${sprinter.id}/moderate`, { body: { hidden: true } })).status, 400);
  let r = await call(admin, `/api/stallions/${sprinter.id}/moderate`, { body: { hidden: true, reason: "Photos belong to someone else" } });
  assert.equal(r.status, 200);
  assert.deepEqual(names(await search(null)), ["Ledger Line"]);
  assert.equal((await call(null, `/api/public/stallions/${sprinter.id}`)).status, 404);
  r = await call(other, `/api/public/stallions/${sprinter.id}`);
  assert.equal(r.data.stallion.hiddenReason, "Photos belong to someone else");
  r = await call(other, `/api/stallions/${sprinter.id}/publish`, { body: { publish: true } });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /Photos belong/);
  const { rows } = await db.query("select event from account_events where event like 'stallion.%' order by id");
  assert.ok(rows.some((x) => x.event === "stallion.hidden"));
  r = await call(admin, `/api/stallions/${sprinter.id}/moderate`, { body: { hidden: false } });
  assert.equal(r.data.stallion.status, "draft", "unhidden = back to a draft the owner can publish");

  assert.equal((await call(breeder, `/api/stallions/${draft.id}/remove`, { body: {} })).status, 404, "not someone else's");
  assert.equal((await call(owner, `/api/stallions/${draft.id}/remove`, { body: {} })).status, 200);
  assert.equal((await call(admin, `/api/stallions/${sprinter.id}/remove`, { body: {} })).status, 200);
});

test("featuring a stallion through Billing: only your own; paying moves him to the top with a Featured tag", async () => {
  const card = await call(owner, "/api/billing/methods", { body: { type: "card", token: "tok_visa", holderName: "Olive Owner", expMonth: 12, expYear: 2034 } });
  assert.equal(card.status, 201, JSON.stringify(card.data));
  const methodId = card.data.method.id;
  const otherCard = await call(breeder, "/api/billing/methods", { body: { type: "card", token: "tok_visa", holderName: "Bree", expMonth: 12, expYear: 2034 } });
  let r = await call(breeder, "/api/billing/purchases", { body: { productId: "stallion_feature_7", stallionId: ledger.id, methodId: otherCard.data.method.id, key: randomUUID() } });
  assert.equal(r.status, 403, JSON.stringify(r.data));
  r = await call(owner, "/api/billing/purchases", { body: { productId: "stallion_feature_7", stallionId: ledger.id, methodId, key: randomUUID() } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.paid, true);
  const page = await call(owner, `/api/public/stallions/${ledger.id}`);
  assert.equal(page.data.stallion.featured, true);
  assert.ok(new Date(page.data.stallion.featuredUntil) > new Date(Date.now() + 6 * 86400000));
  // Featured days only count in the directory: a draft can't be featured.
  const unlisted = await call(owner, "/api/stallions", { body: stallion({ name: "Not Listed Yet" }) });
  r = await call(owner, "/api/billing/purchases", { body: { productId: "stallion_feature_7", stallionId: unlisted.data.stallion.id, methodId, key: randomUUID() } });
  assert.equal(r.status, 409, JSON.stringify(r.data));
  // A Marketplace product can't be pointed at a stallion.
  r = await call(owner, "/api/billing/purchases", { body: { productId: "listing_feature_7", stallionId: ledger.id, methodId, key: randomUUID() } });
  assert.equal(r.status, 400);
});

test("when a Stallion Showcase plan is on sale and paywalls are on, listing needs the plan", async () => {
  await db.query("update billing_catalog set status = 'active' where id = 'stallion_showcase'");
  await db.query("update billing_settings set enforce_paywalls = true");
  const r = await call(breeder, "/api/stallions", { body: stallion({ name: "Paywalled" }) });
  assert.equal(r.status, 402);
  assert.equal(r.data.plan, "stallion_showcase");
  assert.equal((await call(admin, "/api/stallions", { body: stallion({ name: "Staff Horse" }) })).status, 201, "staff always can");
  await db.query("update billing_settings set enforce_paywalls = false");
  await db.query("update billing_catalog set status = 'draft' where id = 'stallion_showcase'");
});

test("writing help is refused cleanly when it isn't set up", async () => {
  const r = await call(owner, "/api/stallions/write-description", { body: { name: "Ledger Line" } });
  assert.equal(r.status, 503);
  assert.equal(r.data.code, "unavailable");
});

test("guests are rate limited on the mating tools too (by address)", async () => {
  let limited = false;
  for (let i = 0; i < 45 && !limited; i++) {
    const r = await call(null, "/api/public/stallions/pedigree-fill", { body: { name: "Nobody Known", pedigree: {}, depth: 3 } });
    limited = r.status === 429;
  }
  assert.equal(limited, true);
});
