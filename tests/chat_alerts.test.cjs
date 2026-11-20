// Stayblz Chat alerts (202611190003_chat_alerts.sql + lib/chatAlerts.ts): every chat event saves an alert for the right
// people (messages, requests, mentions, replies, reactions, groups, friends), mute and blocks are respected, the bell
// list and the poll read them, and Web Push carries the right words, link, picture and tag (sender stubbed).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "true";
const webpush = require("web-push");
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const { chatStorage } = require("../dist/lib/chatStorage");
const push = require("../dist/lib/push");
const { r2Storage } = require("../dist/lib/r2Storage");
r2Storage.isConfigured = () => false;
const keys = webpush.generateVAPIDKeys();
process.env.PUSH_VAPID_PUBLIC_KEY = keys.publicKey;
process.env.PUSH_VAPID_PRIVATE_KEY = keys.privateKey;

const ann = "a1111111-1111-4111-8111-111111111111",
  ben = "b2222222-2222-4222-8222-222222222222",
  cat = "c3333333-3333-4333-8333-333333333333",
  dan = "d4444444-4444-4444-8444-444444444444",
  eve = "e5555555-5555-4555-8555-555555555555";
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Bishop"], [cat]: ["Cat", "Carter"], [dan]: ["Dan", "Dale"], [eve]: ["Eve", "Ember"] };
const tokens = new Map();
const stored = new Map();
const pushed = [];
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
  chatStorage.upload = async (path, body) => void stored.set(path, Buffer.from(body));
  chatStorage.download = async (path) => stored.get(path);
  chatStorage.remove = async (paths) => paths.forEach((p) => stored.delete(p));
  push.pushSender.send = async (target, payload) => void pushed.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  for (const token of tokens.values()) auth.destroySession(token);
  delete process.env.PUSH_VAPID_PUBLIC_KEY;
  delete process.env.PUSH_VAPID_PRIVATE_KEY;
  push.resetPush();
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(user, path, { body, raw, type, stable } = {}) {
  const response = await fetch(origin + path, {
    method: body || raw ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + tokens.get(user),
      "Content-Type": raw ? type : "application/json",
      ...(stable ? { "X-Stayblz-Stable": stable } : {}),
    },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data };
}
const say = (user, id, body, extra = {}) =>
  call(user, `/api/messages/${id}/messages`, { body: { body, clientId: crypto.randomUUID(), ...extra } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await wait(20);
  }
  return check();
}
const alertsOf = async (user, kind) =>
  (await db.query("select * from chat_alerts where user_id = $1 and ($2::text is null or kind = $2) order by created_at", [user, kind ?? null])).rows;
const device = (user) => `https://fcm.googleapis.com/fcm/send/${user.slice(0, 4)}-phone`;
const pushesTo = (user) => pushed.filter((p) => p.endpoint === device(user)).map((p) => p.payload);

let annBen, group;

test("set up: friends, a group, and a phone for everyone with notifications on", async () => {
  for (const other of [ben, cat]) {
    await call(ann, `/api/messages/people/friends/${other}/request`, { body: {} });
    await call(other, `/api/messages/people/friends/${ann}/request`, { body: {} });
  }
  annBen = (await call(ann, `/api/messages/people/${ben}/chat`, { body: {} })).data.conversation.id;
  group = (await call(ann, "/api/messages", { body: { title: "Syndicate" } })).data.conversation.id;
  assert.equal((await call(ann, `/api/messages/${group}/members`, { body: { ids: [ben, cat] } })).status, 200);
  for (const id of Object.keys(people)) {
    await call(id, "/api/notifications/settings", { body: { enabled: true } });
    const sub = { endpoint: device(id), keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };
    assert.equal((await call(id, "/api/notifications/push/subscribe", { body: sub })).status, 201);
  }
});

