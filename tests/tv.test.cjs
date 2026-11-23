const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "true";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { tvSettings, streamUrl, youtubeEmbed } = require("../dist/lib/tv");
const { parseFeed, youtubeChannels, clearYouTubeCache, youtubeReplays, raceDayOf, classify } = require("../dist/lib/youtubeFeed");
const { parseVideos, parseDuration, clearLiveCache, youtubeStatus } = require("../dist/lib/youtubeLive");
const { TV_CHANNELS } = require("../dist/lib/tvChannels");
const { supabase } = require("../dist/lib/supabase");
// No database here: Billing's settings read answers "paywalls off" (the default) straight away.
// The paywall itself (402 without the TV Pass) is tested in billing.test.cjs.
supabase.from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enforce_paywalls: false }, error: null }) }) }) });
const OPEN = { allowed: true, reason: "open", plan: "tv_monthly" };
/** What /status adds when no track is on YouTube (no API key in these tests unless set). */
const NO_YT = { live: [], upcoming: null, latest: null };

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
  for (const key of ["TV_ON_AIR", "TV_STREAM_URL", "TV_TITLE", "TV_NEXT_AT", "TV_EMBED_URL", "TV_YOUTUBE_CHANNELS", "YOUTUBE_API_KEY"]) delete process.env[key];
  // No network: the built-in track channels are off unless a test turns them on.
  process.env.TV_YOUTUBE_DEFAULTS = "off";
  clearYouTubeCache();
  clearLiveCache();
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
  assert.deepEqual(status.data, { state: "off_air", title: null, startsAt: null, access: OPEN, featured: false, ...NO_YT });
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
  assert.deepEqual(status.data, { state: "live", title: "Keeneland Race 7", startsAt: null, access: OPEN, featured: true, ...NO_YT });
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
    access: OPEN,
    featured: false,
    ...NO_YT,
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
  assert.deepEqual(status.data, { state: "live", title: "Los Alamitos", startsAt: null, access: OPEN, featured: true, ...NO_YT });
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
  // A built-in channel takes its name, track and breed from lib/tvChannels.ts.
  assert.deepEqual(channel, {
    id: CH,
    name: "Los Alamitos",
    url: "https://www.youtube.com/channel/" + CH,
    track: "Los Alamitos Race Course",
    breed: "Quarter Horse",
    streamsCards: true,
  });
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
    durationSec: null,
    wasLive: null,
    liveState: null,
  });
  assert.equal(videos[1].kind, "preview");
  assert.equal(videos[1].heading, "Preview show");
  assert.equal(videos[1].races, null);
  // A December race published in January belongs to the year before.
  assert.equal(videos[2].raceDay, "2026-12-31");
  assert.equal(videos[2].firstPost, "6:05 PM");
  assert.equal(videos[2].highlight, null);
});

test("channels: the built-in tracks plus TV_YOUTUBE_CHANNELS, no cap, no duplicates", () => {
  const ids = TV_CHANNELS.map((c) => c.id);
  assert.ok(ids.length > 5);
  assert.equal(new Set(ids).size, ids.length, "no channel listed twice");
  for (const c of TV_CHANNELS) assert.match(c.id, /^UC[A-Za-z0-9_-]{22}$/, c.name);
  const extra = "UCaaaaaaaaaaaaaaaaaaaaaa";
  assert.deepEqual(youtubeChannels({}), ids);
  assert.deepEqual(youtubeChannels({ TV_YOUTUBE_CHANNELS: `${CH},${extra}, nope` }), [...ids, extra], "Los Alamitos is already built in");
  const off = { TV_YOUTUBE_DEFAULTS: "off" };
  assert.deepEqual(youtubeChannels({ ...off, TV_YOUTUBE_CHANNELS: ` ${CH}, nope, ${CH}` }), [CH]);
  assert.deepEqual(youtubeChannels({ ...off, TV_EMBED_URL: `https://www.youtube.com/channel/${CH}/live` }), [CH]);
  assert.deepEqual(youtubeChannels({ ...off, TV_EMBED_URL: "https://www.youtube.com/watch?v=cJA4RJ5teuw" }), []);
});

