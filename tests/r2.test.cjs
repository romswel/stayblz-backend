// Cloudflare R2 storage (lib/r2Storage.ts + routes/storage.ts). Uses a fake S3 client: nothing
// here contacts Cloudflare. The point of most tests: Stayblz can only ever touch keys under stayblz/.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "true";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { r2Storage, r2Key, newKey, r2Files, StorageError, setR2ClientForTests } = require("../dist/lib/r2Storage");

const SECRET = "s3cr3t-value-that-must-never-appear-in-output-0000000000000000000";
const ENV = {
  R2_ACCESS_KEY_ID: "test-access-key-id-0000000000000",
  R2_SECRET_ACCESS_KEY: SECRET,
  R2_ENDPOINT: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
  R2_BUCKET_PRIVATE: "shared-private",
  R2_BUCKET_PUBLIC: "shared-public",
  R2_PUBLIC_URL: "https://pub-0123456789abcdef.r2.dev/",
};

/** In-memory R2: records every command and keeps objects per bucket. */
function fakeR2() {
  const objects = new Map();
  const calls = [];
  const fail = (name, status) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  return {
    objects,
    calls,
    async send(command) {
      const kind = command.constructor.name;
      const input = command.input;
      calls.push({ kind, ...input });
      const id = `${input.Bucket}/${input.Key}`;
      if (!["shared-private", "shared-public"].includes(input.Bucket)) throw fail("NoSuchBucket", 404);
      if (kind === "PutObjectCommand") {
        if (input.IfNoneMatch === "*" && objects.has(id)) throw fail("PreconditionFailed", 412);
        objects.set(id, { body: Buffer.from(input.Body), type: input.ContentType });
        return {};
      }
      if (kind === "GetObjectCommand") {
        const found = objects.get(id);
        if (!found) throw fail("NoSuchKey", 404);
        return {
          ContentType: found.type,
          ContentLength: found.body.length,
          Body: { transformToByteArray: async () => new Uint8Array(found.body) },
        };
      }
      if (kind === "DeleteObjectCommand") {
        objects.delete(id);
        return {};
      }
      throw new Error("unexpected command " + kind);
    },
  };
}

let fake, server, origin;
const tokens = {};

before(async () => {
  tokens.member = auth.createSession({ id: "m1", username: "m1", displayName: "Member", role: "member" });
  tokens.admin = auth.createSession({ id: "a1", username: "a1", displayName: "Admin", role: "admin" });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  setR2ClientForTests(null);
  for (const token of Object.values(tokens)) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  Object.assign(process.env, ENV);
  fake = fakeR2();
  setR2ClientForTests(fake);
});

async function call(path, { method = "GET", as } = {}) {
  const response = await fetch(origin + path, {
    method,
    headers: as ? { Authorization: "Bearer " + tokens[as] } : {},
  });
  const text = await response.text();
  return { status: response.status, text, data: JSON.parse(text) };
}

const code = (fn) => async () => {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof StorageError, "expected a StorageError, got " + error);
    return error.code;
  }
  assert.fail("expected an error");
};

test("keys always land under stayblz/ and cannot escape it", async () => {
  assert.equal(r2Key("horses/u1/h1/photo.jpg"), "stayblz/horses/u1/h1/photo.jpg");
  // Even a Suprah folder name stays inside the Stayblz folder.
  assert.equal(r2Key("screenshots/x.jpg"), "stayblz/screenshots/x.jpg");
  for (const bad of [
    "", "/horses/a", "horses/", "a//b", "../screenshots/x", "a/../../b", "./a", ".env", "a/.hidden",
    "a b", "a\\b", "a/b?c", "a/b#c", "a/%2e%2e/b", "x".repeat(901), "a/".repeat(12) + "b", null, 42,
  ])
    assert.throws(() => r2Key(bad), (e) => e instanceof StorageError && e.code === "bad_key", `accepted ${bad}`);
  const fresh = newKey("horses/u1/", "JPG");
  assert.match(fresh, /^horses\/u1\/[0-9a-f-]{36}\.jpg$/);
  assert.throws(() => newKey("../x"), (e) => e.code === "bad_key");
});

