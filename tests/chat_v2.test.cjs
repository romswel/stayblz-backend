// Stayblz Chat v2: people search + privacy, friends, blocking, per-chat settings + folders, editing, pins,
// attachments (storage stubbed), forwarding, group admin + system lines, search, media, delivered, typing.
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

const ann = "a1111111-1111-4111-8111-111111111111",
  ben = "b2222222-2222-4222-8222-222222222222",
  cat = "c3333333-3333-4333-8333-333333333333",
  dan = "d4444444-4444-4444-8444-444444444444";
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Bishop"], [cat]: ["Cat", "Carter"], [dan]: ["Dan", "Archer"] };
const tokens = new Map();
const stored = new Map();
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
  chatStorage.download = async (path) => {
    if (!stored.has(path)) throw new Error("missing");
    return stored.get(path);
  };
  chatStorage.remove = async (paths) => paths.forEach((p) => stored.delete(p));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  for (const token of tokens.values()) auth.destroySession(token);
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
  const text = Buffer.from(await response.arrayBuffer());
  let data = null;
  try {
    data = JSON.parse(text.toString("utf8"));
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}
const say = (user, id, body, extra = {}) =>
  call(user, `/api/messages/${id}/messages`, { body: { body, clientId: crypto.randomUUID(), ...extra } });
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const upload = (user, id, file, name, type, clientId = crypto.randomUUID()) =>
  call(user, `/api/messages/${id}/attachments?clientId=${clientId}&name=${encodeURIComponent(name)}&width=640&height=480`, {
    raw: file,
    type,
  });

let annBen; // direct chat between friends
let group;

test("people search finds members by name, respects 'findable' and never shows emails", async () => {
  let r = await call(ann, "/api/messages/people/search?q=arch");
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.people.map((p) => p.name), ["Dan Archer"]);
  assert.equal(JSON.stringify(r.data).includes("@"), false);
  assert.equal((await call(ann, "/api/messages/people/search?q=a")).status, 400);
  // Wildcards are literal.
  assert.equal((await call(ann, "/api/messages/people/search?q=%25%25")).data.people.length, 0);

  r = await call(dan, "/api/messages/people/profile", { body: { discoverable: false } });
  assert.equal(r.data.profile.discoverable, false);
  assert.equal(r.data.profile.showActive, true);
  assert.deepEqual((await call(ann, "/api/messages/people/search?q=arch")).data.people, []);
  await call(dan, "/api/messages/people/profile", { body: { discoverable: true } });
});

test("friends: request, accept, and friends skip message requests", async () => {
  let r = await call(ann, `/api/messages/people/friends/${ben}/request`, { body: {} });
  assert.equal(r.data.status, "outgoing");
  r = await call(ben, "/api/messages/people/friends");
  assert.deepEqual(r.data.incoming.map((p) => p.name), ["Ann Archer"]);
  // Asking back accepts.
  r = await call(ben, `/api/messages/people/friends/${ann}/request`, { body: {} });
  assert.equal(r.data.status, "friends");
  assert.deepEqual((await call(ann, "/api/messages/people/friends")).data.friends.map((p) => p.name), ["Ben Bishop"]);

  r = await call(ann, `/api/messages/people/${ben}/chat`, { body: {} });
  assert.equal(r.status, 201);
  annBen = r.data.conversation.id;
  assert.equal(r.data.conversation.waiting, false);
  assert.equal(r.data.conversation.direct.friend, "friends");
  // A stranger still lands in Requests.
  r = await call(cat, `/api/messages/people/${ann}/chat`, { body: {} });
  assert.equal(r.data.conversation.waiting, true);
});

test("blocking stops messages and hides people from each other", async () => {
  const chat = (await call(cat, `/api/messages/people/${ben}/chat`, { body: {} })).data.conversation.id;
  assert.equal((await say(cat, chat, "hi")).status, 201);
  assert.equal((await call(ben, `/api/messages/people/blocks/${cat}`, { body: { block: true } })).status, 200);
  assert.equal((await say(cat, chat, "hello?")).data.code, "blocked");
  assert.equal((await call(cat, `/api/messages/people/${ben}/chat`, { body: {} })).status, 403);
  assert.deepEqual((await call(cat, "/api/messages/people/search?q=bishop")).data.people, []);
  assert.equal((await call(ben, `/api/messages/${chat}`)).data.conversation.direct.blockedByMe, true);
  assert.deepEqual((await call(ben, "/api/messages/people/blocks")).data.blocked.map((p) => p.name), ["Cat Carter"]);
  await call(ben, `/api/messages/people/blocks/${cat}`, { body: { block: false } });
  assert.equal((await say(cat, chat, "now?")).status, 201);
});

