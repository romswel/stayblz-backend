// Stayblz Chat, live (lib/chatLive.ts + routes/chat.ts + /unread): an open chat's long-poll answers as soon as
// something changes (message, Seen, Delivered, typing), the site-wide poll wakes when something reaches you,
// Online / Away / Offline presence, People contacts, "@everyone" (202611210001_chat_everyone.sql), GIF search
// (GIPHY stubbed — tests never reach it) and plain-text alert words.
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
const { chatStorage } = require("../dist/lib/chatStorage");
const { r2Storage } = require("../dist/lib/r2Storage");
const presence = require("../dist/lib/presence");
const live = require("../dist/lib/chatLive");
const gifs = require("../dist/lib/gifs");
const { plainMessage, messageSummary } = require("../dist/lib/push");
r2Storage.isConfigured = () => false;

const ann = "a1111111-1111-4111-8111-111111111111",
  ben = "b2222222-2222-4222-8222-222222222222",
  cat = "c3333333-3333-4333-8333-333333333333",
  dan = "d4444444-4444-4444-8444-444444444444",
  eve = "e5555555-5555-4555-8555-555555555555";
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Bishop"], [cat]: ["Cat", "Carter"], [dan]: ["Dan", "Dale"], [eve]: ["Eve", "Ember"] };
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
  chatStorage.upload = async () => undefined;
  chatStorage.download = async () => Buffer.alloc(0);
  chatStorage.remove = async () => undefined;
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  for (const token of tokens.values()) auth.destroySession(token);
  live.resetChatLive();
  gifs.setGifFetch(null);
  delete process.env.GIPHY_API_KEY;
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(user, path, { body } = {}) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens.get(user), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
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
const timed = async (promise) => {
  const start = Date.now();
  const result = await promise;
  return { ...result, ms: Date.now() - start };
};

let annBen, group;

test("set up: Ann is friends with Ben and Cat, a group of three, and a chat with Dan", async () => {
  for (const other of [ben, cat]) {
    await call(ann, `/api/messages/people/friends/${other}/request`, { body: {} });
    await call(other, `/api/messages/people/friends/${ann}/request`, { body: {} });
  }
  annBen = (await call(ann, `/api/messages/people/${ben}/chat`, { body: {} })).data.conversation.id;
  group = (await call(ann, "/api/messages", { body: { title: "Syndicate" } })).data.conversation.id;
  assert.equal((await call(ann, `/api/messages/${group}/members`, { body: { ids: [ben, cat] } })).status, 200);
  // Dan writes to Ann first (a message request Ann hasn't accepted) — he isn't one of Ann's contacts yet.
  const danChat = (await call(dan, `/api/messages/people/${ann}/chat`, { body: {} })).data.conversation.id;
  await say(dan, danChat, "Hi Ann, about the filly");
});

test("an open chat's long-poll answers the moment a message arrives, with the new message", async () => {
  const opened = await call(ben, `/api/messages/${annBen}`);
  assert.equal(typeof opened.data.v, "number");
  const since = opened.data.now;
  const pending = timed(call(ben, `/api/messages/${annBen}/updates?since=${encodeURIComponent(since)}&v=${opened.data.v}&wait=8`));
  await wait(150);
  await say(ann, annBen, "Gallops at six");
  const answer = await pending;
  assert.equal(answer.status, 200);
  assert.ok(answer.ms < 3000, `answered after ${answer.ms} ms`);
  assert.ok(answer.data.conversation.messages.some((m) => m.body === "Gallops at six"));
  assert.ok(answer.data.v > opened.data.v);
});

test("with nothing new it waits the full time; a stale or missing version answers at once", async () => {
  const opened = await call(ben, `/api/messages/${annBen}`);
  const since = encodeURIComponent(opened.data.now);
  const quiet = await timed(call(ben, `/api/messages/${annBen}/updates?since=${since}&v=${opened.data.v}&wait=1`));
  assert.ok(quiet.ms >= 900, `answered after ${quiet.ms} ms`);
  assert.equal(quiet.status, 200);
  const stale = await timed(call(ben, `/api/messages/${annBen}/updates?since=${since}&v=999999&wait=8`));
  assert.ok(stale.ms < 1500);
  const old = await timed(call(ben, `/api/messages/${annBen}/updates?since=${since}`));
  assert.ok(old.ms < 1500);
  assert.equal((await call(ben, `/api/messages/${annBen}/updates?since=yesterday&v=1&wait=5`)).status, 400);
});

