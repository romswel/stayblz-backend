// Marketplace photos, videos and documents (all optional), video streaming in parts (HTTP Range),
// video still frames (posters), the per-seller storage cap, and both stores: Cloudflare R2 (a fake
// here: nothing contacts Cloudflare, and every key must stay under stayblz/marketplace/) and the
// Supabase Storage fallback (a fake bucket whose signed links are served by a local server).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Readable } = require("node:stream");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
const R2_ENV = {
  R2_ACCESS_KEY_ID: "test-access-key-id-0000000000000",
  R2_SECRET_ACCESS_KEY: "test-secret-0000000000000000000000000000000000000000000000000000",
  R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  R2_BUCKET_PRIVATE: "shared-private",
  R2_BUCKET_PUBLIC: "shared-public",
};
const r2On = () => Object.assign(process.env, R2_ENV);
const r2Off = () => Object.keys(R2_ENV).forEach((k) => delete process.env[k]);
r2On();
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const { setR2ClientForTests } = require("../dist/lib/r2Storage");

const alice = "11111111-1111-4111-8111-111111111111",
  bob = "22222222-2222-4222-8222-222222222222",
  cara = "33333333-3333-4333-8333-333333333333";
const tokens = new Map();
let server, origin, database;

/** Serves bytes from a buffer the way storage does: Range → 206 + Content-Range, or 416. */
function rangeOf(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m) return null;
  let start, end;
  if (m[1] === "") {
    start = Math.max(size - Number(m[2]), 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || end < start ? "bad" : { start, end };
}
async function bytesOf(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/** In-memory R2 that streams and understands Range like the real one. */
const objects = new Map();
const r2Calls = [];
setR2ClientForTests({
  async send(command) {
    const kind = command.constructor.name;
    const { Bucket, Key, Body, ContentType, Range } = command.input;
    r2Calls.push({ kind, Key, Range });
    assert.ok(Key.startsWith("stayblz/marketplace/"), "marketplace keys stay in stayblz/marketplace/: " + Key);
    const id = `${Bucket}/${Key}`;
    const fail = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
    if (kind === "PutObjectCommand") {
      if (objects.has(id)) throw fail("PreconditionFailed", 412);
      objects.set(id, { body: await bytesOf(Body), type: ContentType });
      return {};
    }
    if (kind === "GetObjectCommand") {
      const found = objects.get(id);
      if (!found) throw fail("NoSuchKey", 404);
      const size = found.body.length;
      const r = Range ? rangeOf(Range, size) : null;
      if (r === "bad") throw fail("InvalidRange", 416);
      const part = r ? found.body.subarray(r.start, r.end + 1) : found.body;
      const body = Readable.from([part]);
      body.transformToByteArray = async () => new Uint8Array(part);
      return {
        ContentType: found.type,
        ContentLength: part.length,
        ...(r ? { ContentRange: `bytes ${r.start}-${r.end}/${size}` } : {}),
        Body: body,
      };
    }
    if (kind === "DeleteObjectCommand") return void objects.delete(id);
    throw new Error("unexpected " + kind);
  },
});
const inR2 = () => [...objects.keys()].map((k) => k.replace("shared-private/stayblz/marketplace/", ""));

/** Supabase Storage stand-in for the fallback (bucket "marketplace-media"). */
const bucketFiles = new Map();
let bucketsCreated = 0;
let storageServer, storageOrigin;
const fakeStorage = {
  async createBucket() {
    bucketsCreated++;
    return { data: {}, error: null };
  },
  from: () => ({
    async upload(path, body, { contentType }) {
      if (bucketFiles.has(path)) return { data: null, error: { message: "The resource already exists" } };
      bucketFiles.set(path, { body: Buffer.from(body), type: contentType });
      return { data: { path }, error: null };
    },
    async download(path) {
      const f = bucketFiles.get(path);
      if (!f) return { data: null, error: { message: "Object not found", statusCode: "404" } };
      return { data: new Blob([f.body], { type: f.type }), error: null };
    },
    async remove(paths) {
      paths.forEach((p) => bucketFiles.delete(p));
      return { data: [], error: null };
    },
    async createSignedUrl(path) {
      return { data: { signedUrl: `${storageOrigin}/sign?path=${encodeURIComponent(path)}` }, error: null };
    },
  }),
};

before(async () => {
  database = await installDatabase(supabase);
  for (const [id, name] of [
    [alice, "Alice Seller"],
    [bob, "Bob Buyer"],
    [cara, "Cara Seller"],
  ]) {
    await database.db.query("insert into auth.users(id,email) values($1,$2)", [id, id + "@example.test"]);
    tokens.set(id, auth.createSession({ id, username: id, displayName: name, role: "member", email: id + "@example.test" }));
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  storageServer = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").searchParams.get("path");
    const f = bucketFiles.get(path);
    if (!f) return res.writeHead(400).end('{"error":"not_found"}');
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
});
after(async () => {
  setR2ClientForTests(null);
  delete supabase.storage;
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => storageServer.close(resolve));
  await database.close();
});

async function call(user, path, { body, method, raw, type, headers = {} } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body || raw ? "POST" : "GET"),
    headers: {
      Authorization: "Bearer " + tokens.get(user),
      "Content-Type": raw ? type : "application/json",
      ...headers,
    },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });
  const buf = Buffer.from(await response.arrayBuffer());
  let data = null;
  try {
    data = JSON.parse(buf.toString());
  } catch {}
  return { status: response.status, data, buf, headers: response.headers };
}

