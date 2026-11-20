// Virtual Stayblz: a private list under My racing and a shared list per stable, holding horses the person or team
// doesn't own (community horses, racing-data horses, or typed in by hand) plus their own logged entries.
// Real SQL (PGlite with every migration).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");

const ann = "a1111111-1111-4111-8111-111111111111", // owns community horses
  ben = "b2222222-2222-4222-8222-222222222222", // stable owner
  cat = "c3333333-3333-4333-8333-333333333333", // stable member
  dan = "d4444444-4444-4444-8444-444444444444"; // outsider
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Bishop"], [cat]: ["Cat", "Carter"], [dan]: ["Dan", "Diaz"] };
const tokens = new Map();
let db, database, server, origin, stable, racingHorse;

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
  await db.query("insert into stable_memberships(stable_id,user_id,display_name,role) values($1,$2,'Cat Carter','member')", [stable, cat]);
  const { rows } = await db.query(
    "insert into racing_horses(name,sire,dam,sex,foaled_year) values('Data Runner','Into Mischief','Fast Lady','colt',2022) returning id",
  );
  racingHorse = rows[0].id;
});
after(async () => {
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(user, path, { body, method, team } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      Authorization: "Bearer " + tokens.get(user),
      "Content-Type": "application/json",
      ...(team ? { "X-Stayblz-Stable": team } : {}),
    },
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

async function communityHorse(owner, fields = {}) {
  const r = await call(owner, "/api/community/horses", { body: { name: "Bold Ruler", breed: "Thoroughbred", status: "racing", ...fields } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.horse.id;
}

test("a personal list is private: others can't list, read, edit or log on it", async () => {
  const added = await call(dan, mine, { body: { source: "manual", name: "Secret Prospect", sire: "Gun Runner", notes: "Watch at Keeneland" } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const id = added.data.horse.id;
  assert.equal(added.data.horse.source, "manual");
  assert.equal(added.data.horse.notes, "Watch at Keeneland");

  assert.ok((await call(dan, mine)).data.horses.some((h) => h.id === id));
  assert.ok(!(await call(cat, mine)).data.horses.some((h) => h.id === id));
  assert.equal((await call(cat, `${mine}/${id}`)).status, 404);
  assert.equal((await call(cat, `${mine}/${id}`, { method: "PATCH", body: { notes: "mine now" } })).status, 404);
  assert.equal((await call(cat, `${mine}/${id}/entries`, { body: { kind: "note", entryDate: "2026-11-01", notes: "x" } })).status, 404);
  assert.equal((await call(cat, `${mine}/${id}/remove`, { body: {} })).status, 404);
  // Nor through the stable list.
  assert.equal((await call(ben, `${team}/${id}`, { team: stable })).status, 404);
});

test("entries: workouts, races, sales and notes are logged, edited and removed", async () => {
  const id = (await call(dan, mine, { body: { source: "manual", name: "Log Keeper" } })).data.horse.id;
  const sale = await call(dan, `${mine}/${id}/entries`, {
    body: { kind: "sale", entryDate: "2026-09-10", title: "Keeneland September", hipNumber: "1234", result: "sold", amountCents: 45000000, finish: 3 },
  });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.equal(sale.data.entry.result, "sold");
  assert.equal(sale.data.entry.amountCents, 45000000);
  assert.equal(sale.data.entry.finish, null, "fields that don't belong to a sale are dropped");
  assert.equal(sale.data.entry.author.name, "Dan Diaz");

  const work = await call(dan, `${mine}/${id}/entries`, { body: { kind: "workout", entryDate: "2026-10-02", track: "Saratoga", distance: "4f", timeText: ":47.80" } });
  assert.equal(work.status, 201);
  const race = await call(dan, `${mine}/${id}/entries`, { body: { kind: "race", entryDate: "2026-10-20", title: "Maiden Special Weight", finish: 1, fieldSize: 9 } });
  assert.equal(race.status, 201);

  // Bad input.
  assert.equal((await call(dan, `${mine}/${id}/entries`, { body: { kind: "race", entryDate: "2026-10-20", finish: 10, fieldSize: 9 } })).status, 400);
  assert.equal((await call(dan, `${mine}/${id}/entries`, { body: { kind: "sale", entryDate: "2026-02-30", title: "X" } })).status, 400);
  assert.equal((await call(dan, `${mine}/${id}/entries`, { body: { kind: "sale", entryDate: "2026-02-03", title: "X", result: "maybe" } })).status, 400);
  assert.equal((await call(dan, `${mine}/${id}/entries`, { body: { kind: "gossip", entryDate: "2026-02-03" } })).status, 400);

  const detail = await call(dan, `${mine}/${id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data.entries.map((e) => e.kind), ["race", "workout", "sale"], "newest first");
  assert.equal(detail.data.live, null);
  assert.equal(detail.data.liveUnavailable, false, "a manual horse has no live data to miss");

  const listed = (await call(dan, mine)).data.horses.find((h) => h.id === id);
  assert.deepEqual(listed.counts, { workouts: 1, races: 1, sales: 1, notes: 0 });
  assert.equal(listed.lastEntry, "2026-10-20");

  const edited = await call(dan, `${mine}/entries/${work.data.entry.id}`, { method: "PATCH", body: { kind: "workout", entryDate: "2026-10-02", timeText: ":46.90" } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.entry.timeText, ":46.90");
  assert.equal((await call(dan, `${mine}/entries/${sale.data.entry.id}/remove`, { body: {} })).status, 200);
  assert.equal((await call(dan, `${mine}/${id}`)).data.entries.length, 2);

  assert.equal((await call(dan, `${mine}/${id}/remove`, { body: {} })).status, 200);
  assert.equal((await call(dan, `${mine}/${id}`)).status, 404);
  const { rows } = await db.query("select count(*)::int as n from virtual_horse_entries where virtual_horse_id=$1", [id]);
  assert.equal(rows[0].n, 0, "entries go with the horse");
});

test("a stable list is shared with members only; authors or managers remove things", async () => {
  assert.equal((await call(cat, team)).status, 403, "the stable header is required");
  assert.equal((await call(dan, team, { team: stable })).status, 403, "outsiders are refused");

  const added = await call(cat, team, { team: stable, body: { source: "manual", name: "Team Target" } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const id = added.data.horse.id;
  assert.ok((await call(ben, team, { team: stable })).data.horses.some((h) => h.id === id), "the owner sees a member's horse");
  assert.ok(!(await call(cat, mine)).data.horses.some((h) => h.id === id), "it isn't in the member's private list");

  const bens = await call(ben, `${team}/${id}/entries`, { team: stable, body: { kind: "note", entryDate: "2026-11-02", notes: "Looks sharp" } });
  assert.equal(bens.status, 201);
  assert.equal(bens.data.entry.canEdit, true);
  const cats = await call(cat, `${team}/${id}/entries`, { team: stable, body: { kind: "note", entryDate: "2026-11-03", notes: "Agreed" } });
  assert.equal(cats.status, 201);

  const asCat = await call(cat, `${team}/${id}`, { team: stable });
  assert.equal(asCat.data.horse.addedByName, "Cat Carter");
  assert.deepEqual(asCat.data.entries.map((e) => [e.author.name, e.canEdit]), [["Cat Carter", true], ["Ben Bishop", false]]);

  // A member can't remove the owner's entry; the owner (a manager) can remove the member's.
  assert.equal((await call(cat, `${team}/entries/${bens.data.entry.id}/remove`, { team: stable, body: {} })).status, 403);
  assert.equal((await call(cat, `${team}/entries/${bens.data.entry.id}`, { team: stable, method: "PATCH", body: { kind: "note", entryDate: "2026-11-02", notes: "edited" } })).status, 403);
  assert.equal((await call(ben, `${team}/entries/${cats.data.entry.id}/remove`, { team: stable, body: {} })).status, 200);

  // A horse the owner added can't be removed by a member.
  const bensHorse = (await call(ben, team, { team: stable, body: { source: "manual", name: "Owner Pick" } })).data.horse.id;
  assert.equal((await call(cat, `${team}/${bensHorse}/remove`, { team: stable, body: {} })).status, 403);
  assert.equal((await call(ben, `${team}/${id}/remove`, { team: stable, body: {} })).status, 200);
});

test("community horses: added only when visible, live data follows the owner's privacy, snapshot stays", async () => {
  const open = await communityHorse(ann, { name: "Open Book", visibility: "members", sire: "Tapit" });
  const followersOnly = await communityHorse(ann, { name: "Inner Circle", visibility: "followers" });
  const hidden = await communityHorse(ann, { name: "Hidden Gem", visibility: "private" });

  assert.equal((await call(ann, mine, { body: { source: "community", communityHorseId: open } })).status, 400, "not your own horse");
  assert.equal((await call(dan, mine, { body: { source: "community", communityHorseId: hidden } })).status, 404);
  assert.equal((await call(dan, mine, { body: { source: "community", communityHorseId: followersOnly } })).status, 404);
  assert.equal((await call(dan, "/api/community/people/" + ann + "/follow", { body: {} })).status, 200);
  assert.equal((await call(dan, mine, { body: { source: "community", communityHorseId: followersOnly } })).status, 201, "followers may add it");

  const added = await call(dan, mine, { body: { source: "community", communityHorseId: open } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal(added.data.horse.name, "Open Book");
  assert.equal(added.data.horse.sire, "Tapit");
  assert.equal(added.data.horse.ownerName, "Ann Archer");
  const id = added.data.horse.id;
  const dup = await call(dan, mine, { body: { source: "community", communityHorseId: open } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.id, id);
  assert.deepEqual((await call(dan, `${mine}/state?communityHorseId=${open}`)).data, { added: true, id });
  assert.deepEqual((await call(cat, `${mine}/state?communityHorseId=${open}`)).data, { added: false, id: null });

  assert.equal((await call(ann, `/api/community/horses/${open}/records`, { body: { raceDate: "2026-10-01", track: "Belmont", finish: 1, fieldSize: 8, earningsCents: 3000000 } })).status, 201);
  let detail = await call(dan, `${mine}/${id}`);
  assert.equal(detail.data.live.community.name, "Open Book");
  assert.equal(detail.data.live.community.records.length, 1);
  assert.equal((await call(dan, mine)).data.horses.find((h) => h.id === id).live.wins, 1);

  // The team list re-checks per viewer: the followers-only horse added by Ben's team...
  await call(ben, "/api/community/people/" + ann + "/follow", { body: {} });
  const teamCopy = await call(ben, team, { team: stable, body: { source: "community", communityHorseId: followersOnly } });
  assert.equal(teamCopy.status, 201);
  // ...shows Cat (who doesn't follow Ann) only the copied details.
  const asCat = await call(cat, `${team}/${teamCopy.data.horse.id}`, { team: stable });
  assert.equal(asCat.data.horse.name, "Inner Circle");
  assert.equal(asCat.data.live, null);
  assert.equal(asCat.data.liveUnavailable, true);
  assert.ok((await call(ben, `${team}/${teamCopy.data.horse.id}`, { team: stable })).data.live.community);

  // The owner makes the horse private: entries and snapshot stay, live data goes.
  await call(dan, `${mine}/${id}/entries`, { body: { kind: "note", entryDate: "2026-11-05", notes: "Keep an eye on him" } });
  assert.equal((await call(ann, `/api/community/horses/${open}`, { method: "PATCH", body: { name: "Open Book", breed: "Thoroughbred", status: "racing", sire: "Tapit", visibility: "private" } })).status, 200);
  detail = await call(dan, `${mine}/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.live, null);
  assert.equal(detail.data.liveUnavailable, true);
  assert.equal(detail.data.horse.name, "Open Book");
  assert.equal(detail.data.entries.length, 1);
  assert.equal((await call(dan, mine)).data.horses.find((h) => h.id === id).live, null);
  // Linked horses keep their copied details; only notes change.
  const patched = await call(dan, `${mine}/${id}`, { method: "PATCH", body: { name: "Renamed", notes: "Went private" } });
  assert.equal(patched.data.horse.name, "Open Book");
  assert.equal(patched.data.horse.notes, "Went private");
});

test("racing-data horses are added with their pedigree", async () => {
  const added = await call(cat, mine, { body: { source: "racing", racingHorseId: racingHorse } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal(added.data.horse.name, "Data Runner");
  assert.equal(added.data.horse.sire, "Into Mischief");
  assert.equal(added.data.horse.foaledYear, 2022);
  assert.equal((await call(cat, mine, { body: { source: "racing", racingHorseId: racingHorse } })).status, 409);
  assert.equal((await call(cat, mine, { body: { source: "racing", racingHorseId: "e5555555-5555-4555-8555-555555555555" } })).status, 404);
  // No published starts or workouts yet, so there's nothing live.
  const detail = await call(cat, `${mine}/${added.data.horse.id}`);
  assert.equal(detail.data.liveUnavailable, true);
  // The same horse can also be in the stable's list.
  assert.equal((await call(cat, team, { team: stable, body: { source: "racing", racingHorseId: racingHorse } })).status, 201);
});

test("manual horses need a name and valid details", async () => {
  assert.equal((await call(dan, mine, { body: { source: "manual", name: "  " } })).status, 400);
  assert.equal((await call(dan, mine, { body: { source: "manual", name: "Old Timer", foaledYear: 1800 } })).status, 400);
  assert.equal((await call(dan, mine, { body: { source: "nowhere", name: "X" } })).status, 400);
  const id = (await call(dan, mine, { body: { source: "manual", name: "Typo Hors" } })).data.horse.id;
  const fixed = await call(dan, `${mine}/${id}`, { method: "PATCH", body: { name: "Typo Horse", trainer: "B. Baffert" } });
  assert.equal(fixed.data.horse.name, "Typo Horse");
  assert.equal(fixed.data.horse.trainer, "B. Baffert");
});

test("public horses: members-visible community horses only, by name, paged", async () => {
  const bob = await communityHorse(ben, { name: "Zed Public", visibility: "inherit" });
  await communityHorse(ben, { name: "Zed Private", visibility: "private" });
  await communityHorse(ben, { name: "Zed Followers", visibility: "followers" });
  let r = await call(dan, "/api/community/public-horses?q=zed");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.horses.map((h) => h.name), ["Zed Public"]);
  assert.equal(r.data.horses[0].owner.name, "Ben Bishop");
  assert.equal(r.data.horses[0].visibility, undefined);
  // Your own horses aren't offered back to you.
  assert.equal((await call(ben, "/api/community/public-horses?q=zed")).data.horses.length, 0);
  // Changing the owner's default to followers hides 'inherit' horses.
  assert.equal((await call(ben, "/api/community/me/settings", { method: "PATCH", body: { inventoryVisibility: "followers" } })).status, 200);
  assert.equal((await call(dan, "/api/community/public-horses?q=zed")).data.horses.length, 0);
  await call(ben, "/api/community/me/settings", { method: "PATCH", body: { inventoryVisibility: "members" } });
  // A suspended owner's horses drop out.
  await db.query("update accounts set status='suspended' where id=$1", [ben]);
  assert.equal((await call(dan, "/api/community/public-horses?q=zed")).data.horses.length, 0);
  await db.query("update accounts set status='active' where id=$1", [ben]);
  assert.ok(bob);

  // Paging: 30 horses come back as 24 + 6, with no repeats.
  for (let i = 0; i < 30; i++) await db.query("insert into owner_horses(owner_id,name,visibility) values($1,$2,'members')", [ann, `Page ${String(i).padStart(2, "0")}`]);
  r = await call(dan, "/api/community/public-horses?q=page");
  assert.equal(r.data.horses.length, 24);
  assert.ok(r.data.next);
  const second = await call(dan, "/api/community/public-horses?q=page&before=" + r.data.next);
  assert.equal(second.data.horses.length, 6);
  assert.equal(second.data.next, null);
  const all = [...r.data.horses, ...second.data.horses].map((h) => h.name);
  assert.equal(new Set(all).size, 30);
  assert.deepEqual(all, [...all].sort());
  assert.equal((await call(dan, "/api/community/public-horses?before=garbage")).status, 400);
});

test("limits: 300 horses per list", async () => {
  const values = Array.from({ length: 300 }, (_, i) => `('${dan}', 'manual', 'Bulk ${i}')`).join(",");
  await db.query("delete from virtual_horses where user_id=$1", [dan]);
  await db.query(`insert into virtual_horses(user_id, source, name) values ${values}`);
  const r = await call(dan, mine, { body: { source: "manual", name: "One Too Many" } });
  assert.equal(r.status, 409);
});

test("public horses: filters by breed, sex, status, foaling year and raced; breeds list", async () => {
  const add = (name, fields) => communityHorse(cat, { name, visibility: "members", ...fields });
  const a = await add("Filter Alpha", { breed: "Quarter Horse", sex: "mare", status: "for_sale", foaledYear: 2019 });
  await add("Filter Bravo", { breed: "Thoroughbred", sex: "colt", status: "racing", foaledYear: 2023 });
  await add("Filter Charlie", { breed: "quarter horse", sex: "gelding", status: "racing", foaledYear: 2021 });
  assert.equal((await call(cat, `/api/community/horses/${a}/records`, { body: { raceDate: "2026-09-01", track: "Ruidoso", finish: 2, fieldSize: 8 } })).status, 201);
  const names = async (qs) => {
    const r = await call(dan, "/api/community/public-horses?q=filter&" + qs);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.horses.map((h) => h.name);
  };
  assert.deepEqual(await names("breed=QUARTER%20HORSE"), ["Filter Alpha", "Filter Charlie"]);
  assert.deepEqual(await names("sex=colt"), ["Filter Bravo"]);
  assert.deepEqual(await names("status=for_sale"), ["Filter Alpha"]);
  assert.deepEqual(await names("foaledFrom=2020&foaledTo=2022"), ["Filter Charlie"]);
  assert.deepEqual(await names("raced=1"), ["Filter Alpha"]);
  assert.deepEqual(await names("breed=Quarter%20Horse&status=racing"), ["Filter Charlie"]);
  for (const bad of ["sex=unicorn", "status=asleep", "foaledFrom=99", "foaledTo=abc"])
    assert.equal((await call(dan, "/api/community/public-horses?" + bad)).status, 400, bad);
  const breeds = await call(dan, "/api/community/public-horses/breeds");
  assert.equal(breeds.status, 200);
  assert.ok(breeds.data.breeds.some((b) => b.toLowerCase() === "quarter horse"));
  assert.equal(breeds.data.breeds.filter((b) => b.toLowerCase() === "quarter horse").length, 1, "one entry per breed whatever the case");
});
