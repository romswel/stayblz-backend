// Sharing a horse to the Feed (horse_share posts with the horse's live photos and videos), horse
// videos (upload limits, posters, Range playback) and who may see them. Real SQL (PGlite with every
// migration); storage is a fake Supabase bucket whose signed links a local server answers (R2 off).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const { r2Storage } = require("../dist/lib/r2Storage");
// A developer's .env may have R2 keys; these tests use the Supabase fallback.
r2Storage.isConfigured = () => false;

const ann = "a1111111-1111-4111-8111-111111111111",
  ben = "b2222222-2222-4222-8222-222222222222",
  cat = "c3333333-3333-4333-8333-333333333333";
const people = { [ann]: ["Ann", "Archer"], [ben]: ["Ben", "Bishop"], [cat]: ["Cat", "Carter"] };
const tokens = new Map();
const files = new Map();
let db, database, server, origin, storageServer, storageOrigin;

function rangeOf(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m) return null;
  const start = m[1] === "" ? Math.max(size - Number(m[2]), 0) : Number(m[1]);
  const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || end < start ? "bad" : { start, end };
}

const fakeStorage = {
  from: () => ({
    async upload(path, body, { contentType }) {
      if (files.has(path)) return { data: null, error: { message: "The resource already exists" } };
      files.set(path, { body: Buffer.from(body), type: contentType });
      return { data: { path }, error: null };
    },
    async download(path) {
      const f = files.get(path);
      if (!f) return { data: null, error: { message: "Object not found" } };
      return { data: new Blob([f.body], { type: f.type }), error: null };
    },
    async remove(paths) {
      paths.forEach((p) => files.delete(p));
      return { data: [], error: null };
    },
    async createSignedUrl(path) {
      return { data: { signedUrl: `${storageOrigin}/sign?path=${encodeURIComponent(path)}` }, error: null };
    },
  }),
};

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, [first, last]] of Object.entries(people)) {
    const email = first.toLowerCase() + "@example.test";
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    await db.query("update accounts set email=$2, first_name=$3, last_name=$4 where id=$1", [id, email, first, last]);
    tokens.set(id, auth.createSession({ id, username: email, displayName: `${first} ${last}`, role: "member", email }));
  }
  storageServer = http.createServer((req, res) => {
    const f = files.get(new URL(req.url, "http://x").searchParams.get("path"));
    if (!f) return res.writeHead(400).end();
    const r = req.headers.range ? rangeOf(req.headers.range, f.body.length) : null;
    if (r === "bad") return res.writeHead(416).end();
    if (r) {
      const part = f.body.subarray(r.start, r.end + 1);
      res.writeHead(206, { "Content-Type": f.type, "Content-Length": part.length, "Content-Range": `bytes ${r.start}-${r.end}/${f.body.length}` });
      return res.end(part);
    }
    res.writeHead(200, { "Content-Type": f.type, "Content-Length": f.body.length });
    res.end(f.body);
  });
  await new Promise((resolve) => storageServer.listen(0, "127.0.0.1", resolve));
  storageOrigin = "http://127.0.0.1:" + storageServer.address().port;
  Object.defineProperty(supabase, "storage", { configurable: true, value: fakeStorage });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  delete supabase.storage;
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => storageServer.close(resolve));
  await database.close();
});

async function call(user, path, { body, raw, type, method, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body || raw ? "POST" : "GET"),
    headers: { Authorization: "Bearer " + tokens.get(user), "Content-Type": raw ? type : "application/json", ...headers },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });
  const buf = Buffer.from(await response.arrayBuffer());
  let data = null;
  try {
    data = JSON.parse(buf.toString());
  } catch {}
  return { status: response.status, data, buf, headers: response.headers };
}

const JPEG = (n = 0) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg " + n)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251))]);

