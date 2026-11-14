// Stayblz Paddock: meetings (create/edit/delete, home list, who joins directly), live rooms (seats,
// long-poll sync, call-setup signals, state, chat, reactions), the waiting room (members + guests),
// host tools (admit, mute, remove, lock, co-hosts, end), the 8-person limit and quiet re-joins.
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
const rooms = require("../dist/lib/paddockRooms");

const host = "a1111111-1111-4111-8111-111111111111",
  invitee = "b2222222-2222-4222-8222-222222222222",
  stranger = "c3333333-3333-4333-8333-333333333333",
  teammate = "d4444444-4444-4444-8444-444444444444";
const extras = Array.from({ length: 8 }, (_, i) => `e${i}${i}${i}${i}${i}${i}${i}-5555-4555-8555-55555555555${i}`);
const people = {
  [host]: ["Hana", "Host"],
  [invitee]: ["Ivy", "Invitee"],
  [stranger]: ["Sam", "Stranger"],
  [teammate]: ["Tom", "Teammate"],
  ...Object.fromEntries(extras.map((id, i) => [id, ["Extra", String(i)]])),
};
const tokens = new Map();
let database, db, server, origin, stable;

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, [first, last]] of Object.entries(people)) {
    const email = `${first}.${last}@example.test`.toLowerCase();
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    await db.query("update accounts set email=$2, first_name=$3, last_name=$4 where id=$1", [id, email, first, last]);
    tokens.set(id, auth.createSession({ id, username: email, displayName: `${first} ${last}`, role: "member", email }));
  }
  stable = (await db.query("insert into member_stables(name, owner_id) values('Hill Stable',$1) returning id", [host])).rows[0].id;
  await db.query("insert into stable_memberships values($1,$2,'Hana Host','owner'),($1,$3,'Tom Teammate','member')", [stable, host, teammate]);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(who, path, { body, method, seat } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      ...(who ? { Authorization: "Bearer " + tokens.get(who) } : {}),
      ...(seat ? { "X-Paddock-Seat": seat } : {}),
      "Content-Type": "application/json",
    },
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
const peerId = () => "p" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
async function joinAs(who, code) {
  const id = peerId();
  const r = await call(who, `/api/paddock/${code}/join`, { body: { peerId: id } });
  return { ...r, peerId: id, seat: r.data?.seat };
}
const sync = (seat, body = {}) => call(null, "/api/paddock/live/sync", { body: { since: 0, ack: 0, feedSince: 0, wait: 0, ...body }, seat });
const hostTool = (seat, body) => call(null, "/api/paddock/live/host", { body, seat });

let meeting;

test("signed-out people can't use member routes; bad codes are simply 'not found'", async () => {
  assert.equal((await call(null, "/api/paddock")).status, 401);
  assert.equal((await call(host, "/api/paddock/NOT-A-CODE")).status, 404);
  assert.equal((await call(host, "/api/paddock/abcd-efgh")).data.code, "not_found");
  // A seat that doesn't exist (a restart, a long sleep) asks the browser to re-join.
  const r = await sync("f".repeat(64));
  assert.equal(r.status, 410);
  assert.equal(r.data.code, "expired");
});

test("create a meeting: checked input, readable code, invitees must be real accounts", async () => {
  let r = await call(host, "/api/paddock", { body: { title: "  " } });
  assert.equal(r.status, 400);
  r = await call(host, "/api/paddock", { body: { title: "Gallops", durationMinutes: 2 } });
  assert.match(r.data.error, /5 minutes and 8 hours/);
  r = await call(host, "/api/paddock", { body: { title: "Gallops", stableId: crypto.randomUUID() } });
  assert.match(r.data.error, /your stables/);

  r = await call(host, "/api/paddock", {
    body: {
      title: "  Saturday   gallops ",
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      durationMinutes: 45,
      access: "ask",
      inviteeIds: [invitee, host, crypto.randomUUID()],
    },
  });
  assert.equal(r.status, 201);
  meeting = r.data.meeting;
  assert.match(meeting.code, /^[a-hj-km-np-z]{4}-[a-hj-km-np-z]{4}$/);
  assert.equal(meeting.title, "Saturday gallops");
  assert.equal(meeting.role, "host");
  assert.equal(meeting.hostName, "Hana Host");
  assert.equal(meeting.live.count, 0);
  const row = (await db.query("select invitee_ids from paddock_meetings where id=$1", [meeting.id])).rows[0];
  assert.deepEqual(row.invitee_ids, [invitee]); // yourself and unknown ids are dropped
  // Only the host sees who's invited; nobody gets internal account ids.
  assert.deepEqual(meeting.invitees, [{ id: invitee, name: "Ivy Invitee" }]);
  assert.equal("hostId" in meeting || "cohostIds" in meeting, false);
  const asInvitee = (await call(invitee, `/api/paddock/${meeting.code}`)).data.meeting;
  assert.equal(asInvitee.invitees, null);
  assert.equal(JSON.stringify(asInvitee).includes(host), false);
});