test("put stores in the right bucket, under stayblz/, and never overwrites", async () => {
  await r2Storage.put("private", "docs/a.txt", Buffer.from("hello"), "text/plain", { cacheControl: "no-store" });
  const put = fake.calls.find((c) => c.kind === "PutObjectCommand");
  assert.equal(put.Bucket, "shared-private");
  assert.equal(put.Key, "stayblz/docs/a.txt");
  assert.equal(put.IfNoneMatch, "*");
  assert.equal(put.ContentType, "text/plain");
  assert.equal(put.CacheControl, "no-store");
  assert.equal(await code(() => r2Storage.put("private", "docs/a.txt", Buffer.from("again"), "text/plain"))(), "exists");
  assert.equal((await r2Storage.get("private", "docs/a.txt")).body.toString(), "hello");

  await r2Storage.put("public", "logos/b.png", Buffer.from("png"), "image/png");
  assert.equal(fake.calls.at(-1).Bucket, "shared-public");
});

test("get/open report a missing file as not_found", async () => {
  assert.equal(await code(() => r2Storage.get("private", "nope.txt"))(), "not_found");
  assert.equal(await code(() => r2Storage.open("private", "nope.txt"))(), "not_found");
});

test("remove checks every key before deleting anything", async () => {
  await r2Storage.put("private", "a/1.txt", Buffer.from("1"), "text/plain");
  await r2Storage.put("private", "a/2.txt", Buffer.from("2"), "text/plain");
  fake.calls.length = 0;
  assert.equal(await code(() => r2Storage.remove("private", ["a/1.txt", "../screenshots/x"]))(), "bad_key");
  assert.equal(fake.calls.length, 0, "nothing may be deleted when one key is bad");
  await r2Storage.remove("private", ["a/1.txt", "a/2.txt", "a/1.txt", ""]);
  assert.deepEqual(fake.calls.map((c) => c.Key).sort(), ["stayblz/a/1.txt", "stayblz/a/2.txt"]);
  assert.equal(fake.objects.size, 0);
  await r2Storage.remove("private", []); // no-op
});

test("r2Files matches the chat/community storage shape", async () => {
  const files = r2Files("private");
  await files.upload("horses/u1/x.jpg", Buffer.from("img"), "image/jpeg");
  assert.equal((await files.download("horses/u1/x.jpg")).toString(), "img");
  await files.remove(["horses/u1/x.jpg"]);
  assert.equal(fake.objects.size, 0);
});

test("public URLs and signed links stay inside stayblz/", async () => {
  assert.equal(r2Storage.publicUrl("logos/b.png"), "https://pub-0123456789abcdef.r2.dev/stayblz/logos/b.png");
  setR2ClientForTests(null); // signing happens locally with the real client; no network
  const link = new URL(await r2Storage.signedUrl("docs/a.txt", { seconds: 99999, downloadName: 'race "card".pdf' }));
  assert.match(link.hostname, /\.r2\.cloudflarestorage\.com$/);
  assert.ok(link.pathname.endsWith("/stayblz/docs/a.txt"), link.pathname);
  assert.equal(link.searchParams.get("X-Amz-Expires"), "3600");
  assert.match(link.searchParams.get("response-content-disposition"), /^attachment; filename="race card .pdf"$/);
  assert.equal(link.toString().includes(SECRET), false);
  delete process.env.R2_PUBLIC_URL;
  assert.throws(() => r2Storage.publicUrl("logos/b.png"), (e) => e.code === "no_public_url");
});

test("missing or wrong settings switch storage off with clear problems", async () => {
  delete process.env.R2_SECRET_ACCESS_KEY;
  assert.equal(r2Storage.isConfigured(), false);
  assert.equal(await code(() => r2Storage.put("private", "a.txt", Buffer.from("x"), "text/plain"))(), "not_configured");
  assert.ok(r2Storage.status().problems.includes("R2_SECRET_ACCESS_KEY is missing"));

  Object.assign(process.env, ENV, { R2_ENDPOINT: "https://evil.example.com" });
  assert.equal(r2Storage.isConfigured(), false);
  assert.match(r2Storage.status().problems.join("\n"), /R2_ENDPOINT must look like/);

  Object.assign(process.env, ENV, { R2_BUCKET_PUBLIC: "" });
  assert.equal(r2Storage.isConfigured("private"), true);
  assert.equal(r2Storage.isConfigured("public"), false);
});