test("friend requests and accepts alert the other person (once a day for repeats)", async () => {
  pushed.length = 0;
  let r = await call(dan, `/api/messages/people/friends/${eve}/request`, { body: {} });
  assert.equal(r.data.status, "outgoing");
  assert.ok(await until(() => pushesTo(eve).length === 1));
  assert.deepEqual(
    (({ alertId, ...rest }) => rest)(pushesTo(eve)[0]),
    { kind: "chat", alert: "friend_request", tag: `friend-${dan}`, url: "/messages?people=1", title: "Dan Dale wants to be friends", body: "Accept or decline in Stayblz Chat → People." },
  );
  // Asking again (cancel + ask) doesn't buzz Eve twice in a day.
  await call(dan, `/api/messages/people/friends/${eve}/remove`, { body: {} });
  await call(dan, `/api/messages/people/friends/${eve}/request`, { body: {} });
  await wait(80);
  assert.equal(pushesTo(eve).length, 1);
  r = await call(eve, `/api/messages/people/friends/${dan}/accept`, { body: {} });
  assert.equal(r.data.status, "friends");
  assert.ok(await until(() => pushesTo(dan).length === 1));
  assert.equal(pushesTo(dan)[0].title, "Eve Ember accepted your friend request");
  assert.equal((await alertsOf(dan, "friend_accepted")).length, 1);
});

test("new messages collapse into one alert per chat until it's opened; opening reads it", async () => {
  pushed.length = 0;
  push.resetPush();
  await say(ann, annBen, "Saddle up");
  await say(ann, annBen, "Boots too");
  let rows = await alertsOf(ben, "message");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].body, "Boots too");
  // One buzz for the burst.
  assert.ok(await until(() => pushesTo(ben).length === 1));
  await wait(60);
  assert.equal(pushesTo(ben).length, 1);
  assert.equal(pushesTo(ben)[0].url, `/messages/${annBen}`);
  // Nobody alerts themselves.
  assert.equal((await alertsOf(ann, "message")).length, 0);
  await call(ben, `/api/messages/${annBen}/read`, { body: {} });
  assert.ok((await alertsOf(ben, "message"))[0].read_at);
  await say(ann, annBen, "Leaving now");
  rows = await alertsOf(ben, "message");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].count, 1);
});

test("mentions reach you even in a muted group; the others just get the message", async () => {
  await call(ben, `/api/messages/${group}/settings`, { body: { muted: true } });
  pushed.length = 0;
  push.resetPush();
  const sent = (await say(ann, group, "@ben bishop can you drive? Cat too")).data.message;
  const mention = await alertsOf(ben, "mention");
  assert.equal(mention.length, 1);
  assert.equal(mention[0].message_id, sent.id);
  assert.equal((await alertsOf(cat, "mention")).length, 0);
  assert.ok((await alertsOf(cat, "message")).some((a) => a.conversation_id === group));
  assert.ok(await until(() => pushesTo(ben).length === 1 && pushesTo(cat).length === 1));
  const toBen = pushesTo(ben)[0];
  assert.equal(toBen.title, "Ann Archer mentioned you in Syndicate");
  assert.equal(toBen.body, "@ben bishop can you drive? Cat too");
  assert.equal(toBen.url, `/messages/${group}?m=${sent.id}`);
  assert.equal(toBen.alert, "mention");
  assert.equal(pushesTo(cat)[0].title, "Syndicate");
  assert.equal(pushesTo(cat)[0].body, "Ann Archer: @ben bishop can you drive? Cat too");
  // "@Benjamin" isn't "@Ben Bishop"; a muted chat stays quiet for plain messages.
  pushed.length = 0;
  push.resetPush();
  await say(cat, group, "@Ben Bishopp typo");
  await wait(80);
  assert.equal(pushesTo(ben).length, 0);
  await call(ben, `/api/messages/${group}/settings`, { body: { muted: false } });
});

test("replies tell the person replied to", async () => {
  const original = (await say(ben, group, "Who has the trailer?")).data.message;
  pushed.length = 0;
  push.resetPush();
  const reply = (await say(cat, group, "I do", { replyTo: original.id })).data.message;
  assert.equal((await alertsOf(ben, "reply")).at(-1).message_id, reply.id);
  assert.ok(await until(() => pushesTo(ben).length === 1));
  assert.equal(pushesTo(ben)[0].title, "Cat Carter replied to you in Syndicate");
  // Ann just gets the message.
  assert.equal((await alertsOf(ann, "reply")).length, 0);
});