test("home lists show hosted and invited meetings, never other people's", async () => {
  const mine = (await call(host, "/api/paddock")).data.meetings.map((m) => m.code);
  const theirs = (await call(invitee, "/api/paddock")).data;
  assert.deepEqual(mine, [meeting.code]);
  assert.deepEqual(theirs.meetings.map((m) => [m.code, m.role]), [[meeting.code, "invited"]]);
  assert.equal(theirs.maxPeople, 8);
  assert.deepEqual((await call(stranger, "/api/paddock")).data.meetings, []);
  // Anyone with the code sees what's needed to ask to join.
  const peek = (await call(stranger, `/api/paddock/${meeting.code}`)).data;
  assert.equal(peek.meeting.title, "Saturday gallops");
  assert.equal(peek.canJoin, false);
  assert.equal((await call(invitee, `/api/paddock/${meeting.code}`)).data.canJoin, true);
});

test("only the host edits or deletes", async () => {
  assert.equal((await call(invitee, `/api/paddock/${meeting.code}`, { method: "PATCH", body: { title: "Mine" } })).status, 403);
  assert.equal((await call(invitee, `/api/paddock/${meeting.code}`, { method: "DELETE" })).status, 403);
  const r = await call(host, `/api/paddock/${meeting.code}`, { method: "PATCH", body: { title: "Saturday gallops (team)" } });
  assert.equal(r.data.meeting.title, "Saturday gallops (team)");
});

let hostSeat, hostPeer, ivySeat, ivyPeer;

