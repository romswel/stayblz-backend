const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "true";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { tvSettings, streamUrl, youtubeEmbed } = require("../dist/lib/tv");
const { parseFeed, youtubeChannels, clearYouTubeCache, youtubeReplays } = require("../dist/lib/youtubeFeed");

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
  for (const key of ["TV_ON_AIR", "TV_STREAM_URL", "TV_TITLE", "TV_NEXT_AT", "TV_EMBED_URL", "TV_YOUTUBE_CHANNELS"]) delete process.env[key];
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
  assert.deepEqual(playback.data, { url: STREAM, title: "Keeneland Race 7", kind: "hls" });
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

test("demo YouTube embed: live with kind embed; the HLS stream wins when both are set", async () => {
  process.env.TV_ON_AIR = "true";
  process.env.TV_TITLE = "Los Alamitos";
  process.env.TV_EMBED_URL = "https://www.youtube.com/watch?v=cJA4RJ5teuw&t=600s";
  const status = await call("/api/tv/status");
  assert.deepEqual(status.data, { state: "live", title: "Los Alamitos", startsAt: null });
  const playback = await call("/api/tv/playback");
  assert.equal(playback.data.kind, "embed");
  assert.equal(
    playback.data.url,
    "https://www.youtube-nocookie.com/embed/cJA4RJ5teuw?autoplay=1&playsinline=1&rel=0&start=600",
  );
  process.env.TV_STREAM_URL = STREAM;
  assert.deepEqual((await call("/api/tv/playback")).data, { url: STREAM, title: "Los Alamitos", kind: "hls" });
  delete process.env.TV_STREAM_URL;
  process.env.TV_ON_AIR = "false";
  assert.equal((await call("/api/tv/status")).data.state, "off_air");
  assert.equal((await call("/api/tv/playback")).status, 409);
});

test("YouTube link rules: only YouTube video or channel ids, rebuilt by us", () => {
  const v = "https://www.youtube-nocookie.com/embed/cJA4RJ5teuw?autoplay=1&playsinline=1&rel=0";
  assert.equal(youtubeEmbed("https://youtu.be/cJA4RJ5teuw"), v);
  assert.equal(youtubeEmbed("https://www.youtube.com/live/cJA4RJ5teuw?si=abc"), v);
  assert.equal(youtubeEmbed("https://www.youtube.com/embed/cJA4RJ5teuw"), v);
  assert.equal(
    youtubeEmbed("https://www.youtube.com/channel/UCzU39Vjjyv2_SXipboFPAsQ/live"),
    "https://www.youtube.com/embed/live_stream?autoplay=1&playsinline=1&rel=0&channel=UCzU39Vjjyv2_SXipboFPAsQ",
  );
  for (const bad of [
    "",
    "cJA4RJ5teuw",
    "http://www.youtube.com/watch?v=cJA4RJ5teuw",
    "https://evil.test/watch?v=cJA4RJ5teuw",
    "https://youtube.com.evil.test/watch?v=cJA4RJ5teuw",
    "https://www.youtube.com/watch?v=bad\"><script>",
    "https://www.youtube.com/@losalqh",
    "javascript:alert(1)",
  ])
    assert.equal(youtubeEmbed(bad), null, bad);
});

/* ---------- YouTube replays (demo) ---------- */

const CH = "UCzU39Vjjyv2_SXipboFPAsQ";
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>zU39Vjjyv2_SXipboFPAsQ</yt:channelId>
 <title>Los Alamitos Race Course</title>
 <author><name>Los Alamitos Race Course</name><uri>https://www.youtube.com/channel/${CH}</uri></author>
 <entry>
  <yt:videoId>cJA4RJ5teuw</yt:videoId>
  <title>Los Alamitos NIGHTTIME Full Card &amp; Replays on - Sunday,  November 15</title>
  <published>2026-11-16T06:01:05+00:00</published>
  <media:group>
   <media:description>8 Races starting at 5:55PM. Paul Jones sets a record! &lt;b&gt;</media:description>
   <media:community><media:statistics views="1234"/></media:community>
  </media:group>
 </entry>
 <entry>
  <yt:videoId>cHSBFpM-Oeg</yt:videoId>
  <title>Los Alamitos Preview Show for November 14-15</title>
  <published>2026-11-14T01:40:12+00:00</published>
  <media:group><media:description>Weekend analysis.</media:description></media:group>
 </entry>
 <entry>
  <yt:videoId>bad id here</yt:videoId>
  <title>Skipped</title>
  <published>2026-11-13T01:40:12+00:00</published>
 </entry>
 <entry>
  <yt:videoId>ptg9bFbwWMg</yt:videoId>
  <title>Full Card - Thursday, December 31</title>
  <published>2027-01-01T06:00:00+00:00</published>
  <media:group><media:description>9 races starting at 6:05 p.m.</media:description></media:group>
 </entry>