async function newHorse(owner, fields = {}) {
  const r = await call(owner, "/api/community/horses", { body: { name: "Bold Ruler", breed: "Thoroughbred", status: "racing", ...fields } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.horse.id;
}
const addPhoto = (owner, horse, n) => call(owner, `/api/community/horses/${horse}/images?width=800&height=600`, { raw: JPEG(n), type: "image/jpeg" });
const addVideo = (owner, horse, raw = MP4, extra = "") =>
  call(owner, `/api/community/horses/${horse}/videos?duration=42&width=1280&height=720${extra}`, { raw, type: "video/mp4" });
const feed = async (viewer) => (await call(viewer, "/api/community/feed")).data.posts;

test("an owner shares a horse: the post carries the name, breed and live media (cover first, 5 at most)", async () => {
  const horse = await newHorse(ann, { visibility: "members" });
  const photos = [];
  for (let i = 0; i < 7; i++) {
    const r = await addPhoto(ann, horse, i);
    assert.equal(r.status, 201);
    photos.push(r.data.image.id);
  }
  const video = await addVideo(ann, horse);
  assert.equal(video.status, 201, JSON.stringify(video.data));
  assert.equal(video.data.image.kind, "video");
  assert.equal(video.data.image.durationSeconds, 42);
  // The third photo becomes the main picture.
  assert.equal((await call(ann, `/api/community/horses/${horse}/cover`, { body: { imageId: photos[2] } })).status, 200);
  // A video can't be the main picture.
  assert.equal((await call(ann, `/api/community/horses/${horse}/cover`, { body: { imageId: video.data.image.id } })).status, 400);

  const shared = await call(ann, `/api/community/horses/${horse}/share`, { body: { body: "Meet our new star", visibility: "members" } });
  assert.equal(shared.status, 201, JSON.stringify(shared.data));
  const post = shared.data.post;
  assert.equal(post.kind, "horse_share");
  assert.equal(post.body, "Meet our new star");
  assert.equal(post.horse.name, "Bold Ruler");
  assert.equal(post.horse.breed, "Thoroughbred");
  assert.equal(post.horse.mediaCount, 8);
  assert.equal(post.horse.media.length, 5);
  assert.equal(post.horse.media[0].id, photos[2]);
  assert.deepEqual(post.horse.media.slice(1).map((m) => m.id), [photos[0], photos[1], photos[3], photos[4]]);

  // Another member sees the same post; new photos show up in it (live, nothing copied).
  await addPhoto(ann, horse, 99);
  const seen = (await feed(ben)).find((p) => p.id === post.id);
  assert.equal(seen.horse.mediaCount, 9);
});

test("private horses need the owner's yes; followers-only horses share to followers", async () => {
  const secret = await newHorse(ann, { name: "Hidden Gem", visibility: "private" });
  let r = await call(ann, `/api/community/horses/${secret}/share`, { body: {} });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "horse_private");
  r = await call(ann, `/api/community/horses/${secret}/share`, { body: { makeVisible: true } });
  assert.equal(r.status, 201);
  assert.equal(r.data.post.visibility, "members");
  assert.equal((await call(ann, `/api/community/horses/${secret}`)).data.horse.visibility, "members");
  assert.ok((await feed(ben)).some((p) => p.id === r.data.post.id && p.horse?.name === "Hidden Gem"));

  const close = await newHorse(ann, { name: "Inner Circle", visibility: "followers" });
  r = await call(ann, `/api/community/horses/${close}/share`, { body: { visibility: "members" } });
  assert.equal(r.status, 201);
  assert.equal(r.data.post.visibility, "followers");
  assert.ok(!(await feed(cat)).some((p) => p.id === r.data.post.id), "non-followers don't see it");
  await call(cat, `/api/community/people/${ann}/follow`, { body: {} });
  assert.ok((await feed(cat)).some((p) => p.id === r.data.post.id), "followers do");
});

test("only the owner can share, and captions have a limit", async () => {
  const horse = await newHorse(ann, { name: "Mine Only", visibility: "members" });
  assert.equal((await call(ben, `/api/community/horses/${horse}/share`, { body: {} })).status, 404);
  assert.equal((await call(ann, `/api/community/horses/${horse}/share`, { body: { body: "x".repeat(2001) } })).status, 400);
  assert.equal((await call(ann, `/api/community/horses/${horse}/share`, { body: { visibility: "everyone" } })).status, 400);
});

test("horse videos: type, size and count limits, posters, Range playback and privacy", async () => {
  const horse = await newHorse(ann, { name: "Film Star", visibility: "followers" });
  // Wrong bytes for the claimed type, wrong type, too long. (The 50/100 MB size cap is not covered here.)
  assert.equal((await addVideo(ann, horse, Buffer.from("not really a video at all"))).status, 415);
  assert.equal((await call(ann, `/api/community/horses/${horse}/videos`, { raw: MP4, type: "video/avi" })).status, 415);
  assert.equal((await call(ann, `/api/community/horses/${horse}/videos?duration=181`, { raw: MP4, type: "video/mp4" })).status, 400);
  // Someone else's horse.
  assert.equal((await addVideo(ben, horse)).status, 404);

  const first = await addVideo(ann, horse);
  assert.equal(first.status, 201);
  const id = first.data.image.id;
  assert.equal((await addVideo(ann, horse)).status, 201);
  assert.equal((await addVideo(ann, horse)).status, 201);
  assert.equal((await addVideo(ann, horse)).status, 409, "3 videos per horse");

  // Poster: JPEG only, owner only.
  assert.equal((await call(ann, `/api/community/horses/${horse}/images/${id}/poster`, { raw: MP4, type: "image/jpeg" })).status, 415);
  assert.equal((await call(ben, `/api/community/horses/${horse}/images/${id}/poster`, { raw: JPEG(), type: "image/jpeg" })).status, 404);
  const poster = await call(ann, `/api/community/horses/${horse}/images/${id}/poster`, { raw: JPEG(5), type: "image/jpeg" });
  assert.equal(poster.status, 200);
  assert.equal(poster.data.image.hasPoster, true);
  const still = await call(ann, `/api/community/media/horse/${id}/poster`);
  assert.equal(still.status, 200);
  assert.deepEqual(still.buf, JPEG(5));

  // The owner plays it in parts.
  const part = await call(ann, `/api/community/media/horse/${id}`, { headers: { Range: "bytes=100-199" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 100-199/${MP4.length}`);
  assert.equal(part.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(part.buf, MP4.subarray(100, 200));
  const full = await call(ann, `/api/community/media/horse/${id}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.deepEqual(full.buf, MP4);

  // Followers-only horse: Ben (not following) can't play it or see the poster.
  await call(ben, `/api/community/people/${ann}/unfollow`, { body: {} });
  assert.equal((await call(ben, `/api/community/media/horse/${id}`)).status, 404);
  assert.equal((await call(ben, `/api/community/media/horse/${id}/poster`)).status, 404);

  // Removing a video removes its poster file too.
  const before = files.size;
  assert.equal((await call(ann, `/api/community/horses/${horse}/images/${id}/remove`, { body: {} })).status, 200);
  assert.equal(files.size, before - 2);
});