test("edit within 15 minutes, pin messages, and delivered → seen status", async () => {
  const sent = (await say(ann, annBen, "Gallops at 6")).data.message;
  assert.equal((await call(ann, "/api/messages")).data.conversations.find((c) => c.id === annBen).lastStatus, "sent");
  // Ben's badge poll marks it delivered.
  await call(ben, "/api/messages/unread");
  assert.equal((await call(ann, "/api/messages")).data.conversations.find((c) => c.id === annBen).lastStatus, "delivered");

  let r = await call(ann, `/api/messages/${annBen}/messages/${sent.id}/edit`, { body: { body: "Gallops at 6:30" } });
  assert.equal(r.data.message.body, "Gallops at 6:30");
  assert.equal(r.data.message.edited, true);
  assert.equal((await call(ben, `/api/messages/${annBen}/messages/${sent.id}/edit`, { body: { body: "no" } })).status, 404);
  await db.query("update personal_messages set sent_at = now() - interval '20 minutes' where id=$1", [sent.id]);
  assert.equal((await call(ann, `/api/messages/${annBen}/messages/${sent.id}/edit`, { body: { body: "late" } })).data.code, "edit_window");

  r = await call(ben, `/api/messages/${annBen}/messages/${sent.id}/pin`, { body: { pin: true } });
  assert.equal(r.data.message.pinned, true);
  r = await call(ann, `/api/messages/${annBen}`);
  assert.deepEqual(r.data.conversation.pinnedMessages.map((p) => p.body), ["Gallops at 6:30"]);

  const fresh = (await say(ann, annBen, "See you")).data.message;
  await call(ben, `/api/messages/${annBen}/read`, { body: {} });
  r = await call(ann, "/api/messages");
  assert.equal(r.data.conversations.find((c) => c.id === annBen).lastStatus, "seen");
  assert.ok(fresh.id);
});

test("your own chat settings: pin, mute (out of the badge), mark unread, archive, folders", async () => {
  await say(ben, annBen, "New reply");
  assert.equal((await call(ann, "/api/messages/unread")).data.personal, 1);
  let r = await call(ann, `/api/messages/${annBen}/settings`, { body: { muted: true, pinned: true } });
  assert.deepEqual([r.data.settings.muted, r.data.settings.pinned], [true, true]);
  assert.equal((await call(ann, "/api/messages/unread")).data.personal, 0);
  let row = (await call(ann, "/api/messages")).data.conversations.find((c) => c.id === annBen);
  assert.deepEqual([row.pinned, row.muted, row.unread], [true, true, true]);
  // Ben doesn't see Ann's settings.
  assert.equal((await call(ben, "/api/messages")).data.conversations.find((c) => c.id === annBen).pinned, false);

  await call(ann, `/api/messages/${annBen}/read`, { body: {} });
  await call(ann, `/api/messages/${annBen}/settings`, { body: { unread: true } });
  assert.equal((await call(ann, "/api/messages")).data.conversations.find((c) => c.id === annBen).unread, true);
  await call(ann, `/api/messages/${annBen}/read`, { body: {} });
  assert.equal((await call(ann, "/api/messages")).data.conversations.find((c) => c.id === annBen).unread, false);

  const folder = (await call(ann, "/api/messages/folders", { body: { name: "Syndicate" } })).data.folder;
  assert.equal((await call(ann, "/api/messages/folders", { body: { name: "syndicate" } })).status, 409);
  assert.equal((await call(ben, `/api/messages/${annBen}/settings`, { body: { folder: folder.id } })).data.code, "invalid_folder");
  await call(ann, `/api/messages/${annBen}/settings`, { body: { folder: folder.id, archived: true } });
  row = (await call(ann, "/api/messages")).data.conversations.find((c) => c.id === annBen);
  assert.deepEqual([row.folderId, row.archived], [folder.id, true]);
  // A new message brings an archived chat back.
  await say(ben, annBen, "Back again");
  assert.equal((await call(ann, "/api/messages")).data.conversations.find((c) => c.id === annBen).archived, false);
  await call(ann, `/api/messages/folders/${folder.id}/delete`, { body: {} });
  assert.equal((await call(ann, "/api/messages")).data.conversations.find((c) => c.id === annBen).folderId, null);
});