test("people who never opened a chat can't wait on it (and still can't read it)", async () => {
  const r = await timed(call(eve, `/api/messages/${annBen}/updates?since=${encodeURIComponent(new Date().toISOString())}&v=0&wait=8`));
  assert.equal(r.status, 404);
  assert.ok(r.ms < 1500);
});

test("Seen and typing wake the other person's open chat straight away", async () => {
  const opened = await call(ann, `/api/messages/${annBen}`);
  let pending = timed(call(ann, `/api/messages/${annBen}/updates?since=${encodeURIComponent(opened.data.now)}&v=${opened.data.v}&wait=8`));
  await wait(150);
  await call(ben, `/api/messages/${annBen}/read`, { body: {} });
  let answer = await pending;
  assert.ok(answer.ms < 3000);
  assert.ok(answer.data.conversation.reads.some((r) => r.id === ben));

  pending = timed(call(ann, `/api/messages/${annBen}/updates?since=${encodeURIComponent(answer.data.now)}&v=${answer.data.v}&wait=8`));
  await wait(150);
  await call(ben, `/api/messages/${annBen}/typing`, { body: { on: true } });
  answer = await pending;
  assert.ok(answer.ms < 3000);
  assert.deepEqual(answer.data.conversation.typing, ["Ben Bishop"]);
});

test("the site-wide poll wakes when a message reaches you, and marking it delivered wakes the sender's chat", async () => {
  const first = await call(ben, `/api/messages/unread?since=${encodeURIComponent(new Date().toISOString())}`);
  assert.equal(typeof first.data.uv, "number");
  const annOpen = await call(ann, `/api/messages/${annBen}`);
  const benPoll = timed(call(ben, `/api/messages/unread?since=${encodeURIComponent(first.data.now)}&uv=${first.data.uv}&wait=8`));
  const annWait = timed(call(ann, `/api/messages/${annBen}/updates?since=${encodeURIComponent(annOpen.data.now)}&v=${annOpen.data.v}&wait=8`));
  await wait(150);
  await say(ann, annBen, "Trailer's here");
  const polled = await benPoll;
  assert.ok(polled.ms < 3000, `badge poll answered after ${polled.ms} ms`);
  assert.ok(polled.data.personal >= 1);
  assert.ok(polled.data.alerts.some((a) => a.chatId === annBen && a.body === "Trailer's here"));
  // Ann's own send wakes her chat too; the next wait picks up "Delivered" from Ben's poll.
  let answer = await annWait;
  if (!answer.data.conversation.delivered.some((d) => d.id === ben)) {
    answer = await call(ann, `/api/messages/${annBen}/updates?since=${encodeURIComponent(annOpen.data.now)}`);
  }
  assert.ok(answer.data.conversation.delivered.some((d) => d.id === ben));
});

test("reading a chat wakes your own badge poll at once (the red dot never waits out the 15 s)", async () => {
  await say(ann, annBen, "Saddle's ready");
  const first = await call(ben, `/api/messages/unread?since=${encodeURIComponent(new Date().toISOString())}`);
  const unreadBefore = first.data.personal;
  assert.ok(unreadBefore >= 1);
  const benPoll = timed(call(ben, `/api/messages/unread?since=${encodeURIComponent(first.data.now)}&uv=${first.data.uv}&wait=8`));
  await wait(150);
  assert.equal((await call(ben, `/api/messages/${annBen}/read`, { body: {} })).status, 200);
  const answer = await benPoll;
  assert.ok(answer.ms < 3000, `badge poll answered after ${answer.ms} ms`);
  assert.equal(answer.data.personal, unreadBefore - 1);

  // Muting (or marking unread) changes the badge too: that wakes it as well.
  const again = await call(ben, `/api/messages/unread?since=${encodeURIComponent(answer.data.now)}`);
  const mutePoll = timed(call(ben, `/api/messages/unread?since=${encodeURIComponent(again.data.now)}&uv=${again.data.uv}&wait=8`));
  await wait(150);
  assert.equal((await call(ben, `/api/messages/${annBen}/settings`, { body: { unread: true } })).status, 200);
  const marked = await mutePoll;
  assert.ok(marked.ms < 3000, `badge poll answered after ${marked.ms} ms`);
  assert.equal(marked.data.personal, unreadBefore);
  await call(ben, `/api/messages/${annBen}/settings`, { body: { unread: false } });
});

