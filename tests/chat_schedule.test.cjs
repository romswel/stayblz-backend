// Scheduled updates in Stayblz Chat (202611260001_chat_scheduled_updates.sql + lib/chatSchedule.ts + routes/chatSchedule.ts):
// private to granted accounts, three notes with Philippine times, each time sent once (claim + fixed client id), late
// sends up to 30 minutes then "missed", empty/off/skip handling, "Send now", and the /api/status check.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "true";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const schedule = require("../dist/lib/chatSchedule");

const ann = "a1111111-1111-4111-8111-111111111111",
  ben = "b2222222-2222-4222-8222-222222222222",
  cat = "c3333333-3333-4333-8333-333333333333";
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Bishop"], [cat]: ["Cat", "Carter"] };
const tokens = new Map();
let db, database, server, origin, group, annCat;

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
  return { status: response.status, data: await response.json().catch(() => null) };
}
const put = (user, slot, body) => call(user, `/api/messages/scheduled/${slot}`, { body, method: "PUT" });
const messages = async (chat) =>
  (await db.query("select sender_id, body, client_id from personal_messages where conversation_id = $1 and body not like '% added %' order by sent_at", [chat])).rows;
const note = async (user, slot) =>
  (await db.query("select * from chat_scheduled_notes where account_id = $1 and slot = $2", [user, slot])).rows[0];
const log = async (user) => (await db.query("select * from chat_scheduled_log where account_id = $1 order by id", [user])).rows;
// 9:00:30 PM in Manila on 25 Nov 2026 (UTC+8).
const NINE_PM = Date.parse("2026-11-25T13:00:30Z");
const NINE_PM_DUE = "2026-11-25T13:00:00.000Z";

test("Philippine times: the latest due time, the next one, and after-midnight slots", () => {
  assert.equal(new Date(schedule.lastDue("21:00", NINE_PM)).toISOString(), NINE_PM_DUE);
  // 8:59 PM Manila → yesterday's 9 PM.
  assert.equal(new Date(schedule.lastDue("21:00", Date.parse("2026-11-25T12:59:00Z"))).toISOString(), "2026-11-24T13:00:00.000Z");
  // 1 AM Manila on 26 Nov is 17:00 UTC on 25 Nov.
  assert.equal(new Date(schedule.lastDue("01:00", Date.parse("2026-11-25T17:10:00Z"))).toISOString(), "2026-11-25T17:00:00.000Z");
  assert.equal(new Date(schedule.lastDue("05:00", NINE_PM)).toISOString(), "2026-11-24T21:00:00.000Z");
  assert.equal(schedule.hhmm("05:00:00"), "05:00");
});

test("hidden from everyone without access: plain 404 and no flag on the chat profile", async () => {
  for (const id of [ben, cat]) {
    await call(ann, `/api/messages/people/friends/${id}/request`, { body: {} });
    await call(id, `/api/messages/people/friends/${ann}/request`, { body: {} });
  }
  group = (await call(ann, "/api/messages", { body: { title: "QA updates" } })).data.conversation.id;
  assert.equal((await call(ann, `/api/messages/${group}/members`, { body: { ids: [ben] } })).status, 200);
  annCat = (await call(ann, `/api/messages/people/${cat}/chat`, { body: {} })).data.conversation.id;

  const r = await call(ann, "/api/messages/scheduled");
  assert.equal(r.status, 404);
  assert.deepEqual(r.data, { error: "Route not found.", code: "route_not_found" });
  // Same answer as an address that doesn't exist at all.
  assert.deepEqual((await call(ann, "/api/no-such-thing")).data, r.data);
  assert.equal((await put(ann, 1, { body: "x" })).status, 404);
  const profile = await call(ann, "/api/messages/people/profile");
  assert.equal(profile.status, 200);
  assert.equal(profile.data.scheduledUpdates, undefined);
});