const horse = (overrides = {}) => ({
  name: "Media Test Horse",
  price: 15000,
  breed: "thoroughbred",
  discipline: "flat-racing",
  type: "racehorse",
  gender: "mare",
  color: "bay",
  age: 5,
  heightIn: 64,
  location: "Ocala, Florida",
  ...overrides,
});

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg body")]);
const POSTER = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.from("still frame")]);
// 4-byte size + "ftyp" + brand, then numbered bytes so ranges are easy to check.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251))]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("webm body bytes")]);
const PDF = Buffer.from("%PDF-1.7 fake document");

const upload = (user, kind, raw, type, extra = "") => call(user, `/api/marketplace/uploads?kind=${kind}${extra}`, { raw, type });

/* ------------------------------ R2 ------------------------------ */

test("a listing can have no photos, videos or documents", async () => {
  const r = await call(alice, "/api/marketplace/listings", { body: horse({ name: "No Media Mare" }) });
  assert.equal(r.status, 201);
  assert.equal(r.data.listing.cover, null);
  assert.deepEqual([r.data.listing.photoCount, r.data.listing.videoCount, r.data.listing.documentCount], [0, 0, 0]);
  assert.deepEqual(r.data.listing.media, []);
  const edit = await call(alice, `/api/marketplace/listings/${r.data.listing.id}`, {
    method: "PATCH",
    body: { ...horse({ name: "No Media Mare" }), mediaIds: [], documentIds: [] },
  });
  assert.equal(edit.status, 200);
});

test("uploads are checked: kind, real type, size, length", async () => {
  assert.equal((await upload(alice, "video", Buffer.from("<html>not a video</html>"), "video/mp4")).status, 415);
  assert.equal((await upload(alice, "video", JPEG, "image/jpeg")).status, 415, "a photo isn't a video");
  assert.equal((await upload(alice, "photo", MP4, "video/mp4")).status, 415, "a video isn't a photo");
  assert.equal((await upload(alice, "video", Buffer.from("x"), "video/x-msvideo")).status, 415, "AVI isn't accepted");
  assert.equal((await upload(alice, "video", MP4, "video/mp4", "&duration=999")).status, 400, "over 3 minutes");
  assert.equal((await upload(alice, "photo", Buffer.alloc(8 * 1024 * 1024 + 1, 1), "image/jpeg")).status, 413);
  assert.equal(objects.size, 0, "nothing was stored");
});

let listingId, photoId, videoId, webmId, docId;