test("the chat list shows the latest reaction until a newer message; taking it back or unsending clears it", async () => {
  const row = async (who) => (await call(who, "/api/messages")).data.conversations.find((c) => c.id === annBen);
  const react = (who, id, emoji) => call(who, `/api/messages/${annBen}/messages/${id}/react`, { body: { emoji } });
  const benSaid = (await say(ben, annBen, "**Bolt** looks sharp")).data.message;
  assert.equal((await row(ann)).lastReaction, null);

  assert.equal((await react(ann, benSaid.id, "❤️")).status, 200);
  const mine = (await row(ann)).lastReaction;
  assert.equal(mine.emoji, "❤️");
  assert.equal(mine.mine, true);
  assert.equal(mine.toMe, false);
  assert.equal(mine.body, "**Bolt** looks sharp");
  assert.equal(mine.message, benSaid.id);
  const theirs = (await row(ben)).lastReaction;
  assert.equal(theirs.mine, false);
  assert.equal(theirs.toMe, true);
  assert.equal(theirs.byName, "Ann Archer");
  // A reaction doesn't make the chat unread or change the last message.
  assert.equal((await row(ann)).lastMessage, "**Bolt** looks sharp");
  // The open chat carries it too (its header is the same preview).
  assert.equal((await call(ann, `/api/messages/${annBen}`)).data.conversation.lastReaction.emoji, "❤️");

  // Taking it back clears it.
  await react(ann, benSaid.id, "❤️");
  assert.equal((await row(ann)).lastReaction, null);
  // A newer message wins.
  await react(ann, benSaid.id, "👍");
  assert.equal((await row(ben)).lastReaction.emoji, "👍");
  await say(ben, annBen, "Thanks");
  assert.equal((await row(ben)).lastReaction, null);
  // The line reads the message as it is now: an edit shows its new words.
  const second = (await say(ben, annBen, "Meet at barn 4, code 1234")).data.message;
  await react(ann, second.id, "😮");
  assert.equal((await row(ann)).lastReaction.body, "Meet at barn 4, code 1234");
  assert.equal((await call(ben, `/api/messages/${annBen}/messages/${second.id}/edit`, { body: { body: "Meet at barn 4" } })).status, 200);
  assert.equal((await row(ann)).lastReaction.body, "Meet at barn 4");
  // Unsending the reacted message drops the line, so its words don't linger in the list.
  assert.equal((await call(ben, `/api/messages/${annBen}/messages/${second.id}/unsend`, { body: {} })).status, 200);
  assert.equal((await row(ann)).lastReaction, null);
  // A long message comes whole, so a spoiler near the end stays hidden in the list's plain words.
  const tip = "Tip for Saturday: ||Bolt wins the 3:15 at Ascot by three lengths, the yard has been keeping it quiet all week so please don't tell anyone||";
  const third = (await say(ben, annBen, tip)).data.message;
  await react(ann, third.id, "🤫");
  const body = (await row(ann)).lastReaction.body;
  assert.equal(body, tip);
  assert.equal(plainMessage(body), "Tip for Saturday: (spoiler)");
});

test("an opened chat says when you last read it (readAt), so the app can open at your first unread message", async () => {
  await call(ben, `/api/messages/${annBen}/read`, { body: {} });
  const read = (await call(ben, `/api/messages/${annBen}`)).data.conversation.readAt;
  assert.equal(typeof read, "string");
  await say(ann, annBen, "Are you coming?");
  const opened = (await call(ben, `/api/messages/${annBen}`)).data.conversation;
  assert.equal(opened.readAt, read);
  assert.equal(opened.unread, true);
  const unreadOnes = opened.messages.filter((m) => !m.mine && Date.parse(m.sentAt) > Date.parse(opened.readAt));
  assert.deepEqual(unreadOnes.map((m) => m.body), ["Are you coming?"]);
});