test("granted in SQL: three notes with the default times and the chats you're in", async () => {
  const granted = await db.query("select public.set_chat_schedule_access('ANN@example.test') as said");
  assert.match(granted.rows[0].said, /turned on/);
  assert.equal((await call(ann, "/api/messages/people/profile")).data.scheduledUpdates, true);
  const r = await call(ann, "/api/messages/scheduled");
  assert.equal(r.status, 200);
  assert.equal(r.data.zone, "Asia/Manila");
  assert.deepEqual(r.data.notes.map((n) => [n.slot, n.sendAt, n.body, n.enabled, n.chat]), [
    [1, "21:00", "", true, null],
    [2, "01:00", "", true, null],
    [3, "05:00", "", true, null],
  ]);
  const ids = r.data.chats.map((c) => c.id);
  assert.ok(ids.includes(group) && ids.includes(annCat));
  assert.equal(r.data.chats.find((c) => c.id === group).group, true);
  // Ben has no access.
  assert.equal((await call(ben, "/api/messages/scheduled")).status, 404);
});

test("saving checks the input and only allows chats you're in", async () => {
  assert.equal((await put(ann, 1, { body: "y".repeat(4001) })).status, 400);
  assert.equal((await put(ann, 1, { sendAt: "25:00" })).status, 400);
  assert.equal((await put(ann, 1, { chat: { kind: "personal", id: crypto.randomUUID() } })).status, 400);
  assert.equal((await call(ann, "/api/messages/scheduled/4", { body: {}, method: "PUT" })).status, 404);
  const r = await put(ann, 1, { body: "**Progress** — chat fixes done", chat: { kind: "personal", id: group } });
  assert.equal(r.status, 200);
  assert.equal(r.data.note.body, "**Progress** — chat fixes done");
  assert.deepEqual(r.data.note.chat, { kind: "personal", id: group, stableId: null });
  assert.equal(r.data.note.sendAt, "21:00");
});

test("at 9 PM the note goes to the chat once, as Ann, then empties", async () => {
  await db.query("update chat_scheduled_notes set handled_due = '2026-11-24T13:00:00Z' where account_id = $1 and slot = 1", [ann]);
  assert.equal(await schedule.runChatSchedule(NINE_PM), 1);
  let sent = await messages(group);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sender_id, ann);
  assert.equal(sent[0].body, "**Progress** — chat fixes done");
  assert.equal((await note(ann, 1)).body, "");
  assert.equal(new Date((await note(ann, 1)).handled_due).toISOString(), NINE_PM_DUE);
  const entries = await log(ann);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, "sent");
  assert.equal(entries[0].preview, "Progress — chat fixes done");

  // The same minute again, and a second server that never saw the claim: still one message.
  assert.equal(await schedule.runChatSchedule(NINE_PM + 20_000), 0);
  await db.query("update chat_scheduled_notes set handled_due = null, body = '**Progress** — chat fixes done' where account_id = $1 and slot = 1", [ann]);
  await schedule.runChatSchedule(NINE_PM + 40_000);
  sent = await messages(group);
  assert.equal(sent.length, 1);
  // Ben's chat list shows it.
  const list = await call(ben, "/api/messages");
  assert.match(list.data.conversations.find((c) => c.id === group).lastMessage, /Progress/);
});