</feed>`;

test("feed parsing: cards get race count, first post, highlight and race day; bad entries are skipped", () => {
  const { channel, videos } = parseFeed(FEED);
  assert.deepEqual(channel, { id: CH, name: "Los Alamitos Race Course", url: "https://www.youtube.com/channel/" + CH });
  assert.equal(videos.length, 3);
  assert.deepEqual(videos[0], {
    id: "cJA4RJ5teuw",
    channelId: CH,
    title: "Los Alamitos NIGHTTIME Full Card & Replays on - Sunday, November 15",
    kind: "card",
    heading: "Sunday night card",
    publishedAt: "2026-11-16T06:01:05.000Z",
    raceDay: "2026-11-15",
    races: 8,
    firstPost: "5:55 PM",
    highlight: "Paul Jones sets a record! <b>",
    description: "8 Races starting at 5:55PM. Paul Jones sets a record! <b>",
    views: 1234,
  });
  assert.equal(videos[1].kind, "preview");
  assert.equal(videos[1].heading, "Preview show");
  assert.equal(videos[1].races, null);
  // A December race published in January belongs to the year before.
  assert.equal(videos[2].raceDay, "2026-12-31");
  assert.equal(videos[2].firstPost, "6:05 PM");
  assert.equal(videos[2].highlight, null);
});

test("channels come from TV_YOUTUBE_CHANNELS, else a channel /live embed", () => {
  assert.deepEqual(youtubeChannels({ TV_YOUTUBE_CHANNELS: ` ${CH}, nope, ${CH}` }), [CH]);
  assert.deepEqual(youtubeChannels({ TV_EMBED_URL: `https://www.youtube.com/channel/${CH}/live` }), [CH]);
  assert.deepEqual(youtubeChannels({ TV_EMBED_URL: "https://www.youtube.com/watch?v=cJA4RJ5teuw" }), []);
});

test("GET /youtube: members only; lists videos; serves the cached copy when YouTube fails; 502 with nothing to show", async () => {
  const realFetch = globalThis.fetch;
  let feedCalls = 0;
  let feedUp = true;
  globalThis.fetch = (url, init) => {
    if (String(url).startsWith("https://www.youtube.com/feeds/videos.xml")) {
      feedCalls++;
      assert.equal(String(url), "https://www.youtube.com/feeds/videos.xml?channel_id=" + CH);
      return Promise.resolve(feedUp ? new Response(FEED, { status: 200 }) : new Response("down", { status: 503 }));
    }
    return realFetch(url, init);
  };
  try {
    clearYouTubeCache();
    assert.deepEqual((await call("/api/tv/youtube")).data, { channels: [], videos: [] });
    assert.equal(feedCalls, 0);
    assert.equal((await call("/api/tv/youtube", false)).status, 401);

    process.env.TV_YOUTUBE_CHANNELS = CH;
    const first = await call("/api/tv/youtube");
    assert.equal(first.status, 200);
    assert.equal(first.data.channels[0].name, "Los Alamitos Race Course");
    assert.deepEqual(first.data.videos.map((v) => v.id), ["ptg9bFbwWMg", "cJA4RJ5teuw", "cHSBFpM-Oeg"]);
    await call("/api/tv/youtube");
    assert.equal(feedCalls, 1, "cached for 10 minutes");

    feedUp = false;
    const later = await youtubeReplays({ TV_YOUTUBE_CHANNELS: CH }, Date.now() + 11 * 60_000);
    assert.equal(feedCalls, 2, "re-fetched after 10 minutes");
    assert.equal(later.failed, false);
    assert.equal(later.videos.length, 3, "stale copy served while YouTube is down");
    clearYouTubeCache();
    const down = await call("/api/tv/youtube");
    assert.equal(down.status, 502);
    assert.match(down.data.error, /YouTube replays/);
  } finally {
    globalThis.fetch = realFetch;
    clearYouTubeCache();
  }
});
