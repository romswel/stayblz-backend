// Photos and attachments on Cloudflare R2 with Supabase fallback (lib/mediaStore.ts), community horse
// and post photos end to end, and profile pictures (routes/avatars.ts). R2 is a fake here: nothing
// contacts Cloudflare, and every key must stay under stayblz/ (Suprah shares the real buckets).
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "true";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const { setR2ClientForTests } = require("../dist/lib/r2Storage");
const { mediaStore } = require("../dist/lib/mediaStore");

const R2_ENV = {
  R2_ACCESS_KEY_ID: "test-access-key-id-0000000000000",
  R2_SECRET_ACCESS_KEY: "test-secret-0000000000000000000000000000000000000000000000000000",
  R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  R2_BUCKET_PRIVATE: "shared-private",
  R2_BUCKET_PUBLIC: "shared-public",
};
const r2On = () => Object.assign(process.env, R2_ENV);
const r2Off = () => Object.keys(R2_ENV).forEach((k) => delete process.env[k]);

/** In-memory R2 that can be told to fail. */
function fakeR2() {
  const objects = new Map();
  const state = { objects, calls: [], failPut: null, failGet: null };
  const fail = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  state.send = async (command) => {
    const kind = command.constructor.name;
    const { Bucket, Key, Body, ContentType } = command.input;
    state.calls.push({ kind, Bucket, Key });
    assert.ok(Key.startsWith("stayblz/"), "every R2 key stays in the Stayblz folder: " + Key);
    const id = `${Bucket}/${Key}`;
    if (kind === "PutObjectCommand") {
      if (state.failPut) throw fail(state.failPut, 503);
      objects.set(id, { body: Buffer.from(Body), type: ContentType });
      return {};
    }
    if (kind === "GetObjectCommand") {
      if (state.failGet) throw fail(state.failGet, 403);
      const found = objects.get(id);
      if (!found) throw fail("NoSuchKey", 404);
      return { ContentType: found.type, ContentLength: found.body.length, Body: { transformToByteArray: async () => new Uint8Array(found.body) } };
    }
    if (kind === "DeleteObjectCommand") return void objects.delete(id);
    throw new Error("unexpected " + kind);
  };
  return state;
}

/** Stand-in for a Supabase Storage bucket. */
function fakeBucket() {
  const files = new Map();
  return {
    files,
    async upload(path, body) {
      if (files.has(path)) throw new Error("exists");
      files.set(path, Buffer.from(body));
    },
    async download(path) {
      if (!files.has(path)) throw new Error("missing_file");
      return files.get(path);
    },
    async remove(paths) {
      paths.forEach((p) => files.delete(p));
    },
  };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg body")]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png")]);

/* ------------------------------ mediaStore ------------------------------ */

test("R2 off: everything stays on Supabase, exactly as before", async () => {
  r2Off();
  const r2 = fakeR2();
  setR2ClientForTests(r2);
  const bucket = fakeBucket();
  const store = mediaStore("community", bucket);
  await store.upload("horses/a/b/c", JPEG, "image/jpeg");
  assert.deepEqual([...bucket.files.keys()], ["horses/a/b/c"]);
  assert.deepEqual((await store.download("horses/a/b/c")), JPEG);
  await store.remove(["horses/a/b/c"]);
  assert.equal(bucket.files.size, 0);
  assert.equal(r2.calls.length, 0, "R2 is never contacted while it is off");
});

test("R2 on: new files go to stayblz/<area>/ in the private bucket; older Supabase files still open", async () => {
  r2On();
  const r2 = fakeR2();
  setR2ClientForTests(r2);
  const bucket = fakeBucket();
  bucket.files.set("posts/u/old", Buffer.from("saved before R2"));
  const store = mediaStore("community", bucket);

  await store.upload("posts/u/new", JPEG, "image/jpeg");
  assert.deepEqual([...r2.objects.keys()], ["shared-private/stayblz/community/posts/u/new"]);
  assert.equal(bucket.files.has("posts/u/new"), false, "not stored twice");
  assert.deepEqual(await store.download("posts/u/new"), JPEG);
  assert.equal((await store.download("posts/u/old")).toString(), "saved before R2");

  await store.remove(["posts/u/new", "posts/u/old"]);
  assert.equal(r2.objects.size, 0);
  assert.equal(bucket.files.size, 0);
  await assert.rejects(store.download("posts/u/gone"), /missing_file/);
});