test("photos, videos and documents upload, attach in order and show on the listing", async () => {
  const p = await upload(alice, "photo", JPEG, "image/jpeg", "&width=800&height=600");
  assert.equal(p.status, 201);
  photoId = p.data.file.id;
  const v = await upload(alice, "video", MP4, "video/mp4", "&width=1920&height=1080&duration=12");
  assert.equal(v.status, 201);
  assert.equal(v.data.file.kind, "video");
  assert.equal(v.data.file.duration, 12);
  assert.equal(v.data.file.poster, false);
  videoId = v.data.file.id;
  const w = await upload(alice, "video", WEBM, "video/webm");
  assert.equal(w.status, 201);
  webmId = w.data.file.id;
  const d = await upload(alice, "document", PDF, "application/pdf", "&name=Vet%20report.pdf");
  assert.equal(d.status, 201);
  docId = d.data.file.id;

  // A still frame for the MP4 (only the seller, only videos, only JPEG).
  assert.equal((await call(alice, `/api/marketplace/uploads/${videoId}/poster`, { raw: POSTER, type: "image/jpeg" })).status, 200);
  assert.equal((await call(alice, `/api/marketplace/uploads/${webmId}/poster`, { raw: MP4, type: "image/jpeg" })).status, 415);
  assert.equal((await call(bob, `/api/marketplace/uploads/${webmId}/poster`, { raw: POSTER, type: "image/jpeg" })).status, 404);
  assert.equal((await call(alice, `/api/marketplace/uploads/${photoId}/poster`, { raw: POSTER, type: "image/jpeg" })).status, 404);

  // Unsaved uploads are only visible to the seller; nobody else can attach them.
  assert.equal((await call(bob, `/api/marketplace/media/${videoId}`)).status, 404);
  assert.equal((await call(alice, `/api/marketplace/media/${videoId}`)).status, 200);
  assert.equal((await call(bob, "/api/marketplace/listings", { body: { ...horse(), mediaIds: [videoId] } })).status, 400);
  assert.equal((await call(alice, "/api/marketplace/listings", { body: { ...horse(), documentIds: [videoId] } })).status, 400, "kinds must match");
  assert.equal((await call(alice, "/api/marketplace/listings", { body: { ...horse(), mediaIds: [videoId, videoId] } })).status, 400);

  // A video first: it becomes the cover (showing its still frame).
  const r = await call(alice, "/api/marketplace/listings", {
    body: { ...horse(), mediaIds: [videoId, photoId, webmId], documentIds: [docId] },
  });
  assert.equal(r.status, 201);
  const l = r.data.listing;
  listingId = l.id;
  assert.deepEqual(l.cover, { id: videoId, kind: "video", width: 1920, height: 1080, duration: 12, poster: true });
  assert.deepEqual([l.photoCount, l.videoCount, l.documentCount], [1, 2, 1]);
  assert.deepEqual(l.media.map((m) => [m.id, m.kind]), [[videoId, "video"], [photoId, "photo"], [webmId, "video"]]);
  assert.ok(inR2().every((k) => k.startsWith(alice + "/")), "files sit in the seller's folder");
  assert.equal(inR2().length, 5, "photo, 2 videos, still frame, document");
  assert.equal(bucketFiles.size, 0, "nothing went to Supabase while R2 is set up");
});

test("videos stream in parts (Range), which phones need to play them", async () => {
  const size = MP4.length;
  const whole = await call(bob, `/api/marketplace/media/${videoId}`);
  assert.equal(whole.status, 200);
  assert.ok(whole.buf.equals(MP4));
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("content-type"), "video/mp4");

  const probe = await call(bob, `/api/marketplace/media/${videoId}`, { headers: { Range: "bytes=0-1" } });
  assert.equal(probe.status, 206, "Safari's first question gets a part");
  assert.equal(probe.headers.get("content-range"), `bytes 0-1/${size}`);
  assert.equal(probe.headers.get("content-length"), "2");
  assert.ok(probe.buf.equals(MP4.subarray(0, 2)));

  const middle = await call(bob, `/api/marketplace/media/${videoId}`, { headers: { Range: "bytes=100-199" } });
  assert.equal(middle.status, 206);
  assert.ok(middle.buf.equals(MP4.subarray(100, 200)));
  assert.equal(r2Calls.at(-1).Range, "bytes=100-199", "only the asked-for part is read from storage");

  const open = await call(bob, `/api/marketplace/media/${videoId}`, { headers: { Range: "bytes=2000-" } });
  assert.equal(open.status, 206);
  assert.ok(open.buf.equals(MP4.subarray(2000)));

  const past = await call(bob, `/api/marketplace/media/${videoId}`, { headers: { Range: `bytes=${size}-` } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), `bytes */${size}`);

  const still = await call(bob, `/api/marketplace/media/${videoId}/poster`);
  assert.equal(still.status, 200);
  assert.equal(still.headers.get("content-type"), "image/jpeg");
  assert.ok(still.buf.equals(POSTER));
  assert.equal((await call(bob, `/api/marketplace/media/${webmId}/poster`)).status, 404, "no still frame for this one");
  assert.ok((await call(bob, `/api/marketplace/media/${photoId}`)).buf.equals(JPEG));
  const doc = await call(bob, `/api/marketplace/media/${docId}`);
  assert.match(doc.headers.get("content-disposition"), /^attachment; filename="Vet report.pdf"/);
});