test("kept notes repeat, empty notes and late starts are logged, off notes stay quiet", async () => {
  // Kept: sends the next day too and stays written.
  await put(ann, 1, { body: "Daily check-in", keepAfterSend: true });
  await db.query("update chat_scheduled_notes set handled_due = $2 where account_id = $1 and slot = 1", [ann, NINE_PM_DUE]);
  const nextDay = NINE_PM + 86_400_000;
  assert.equal(await schedule.runChatSchedule(nextDay), 1);
  assert.equal((await note(ann, 1)).body, "Daily check-in");

  // Empty 1 AM note: "empty", nothing sent.
  await put(ann, 2, { chat: { kind: "personal", id: group } });
  await db.query("update chat_scheduled_notes set handled_due = '2026-11-24T17:00:00Z' where account_id = $1 and slot = 2", [ann]);
  await schedule.runChatSchedule(Date.parse("2026-11-25T17:00:20Z"));
  // 5 AM note, but the server only wakes at 7:15 AM: "missed".
  await put(ann, 3, { body: "Morning update", chat: { kind: "personal", id: annCat } });
  await db.query("update chat_scheduled_notes set handled_due = '2026-11-24T21:00:00Z' where account_id = $1 and slot = 3", [ann]);
  await schedule.runChatSchedule(Date.parse("2026-11-25T23:15:00Z"));
  const statuses = (await log(ann)).map((e) => [e.slot, e.status]);
  assert.deepEqual(statuses.slice(-3), [[1, "sent"], [2, "empty"], [3, "missed"]]);
  assert.equal((await messages(annCat)).length, 0);
  assert.equal((await note(ann, 3)).body, "Morning update"); // a missed note keeps its words for "Send now"

  // Turned off: nothing at all, not even a log line.
  await put(ann, 3, { enabled: false });
  await db.query(
    "update chat_scheduled_notes set handled_due = case slot when 3 then '2026-11-25T21:00:00Z'::timestamptz when 2 then '2026-11-26T17:00:00Z'::timestamptz else handled_due end where account_id = $1",
    [ann],
  );
  const count = (await log(ann)).length;
  assert.equal(await schedule.runChatSchedule(Date.parse("2026-11-26T21:00:30Z")), 0);
  assert.equal((await log(ann)).length, count);
});

test("skip next: that one time is passed over, then it carries on", async () => {
  await put(ann, 3, { enabled: true });
  const r = await call(ann, "/api/messages/scheduled/3/skip", { body: { skip: true } });
  assert.equal(r.status, 200);
  assert.ok(r.data.note.skippingAt);
  const skipped = Date.parse(r.data.note.skippingAt);
  assert.equal(await schedule.runChatSchedule(skipped + 30_000), 0);
  assert.equal(await schedule.runChatSchedule(skipped + 86_400_000 + 30_000), 1);
  assert.equal((await messages(annCat)).length, 1);
  const undo = await call(ann, "/api/messages/scheduled/1/skip", { body: { skip: false } });
  assert.equal(undo.data.note.skippingAt, null);
});

test("Send now posts at once, a double press sends once, and leaving the chat is explained", async () => {
  await put(ann, 2, { body: "Hotfix shipped", keepAfterSend: true });
  const before = (await messages(group)).length;
  const first = await call(ann, "/api/messages/scheduled/2/send", { body: {} });
  assert.equal(first.status, 201);
  assert.equal(first.data.entry.status, "sent");
  const again = await call(ann, "/api/messages/scheduled/2/send", { body: {} });
  assert.equal(again.status, 201);
  assert.equal((await messages(group)).length, before + 1);
  assert.equal((await call(ann, "/api/messages/scheduled/3/send", { body: {} })).status, 409); // empty after sending

  // Ann leaves the group: the next send fails with plain words, and the log says why.
  await db.query("update personal_conversations set member_ids = array_remove(member_ids, $2::uuid) where id = $1", [group, ann]);
  await put(ann, 2, { body: "After leaving" });
  const failed = await call(ann, "/api/messages/scheduled/2/send", { body: {} });
  assert.equal(failed.status, 409);
  assert.match(failed.data.error, /no longer in that chat/);
  const history = (await call(ann, "/api/messages/scheduled")).data.history;
  assert.equal(history[0].status, "failed");
});

test("taking access away removes the notes and hides it again", async () => {
  await db.query("select public.set_chat_schedule_access('ann@example.test', false)");
  assert.equal((await call(ann, "/api/messages/scheduled")).status, 404);
  assert.equal((await db.query("select count(*)::int as n from chat_scheduled_notes where account_id = $1", [ann])).rows[0].n, 0);
  assert.equal(await schedule.runChatSchedule(NINE_PM + 3 * 86_400_000), 0);
});

test("/api/status answers with the server and database state", async () => {
  const r = await fetch(origin + "/api/status");
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.ok, true);
  assert.equal(data.server, "up");
  assert.ok(["ok", "slow", "down"].includes(data.database));
  assert.equal(data.notice, null);
  assert.equal(typeof data.uptimeSeconds, "number");
});
