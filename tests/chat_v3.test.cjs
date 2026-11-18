// Stayblz Chat v3 + notifications: timed mute, who reacted, preview sender names, voice clips, links,
// the incoming-message feed behind on-screen alerts, notification settings and Web Push (sender stubbed).
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
// Whether R2 "is set up" is decided per test (a developer's .env may have R2 keys).
let r2On = false;
r2Storage.isConfigured = () => r2On;
// Loading the app reads a developer's .env; these tests decide for themselves whether push keys exist.
delete process.env.PUSH_VAPID_PUBLIC_KEY;
delete process.env.PUSH_VAPID_PRIVATE_KEY;

const ann = "a1111111-1111-4111-8111-111111111111",
  ben = "b2222222-2222-4222-8222-222222222222",
  cat = "c3333333-3333-4333-8333-333333333333";
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Bishop"], [cat]: ["Cat", "Carter"] };
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
  push.pushSender.send = async (target, payload) => {
    if (target.endpoint.includes("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
    pushed.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
  };
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(user, path, { body, raw, type } = {}) {
  const response = await fetch(origin + path, {
    method: body || raw ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens.get(user), "Content-Type": raw ? type : "application/json" },
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
const say = (user, id, body) => call(user, `/api/messages/${id}/messages`, { body: { body, clientId: crypto.randomUUID() } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await wait(20);
  }
  return check();
}

let annBen, group;

test("set up: friends chat and a group", async () => {
  await call(ann, `/api/messages/people/friends/${ben}/request`, { body: {} });
  await call(ben, `/api/messages/people/friends/${ann}/request`, { body: {} });
  annBen = (await call(ann, `/api/messages/people/${ben}/chat`, { body: {} })).data.conversation.id;
  group = (await call(ann, "/api/messages", { body: { title: "Syndicate" } })).data.conversation.id;
  assert.equal((await call(ann, `/api/messages/${group}/members`, { body: { ids: [ben, cat] } })).status, 200);
});

test("previews name the last sender and list the other members' ids", async () => {
  assert.equal((await say(ben, group, "Who's driving?")).status, 201);
  const list = (await call(ann, "/api/messages")).data.conversations;
  const g = list.find((c) => c.id === group);
  assert.equal(g.lastSenderName, "Ben Bishop");
  assert.equal(g.lastSenderId, ben);
  assert.deepEqual([...g.participantIds].sort(), [ben, cat].sort());
  const d = list.find((c) => c.id === annBen);
  assert.deepEqual(d.participantIds, [ben]);
});

test("reactions say who reacted", async () => {
  const sent = (await say(ann, annBen, "Gallops at six?")).data.message;
  await call(ben, `/api/messages/${annBen}/messages/${sent.id}/react`, { body: { emoji: "❤️" } });
  const r = await call(ann, `/api/messages/${annBen}/messages/${sent.id}/react`, { body: { emoji: "❤️" } });
  assert.deepEqual(r.data.message.reactions, [{ emoji: "❤️", count: 2, mine: true, ids: [ann, ben].sort() }]);
});

test("mute for a while: muted until a time, out of the badge, and plain 'muted' clears the timer", async () => {
  assert.equal((await call(ann, `/api/messages/${group}/settings`, { body: { muteMinutes: 0 } })).status, 400);
  assert.equal((await call(ann, `/api/messages/${group}/settings`, { body: { muteMinutes: 60, muted: true } })).status, 400);
  const before = (await call(ann, "/api/messages/unread")).data.personal;
  let r = await call(ann, `/api/messages/${group}/settings`, { body: { muteMinutes: 60 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.settings.muted, true);
  const until = Date.parse(r.data.settings.mutedUntil);
  assert.ok(until > Date.now() + 59 * 60_000 && until < Date.now() + 61 * 60_000);
  const g = (await call(ann, "/api/messages")).data.conversations.find((c) => c.id === group);
  assert.equal(g.muted, true);
  assert.ok(g.mutedUntil);
  assert.equal((await call(ann, "/api/messages/unread")).data.personal, before - 1);
  // A timer that has run out no longer mutes.
  await db.query("update chat_settings set muted_until = now() - interval '1 minute' where user_id = $1 and conversation_id = $2", [ann, group]);
  assert.equal((await call(ann, "/api/messages")).data.conversations.find((c) => c.id === group).muted, false);
  r = await call(ann, `/api/messages/${group}/settings`, { body: { muted: true } });
  assert.equal(r.data.settings.muted, true);
  assert.equal(r.data.settings.mutedUntil, null);
  r = await call(ann, `/api/messages/${group}/settings`, { body: { muted: false } });
  assert.equal(r.data.settings.muted, false);
});

test("voice clips: real audio is accepted with its length; a fake one isn't", async () => {
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(400, 1)]);
  let r = await call(ann, `/api/messages/${annBen}/attachments?clientId=${crypto.randomUUID()}&name=voice.webm&duration=7`, {
    raw: webm,
    type: "audio/webm;codecs=opus",
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.message.attachment, { name: "voice.webm", size: 404, type: "audio/webm", duration: 7 });
  const list = (await call(ben, "/api/messages")).data.conversations;
  assert.equal(list.find((c) => c.id === annBen).lastMessage, "🎤 Voice message");
  r = await call(ann, `/api/messages/${annBen}/attachments?clientId=${crypto.randomUUID()}&name=voice.webm`, {
    raw: Buffer.from("not audio at all, just text"),
    type: "audio/webm",
  });
  assert.equal(r.status, 415);
  // Safari records MP4.
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(300, 2)]);
  r = await call(ann, `/api/messages/${annBen}/attachments?clientId=${crypto.randomUUID()}&name=voice.m4a&duration=999`, {
    raw: mp4,
    type: "audio/mp4",
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.message.attachment.duration, undefined);
});

test("videos and file limits follow where files are stored: 4 MB on Supabase, 25 MB on R2", async () => {
  const mp4 = (bytes) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(bytes, 3)]);
  const send = (file, name = "clip.mp4", type = "video/mp4", extra = "") =>
    call(ann, `/api/messages/${annBen}/attachments?clientId=${crypto.randomUUID()}&name=${name}${extra}`, { raw: file, type });
  r2On = false;
  let r = await call(ann, "/api/messages/people/profile");
  assert.deepEqual(r.data.limits, { storage: "supabase", fileBytes: 4 * 1024 * 1024, quotaBytes: 50 * 1024 * 1024 });
  r = await send(mp4(2000), "clip.mp4", "video/mp4", "&duration=95");
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.message.attachment, { name: "clip.mp4", size: 2012, type: "video/mp4", duration: 95 });
  assert.equal((await call(ben, "/api/messages")).data.conversations.find((c) => c.id === annBen).lastMessage, "🎬 Video");
  r = await send(mp4(5 * 1024 * 1024));
  assert.equal(r.status, 413);
  assert.match(r.data.error, /4 MB/);
  // iPhone videos are QuickTime.
  assert.equal((await send(mp4(500), "IMG_0001.MOV", "video/quicktime")).status, 201);
  assert.equal((await send(Buffer.from("definitely not a video file"), "x.mp4")).status, 415);

  r2On = true;
  try {
    r = await call(ann, "/api/messages/people/profile");
    assert.deepEqual(r.data.limits, { storage: "r2", fileBytes: 25 * 1024 * 1024, quotaBytes: 500 * 1024 * 1024 });
    assert.equal((await send(mp4(5 * 1024 * 1024))).status, 201);
    assert.equal((await send(mp4(26 * 1024 * 1024))).status, 413);
  } finally {
    r2On = false;
  }
});

test("group photo: members change and remove it, only members can see it, files are cleaned up", async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 9)]);
  const setPhoto = (user, id, file = png, type = "image/png") => call(user, `/api/messages/${id}/photo`, { raw: file, type });
  assert.equal((await setPhoto(ben, annBen)).status, 400); // not a group
  assert.equal((await setPhoto(ben, group, Buffer.from("<svg/>"), "image/svg+xml")).status, 415);
  let r = await setPhoto(ben, group);
  assert.equal(r.status, 201);
  const version = r.data.photo;
  const g = (await call(ann, "/api/messages")).data.conversations.find((c) => c.id === group);
  assert.equal(g.photo, version);
  assert.equal(g.lastMessage, "Ben Bishop changed the group photo");
  const path = [...stored.keys()].find((k) => k.endsWith(version));
  assert.match(path, new RegExp(`^group-photos/personal/${group}/`));
  r = await fetch(`${origin}/api/messages/${group}/photo/${version}`, { headers: { Authorization: "Bearer " + tokens.get(cat) } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  // A stranger (not in the group) can't see it.
  await db.query("insert into auth.users(id,email) values($1,'dan@example.test')", ["d4444444-4444-4444-8444-444444444444"]);
  await db.query("update accounts set email='dan@example.test', first_name='Dan', last_name='Doe' where id=$1", ["d4444444-4444-4444-8444-444444444444"]);
  tokens.set("dan", auth.createSession({ id: "d4444444-4444-4444-8444-444444444444", username: "dan", displayName: "Dan Doe", role: "member", email: "dan@example.test" }));
  assert.equal((await call("dan", `/api/messages/${group}/photo/${version}`)).status, 404);
  // Replacing deletes the old file; removing clears it.
  r = await setPhoto(ann, group);
  assert.equal(stored.has(path), false);
  r = await call(ann, `/api/messages/${group}/photo/remove`, { body: {} });
  assert.equal(r.data.photo, null);
  assert.equal([...stored.keys()].some((k) => k.startsWith(`group-photos/personal/${group}/`)), false);
  assert.equal((await call(ann, "/api/messages")).data.conversations.find((c) => c.id === group).photo, null);
});