test("editing drops a removed video and its still frame; removing the listing removes everything", async () => {
  const r = await call(alice, `/api/marketplace/listings/${listingId}`, {
    method: "PATCH",
    body: { ...horse(), mediaIds: [photoId, webmId], documentIds: [docId] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.listing.cover.id, photoId);
  assert.equal(inR2().length, 3, "the dropped video and its still frame are gone");
  assert.equal((await call(bob, `/api/marketplace/media/${videoId}`)).status, 404);
  assert.equal((await call(alice, `/api/marketplace/listings/${listingId}/remove`, { body: {} })).status, 200);
  assert.equal(inR2().length, 0);
});

test("too many photos or videos gets a message that says so", async () => {
  const ids = [];
  for (let i = 0; i < 9; i++) ids.push((await upload(cara, "photo", JPEG, "image/jpeg")).data.file.id);
  const r = await call(cara, "/api/marketplace/listings", { body: { ...horse(), mediaIds: ids } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /up to 8 photos/);
  const tooLong = await call(cara, "/api/marketplace/listings", { body: { ...horse(), mediaIds: [...ids, ...ids.slice(0, 3)].map((_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) } });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.data.error, /up to 11 photos and videos/);
  for (const id of ids) await call(cara, `/api/marketplace/uploads/${id}/remove`, { body: {} });
});

test("the form can ask for today's limits: 100 MB videos with R2, 50 MB without", async () => {
  const on = await call(bob, "/api/marketplace/limits");
  assert.equal(on.status, 200);
  assert.deepEqual(on.data, { videoBytes: 100 * 1024 * 1024, videoSeconds: 180, photos: 8, videos: 3, documents: 5 });
  r2Off();
  try {
    assert.equal((await call(bob, "/api/marketplace/limits")).data.videoBytes, 50 * 1024 * 1024);
  } finally {
    r2On();
  }
  const guest = await fetch(origin + "/api/marketplace/limits");
  assert.equal(guest.status, 401);
});

/* --------------------------- Supabase fallback --------------------------- */

test("without R2, files go to Supabase Storage and videos still stream in parts", async () => {
  r2Off();
  try {
    const before = objects.size;
    const v = await upload(alice, "video", MP4, "video/mp4", "&duration=4");
    assert.equal(v.status, 201);
    const p = await upload(alice, "photo", JPEG, "image/jpeg");
    assert.equal(p.status, 201);
    assert.equal((await call(alice, `/api/marketplace/uploads/${v.data.file.id}/poster`, { raw: POSTER, type: "image/jpeg" })).status, 200);
    assert.equal(objects.size, before, "R2 isn't touched");
    assert.equal(bucketFiles.size, 3, "video, still frame and photo are in the Supabase bucket");
    assert.ok([...bucketFiles.keys()].every((k) => k.startsWith(`marketplace/${alice}/`)));
    assert.ok(bucketsCreated >= 1, "the private bucket is made when first needed");

    const r = await call(alice, "/api/marketplace/listings", { body: { ...horse({ name: "Supabase Only" }), mediaIds: [p.data.file.id, v.data.file.id] } });
    assert.equal(r.status, 201);
    const probe = await call(bob, `/api/marketplace/media/${v.data.file.id}`, { headers: { Range: "bytes=0-1" } });
    assert.equal(probe.status, 206);
    assert.equal(probe.headers.get("content-range"), `bytes 0-1/${MP4.length}`);
    assert.ok(probe.buf.equals(MP4.subarray(0, 2)));
    const slice = await call(bob, `/api/marketplace/media/${v.data.file.id}`, { headers: { Range: "bytes=1500-" } });
    assert.ok(slice.buf.equals(MP4.subarray(1500)));
    assert.ok((await call(bob, `/api/marketplace/media/${v.data.file.id}/poster`)).buf.equals(POSTER));
    assert.ok((await call(bob, `/api/marketplace/media/${p.data.file.id}`)).buf.equals(JPEG));

    assert.equal((await call(alice, `/api/marketplace/listings/${r.data.listing.id}/remove`, { body: {} })).status, 200);
    assert.equal(bucketFiles.size, 0, "removing the listing empties the bucket again");
  } finally {
    r2On();
  }
});

test("each seller has a storage cap (300 MB without R2), other sellers aren't affected", async () => {
  r2Off();
  try {
    for (let i = 0; i < 6; i++)
      await database.db.query(
        "insert into marketplace_files(seller_id,kind,storage_key,content_type,size_bytes) values($1,'video',$2,'video/mp4',52428800)",
        [bob, `marketplace/${bob}/full-${i}.mp4`],
      );
    const r = await upload(bob, "photo", JPEG, "image/jpeg");
    assert.equal(r.status, 409);
    assert.match(r.data.error, /300 MB/);
    const v = await upload(bob, "video", MP4, "video/mp4");
    assert.equal(v.status, 409, "videos count too");
    const other = await upload(alice, "photo", JPEG, "image/jpeg");
    assert.equal(other.status, 201, "Alice can still upload");
    await call(alice, `/api/marketplace/uploads/${other.data.file.id}/remove`, { body: {} });
  } finally {
    r2On();
  }
  // With R2 the cap is far higher, so the same seller can upload again.
  assert.equal((await upload(bob, "photo", JPEG, "image/jpeg")).status, 201);
  await database.db.query("delete from marketplace_files where seller_id=$1", [bob]);
});