test("reactions alert the author once; taking one back or reacting to yourself stays quiet", async () => {
  const mine = (await say(ann, annBen, "Won by a neck!")).data.message;
  pushed.length = 0;
  let r = await call(ben, `/api/messages/${annBen}/messages/${mine.id}/react`, { body: { emoji: "🎉" } });
  assert.equal(r.status, 200);
  assert.ok(await until(() => pushesTo(ann).length === 1));
  assert.deepEqual(
    (({ alertId, ...rest }) => rest)(pushesTo(ann)[0]),
    {
      kind: "chat",
      alert: "reaction",
      tag: `react-${mine.id}`,
      url: `/messages/${annBen}?m=${mine.id}`,
      title: "Ben Bishop reacted 🎉 to your message",
      body: "“Won by a neck!”",
    },
  );
  // Switching the reaction updates the same alert without another buzz; removing it says nothing.
  await call(ben, `/api/messages/${annBen}/messages/${mine.id}/react`, { body: { emoji: "❤️" } });
  await call(ben, `/api/messages/${annBen}/messages/${mine.id}/react`, { body: { emoji: "❤️" } });
  await call(ann, `/api/messages/${annBen}/messages/${mine.id}/react`, { body: { emoji: "👍" } });
  await wait(80);
  assert.equal(pushesTo(ann).length, 1);
  const rows = await alertsOf(ann, "reaction");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].emoji, "❤️");
});

test("photos: the alert says what was sent and carries the picture (previews on only)", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  pushed.length = 0;
  push.resetPush();
  const r = await call(ann, `/api/messages/${annBen}/attachments?name=gate.png&clientId=${crypto.randomUUID()}`, { raw: png, type: "image/png" });
  assert.equal(r.status, 201);
  assert.ok(await until(() => pushesTo(ben).length === 1));
  assert.equal(pushesTo(ben)[0].body, "📷 Sent a photo");
  assert.equal(pushesTo(ben)[0].image, `/api/messages/${annBen}/files/${r.data.message.id}`);
  // The stored path never leaves the server.
  assert.ok(!JSON.stringify((await alertsOf(ben)).map((a) => a.attachment)).includes("personal/"));
  await call(ben, "/api/notifications/settings", { body: { previews: false } });
  pushed.length = 0;
  push.resetPush();
  await call(ann, `/api/messages/${annBen}/attachments?name=gate2.png&clientId=${crypto.randomUUID()}`, { raw: png, type: "image/png" });
  assert.ok(await until(() => pushesTo(ben).length === 1));
  assert.equal(pushesTo(ben)[0].image, undefined);
  assert.match(pushesTo(ben)[0].body, /new message/);
  await call(ben, "/api/notifications/settings", { body: { previews: true } });
});

test("message requests: the request alerts, and accepting tells the sender", async () => {
  const chat = (await call(ann, `/api/messages/people/${dan}/chat`, { body: {} })).data.conversation.id;
  pushed.length = 0;
  push.resetPush();
  assert.equal((await say(ann, chat, "Hi Dan, about the filly")).status, 201);
  assert.ok(await until(() => pushesTo(dan).length === 1));
  assert.equal(pushesTo(dan)[0].alert, "request");
  assert.equal(pushesTo(dan)[0].body, "Message request: Hi Dan, about the filly");
  assert.equal((await call(dan, `/api/messages/${chat}/accept`, { body: {} })).status, 200);
  assert.ok(await until(() => pushesTo(ann).length === 1));
  assert.equal(pushesTo(ann)[0].title, "Dan Dale accepted your message request");
  assert.equal(pushesTo(ann)[0].url, `/messages/${chat}`);
});

test("being added to a group alerts only the people really added", async () => {
  pushed.length = 0;
  assert.equal((await call(ann, `/api/messages/${group}/members`, { body: { ids: [ben, dan] } })).status, 200);
  assert.ok(await until(() => pushesTo(dan).length === 1));
  await wait(60);
  assert.equal(pushesTo(dan)[0].title, "Ann Archer added you to Syndicate");
  assert.equal(pushesTo(ben).length, 0);
});

