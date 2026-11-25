// Co-owned horses (My racing → My horses): invites, shared editing, lead-only actions, changes that need approval,
// bell alerts for the other owners, and race-data alerts reaching co-owners. Real SQL (PGlite with every migration).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const { horseAlertsSettled } = require("../dist/lib/horseAlerts");

const ann = "a1111111-1111-4111-8111-111111111111", // lead owner
  ben = "b2222222-2222-4222-8222-222222222222", // co-owner (Ann's dad)
  cat = "c3333333-3333-4333-8333-333333333333"; // stranger
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Archer"], [cat]: ["Cat", "Carter"] };
const tokens = new Map();
let db, database, server, origin;

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
});
after(async () => {
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(user, path, { body, method } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { Authorization: "Bearer " + tokens.get(user), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {}
  return { status: response.status, data };
}
const C = "/api/community";
const details = { name: "Dad's Dream", breed: "Thoroughbred", status: "racing", visibility: "private" };
async function horseAlerts(user) {
  await horseAlertsSettled();
  const { rows } = await db.query("select chat_title, body, link from chat_alerts where user_id=$1 and kind='horse' order by created_at", [user]);
  return rows;
}
const myHorses = async (user) => (await call(user, `${C}/people/${user}/horses`)).data.horses;

let horse;

test("the lead owner invites a member; the invite waits until it is accepted", async () => {
  const created = await call(ann, `${C}/horses`, { body: details });
  assert.equal(created.status, 201);
  horse = created.data.horse.id;
  assert.equal(created.data.horse.role, "lead");

  // A private horse: Ben can't see it yet.
  assert.equal((await call(ben, `${C}/horses/${horse}`)).status, 404);

  const invited = await call(ann, `${C}/horses/${horse}/owners`, { body: { accountId: ben, shareBps: 5000 } });
  assert.equal(invited.status, 201, JSON.stringify(invited.data));
  assert.deepEqual(
    invited.data.owners.map((o) => [o.name, o.lead, o.status, o.shareBps]),
    [["Ann Archer", true, "accepted", null], ["Ben Archer", false, "pending", 5000]],
  );
  assert.equal((await call(ann, `${C}/horses/${horse}/owners`, { body: { accountId: ben } })).status, 409, "no double invite");
  assert.equal((await call(ann, `${C}/horses/${horse}/owners`, { body: { accountId: ann } })).status, 400);

  const alerts = await horseAlerts(ben);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].chat_title, /Co-own Dad's Dream/);
  assert.equal(alerts[0].link, "/account/horses#invites");

  // Still pending: no edit access, no horse in Ben's list.
  assert.equal((await call(ben, `${C}/horses/${horse}`, { method: "PATCH", body: { ...details, name: "X" } })).status, 404);
  assert.equal((await myHorses(ben)).length, 0);

  const invites = (await call(ben, `${C}/horse-invites`)).data.invites;
  assert.equal(invites.length, 1);
  assert.equal(invites[0].horse.name, "Dad's Dream");
  assert.equal(invites[0].invitedBy.name, "Ann Archer");

  const accepted = await call(ben, `${C}/horse-invites/${horse}/accept`, { body: {} });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.horse.role, "coowner");
  assert.equal((await call(ben, `${C}/horse-invites`)).data.invites.length, 0);
  assert.ok((await horseAlerts(ann)).some((a) => /New co-owner/.test(a.chat_title)));
});

test("both owners see the same horse; edits by either show for both at once", async () => {
  const bens = await myHorses(ben);
  assert.deepEqual(bens.map((h) => [h.id, h.role, h.mine]), [[horse, "coowner", true]]);
  assert.equal((await myHorses(ann))[0].coOwners, 1);

  const edit = await call(ben, `${C}/horses/${horse}`, { method: "PATCH", body: { ...details, trainer: "T. Smith", visibility: "members" } });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  const forAnn = (await call(ann, `${C}/horses/${horse}`)).data.horse;
  assert.equal(forAnn.trainer, "T. Smith");
  assert.equal(forAnn.visibility, "private", "who can see the horse stays the lead owner's choice");
  assert.ok((await horseAlerts(ann)).some((a) => /was updated/.test(a.chat_title)));

  // A burst of edits makes one alert, not one per save.
  const before = (await horseAlerts(ann)).length;
  await call(ben, `${C}/horses/${horse}`, { method: "PATCH", body: { ...details, trainer: "T. Jones" } });
  assert.equal((await horseAlerts(ann)).length, before);

  const race = await call(ben, `${C}/horses/${horse}/records`, { body: { raceDate: "2026-10-01", track: "Belmont", finish: 1, fieldSize: 8 } });
  assert.equal(race.status, 201);
  assert.equal((await call(ann, `${C}/horses/${horse}`)).data.horse.records.length, 1);

  // Public profile: the owners are listed without shares.
  await call(ann, `${C}/horses/${horse}`, { method: "PATCH", body: { ...details, trainer: "T. Jones", visibility: "members" } });
  const forCat = (await call(cat, `${C}/horses/${horse}`)).data.horse;
  assert.deepEqual(forCat.owners, [
    { id: ann, name: "Ann Archer", lead: true, me: false },
    { id: ben, name: "Ben Archer", lead: false, me: false },
  ]);
  assert.equal(forCat.mine, false);
});

test("only the lead owner deletes the horse, manages owners and approval; strangers can't edit", async () => {
  assert.equal((await call(ben, `${C}/horses/${horse}/remove`, { body: {} })).status, 403);
  assert.equal((await call(ben, `${C}/horses/${horse}/owners`, { body: { accountId: cat } })).status, 403);
  assert.equal((await call(ben, `${C}/horses/${horse}/approval`, { method: "PATCH", body: { requireApproval: false } })).status, 403);
  assert.equal((await call(ben, `${C}/horses/${horse}/formfav`, { body: { name: "X", code: "gallops" } })).status, 403);
  assert.equal((await call(cat, `${C}/horses/${horse}`, { method: "PATCH", body: details })).status, 404);
  assert.equal((await call(cat, `${C}/horses/${horse}/owners`)).status, 404);
  assert.equal((await call(ann, `${C}/horses/${horse}/owners/${ann}/remove`, { body: {} })).status, 400);
  assert.equal((await call(ann, `${C}/horses/${horse}/owners/${ann}`, { method: "PATCH", body: { shareBps: 6000 } })).status, 400, "over 100%");
  assert.equal((await call(ann, `${C}/horses/${horse}/owners/${ann}`, { method: "PATCH", body: { shareBps: 5000 } })).status, 200);
});

test("with approval on, a co-owner's changes wait until another owner accepts or declines them", async () => {
  assert.equal((await call(ann, `${C}/horses/${horse}/approval`, { method: "PATCH", body: { requireApproval: true } })).status, 200);
  const current = (await call(ann, `${C}/horses/${horse}`)).data.horse;

  const proposed = await call(ben, `${C}/horses/${horse}`, { method: "PATCH", body: { ...details, trainer: "B. Baffert", visibility: "members" } });
  assert.equal(proposed.status, 202);
  assert.ok(proposed.data.pending.id);
  assert.equal((await call(ann, `${C}/horses/${horse}`)).data.horse.trainer, current.trainer, "not changed yet");
  assert.ok((await horseAlerts(ann)).some((a) => /change to approve/.test(a.chat_title)));

  const list = (await call(ann, `${C}/horses/${horse}/changes`)).data.changes;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].fields, [{ field: "trainer", from: "T. Jones", to: "B. Baffert" }]);
  assert.equal(list[0].proposedBy.name, "Ben Archer");
  assert.equal((await myHorses(ann))[0].pendingChanges, 1);

  // The proposer can't approve their own change.
  assert.equal((await call(ben, `${C}/changes/${list[0].id}/accept`, { body: {} })).status, 403);
  const ok = await call(ann, `${C}/changes/${list[0].id}/accept`, { body: {} });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.horse.trainer, "B. Baffert");
  assert.equal((await call(ann, `${C}/changes/${list[0].id}/accept`, { body: {} })).status, 409, "answered once");
  assert.ok((await horseAlerts(ben)).some((a) => /change accepted/.test(a.chat_title)));

  // A new race, declined.
  const race = await call(ben, `${C}/horses/${horse}/records`, { body: { raceDate: "2026-11-01", track: "Aqueduct", finish: 3 } });
  assert.equal(race.status, 202);
  const [change] = (await call(ann, `${C}/horses/${horse}/changes`)).data.changes;
  assert.equal(change.kind, "record_add");
  assert.equal(change.proposed.track, "Aqueduct");
  assert.equal((await call(ann, `${C}/changes/${change.id}/decline`, { body: {} })).status, 200);
  assert.equal((await call(ann, `${C}/horses/${horse}`)).data.horse.records.length, 1);
  assert.ok((await horseAlerts(ben)).some((a) => /change declined/.test(a.chat_title)));

  // Removing a race, accepted.
  const [record] = (await call(ann, `${C}/horses/${horse}`)).data.horse.records;
  assert.equal((await call(ben, `${C}/records/${record.id}/remove`, { body: {} })).status, 202);
  const [removal] = (await call(ann, `${C}/horses/${horse}/changes`)).data.changes;
  assert.equal(removal.record.track, "Belmont");
  assert.equal((await call(ann, `${C}/changes/${removal.id}/accept`, { body: {} })).status, 200);
  assert.equal((await call(ann, `${C}/horses/${horse}`)).data.horse.records.length, 0);

  // The lead owner's own edits still go straight in.
  assert.equal((await call(ann, `${C}/horses/${horse}`, { method: "PATCH", body: { ...details, visibility: "members", trainer: "A. Archer" } })).status, 200);
  assert.equal((await call(ben, `${C}/horses/${horse}`)).data.horse.trainer, "A. Archer");
});