test("R2 trouble never loses an upload: it falls back to Supabase", async () => {
  r2On();
  const r2 = fakeR2();
  r2.failPut = "ServiceUnavailable";
  setR2ClientForTests(r2);
  const bucket = fakeBucket();
  const store = mediaStore("chat", bucket);
  await store.upload("personal/c1/f1", PNG, "image/png");
  assert.ok(bucket.files.has("personal/c1/f1"));
  r2.failPut = null;
  assert.deepEqual(await store.download("personal/c1/f1"), PNG, "found in Supabase after the R2 miss");

  // Broken R2 keys: the file isn't in Supabase either, so the R2 problem is reported.
  r2.failGet = "InvalidAccessKeyId";
  await assert.rejects(store.download("personal/c1/nowhere"), (e) => e.code === "access_denied");
  r2.failGet = null;
});

/* ------------------------------ routes (database + fake R2) ------------------------------ */

const owner = "a1111111-1111-4111-8111-111111111111";
const viewer = "b2222222-2222-4222-8222-222222222222";
const banned = "c3333333-3333-4333-8333-333333333333";
const tokens = {};
let db, database, server, origin, r2;

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, first] of [[owner, "Olive"], [viewer, "Victor"], [banned, "Barry"]]) {
    const email = first.toLowerCase() + "@example.test";
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    await db.query("update accounts set first_name=$2, last_name='Test' where id=$1", [id, first]);
    tokens[id] = auth.createSession({ id, username: email, displayName: `${first} Test`, role: "member", email });
  }
  tokens.dev = auth.createSession({ id: "dev1", username: "dev", displayName: "Dev", role: "member" });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  setR2ClientForTests(null);
  r2Off();
  Object.values(tokens).forEach((t) => auth.destroySession(t));
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});
beforeEach(() => {
  r2On();
  r2 = fakeR2();
  setR2ClientForTests(r2);
});

async function call(path, { as, method = "GET", json, body, type } = {}) {
  const headers = as ? { Authorization: "Bearer " + tokens[as] } : {};
  if (json !== undefined) headers["Content-Type"] = "application/json";
  if (type) headers["Content-Type"] = type;
  const res = await fetch(origin + path, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  const buffer = Buffer.from(await res.arrayBuffer());
  let data = null;
  try {
    data = JSON.parse(buffer.toString());
  } catch {}
  return { status: res.status, data, buffer, headers: res.headers };
}

test("horse photos: saved in R2 under stayblz/community/, shown to members, removed with the horse", async () => {
  const horse = await call("/api/community/horses", { as: owner, method: "POST", json: { name: "Storage Star" } });
  assert.equal(horse.status, 201, JSON.stringify(horse.data));
  const id = horse.data.horse.id;
  const up = await call(`/api/community/horses/${id}/images?width=800&height=600`, { as: owner, method: "POST", body: JPEG, type: "image/jpeg" });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const keys = [...r2.objects.keys()];
  assert.equal(keys.length, 1);
  assert.match(keys[0], new RegExp(`^shared-private/stayblz/community/horses/${owner}/${id}/[0-9a-f-]{36}$`));

  const seen = await call(`/api/community/media/horse/${up.data.image.id}`, { as: viewer });
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.buffer, JPEG);
  assert.equal(seen.headers.get("content-type"), "image/jpeg");

  // Private horse: other members get 404, the owner still sees it.
  await call(`/api/community/horses/${id}`, { as: owner, method: "PATCH", json: { name: "Storage Star", visibility: "private" } });
  assert.equal((await call(`/api/community/media/horse/${up.data.image.id}`, { as: viewer })).status, 404);
  assert.equal((await call(`/api/community/media/horse/${up.data.image.id}`, { as: owner })).status, 200);

  assert.equal((await call(`/api/community/horses/${id}/remove`, { as: owner, method: "POST", json: {} })).status, 200);
  assert.equal(r2.objects.size, 0, "the photo is deleted from R2 with the horse");
});