test("links: messages with web links, newest first, members only", async () => {
  await say(ben, annBen, "Card is up: https://stayblz-app.com/entries and more");
  await say(ben, annBen, "no link here");
  const r = await call(ann, `/api/messages/${annBen}/links`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.messages.map((m) => m.body), ["Card is up: https://stayblz-app.com/entries and more"]);
  assert.equal((await call(cat, `/api/messages/${annBen}/links`)).status, 404);
});

test("incoming feed: newest unread per chat since a time, skipping muted chats, flagging requests", async () => {
  let r = await call(ben, "/api/messages/unread?since=" + encodeURIComponent(new Date().toISOString()));
  assert.ok(r.data.now);
  const since = r.data.now;
  await wait(10);
  await say(ann, annBen, "Track is fast today");
  await say(cat, group, "I'll drive");
  // A stranger's first message arrives as a request.
  const req = (await call(cat, `/api/messages/people/${ben}/chat`, { body: {} })).data.conversation.id;
  await say(cat, req, "Is your filly for sale?");
  r = await call(ben, "/api/messages/unread?since=" + encodeURIComponent(since));
  const byChat = Object.fromEntries(r.data.incoming.map((i) => [i.chatId, i]));
  assert.equal(byChat[annBen].body, "Track is fast today");
  assert.equal(byChat[annBen].from, "Ann Archer");
  assert.equal(byChat[annBen].group, false);
  assert.equal(byChat[group].title, "Syndicate");
  assert.equal(byChat[group].from, "Cat Carter");
  assert.equal(byChat[req].request, true);
  // Muted: no alert. Read: no alert.
  await call(ben, `/api/messages/${group}/settings`, { body: { muteMinutes: 15 } });
  await call(ben, `/api/messages/${annBen}/read`, { body: {} });
  r = await call(ben, "/api/messages/unread?since=" + encodeURIComponent(since));
  assert.deepEqual(r.data.incoming.map((i) => i.chatId), [req]);
  // Bad times are ignored safely; no `since` keeps the old shape.
  assert.deepEqual((await call(ben, "/api/messages/unread?since=yesterday")).data.incoming, []);
  assert.equal("incoming" in (await call(ben, "/api/messages/unread")).data, false);
  await call(ben, `/api/messages/${group}/settings`, { body: { muted: false } });
});