test("race-data alerts for a linked horse reach every co-owner", async () => {
  await db.query("update owner_horses set formfav_key='gallops|dad''s dream', formfav_name='Dad''s Dream', formfav_code='gallops', formfav_linked_at=now() - interval '1 day' where id=$1", [horse]);
  const { data, error } = await supabase.rpc("formfav_notify", {
    p_events: [{ key: "gallops|dad's dream", ref: "d4444444-4444-4444-8444-444444444444", kind: "race_result", horse: "Dad's Dream", title: "Won at Belmont", body: "1st of 8", at: new Date().toISOString() }],
  });
  assert.equal(error, null, error && error.message);
  const who = data.alerts.map((a) => a.userId).sort();
  assert.deepEqual(who, [ann, ben].sort());
});

test("a co-owner can leave; the lead owner can remove one", async () => {
  assert.equal((await call(ben, `${C}/horses/${horse}/owners/${ben}/remove`, { body: {} })).status, 200);
  assert.equal((await myHorses(ben)).length, 0);
  assert.equal((await call(ben, `${C}/horses/${horse}`, { method: "PATCH", body: details })).status, 404);

  await call(ann, `${C}/horses/${horse}/owners`, { body: { accountId: cat } });
  await call(cat, `${C}/horse-invites/${horse}/accept`, { body: {} });
  const removed = await call(ann, `${C}/horses/${horse}/owners/${cat}/remove`, { body: {} });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.owners.map((o) => o.name), ["Ann Archer"]);
  assert.ok((await horseAlerts(cat)).some((a) => /no longer a co-owner/.test(a.body)));

  // Declining an invite.
  await call(ann, `${C}/horses/${horse}/owners`, { body: { accountId: ben } });
  assert.equal((await call(ben, `${C}/horse-invites/${horse}/decline`, { body: {} })).status, 200);
  assert.equal((await call(ben, `${C}/horse-invites`)).data.invites.length, 0);
});