test("race days from the ways tracks write dates", () => {
  const pub = "2026-11-23T12:00:00Z";
  assert.equal(raceDayOf("Kentucky Downs Racing Live Stream - September 9th, 2026", pub), "2026-09-09");
  assert.equal(raceDayOf("11/23/2026 Finger Lakes Racetrack (up to 10 second delay)", pub), "2026-11-23");
  assert.equal(raceDayOf("Canterbury Park 9-19-2026", pub), "2026-09-19");
  assert.equal(raceDayOf("Race #9 11/19/26", pub), "2026-11-19");
  assert.equal(raceDayOf("CDP 2026 November 21 R14", pub), "2026-11-21");
  assert.equal(raceDayOf("Sunday, November 22 at Del Mar", pub), "2026-11-22");
  assert.equal(raceDayOf("Red Shores Racetrack Live Stream", pub), null);
  assert.equal(raceDayOf("13/45/2026 nonsense", pub), null);
});

test("kinds: cards, single-race replays, previews; sales and draws are never cards", () => {
  const v = (title, description = "") => ({ id: "cJA4RJ5teuw", channelId: CH, title, kind: "video", heading: title, publishedAt: "2026-11-23T00:00:00.000Z", raceDay: raceDayOf(title, "2026-11-23T00:00:00Z"), races: null, firstPost: null, highlight: null, description, views: null, durationSec: null, wasLive: null, liveState: null });
  assert.equal(classify(v("Emerald Downs Live Stream 9-7")).kind, "card");
  assert.equal(classify(v("Lone Star Live - Saturday, November 21, 2026")).kind, "card");
  assert.equal(classify(v("11/23/2026 Finger Lakes Racetrack (up to 10 second delay)")).heading, "Monday race card");
  assert.equal(classify(v("America's Day at the Races - Sunday November 22, 2026")).heading, "Sunday race card");
  assert.equal(classify(v("Sunday, November 22 at Del Mar")).kind, "video", "no sign of a broadcast in the title alone");
  assert.equal(classify(v("Sunday, November 22 at Del Mar"), true).kind, "card", "a long livestream is a card");
  assert.equal(classify(v("Gulfstream Park November 22, 2026 Race 10")).kind, "race");
  assert.equal(classify(v("CDP 2026 November 21 R14")).kind, "race");
  assert.equal(classify(v("Canadian Derby Preview Show! August 20, 2026"), true).kind, "preview");
  assert.equal(classify(v("2026 November Horses of Racing Age Sale Livestream"), true).kind, "video");
  assert.equal(classify(v("Parx Draw 11-19-26 for 11-25-26"), true).kind, "video");
  const loose = classify(v("Lone Star Live - Saturday, November 21, 2026", "A 10-race card. First post 1:10 p.m."), true);
  assert.deepEqual([loose.races, loose.firstPost, loose.highlight], [10, "1:10 PM", null]);
  assert.deepEqual([classify(v("Preview Show - Los Alamitos Trials", "8 races starting at 1:10 PM")).races], [null], "card details only on cards");
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
    assert.equal(first.data.channels[0].name, "Los Alamitos");
    assert.deepEqual(first.data.videos.map((v) => v.id), ["ptg9bFbwWMg", "cJA4RJ5teuw", "cHSBFpM-Oeg"]);
    await call("/api/tv/youtube");
    assert.equal(feedCalls, 1, "cached for 10 minutes");

    feedUp = false;
    const later = await youtubeReplays({ TV_YOUTUBE_DEFAULTS: "off", TV_YOUTUBE_CHANNELS: CH }, Date.now() + 11 * 60_000);
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

/* ---------- Live tracks on YouTube (Data API) ---------- */

const CH2 = "UC7NsS9H61hQ51JLeaHHeivA"; // Del Mar (built in)
const KEY = "test-key-aaaaaaaaaaaaaaaaaaaa";
function feedXml(channelId, name, entries) {
  return `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <yt:channelId>${channelId.slice(2)}</yt:channelId><author><name>${name}</name></author>
 ${entries.map((e) => `<entry><yt:videoId>${e.id}</yt:videoId><title>${e.title}</title><published>${e.published}</published></entry>`).join("\n")}
</feed>`;
}
const LIVE_FEEDS = {
  [CH]: feedXml(CH, "Los Alamitos Race Course", [
    { id: "LIVEvideo01", title: "Los Alamitos NIGHTTIME Full Card Stream - Sunday, November 22", published: "2026-11-22T20:00:00+00:00" },
    { id: "cJA4RJ5teuw", title: "Los Alamitos NIGHTTIME Full Card - Saturday, November 21", published: "2026-11-21T20:00:00+00:00" },
  ]),
  [CH2]: feedXml(CH2, "Del Mar Racing", [
    { id: "DMsale00001", title: "Horses of Racing Age Sale Livestream", published: "2026-11-22T21:00:00+00:00" },
    { id: "DMlive00001", title: "Sunday, November 22 at Del Mar", published: "2026-11-22T19:00:00+00:00" },
    { id: "DMnext00001", title: "Saturday, November 28 at Del Mar", published: "2026-11-22T18:00:00+00:00" },
    { id: "DMrace00010", title: "Dairago (FR) wins race 9 at Del Mar 11/22/26", published: "2026-11-22T17:00:00+00:00" },
  ]),
};
const item = (id, channelId, title, live, extra = {}) => ({
  id,
  snippet: { channelId, title, liveBroadcastContent: live },
  contentDetails: { duration: extra.duration ?? "P0D" },
  status: { embeddable: extra.embeddable ?? true },
  ...(extra.stream ? { liveStreamingDetails: extra.stream } : {}),
});
const API_ITEMS = [
  item("LIVEvideo01", CH, "Los Alamitos NIGHTTIME Full Card Stream - Sunday, November 22", "live", { stream: { actualStartTime: "2026-11-23T01:00:00Z", concurrentViewers: "500" } }),
  item("cJA4RJ5teuw", CH, "Los Alamitos NIGHTTIME Full Card - Saturday, November 21", "none", { duration: "PT4H2M", stream: { actualStartTime: "2026-11-22T01:00:00Z", actualEndTime: "2026-11-22T05:02:00Z" } }),
  item("DMsale00001", CH2, "Horses of Racing Age Sale Livestream", "live", { stream: { actualStartTime: "2026-11-22T21:00:00Z", concurrentViewers: "5000" } }),
  item("DMlive00001", CH2, "Sunday, November 22 at Del Mar", "live", { embeddable: false, stream: { actualStartTime: "2026-11-22T20:00:00Z", concurrentViewers: "900" } }),
  item("DMnext00001", CH2, "Saturday, November 28 at Del Mar", "upcoming", { stream: { scheduledStartTime: "2099-11-28T20:00:00Z" } }),
  item("DMrace00010", CH2, "Dairago (FR) wins race 9 at Del Mar 11/22/26", "none", { duration: "PT2M10S" }),
];

function mockYouTube({ apiUp = true } = {}) {
  const realFetch = globalThis.fetch;
  const calls = { feed: 0, api: 0, apiUrls: [] };
  globalThis.fetch = (url, init) => {
    const u = String(url);
    if (u.startsWith("https://www.youtube.com/feeds/videos.xml")) {
      calls.feed++;
      const id = new URL(u).searchParams.get("channel_id");
      return Promise.resolve(new Response(LIVE_FEEDS[id] ?? "nope", { status: LIVE_FEEDS[id] ? 200 : 404 }));
    }
    if (u.startsWith("https://www.googleapis.com/youtube/v3/videos")) {
      calls.api++;
      calls.apiUrls.push(u);
      if (!apiUp) return Promise.resolve(new Response("{}", { status: 500 }));
      const ids = new URL(u).searchParams.get("id").split(",");
      return Promise.resolve(Response.json({ items: API_ITEMS.filter((i) => ids.includes(i.id)) }));
    }
    return realFetch(url, init);
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

test("Data API parsing: durations and malformed items", () => {
  assert.equal(parseDuration("PT4H2M"), 14520);
  assert.equal(parseDuration("P1DT1S"), 86401);
  assert.equal(parseDuration("P0D"), null);
  assert.equal(parseDuration("4 hours"), null);
  assert.deepEqual(parseVideos({ items: [{ id: "bad" }, null, "x", { id: "cJA4RJ5teuw" }] }), []);
  assert.deepEqual(parseVideos("nonsense"), []);
  const [d] = parseVideos({ items: [API_ITEMS[1]] });
  assert.deepEqual(d, {
    id: "cJA4RJ5teuw",
    channelId: CH,
    title: "Los Alamitos NIGHTTIME Full Card - Saturday, November 21",
    liveState: "none",
    wasLive: true,
    startedAt: "2026-11-22T01:00:00.000Z",
    endedAt: "2026-11-22T05:02:00.000Z",
    scheduledAt: null,
    viewers: null,
    durationSec: 14520,
    embeddable: true,
  });
});

test("live tracks: /status lists them without stream addresses; /playback?channel is free; replays get lengths", async () => {
  process.env.TV_YOUTUBE_CHANNELS = `${CH},${CH2}`;
  process.env.YOUTUBE_API_KEY = KEY;
  const yt = mockYouTube();
  try {
    const status = await call("/api/tv/status");
    assert.equal(status.status, 200);
    assert.equal(status.data.state, "live");
    assert.equal(status.data.featured, false);
    assert.equal(status.data.title, "Los Alamitos NIGHTTIME Full Card Stream - Sunday, November 22", "the latest stream to start leads");
    assert.deepEqual(
      status.data.live.map((l) => [l.channelId, l.channelName, l.viewers]),
      [[CH, "Los Alamitos", 500], [CH2, "Del Mar", 900]],
      "the horse sale stream is not racing",
    );
    assert.equal(status.data.live[0].track, "Los Alamitos Race Course");
    assert.equal(status.data.live[0].videoId, "LIVEvideo01");
    assert.deepEqual(status.data.upcoming, { channelId: CH2, channelName: "Del Mar", title: "Saturday, November 28 at Del Mar", startsAt: "2099-11-28T20:00:00.000Z" });
    assert.deepEqual(status.data.latest, { channelId: CH, channelName: "Los Alamitos", videoId: "cJA4RJ5teuw", title: "Los Alamitos NIGHTTIME Full Card - Saturday, November 21", endedAt: "2026-11-22T05:02:00.000Z" });
    assert.ok(yt.calls.apiUrls[0].includes("key=" + KEY));

    const apiCalls = yt.calls.api;
    await call("/api/tv/status");
    assert.equal(yt.calls.api, apiCalls, "cached for 2 minutes");

    const play = await call("/api/tv/playback?channel=" + CH);
    assert.equal(play.status, 200);
    assert.deepEqual(play.data, {
      url: "https://www.youtube-nocookie.com/embed/LIVEvideo01?autoplay=1&playsinline=1&rel=0",
      title: "Los Alamitos NIGHTTIME Full Card Stream - Sunday, November 22",
      kind: "embed",
      embeddable: true,
      watchUrl: "https://www.youtube.com/watch?v=LIVEvideo01",
    });
    assert.equal((await call("/api/tv/playback?channel=" + CH2)).data.embeddable, false);
    assert.equal((await call("/api/tv/playback?channel=UCaaaaaaaaaaaaaaaaaaaaaa")).status, 404, "not one of ours");
    assert.equal((await call("/api/tv/playback?channel=nope")).status, 404);
    assert.equal((await call("/api/tv/playback?channel=" + CH, false)).status, 401);

    const replays = (await call("/api/tv/youtube")).data;
    assert.deepEqual(replays.videos.map((v) => v.id), ["DMrace00010", "cJA4RJ5teuw"], "newest first");
    const ids = replays.videos.map((v) => v.id);
    assert.equal(ids.includes("LIVEvideo01") || ids.includes("DMlive00001") || ids.includes("DMnext00001"), false, "live and scheduled streams aren't replays");
    const card = replays.videos.find((v) => v.id === "cJA4RJ5teuw");
    assert.deepEqual([card.kind, card.durationSec, card.wasLive, card.heading], ["card", 14520, true, "Saturday night card"]);
    assert.equal(replays.videos.find((v) => v.id === "DMrace00010").kind, "race");
    assert.equal(replays.channels.find((c) => c.id === CH2).breed, "Thoroughbred");
  } finally {
    yt.restore();
  }
});

test("live tracks: no key = no YouTube calls; a failing API leaves Live empty instead of failing /status", async () => {
  process.env.TV_YOUTUBE_CHANNELS = CH;
  const yt = mockYouTube({ apiUp: false });
  try {
    const off = await call("/api/tv/status");
    assert.deepEqual(off.data, { state: "off_air", title: null, startsAt: null, access: OPEN, featured: false, ...NO_YT });
    assert.equal(yt.calls.api + yt.calls.feed, 0);
    assert.equal((await call("/api/tv/playback?channel=" + CH)).status, 409, "listed but not live");

    process.env.YOUTUBE_API_KEY = KEY;
    const down = await call("/api/tv/status");
    assert.equal(down.status, 200);
    assert.equal(down.data.state, "off_air");
    assert.ok(yt.calls.api > 0);
    // The featured broadcast still shows while YouTube is down.
    process.env.TV_ON_AIR = "true";
    process.env.TV_STREAM_URL = STREAM;
    assert.equal((await call("/api/tv/status")).data.featured, true);
    assert.deepEqual(await youtubeStatus({ ...process.env, YOUTUBE_API_KEY: "" }), NO_YT);
  } finally {
    yt.restore();
  }
});