test("presence: online when using Stayblz, away when idle, offline after a few quiet minutes", async () => {
  presence.resetPresence();
  await call(cat, `/api/messages/unread?presence=active`);
  let list = (await call(ann, `/api/messages/${group}`)).data.conversation.members;
  assert.equal(list.find((m) => m.id === cat).presence, "online");
  assert.equal(list.find((m) => m.id === cat).active, true);
  assert.equal(list.find((m) => m.id === ben).presence, "offline");
  assert.equal(list.find((m) => m.me).presence, null);

  await call(cat, `/api/messages/unread?presence=idle`);
  // Still within a minute of being active: online (no blink when one poll says idle).
  assert.equal(presence.presenceOf(cat), "online");
  const now = Date.now();
  assert.equal(presence.presenceOf(cat, now + 80_000), "away");
  assert.equal(presence.presenceOf(cat, now + 7 * 60_000), "offline");

  // One-to-one chat list rows carry it too; hiding your activity hides it both ways.
  await call(ben, `/api/messages/unread`);
  let rows = (await call(ann, "/api/messages")).data.conversations;
  assert.equal(rows.find((c) => c.id === annBen).presence, "online");
  await call(ben, "/api/messages/people/profile", { body: { showActive: false } });
  rows = (await call(ann, "/api/messages")).data.conversations;
  assert.equal(rows.find((c) => c.id === annBen).presence, null);
  assert.equal(rows.find((c) => c.id === annBen).active, false);
  await call(ben, "/api/messages/people/profile", { body: { showActive: true } });
});

test("People contacts: friends first, then people from your chats; no unaccepted requests or blocked people", async () => {
  // Eve joins the group through Ann, so she's someone Ann shares a chat with (not a friend).
  assert.equal((await call(ann, `/api/messages/${group}/members`, { body: { ids: [eve] } })).status, 200);
  let r = await call(ann, "/api/messages/people/contacts");
  assert.equal(r.status, 200);
  const names = r.data.people.map((p) => p.name);
  assert.deepEqual(names.slice(0, 2).sort(), ["Ben Bishop", "Cat Carter"]);
  assert.ok(r.data.people.slice(0, 2).every((p) => p.status === "friends"));
  const eveRow = r.data.people.find((p) => p.id === eve);
  assert.equal(eveRow.status, "none");
  assert.equal(eveRow.sharedChats, 1);
  assert.ok(["online", "away", "offline"].includes(eveRow.presence));
  assert.ok(!names.includes("Dan Dale"), "a request Ann hasn't accepted isn't a contact");
  assert.equal(r.data.people.find((p) => p.id === ben).sharedChats, 2);

  await call(eve, `/api/messages/people/blocks/${ann}`, { body: { block: true } });
  r = await call(ann, "/api/messages/people/contacts");
  assert.ok(!r.data.people.some((p) => p.id === eve), "blocked either way: not listed");
  await call(eve, `/api/messages/people/blocks/${ann}`, { body: { block: false } });
});

test("@everyone in a group mentions every member; an email address doesn't", async () => {
  const before = (await db.query("select count(*)::int as n from chat_alerts where kind = 'mention'")).rows[0].n;
  await say(ann, group, "@everyone vet at noon");
  await wait(150);
  const rows = (await db.query("select user_id from chat_alerts where kind = 'mention' order by created_at")).rows;
  assert.equal(rows.length - before, 3); // Ben, Cat and Eve; never the sender
  assert.ok(!rows.some((r) => r.user_id === ann));
  const check = (body) => db.query("select public.chat_mentions_name($1, 'Zed Zulu') as m", [body]).then((r) => r.rows[0].m);
  assert.equal(await check("@EVERYONE look"), true);
  assert.equal(await check("mail me at bob@everyone.com"), false);
  assert.equal(await check("@everyones"), false);
  assert.equal(await check("@highlight big news"), false);
});