test("blocking stops alerts from that person", async () => {
  await call(ben, `/api/messages/people/blocks/${cat}`, { body: { block: true } });
  const before = (await alertsOf(ben)).length;
  await say(cat, group, "@Ben Bishop hello?");
  assert.equal((await alertsOf(ben)).length, before);
  await call(ben, `/api/messages/people/blocks/${cat}`, { body: { block: false } });
});

test("switches: mentions and reactions can be turned off for pop-ups but stay in the bell list", async () => {
  await call(ben, "/api/notifications/settings", { body: { chatMentions: false } });
  pushed.length = 0;
  await say(ann, group, "@Ben Bishop quiet one");
  await wait(80);
  assert.equal(pushesTo(ben).length, 0);
  assert.ok((await alertsOf(ben, "mention")).some((a) => a.body === "@Ben Bishop quiet one"));
  await call(ben, "/api/notifications/settings", { body: { chatMentions: true } });
});

test("the bell: list, unread count, new-since, mark read; the poll carries new alerts", async () => {
  let r = await call(ben, "/api/notifications/alerts");
  assert.equal(r.status, 200);
  assert.ok(r.data.items.length >= 4);
  assert.ok(r.data.unread >= 1);
  const first = r.data.items[0];
  assert.deepEqual(Object.keys(first).sort(), [
    "actorId", "actorName", "at", "attachment", "body", "chatId", "chatKind", "count", "emoji", "group", "id", "kind", "link", "messageId", "read", "stableId", "title",
  ].sort());
  const since = new Date().toISOString();
  await wait(20);
  await say(ann, group, "@Ben Bishop new one");
  r = await call(ben, `/api/notifications/alerts?since=${encodeURIComponent(since)}`);
  assert.deepEqual(r.data.items.map((a) => a.kind), ["mention"]);
  const poll = await call(ben, `/api/messages/unread?since=${encodeURIComponent(since)}`);
  assert.ok(poll.data.alerts.some((a) => a.kind === "mention" && a.body === "@Ben Bishop new one"));
  assert.equal(typeof poll.data.alertsUnread, "number");
  r = await call(ben, "/api/notifications/alerts/read", { body: { ids: [r.data.items[0].id] } });
  assert.equal(r.status, 200);
  assert.equal((await call(ben, "/api/notifications/alerts/read", { body: { ids: ["nope"] } })).status, 400);
  r = await call(ben, "/api/notifications/alerts/read", { body: { all: true } });
  assert.equal(r.data.unread, 0);
  // Other people's alerts are never visible.
  r = await call(cat, "/api/notifications/alerts");
  assert.ok(r.data.items.every((a) => a.actorId !== cat));
});

test("team chats: group adds and mentions link to the stable's chat", async () => {
  let r = await call(ann, "/api/workspaces", { body: { name: "Alert stable" } });
  const stable = r.data.stable.id;
  await db.query("insert into stable_memberships(stable_id,user_id,display_name,role) values($1,$2,'Ben B.','member')", [stable, ben]);
  pushed.length = 0;
  r = await call(ann, "/api/team-messages", { stable, body: { title: "Yard", memberIds: [ben] } });
  assert.equal(r.status, 201);
  const chat = r.data.conversation.id;
  assert.ok(await until(() => pushesTo(ben).length === 1));
  assert.equal(pushesTo(ben)[0].title, "Ann Archer added you to Yard");
  assert.equal(pushesTo(ben)[0].url, `/team-messages/${chat}?stable=${stable}`);
  pushed.length = 0;
  const sent = await call(ann, `/api/team-messages/${chat}/messages`, { stable, body: { body: "@Ben B. muck out please", clientId: crypto.randomUUID() } });
  assert.equal(sent.status, 201);
  assert.ok(await until(() => pushesTo(ben).length === 1));
  assert.equal(pushesTo(ben)[0].alert, "mention");
  assert.equal(pushesTo(ben)[0].url, `/team-messages/${chat}?stable=${stable}&m=${sent.data.message.id}`);
  assert.equal(pushesTo(ben)[0].stableId, stable);
  // Leaving the stable hides its alerts.
  await db.query("delete from stable_memberships where stable_id = $1 and user_id = $2", [stable, ben]);
  r = await call(ben, "/api/notifications/alerts");
  assert.ok(r.data.items.every((a) => a.chatKind !== "team"));
});