test("joining: seats, connection servers, and a long-poll that answers as soon as someone arrives", async () => {
  let r = await call(stranger, `/api/paddock/${meeting.code}/join`, { body: { peerId: peerId() } });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "ask");

  const h = await joinAs(host, meeting.code);
  assert.equal(h.status, 200);
  assert.equal(h.data.role, "host");
  assert.equal(h.data.maxPeople, 8);
  assert.equal(h.data.relay, false); // no relay key configured: free STUN only
  assert.ok(h.data.iceServers[0].urls.some((u) => u.startsWith("stun:")));
  hostSeat = h.seat;
  hostPeer = h.peerId;
  const first = await sync(hostSeat);
  assert.deepEqual(first.data.peers.map((p) => p.name), ["Hana Host"]);
  assert.equal(first.data.you.role, "host");

  // The host waits; Ivy joining wakes the wait almost immediately.
  const started = Date.now();
  const waiting = sync(hostSeat, { since: first.data.version, wait: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const i = await joinAs(invitee, meeting.code);
  ivySeat = i.seat;
  ivyPeer = i.peerId;
  const woke = await waiting;
  assert.ok(Date.now() - started < 2000, "the wait answered when Ivy arrived");
  assert.deepEqual(woke.data.peers.map((p) => p.name).sort(), ["Hana Host", "Ivy Invitee"]);
  assert.equal((await call(host, "/api/paddock")).data.meetings[0].live.count, 2);
  // Attendance is recorded.
  const seen = (await db.query("select account_id from paddock_attendance where meeting_id=$1 order by account_id", [meeting.id])).rows;
  assert.deepEqual(seen.map((s) => s.account_id), [host, invitee]);
});

test("call-setup signals go only to the right person, in order, until acknowledged", async () => {
  let r = await call(null, "/api/paddock/live/send", {
    seat: hostSeat,
    body: {
      signals: [
        { to: ivyPeer, type: "description", gen: 1, data: { type: "offer", sdp: "v=0..." } },
        { to: ivyPeer, type: "candidate", gen: 1, data: { candidate: "a" } },
        { to: "nobody-here-123", type: "candidate", gen: 1, data: {} },
      ],
    },
  });
  assert.deepEqual(r.data, { delivered: 2 });
  assert.equal((await call(null, "/api/paddock/live/send", { seat: hostSeat, body: { signals: [{ to: ivyPeer, type: "evil", gen: 1 }] } })).status, 400);
  assert.equal(
    (await call(null, "/api/paddock/live/send", { seat: hostSeat, body: { signals: [{ to: ivyPeer, type: "candidate", gen: 1, data: "x".repeat(30000) }] } })).status,
    400,
  );
  r = await sync(ivySeat);
  assert.deepEqual(r.data.signals.map((s) => [s.from, s.type, s.seq]), [[hostPeer, "description", 1], [hostPeer, "candidate", 2]]);
  assert.equal((await sync(hostSeat)).data.signals.length, 0);
  // Not acknowledged yet: delivered again. An ack for another inbox (after a restart) is ignored.
  const again = await sync(ivySeat, { ack: 2, epoch: "not-this-one" });
  assert.equal(again.data.signals.length, 2);
  // Acknowledged for this inbox: gone.
  assert.equal((await sync(ivySeat, { ack: 2, epoch: again.data.you.epoch })).data.signals.length, 0);
});

test("mic/camera/hand state, chat and reactions reach everyone; newcomers see chat only", async () => {
  await call(null, "/api/paddock/live/send", { seat: ivySeat, body: { state: { mic: true, cam: true, hand: true } } });
  let r = await sync(hostSeat);
  const ivy = r.data.peers.find((p) => p.id === ivyPeer);
  assert.equal(ivy.state.mic, true);
  assert.equal(typeof ivy.state.hand, "number");
  assert.equal((await call(null, "/api/paddock/live/send", { seat: ivySeat, body: { state: { mic: "yes" } } })).status, 400);

  assert.equal((await call(null, "/api/paddock/live/chat", { seat: hostSeat, body: { id: "msg-000001", text: "  Morning all  " } })).status, 201);
  await call(null, "/api/paddock/live/chat", { seat: hostSeat, body: { id: "msg-000001", text: "Morning all" } }); // same id: stored once
  assert.equal((await call(null, "/api/paddock/live/chat", { seat: hostSeat, body: { id: "msg-000002", text: "" } })).status, 400);
  assert.equal((await call(null, "/api/paddock/live/react", { seat: ivySeat, body: { emoji: "🐎" } })).status, 201);
  assert.equal((await call(null, "/api/paddock/live/react", { seat: ivySeat, body: { emoji: "💩" } })).status, 400);
  r = await sync(ivySeat, { feedSince: 1 });
  const kinds = r.data.feed.map((f) => [f.kind, f.text]);
  assert.ok(kinds.some(([k, t]) => k === "chat" && t === "Morning all"));
  assert.ok(kinds.some(([k, t]) => k === "reaction" && t === "🐎"));
  assert.equal(kinds.filter(([k]) => k === "chat").length, 1);
  // A first sync (feedSince 0) only carries the chat so far.
  const fresh = await sync(hostSeat, { feedSince: 0 });
  assert.deepEqual(fresh.data.feed.map((f) => f.kind), ["chat"]);
});

let knockId, knockToken;

test("waiting room: a member without access asks, the host sees it and lets them in", async () => {
  let r = await call(stranger, `/api/paddock/${meeting.code}/knock`, { body: {} });
  assert.equal(r.status, 201);
  ({ id: knockId, token: knockToken } = r.data.knock);
  // Asking twice is one request.
  assert.equal((await call(stranger, `/api/paddock/${meeting.code}/knock`, { body: {} })).data.knock.id, knockId);
  assert.deepEqual((await sync(hostSeat)).data.knocks.map((k) => [k.name, k.guest]), [["Sam Stranger", false]]);
  assert.deepEqual((await sync(ivySeat)).data.knocks, []); // only hosts see the list

  // Not admitted yet: waiting (and the host is here).
  const waitingStatus = call(null, `/api/paddock/live/knock/${knockId}`, { body: { token: knockToken, wait: 4000 } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await hostTool(ivySeat, { action: "admit", knock: knockId })).status, 403);
  assert.equal((await hostTool(hostSeat, { action: "admit", knock: knockId })).status, 200);
  const status = (await waitingStatus).data;
  assert.equal(status.status, "admitted");
  assert.equal((await call(null, `/api/paddock/live/knock/${knockId}`, { body: { token: "wrong", wait: 0 } })).status, 404);

  r = await call(null, `/api/paddock/live/knock/${knockId}/join`, { body: { token: knockToken, peerId: peerId() } });
  assert.equal(r.status, 200);
  assert.equal(r.data.role, "member");
  assert.ok(r.data.pass);
  // Admitted for this session: a direct join now works too (e.g. from a second tab).
  assert.equal((await call(stranger, `/api/paddock/${meeting.code}`)).data.canJoin, true);
  await call(null, "/api/paddock/live/leave", { body: { seat: r.data.seat } });
});

let guestPass;

test("guests: see the basics (no names), ask with a name, can be declined or let in", async () => {
  let r = await call(null, `/api/paddock/live/guest/${meeting.code}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.meeting.title, "Saturday gallops (team)");
  assert.equal(r.data.live.count, 2);
  assert.equal(JSON.stringify(r.data).includes("Ivy"), false);
  assert.equal((await call(null, `/api/paddock/live/guest/${meeting.code}/knock`, { body: { name: " " } })).status, 400);

  r = await call(null, `/api/paddock/live/guest/${meeting.code}/knock`, { body: { name: "  Gail​  Guest " } });
  assert.equal(r.status, 201);
  let { id, token } = r.data.knock;
  let knocksSeen = (await sync(hostSeat)).data.knocks;
  assert.deepEqual(knocksSeen.map((k) => [k.name, k.guest]), [["Gail Guest", true]]);
  await hostTool(hostSeat, { action: "deny", knock: id });
  assert.equal((await call(null, `/api/paddock/live/knock/${id}`, { body: { token, wait: 0 } })).data.status, "denied");
  assert.equal((await call(null, `/api/paddock/live/knock/${id}/join`, { body: { token, peerId: peerId() } })).status, 404);

  r = await call(null, `/api/paddock/live/guest/${meeting.code}/knock`, { body: { name: "Gail Guest" } });
  ({ id, token } = r.data.knock);
  assert.equal((await hostTool(hostSeat, { action: "admit-all" })).data.admitted, 1);
  r = await call(null, `/api/paddock/live/knock/${id}/join`, { body: { token, peerId: peerId() } });
  assert.equal(r.status, 200);
  assert.equal(r.data.role, "guest");
  guestPass = r.data.pass;
  const peers = (await sync(hostSeat)).data.peers;
  assert.ok(peers.some((p) => p.name === "Gail Guest" && p.guest));
  await call(null, "/api/paddock/live/leave", { body: { seat: r.data.seat } });
});

test("a return pass puts an admitted guest straight back in, even after a server restart", async () => {
  assert.equal((await call(null, "/api/paddock/live/rejoin", { body: { pass: guestPass + "x", peerId: peerId() } })).status, 403);
  rooms.resetRooms(); // what a restart does to memory
  const r = await call(null, "/api/paddock/live/rejoin", { body: { pass: guestPass, peerId: peerId() } });
  assert.equal(r.status, 200);
  assert.equal(r.data.role, "guest");
  const back = await sync(r.data.seat);
  assert.deepEqual(back.data.peers.map((p) => p.name), ["Gail Guest"]);
  // The host and Ivy re-join quietly with their same ids after the restart.
  const h = await call(host, `/api/paddock/${meeting.code}/join`, { body: { peerId: hostPeer } });
  const i = await call(invitee, `/api/paddock/${meeting.code}/join`, { body: { peerId: ivyPeer } });
  hostSeat = h.data.seat;
  ivySeat = i.data.seat;
  assert.equal(h.data.peerId, hostPeer);
  await call(null, "/api/paddock/live/leave", { body: { seat: r.data.seat } });
});

test("re-joining with the same id keeps the place; a reload replaces the old one", async () => {
  const before = (await sync(hostSeat)).data;
  const again = await call(invitee, `/api/paddock/${meeting.code}/join`, { body: { peerId: ivyPeer } });
  assert.equal(again.status, 200);
  assert.notEqual(again.data.seat, ivySeat);
  assert.equal((await sync(ivySeat)).data.code, "expired"); // the old seat stops working
  ivySeat = again.data.seat;
  assert.equal((await sync(hostSeat)).data.peers.length, before.peers.length);
  // A reload: new id, replacing the old one at once (no ghost tile), arriving with camera on.
  const reloadId = peerId();
  const reload = await call(invitee, `/api/paddock/${meeting.code}/join`, {
    body: { peerId: reloadId, replaces: ivyPeer, state: { mic: false, cam: true, hand: "yes" } },
  });
  ivySeat = reload.data.seat;
  ivyPeer = reloadId;
  const peers = (await sync(hostSeat)).data.peers;
  assert.equal(peers.filter((p) => p.name === "Ivy Invitee").length, 1);
  assert.equal(peers.find((p) => p.name === "Ivy Invitee").id, reloadId);
  // Only real true/false values count.
  assert.deepEqual(peers.find((p) => p.id === reloadId).state, { mic: false, cam: true, screen: false, hand: null });
});

test("host tools: mute asks that browser to mute; co-hosts can manage; remove keeps people out", async () => {
  await call(null, "/api/paddock/live/send", { seat: ivySeat, body: { state: { mic: true } } });
  assert.equal((await hostTool(hostSeat, { action: "mute", peer: ivyPeer })).status, 200);
  let r = await sync(ivySeat);
  assert.equal(r.data.you.state.mic, false);
  assert.deepEqual(r.data.signals.filter((s) => s.type === "control").map((s) => s.data.action), ["mute"]);

  // The host makes the teammate a co-host; the teammate (stable member) joins directly.
  const t = await joinAs(teammate, meeting.code);
  assert.equal(t.status, 403); // not linked to the stable yet
  await call(host, `/api/paddock/${meeting.code}`, { method: "PATCH", body: { stableId: stable } });
  const tom = await joinAs(teammate, meeting.code);
  assert.equal(tom.status, 200);
  assert.equal(tom.data.role, "member");
  assert.equal((await hostTool(tom.seat, { action: "lock", on: true })).status, 403);
  assert.equal((await hostTool(hostSeat, { action: "cohost", peer: tom.peerId, on: true })).status, 200);
  assert.equal((await sync(tom.seat)).data.you.role, "cohost");
  assert.equal((await hostTool(tom.seat, { action: "cohost", peer: ivyPeer, on: true })).status, 403); // host only

  // Removing Ivy: out now, can't come back directly or by asking.
  assert.equal((await hostTool(tom.seat, { action: "remove", peer: hostPeer })).status, 404); // nobody removes the host
  assert.equal((await hostTool(tom.seat, { action: "remove", peer: ivyPeer })).status, 200);
  r = await sync(ivySeat);
  assert.equal(r.status, 410);
  assert.equal(r.data.code, "removed");
  assert.equal((await joinAs(invitee, meeting.code)).data.code, "removed");
  assert.equal((await call(invitee, `/api/paddock/${meeting.code}/knock`, { body: {} })).data.code, "removed");
  assert.deepEqual((await call(invitee, "/api/paddock")).data.meetings, []);
  await call(null, "/api/paddock/live/leave", { body: { seat: tom.seat } });
});

test("lock stops new people; guests can be switched off; the call holds 8 people", async () => {
  assert.equal((await hostTool(hostSeat, { action: "lock", on: true })).status, 200);
  assert.equal((await call(stranger, `/api/paddock/${meeting.code}/knock`, { body: {} })).data.code, "locked");
  await call(host, `/api/paddock/${meeting.code}`, { method: "PATCH", body: { access: "open" } });
  assert.equal((await joinAs(extras[0], meeting.code)).data.code, "locked");
  // Co-hosts still get in (Tom was made co-host above).
  const tom = await joinAs(teammate, meeting.code);
  assert.equal(tom.status, 200);
  await call(null, "/api/paddock/live/leave", { body: { seat: tom.seat } });
  await hostTool(hostSeat, { action: "lock", on: false });

  await call(host, `/api/paddock/${meeting.code}`, { method: "PATCH", body: { guestsAllowed: false } });
  assert.equal((await call(null, `/api/paddock/live/guest/${meeting.code}/knock`, { body: { name: "Gus" } })).data.code, "guests_off");

  const seats = [];
  for (const id of extras.slice(0, 7)) {
    const r = await joinAs(id, meeting.code); // open: any signed-in member walks in
    assert.equal(r.status, 200, `extra ${id} joins`);
    seats.push(r.seat);
  }
  const ninth = await joinAs(extras[7], meeting.code);
  assert.equal(ninth.status, 409);
  assert.equal(ninth.data.code, "full");
  for (const seat of seats) await call(null, "/api/paddock/live/leave", { body: { seat } });
});

test("ending the call sends everyone out; deleting removes the meeting", async () => {
  const other = await joinAs(extras[0], meeting.code);
  assert.equal((await hostTool(other.seat, { action: "end" })).status, 403);
  const waiting = sync(other.seat, { since: (await sync(other.seat)).data.version, wait: 4000 });
  assert.equal((await hostTool(hostSeat, { action: "end" })).status, 200);
  const r = await waiting;
  assert.equal(r.status, 410);
  assert.equal(r.data.code, "ended");
  assert.equal((await sync(hostSeat)).data.code, "ended");
  // The link still works later: a new call can start.
  assert.equal((await joinAs(host, meeting.code)).status, 200);
  assert.equal((await call(host, `/api/paddock/${meeting.code}`, { method: "DELETE" })).status, 200);
  assert.equal((await call(host, `/api/paddock/${meeting.code}`)).status, 404);
});
