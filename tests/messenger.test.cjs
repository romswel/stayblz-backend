// Messenger: direct chats + requests, read receipts, unread counts, replies, reactions,
// unsend, polling for changes, leaving, and team direct chats. Real SQL via PGlite.
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

const alice = "11111111-1111-4111-8111-111111111111",
  bob = "22222222-2222-4222-8222-222222222222",
  carol = "33333333-3333-4333-8333-333333333333",
  dave = "55555555-5555-4555-8555-555555555555";
const names = { [alice]: ["Alice", "Ames"], [bob]: ["Bob", "Burke"], [carol]: ["Carol", "Cole"], [dave]: ["Dave", "Dunn"] };
const tokens = new Map();
let db, database, server, origin, direct, stable;

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, [first, last]] of Object.entries(names)) {
    const email = first.toLowerCase() + "@example.test";
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    // The sign-up trigger already made the account row; fill in the profile.
    await db.query("update accounts set email=$2, first_name=$3, last_name=$4, status=$5 where id=$1", [
      id, email, first, last, id === dave ? "suspended" : "active",
    ]);
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
async function call(user, path, { body, stable: stableId } = {}) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + tokens.get(user),
      "Content-Type": "application/json",
      ...(stableId ? { "X-Stayblz-Stable": stableId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
const send = (user, id, body, extra = {}) =>
  call(user, `/api/messages/${id}/messages`, { body: { body, clientId: crypto.randomUUID(), ...extra } });

test("direct chats start by account email and arrive as a request until accepted", async () => {
  assert.equal((await call(alice, "/api/messages/direct", { body: { email: "nobody@example.test" } })).data.code, "no_account");
  assert.equal((await call(alice, "/api/messages/direct", { body: { email: "alice@example.test" } })).status, 400);
  // Suspended accounts can't be found.
  assert.equal((await call(alice, "/api/messages/direct", { body: { email: "dave@example.test" } })).status, 404);

  let r = await call(alice, "/api/messages/direct", { body: { email: "  BOB@example.test " } });
  assert.equal(r.status, 201);
  direct = r.data.conversation.id;
  assert.equal(r.data.conversation.kind, "direct");
  assert.equal(r.data.conversation.title, "Bob Burke");
  assert.equal(r.data.conversation.waiting, true);
  assert.deepEqual(r.data.conversation.members.map((m) => [m.name, m.pending]), [["Alice Ames", false], ["Bob Burke", true]]);
  // Starting again reopens the same chat.
  assert.equal((await call(alice, "/api/messages/direct", { body: { email: "bob@example.test" } })).data.conversation.id, direct);

  // Bob doesn't see an empty request.
  assert.equal((await call(bob, "/api/messages")).data.conversations.length, 0);
  r = await send(alice, direct, "Are you running Saturday?");
  assert.equal(r.status, 201);
  r = await call(bob, "/api/messages");
  assert.equal(r.data.conversations.length, 1);
  assert.equal(r.data.conversations[0].request, true);
  assert.equal(r.data.conversations[0].title, "Alice Ames");
  assert.equal(r.data.conversations[0].unread, false);
  assert.deepEqual((await call(bob, "/api/messages/unread")).data, { personal: 0, requests: 1, team: 0 });

  // Pending: Bob can read but not reply, react, or send read receipts.
  r = await call(bob, `/api/messages/${direct}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.conversation.messages[0].body, "Are you running Saturday?");
  assert.equal((await send(bob, direct, "Hi")).data.code, "request_pending");
  const first = r.data.conversation.messages[0].id;
  assert.equal((await call(bob, `/api/messages/${direct}/messages/${first}/react`, { body: { emoji: "👍" } })).status, 409);
  await call(bob, `/api/messages/${direct}/read`, { body: {} });
  assert.deepEqual((await call(alice, `/api/messages/${direct}`)).data.conversation.reads, []);

  // Outsiders get a plain 404.
  assert.equal((await call(carol, `/api/messages/${direct}`)).status, 404);
  assert.equal((await send(carol, direct, "Let me in")).status, 404);

  assert.equal((await call(bob, `/api/messages/${direct}/accept`, { body: {} })).status, 200);
  r = await call(bob, "/api/messages");
  assert.equal(r.data.conversations[0].request, false);
  assert.equal((await send(bob, direct, "Yes — race 4.")).status, 201);
  assert.deepEqual((await call(alice, "/api/messages/unread")).data, { personal: 1, requests: 0, team: 0 });
});

test("read times power Seen and clear the unread badge", async () => {
  let r = await call(alice, `/api/messages/${direct}`);
  const bobRead = r.data.conversation.reads.find((x) => x.id === bob);
  assert.ok(bobRead && Date.parse(bobRead.at) >= Date.parse(r.data.conversation.messages[0].sentAt));
  assert.equal((await call(alice, "/api/messages")).data.conversations[0].unread, true);
  assert.equal((await call(alice, `/api/messages/${direct}/read`, { body: {} })).status, 200);
  assert.equal((await call(alice, "/api/messages")).data.conversations[0].unread, false);
  assert.deepEqual((await call(alice, "/api/messages/unread")).data, { personal: 0, requests: 0, team: 0 });
});

test("replies, reactions and unsend; polling returns only what changed", async () => {
  // Earlier messages were "a minute ago" (polls overlap 10 s on purpose, so recent rows would repeat).
  await db.query("update personal_messages set updated_at = now() - interval '1 minute' where conversation_id=$1", [direct]);
  let r = await call(alice, `/api/messages/${direct}`);
  const since = r.data.now;
  const target = r.data.conversation.messages.find((m) => m.body === "Yes — race 4.");

  r = await send(alice, direct, "Great, see you there", { replyTo: target.id });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.message.replyTo, { id: target.id, from: "Bob Burke", body: "Yes — race 4.", removed: false });
  const reply = r.data.message.id;
  // A reply to a message from another chat is dropped, not leaked.
  const other = await call(carol, "/api/messages", { body: { title: "Carol's group" } });
  const foreign = (await send(carol, other.data.conversation.id, "Private")).data.message.id;
  r = await send(alice, direct, "Sneaky", { replyTo: foreign });
  assert.equal(r.data.message.replyTo, null);

  r = await call(bob, `/api/messages/${direct}/messages/${reply}/react`, { body: { emoji: "❤️" } });
  assert.deepEqual(r.data.message.reactions, [{ emoji: "❤️", count: 1, mine: true }]);
  r = await call(alice, `/api/messages/${direct}/messages/${reply}/react`, { body: { emoji: "❤️" } });
  assert.deepEqual(r.data.message.reactions, [{ emoji: "❤️", count: 2, mine: true }]);
  // Same emoji again removes yours.
  r = await call(alice, `/api/messages/${direct}/messages/${reply}/react`, { body: { emoji: "❤️" } });
  assert.deepEqual(r.data.message.reactions, [{ emoji: "❤️", count: 1, mine: false }]);
  assert.equal((await call(alice, `/api/messages/${direct}/messages/${reply}/react`, { body: { emoji: "💩" } })).status, 400);

  // Only your own messages can be unsent; the text is erased for everyone.
  assert.equal((await call(alice, `/api/messages/${direct}/messages/${target.id}/unsend`, { body: {} })).status, 404);
  r = await call(bob, `/api/messages/${direct}/messages/${target.id}/unsend`, { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.message.removed, true);
  assert.equal(r.data.message.body, "");
  const stored = await db.query("select body, reactions from personal_messages where id=$1", [target.id]);
  assert.deepEqual(stored.rows[0], { body: "", reactions: {} });

  r = await call(alice, `/api/messages/${direct}/updates?since=${encodeURIComponent(since)}`);
  assert.equal(r.status, 200);
  const changed = new Map(r.data.conversation.messages.map((m) => [m.id, m]));
  assert.equal(changed.get(target.id).removed, true);
  assert.equal(changed.get(reply).replyTo.removed, true);
  assert.equal(changed.get(reply).replyTo.body, "");
  assert.ok(!r.data.conversation.messages.some((m) => m.body === "Are you running Saturday?"));
  assert.equal((await call(alice, `/api/messages/${direct}/updates?since=yesterday`)).status, 400);
});

test("leaving removes you; the last person out deletes the chat", async () => {
  const group = await call(carol, "/api/messages", { body: { title: "Solo notes" } });
  const id = group.data.conversation.id;
  assert.equal(group.data.conversation.canInvite, true);
  assert.equal((await call(carol, `/api/messages/${id}/leave`, { body: {} })).status, 200);
  assert.equal((await db.query("select count(*)::int as n from personal_conversations where id=$1", [id])).rows[0].n, 0);

  assert.equal((await call(bob, `/api/messages/${direct}/leave`, { body: {} })).status, 200);
  assert.equal((await call(bob, `/api/messages/${direct}`)).status, 404);
  const r = await call(alice, `/api/messages/${direct}`);
  assert.equal(r.data.conversation.members.length, 1);
});

test("team direct chats only reach teammates in the selected stable", async () => {
  let r = await call(alice, "/api/workspaces", { body: { name: "Chat stable" } });
  stable = r.data.stable.id;
  await db.query("insert into stable_memberships(stable_id,user_id,display_name,role) values($1,$2,'Bob B.','member')", [stable, bob]);
  assert.equal((await call(alice, "/api/team-messages/direct", { stable, body: { memberId: carol } })).status, 400);
  r = await call(alice, "/api/team-messages/direct", { stable, body: { memberId: bob } });
  assert.equal(r.status, 201);
  const id = r.data.conversation.id;
  assert.equal(r.data.conversation.title, "Bob B.");
  assert.equal((await call(bob, "/api/team-messages/direct", { stable, body: { memberId: alice } })).data.conversation.id, id);
  r = await call(bob, `/api/team-messages/${id}/messages`, { stable, body: { body: "Gallops at 6", clientId: crypto.randomUUID() } });
  assert.equal(r.status, 201);
  assert.equal(r.data.message.from, "Bob B.");
  assert.equal((await call(alice, "/api/messages/unread")).data.team, 1);
  // The team chat can't be opened through personal messages or another stable.
  assert.equal((await call(alice, `/api/messages/${id}`)).status, 404);
  assert.equal((await call(carol, `/api/team-messages/${id}`, { stable })).status, 403);
  await call(alice, `/api/team-messages/${id}/read`, { stable, body: {} });
  assert.equal((await call(alice, "/api/messages/unread")).data.team, 0);
  // Removed from the stable: no longer counted.
  await call(alice, `/api/team-messages/${id}/messages`, { stable, body: { body: "Ok", clientId: crypto.randomUUID() } });
  await db.query("delete from stable_memberships where stable_id=$1 and user_id=$2", [stable, bob]);
  assert.equal((await call(bob, "/api/messages/unread")).data.team, 0);
});

test("browser roles cannot call the chat functions", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    try {
      await assert.rejects(db.query("select chat_list('personal',$1,null)", [alice]), /permission denied/);
      await assert.rejects(db.query("select chat_start_direct($1,'x','bob@example.test')", [alice]), /permission denied/);
      await assert.rejects(db.query("select chat_unread($1)", [alice]), /permission denied/);
    } finally {
      await db.exec("reset role");
    }
  }
});