test("check: read-only by default; write check leaves nothing behind", async () => {
  const quiet = await r2Storage.check();
  assert.equal(quiet.ok, true);
  assert.equal(quiet.private.connected, true);
  assert.deepEqual([...new Set(fake.calls.map((c) => c.kind))], ["GetObjectCommand"]);
  assert.ok(fake.calls.every((c) => c.Key.startsWith("stayblz/_checks/")));

  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const key = new URL(url).pathname.slice(1);
    const found = fake.objects.get("shared-public/" + key);
    return { ok: !!found, text: async () => (found ? found.body.toString() : "") };
  };
  try {
    const full = await r2Storage.check({ write: true });
    assert.equal(full.ok, true);
    assert.deepEqual(
      { wrote: full.private.wrote, readBack: full.private.readBack, deleted: full.private.deleted },
      { wrote: true, readBack: true, deleted: true },
    );
    assert.equal(full.public.publicUrl, true);
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(fake.objects.size, 0, "the check file is deleted");
  assert.ok(fake.calls.every((c) => c.Key.startsWith("stayblz/_checks/")));
});

test("check spots a wrong bucket name (a HEAD request could not)", async () => {
  process.env.R2_BUCKET_PRIVATE = "typo-private";
  const report = await r2Storage.check();
  assert.equal(report.ok, false);
  assert.equal(report.private.connected, false);
  assert.equal(report.private.error, "no_such_bucket");
  assert.equal(report.public.ok, true);
});

test("get refuses files too big for memory; open is for those", async () => {
  let destroyed = false;
  setR2ClientForTests({
    async send() {
      return { ContentLength: 26 * 1024 * 1024, ContentType: "video/mp4", Body: { destroy: () => (destroyed = true) } };
    },
  });
  assert.equal(await code(() => r2Storage.get("private", "videos/big.mp4"))(), "too_large");
  assert.equal(destroyed, true, "the download is cancelled, not left open");
  const opened = await r2Storage.open("private", "videos/big.mp4");
  assert.equal(opened.size, 26 * 1024 * 1024);
});

test("signed download names are plain ASCII (safe in a header)", async () => {
  setR2ClientForTests(null);
  const link = new URL(await r2Storage.signedUrl("docs/a.pdf", { downloadName: "Résumé\r\nX-Evil: 1 – ½.pdf" }));
  const disposition = link.searchParams.get("response-content-disposition");
  assert.match(disposition, /^attachment; filename="[\x20-\x7e]+"$/);
  assert.equal(/[\r\n]/.test(disposition), false);
});

test("check reports bad keys as access_denied without throwing", async () => {
  setR2ClientForTests({
    async send() {
      throw Object.assign(new Error("denied"), { name: "InvalidAccessKeyId", $metadata: { httpStatusCode: 403 } });
    },
  });
  const report = await r2Storage.check({ write: true });
  assert.equal(report.ok, false);
  assert.equal(report.private.error, "access_denied");
  assert.equal(report.private.connected, false);
});

test("admin routes: guests 401, members 403, admins see status without secrets", async () => {
  assert.equal((await call("/api/admin/storage")).status, 401);
  assert.equal((await call("/api/admin/storage", { as: "member" })).status, 403);
  assert.equal((await call("/api/admin/storage/check", { method: "POST", as: "member" })).status, 403);

  const status = await call("/api/admin/storage", { as: "admin" });
  assert.equal(status.status, 200);
  assert.equal(status.data.storage.folder, "stayblz/");
  assert.equal(status.data.storage.private.configured, true);
  assert.equal(status.data.storage.public.publicUrl, true);
  for (const value of [SECRET, ENV.R2_ACCESS_KEY_ID, ENV.R2_ENDPOINT])
    assert.equal(status.text.includes(value), false, "status must not reveal settings");

  const check = await call("/api/admin/storage/check", { as: "admin" });
  assert.equal(check.status, 200);
  assert.equal(check.data.storage.private.connected, true);
  assert.equal(fake.calls.some((c) => c.kind !== "GetObjectCommand"), false, "GET check changes nothing");
});