test("alert words drop chat formatting, spoilers and @highlight; a lone GIF link reads GIF", () => {
  assert.equal(plainMessage("**Big** _news_ ~~maybe~~ `code`"), "Big news maybe code");
  assert.equal(plainMessage("@highlight Race day moved"), "Race day moved");
  assert.equal(plainMessage("Winner is ||Bolt||"), "Winner is (spoiler)");
  assert.equal(plainMessage("> quoted\n- one\n2. two"), "quoted\none\ntwo");
  assert.equal(plainMessage("https://media2.giphy.com/media/abc/giphy.gif?cid=1"), "GIF");
  assert.equal(messageSummary({ body: "snake_case_name stays" }), "snake_case_name stays");
});

// Same examples as the frontend's tests/chat-format.spec.ts: lib/chatFormat.ts is an identical copy of the
// frontend's, so a push notification reads exactly like the chat list.
test("alert words: symbols that aren't formatting stay as typed, never blank; phone-style marks still format", () => {
  const same = ["****", "***", "*****", "~~~~", "||||", "```", "````", ">", "2*3*4", "5 * 3 * 2", "pass: ****", "** spaced **", "snake_case_name"];
  for (const text of same) assert.equal(plainMessage(text), text, JSON.stringify(text));
  assert.equal(plainMessage("**hello **"), "hello"); // a phone keyboard's space after a suggested word
  assert.equal(plainMessage("*hello *"), "hello");
  assert.equal(plainMessage("***bold italic***"), "bold italic");
  assert.equal(plainMessage("**https://x.com/a**"), "https://x.com/a");
  assert.equal(plainMessage("```js\nconst a = 1\n```"), "const a = 1");
  assert.equal(plainMessage("```hello world\nmore\n```"), "hello world\nmore");
  assert.equal(plainMessage("x**2 + y**2"), "x2 + y2");
  assert.equal(plainMessage("/me waves"), "waves");
  assert.equal(messageSummary({ body: "****" }), "****");
  assert.equal(messageSummary({ body: "> \n" }), ">");
  // Alert texts are squeezed onto one line: a code block's language name isn't part of the message.
  assert.equal(plainMessage("```js const a = 1 ```"), "const a = 1");
  // Never blank, even for a message that is only "@highlight".
  assert.equal(plainMessage("@highlight"), "@highlight");
  // A link that ends in "_" keeps it; marks around a link are formatting.
  assert.equal(plainMessage("see https://x.com/report_ ok"), "see https://x.com/report_ ok");
  assert.equal(plainMessage("_https://x.com/a_"), "https://x.com/a");
});

test("GIF search: hidden without a key; with one it returns GIPHY media only, and pages", async () => {
  let r = await call(ann, "/api/gifs?q=horse");
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, false);
  const asked = [];
  gifs.setGifFetch(async (url) => {
    asked.push(url);
    return new Response(
      JSON.stringify({
        data: [
          { id: "g1", title: "Horse run", images: { downsized: { url: "https://media1.giphy.com/media/g1/giphy.gif", width: "320", height: "180" }, fixed_height_small: { url: "https://media1.giphy.com/media/g1/100.gif", webp: "https://media1.giphy.com/media/g1/100.webp" } } },
          { id: "bad", title: "Elsewhere", images: { downsized: { url: "https://evil.example/x.gif" } } },
        ],
        pagination: { total_count: 50, count: 2, offset: 0 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  process.env.GIPHY_API_KEY = "test-key";
  r = await call(ann, "/api/gifs?q=horse");
  assert.equal(r.data.enabled, true);
  assert.deepEqual(r.data.results, [
    { id: "g1", title: "Horse run", url: "https://media1.giphy.com/media/g1/giphy.gif", preview: "https://media1.giphy.com/media/g1/100.webp", width: 320, height: 180 },
  ]);
  assert.equal(r.data.next, 2);
  assert.match(asked[0], /\/search\?/);
  assert.match(asked[0], /rating=pg/);
  r = await call(ann, "/api/gifs");
  assert.match(asked[1], /\/trending\?/);
  assert.equal((await fetch(origin + "/api/gifs?q=x")).status, 401);
});