test("notification settings: off by default, saved per account, checked input", async () => {
  let r = await call(ann, "/api/notifications/settings");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.settings, {
    enabled: false,
    chatMessages: true,
    chatRequests: true,
    chatMentions: true,
    chatReactions: true,
    paddockCalls: true,
    previews: true,
    sound: true,
    promptedAt: null,
    devices: 0,
  });
  assert.deepEqual(r.data.push, { available: false, publicKey: null });
  r = await call(ann, "/api/notifications/settings", { body: { enabled: true, previews: false, prompted: true } });
  assert.equal(r.data.settings.enabled, true);
  assert.equal(r.data.settings.previews, false);
  assert.ok(r.data.settings.promptedAt);
  assert.equal((await call(ann, "/api/notifications/settings", { body: { enabled: "yes" } })).status, 400);
  assert.equal((await call(ann, "/api/notifications/settings", { body: { admin: true } })).status, 400);
  assert.equal((await call(ann, "/api/notifications/settings", { body: {} })).status, 400);
  // Without server keys, push says so honestly.
  const sub = { endpoint: "https://push.example.test/ann-1", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } };
  r = await call(ann, "/api/notifications/push/subscribe", { body: sub });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "push_unavailable");
});

test("web push: alerts the right devices with the right words, respects mute/off/previews, drops gone devices", async () => {
  const keys = webpush.generateVAPIDKeys();
  process.env.PUSH_VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.PUSH_VAPID_PRIVATE_KEY = keys.privateKey;
  push.resetPush();
  try {
    const info = (await call(ben, "/api/notifications/settings")).data.push;
    assert.deepEqual(info, { available: true, publicKey: keys.publicKey });
    const sub = (user, name) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } });
    // Only the browsers' push services: never an internal or arbitrary address (the server POSTs to it).
    for (const endpoint of ["http://fcm.googleapis.com/fcm/send/x1", "https://169.254.169.254/latest/meta-data", "https://evil.example.com/fcm.googleapis.com", "https://fcm.googleapis.com.evil.test/x", "https://fcm.googleapis.com:8443/fcm/send/x"])
      assert.equal((await call(ben, "/api/notifications/push/subscribe", { body: { endpoint, keys: sub().keys } })).status, 400, endpoint);
    assert.equal((await call(ben, "/api/notifications/push/subscribe", { body: { endpoint: "https://wns2-par02p.notify.windows.com/w/?token=abc", keys: sub().keys } })).status, 201);
    await call(ben, "/api/notifications/push/unsubscribe", { body: { endpoint: "https://wns2-par02p.notify.windows.com/w/?token=abc" } });
    assert.equal((await call(ben, "/api/notifications/push/subscribe", { body: sub(ben, "ben-phone") })).status, 201);
    assert.equal((await call(cat, "/api/notifications/push/subscribe", { body: sub(cat, "cat-gone") })).status, 201);
    await call(ben, "/api/notifications/settings", { body: { enabled: true } });
    await call(cat, "/api/notifications/settings", { body: { enabled: true } });

    // Direct message to Ben: one alert, the message text, a link to the chat.
    pushed.length = 0;
    await say(ann, annBen, "Saddle up");
    assert.ok(await until(() => pushed.length === 1));
    assert.equal(pushed[0].endpoint, "https://fcm.googleapis.com/fcm/send/ben-phone");
    const { alertId, ...words } = pushed[0].payload;
    assert.match(alertId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(words, { kind: "chat", alert: "message", tag: `chat-${annBen}`, url: `/messages/${annBen}`, title: "Ann Archer", body: "Saddle up" });

    // Group: title = group name, body = "Name: text"; Cat's dead subscription is removed.
    pushed.length = 0;
    push.resetPush();
    await say(ann, group, "Leaving at 5");
    assert.ok(await until(() => pushed.length === 1));
    await wait(50);
    assert.equal(pushed[0].payload.title, "Syndicate");
    assert.equal(pushed[0].payload.body, "Ann Archer: Leaving at 5");
    assert.equal((await db.query("select count(*)::int n from push_subscriptions where endpoint like '%cat-gone'")).rows[0].n, 0);

    // A burst in one chat doesn't buzz the phone for every message.
    pushed.length = 0;
    await say(ann, group, "and bring the boots");
    await wait(80);
    assert.equal(pushed.length, 0);

    // Muted chat, previews off, notifications off.
    push.resetPush();
    await call(ben, `/api/messages/${annBen}/settings`, { body: { muteMinutes: 30 } });
    await say(ann, annBen, "you there?");
    await wait(80);
    assert.equal(pushed.length, 0);
    await call(ben, `/api/messages/${annBen}/settings`, { body: { muted: false } });
    await call(ben, "/api/notifications/settings", { body: { previews: false } });
    await say(ann, annBen, "private plans");
    assert.ok(await until(() => pushed.length === 1));
    // Ben hasn't opened the chat since the earlier ones, so the alert counts them all (and shows no text).
    assert.match(pushed[0].payload.body, /^\d+ new messages$/);
    pushed.length = 0;
    push.resetPush();
    await call(ben, "/api/notifications/settings", { body: { enabled: false } });
    await say(ann, annBen, "hello?");
    await wait(80);
    assert.equal(pushed.length, 0);

    // Test alert goes to your own devices only.
    pushed.length = 0;
    const t = await call(ben, "/api/notifications/push/test", { body: {} });
    assert.equal(t.status, 200);
    assert.deepEqual(t.data, { available: true, sent: 1, devices: 1 });
    assert.equal(pushed[0].payload.kind, "test");
    // Unsubscribe.
    assert.equal((await call(ben, "/api/notifications/push/unsubscribe", { body: { endpoint: "https://fcm.googleapis.com/fcm/send/ben-phone" } })).status, 200);
    assert.equal((await call(ben, "/api/notifications/settings")).data.settings.devices, 0);
  } finally {
    delete process.env.PUSH_VAPID_PUBLIC_KEY;
    delete process.env.PUSH_VAPID_PRIVATE_KEY;
    push.resetPush();
  }
});

test("a device that moves to another account stops alerting the first one", async () => {
  const endpoint = "https://push.example.test/shared-laptop";
  await db.query("insert into push_subscriptions(user_id, endpoint, p256dh, auth) values($1,$2,$3,$4)", [ann, endpoint, "B".repeat(87), "a".repeat(22)]);
  await supabase.rpc("push_subscription_save", { p_user: ben, p_endpoint: endpoint, p_p256dh: "B".repeat(87), p_auth: "a".repeat(22), p_agent: "x" });
  const rows = (await db.query("select user_id from push_subscriptions where endpoint = $1", [endpoint])).rows;
  assert.deepEqual(rows.map((r) => r.user_id), [ben]);
});