test("post photos: uploaded to R2, attached to a post, streamed to members", async () => {
  const up = await call("/api/community/uploads", { as: owner, method: "POST", body: PNG, type: "image/png" });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.match([...r2.objects.keys()][0], new RegExp(`^shared-private/stayblz/community/posts/${owner}/`));
  // Before the post is published, only the uploader may open it.
  assert.equal((await call(`/api/community/media/post/${up.data.image.id}`, { as: viewer })).status, 404);
  const post = await call("/api/community/posts", { as: owner, method: "POST", json: { body: "First gallop", imageIds: [up.data.image.id] } });
  assert.equal(post.status, 201, JSON.stringify(post.data));
  const seen = await call(`/api/community/media/post/${up.data.image.id}`, { as: viewer });
  assert.equal(seen.status, 200);
  assert.deepEqual(seen.buffer, PNG);
  assert.equal((await call(`/api/community/posts/${post.data.post.id}/remove`, { as: owner, method: "POST", json: {} })).status, 200);
  assert.equal(r2.objects.size, 0);
});

test("profile pictures: upload, look up, show, replace and remove", async () => {
  assert.equal((await call("/api/avatars/me")).status, 401);
  assert.deepEqual((await call("/api/avatars/me", { as: owner })).data, { avatar: null });

  const first = await call("/api/avatars/me?width=512&height=512", { as: owner, method: "POST", body: JPEG, type: "image/jpeg" });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const v1 = first.data.avatar;
  assert.match(v1, /^[0-9a-f-]{36}$/);
  assert.deepEqual([...r2.objects.keys()], [`shared-private/stayblz/community/avatars/${owner}/${v1}`]);

  const lookup = await call(`/api/avatars/lookup?ids=${owner},${viewer}`, { as: viewer });
  assert.deepEqual(lookup.data, { avatars: { [owner]: v1 } });
  const image = await call(`/api/avatars/${owner}/${v1}`, { as: viewer });
  assert.equal(image.status, 200);
  assert.deepEqual(image.buffer, JPEG);
  assert.match(image.headers.get("cache-control"), /private/);
  assert.equal((await call(`/api/avatars/${owner}/${v1}`)).status, 401, "guests never see pictures");

  const second = await call("/api/avatars/me", { as: owner, method: "POST", body: PNG, type: "image/png" });
  const v2 = second.data.avatar;
  assert.notEqual(v2, v1);
  assert.deepEqual([...r2.objects.keys()], [`shared-private/stayblz/community/avatars/${owner}/${v2}`], "the old picture is deleted");
  assert.equal((await call(`/api/avatars/${owner}/${v1}`, { as: viewer })).status, 404, "old address stops working");

  assert.deepEqual((await call("/api/avatars/me/remove", { as: owner, method: "POST", json: {} })).data, { avatar: null });
  assert.equal(r2.objects.size, 0);
  assert.deepEqual((await call(`/api/avatars/lookup?ids=${owner}`, { as: viewer })).data, { avatars: {} });
});

test("profile pictures: only real photos, size limit, no dev profiles, suspended people hidden", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal((await call("/api/avatars/me", { as: owner, method: "POST", body: svg, type: "image/svg+xml" })).status, 415);
  assert.equal((await call("/api/avatars/me", { as: owner, method: "POST", body: Buffer.from("not a jpeg"), type: "image/jpeg" })).status, 415);
  const huge = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]);
  assert.equal((await call("/api/avatars/me", { as: owner, method: "POST", body: huge, type: "image/jpeg" })).status, 413);
  assert.equal((await call("/api/avatars/me", { as: "dev", method: "POST", body: JPEG, type: "image/jpeg" })).status, 409);
  assert.equal(r2.objects.size, 0, "nothing was stored");

  const pic = await call("/api/avatars/me", { as: banned, method: "POST", body: JPEG, type: "image/jpeg" });
  assert.equal(pic.status, 201);
  await db.query("update accounts set status='suspended' where id=$1", [banned]);
  assert.deepEqual((await call(`/api/avatars/lookup?ids=${banned}`, { as: viewer })).data, { avatars: {} });
  assert.equal((await call(`/api/avatars/${banned}/${pic.data.avatar}`, { as: viewer })).status, 404);

  assert.equal((await call(`/api/avatars/lookup?ids=nope`, { as: viewer })).status, 400);
  const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
  assert.equal((await call(`/api/avatars/lookup?ids=${many}`, { as: viewer })).status, 400);
});
