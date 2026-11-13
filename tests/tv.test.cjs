const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "true";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { tvSettings, streamUrl } = require("../dist/lib/tv");

const STREAM = "https://video.example.test/live/race.m3u8";
let server, origin, token;

before(async () => {
  token = auth.createSession({ id: "m1", username: "m1", displayName: "Member", role: "member" });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  for (const key of ["TV_ON_AIR", "TV_STREAM_URL", "TV_TITLE", "TV_NEXT_AT"]) delete process.env[key];
});

async function call(path, signedIn = true) {
  const response = await fetch(origin + path, {
    headers: signedIn ? { Authorization: "Bearer " + token } : {},
  });
  return { status: response.status, data: await response.json(), cache: response.headers.get("cache-control") };
}

test("guests get 401 on both TV routes", async () => {
  assert.equal((await call("/api/tv/status", false)).status, 401);
  assert.equal((await call("/api/tv/playback", false)).status, 401);
});

test("off air by default; playback refuses with off_air", async () => {
  const status = await call("/api/tv/status");
  assert.equal(status.status, 200);
  assert.deepEqual(status.data, { state: "off_air", title: null, startsAt: null });
  assert.equal(status.cache, "no-store");
  const playback = await call("/api/tv/playback");
  assert.equal(playback.status, 409);
  assert.equal(playback.data.code, "off_air");
});

test("live: status names the broadcast but never the stream; playback hands it out", async () => {
  process.env.TV_ON_AIR = "true";
  process.env.TV_STREAM_URL = STREAM;
  process.env.TV_TITLE = "  Keeneland \n Race 7  ";
  const status = await call("/api/tv/status");
  assert.deepEqual(status.data, { state: "live", title: "Keeneland Race 7", startsAt: null });
  assert.equal(JSON.stringify(status.data).includes("m3u8"), false);
  const playback = await call("/api/tv/playback");
  assert.equal(playback.status, 200);
  assert.deepEqual(playback.data, { url: STREAM, title: "Keeneland Race 7" });
});

test("the on-air switch without a valid stream is not live", async () => {
  process.env.TV_ON_AIR = "true";
  for (const bad of ["", "not a url", "ftp://x.test/a.m3u8", "http://video.example.test/a.m3u8", "https://u:p@x.test/a.m3u8"]) {
    process.env.TV_STREAM_URL = bad;
    assert.equal((await call("/api/tv/status")).data.state, "off_air", bad);
    assert.equal((await call("/api/tv/playback")).status, 409, bad);
  }
});

test("upcoming only for a future start time", async () => {
  process.env.TV_TITLE = "Saturday card";
  process.env.TV_NEXT_AT = "2099-01-01T18:30:00Z";
  assert.deepEqual((await call("/api/tv/status")).data, {
    state: "upcoming",
    title: "Saturday card",
    startsAt: "2099-01-01T18:30:00.000Z",
  });
  process.env.TV_NEXT_AT = "2001-01-01T00:00:00Z";
  assert.equal((await call("/api/tv/status")).data.state, "off_air");
  process.env.TV_NEXT_AT = "soon";
  assert.equal((await call("/api/tv/status")).data.state, "off_air");
});

test("stream address rules: https anywhere, http only for localhost outside production", () => {
  assert.equal(streamUrl(STREAM, true), STREAM);
  assert.equal(streamUrl("http://localhost:8080/a.m3u8", false), "http://localhost:8080/a.m3u8");
  assert.equal(streamUrl("http://localhost:8080/a.m3u8", true), null);
  assert.equal(streamUrl("javascript:alert(1)", false), null);
  assert.equal(tvSettings({ TV_TITLE: "x".repeat(300), TV_NEXT_AT: "2099-01-01T00:00:00Z" }).title.length, 120);
});