test("attachments: checked type, member-only download, quota, unsend deletes the file", async () => {
  let r = await upload(ann, annBen, png, "paddock.png", "image/png");
  assert.equal(r.status, 201);
  const photo = r.data.message;
  assert.equal(photo.attachment.name, "paddock.png");
  assert.equal(photo.attachment.width, 640);
  assert.equal(photo.attachment.path, undefined);
  assert.equal((await call(ann, "/api/messages")).data.conversations.find((c) => c.id === annBen).lastMessage, "📷 Photo");

  assert.equal((await upload(ann, annBen, Buffer.from("<svg/>"), "x.svg", "image/svg+xml")).status, 415);
  assert.equal((await upload(ann, annBen, Buffer.from("not a png"), "fake.png", "image/png")).status, 415);
  assert.equal((await upload(ann, annBen, Buffer.alloc(4 * 1024 * 1024 + 10, 1), "big.txt", "text/plain")).status, 413);
  assert.equal((await upload(cat, annBen, png, "x.png", "image/png")).status, 404);

  r = await call(ben, `/api/messages/${annBen}/files/${photo.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.match(r.headers.get("content-disposition"), /^inline/);
  assert.ok(Buffer.compare(r.data, png) === 0);
  assert.equal((await call(cat, `/api/messages/${annBen}/files/${photo.id}`)).status, 404);

  r = await upload(ann, annBen, Buffer.from("Odds,Horse\n3-1,Ridge\n"), "card.csv", "text/csv");
  const csv = r.data.message;
  assert.match((await call(ben, `/api/messages/${annBen}/files/${csv.id}`)).headers.get("content-disposition"), /^attachment/);
  assert.equal((await call(ann, `/api/messages/${annBen}/media`)).data.messages.length, 2);

  // A retry with the same client id doesn't store the file twice.
  const id = crypto.randomUUID();
  const first = await upload(ann, annBen, png, "again.png", "image/png", id);
  const count = stored.size;
  const second = await upload(ann, annBen, png, "again.png", "image/png", id);
  assert.equal(second.data.message.id, first.data.message.id);
  assert.equal(stored.size, count);

  // Quota: 50 MB per person.
  await db.query(
    "update personal_messages set attachment = jsonb_set(attachment, '{size}', '52428700') where id=$1",
    [first.data.message.id],
  );
  assert.equal((await upload(ann, annBen, png, "full.png", "image/png")).data.code, "quota");
  await db.query("update personal_messages set attachment = jsonb_set(attachment, '{size}', '208') where id=$1", [first.data.message.id]);

  const before = stored.size;
  await call(ann, `/api/messages/${annBen}/messages/${photo.id}/unsend`, { body: {} });
  assert.equal(stored.size, before - 1);
  assert.equal((await call(ben, `/api/messages/${annBen}/files/${photo.id}`)).status, 404);
});

test("forwarding shares the file; groups: add, rename, remove with system lines; search", async () => {
  let r = await call(ann, "/api/messages", { body: { title: "Saturday" } });
  group = r.data.conversation.id;
  r = await call(ann, `/api/messages/${group}/members`, { body: { ids: [ben, cat] } });
  assert.equal(r.data.added, 2);
  r = await call(ben, `/api/messages/${group}`);
  assert.equal(r.data.conversation.members.length, 3);
  assert.match(r.data.conversation.messages.at(-1).body, /Ann Archer added (Ben Bishop, Cat Carter|Cat Carter, Ben Bishop)/);
  assert.equal(r.data.conversation.messages.at(-1).system, true);

  const file = (await upload(ann, annBen, png, "form.png", "image/png")).data.message;
  r = await call(ann, `/api/messages/${annBen}/messages/${file.id}/forward`, { body: { to: [group] } });
  assert.deepEqual(r.data.results, [{ to: group, ok: true }]);
  const forwarded = (await call(cat, `/api/messages/${group}`)).data.conversation.messages.at(-1);
  assert.equal(forwarded.forwarded, true);
  assert.equal(forwarded.attachment.name, "form.png");
  assert.equal((await call(cat, `/api/messages/${group}/files/${forwarded.id}`)).status, 200);
  // Unsending the original keeps the forwarded copy's file.
  await call(ann, `/api/messages/${annBen}/messages/${file.id}/unsend`, { body: {} });
  assert.equal((await call(cat, `/api/messages/${group}/files/${forwarded.id}`)).status, 200);
  // Can't forward into a chat you're not in.
  r = await call(cat, `/api/messages/${group}/messages/${forwarded.id}/forward`, { body: { to: [annBen] } });
  assert.equal(r.data.results[0].ok, false);

  assert.equal((await call(ben, `/api/messages/${group}/rename`, { body: { title: "Saturday syndicate" } })).status, 200);
  assert.equal((await call(ann, `/api/messages/${group}`)).data.conversation.title, "Saturday syndicate");
  assert.equal((await call(ben, `/api/messages/${group}/members/${cat}/remove`, { body: {} })).data.code, "not_admin");
  assert.equal((await call(ann, `/api/messages/${group}/members/${cat}/remove`, { body: {} })).status, 200);
  assert.equal((await call(cat, `/api/messages/${group}`)).status, 404);

  await say(ben, group, "Ridge Runner looked sharp");
  r = await call(ann, `/api/messages/${group}/search?q=ridge`);
  assert.deepEqual(r.data.messages.map((m) => m.body), ["Ridge Runner looked sharp"]);
  assert.equal((await call(cat, `/api/messages/${group}/search?q=ridge`)).status, 404);
});

test("typing and active status live in memory and respect privacy", async () => {
  await call(ann, `/api/messages/${annBen}`);
  await call(ben, `/api/messages/${annBen}`);
  assert.deepEqual((await call(ann, `/api/messages/${annBen}/typing`, { body: { on: true } })).data, { ok: true });
  let r = await call(ben, `/api/messages/${annBen}/updates?since=${encodeURIComponent(new Date().toISOString())}`);
  assert.deepEqual(r.data.conversation.typing, ["Ann Archer"]);
  assert.equal(r.data.conversation.members.find((m) => m.id === ann).active, true);
  // Someone who never opened the chat can't set typing.
  assert.deepEqual((await call(cat, `/api/messages/${annBen}/typing`, { body: { on: true } })).data, { ok: false });

  await call(ann, "/api/messages/people/profile", { body: { showActive: false } });
  r = await call(ben, `/api/messages/${annBen}`);
  assert.equal(r.data.conversation.members.find((m) => m.id === ann).active, false);
  assert.equal(r.data.conversation.members.find((m) => m.id === ann).seenAt, null);
  assert.equal((await call(ben, "/api/messages")).data.conversations.find((c) => c.id === annBen).active, false);
});

test("the last person leaving deletes the chat and its files", async () => {
  const solo = (await call(dan, "/api/messages", { body: { title: "Notes to self" } })).data.conversation.id;
  await upload(dan, solo, png, "mine.png", "image/png");
  const count = stored.size;
  assert.equal((await call(dan, `/api/messages/${solo}/leave`, { body: {} })).status, 200);
  assert.equal(stored.size, count - 1);
});

test("browser roles can't read the new tables or call the new functions", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    try {
      for (const table of ["chat_profiles", "chat_folders", "chat_settings", "chat_friends", "chat_blocks"])
        await assert.rejects(db.query("select * from " + table), /permission denied/);
      await assert.rejects(db.query("select chat_people_search($1,'ann')", [ann]), /permission denied/);
      await assert.rejects(db.query("select chat_attachment('personal',$1,null,$1,$1)", [ann]), /permission denied/);
    } finally {
      await db.exec("reset role");
    }
  }
});

test("any single emoji can be a reaction, but not text or markup", async () => {
  const m = (await say(ben, annBen, "React to me")).data.message;
  assert.equal((await call(ann, `/api/messages/${annBen}/messages/${m.id}/react`, { body: { emoji: "🏆" } })).status, 200);
  for (const bad of ["lol", "<b>", "🏆 🏆", "a".repeat(20)])
    assert.equal((await call(ann, `/api/messages/${annBen}/messages/${m.id}/react`, { body: { emoji: bad } })).status, 400, bad);
});

test("file names are kept as typed, including % and accents", async () => {
  const r = await upload(ann, annBen, Buffer.from("x"), "50% odds – Café.txt", "text/plain");
  assert.equal(r.status, 201);
  assert.equal(r.data.message.attachment.name, "50% odds – Café.txt");
  const file = await call(ben, `/api/messages/${annBen}/files/${r.data.message.id}`);
  assert.match(file.headers.get("content-disposition"), /filename\*=UTF-8''50%25%20odds%20%E2%80%93%20Caf%C3%A9\.txt/);
});
