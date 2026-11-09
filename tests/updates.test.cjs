const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "false";
const { app } = require("../dist/app");
const { supabase } = require("../dist/lib/supabase");
const { identity } = require("../dist/lib/identity");
const { installDatabase } = require("./support/pgrest.cjs");

const customer = "11111111-1111-4111-8111-111111111111",
  admin = "22222222-2222-4222-8222-222222222222";
const providerUsers = new Map();
let database, db, server, origin;
const originals = {};
const token = (id) => "h." + Buffer.from(JSON.stringify({ sub: id, aal: "aal1" })).toString("base64url") + ".s";
const subject = (value) => JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()).sub;

async function call(id, path, { body, method, cookie } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(id ? { Cookie: "stayblz_access=" + token(id) } : cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}
const post = (over = {}) => ({
  kind: "update",
  title: "Faster racecards",
  summary: "Racecards load quicker.",
  body: "## What changed\n\n- Lists open **twice** as fast.\n- [Read the FAQ](https://stayblz-frontend.vercel.app/faq)",
  items: [{ tag: "improved", text: "Racecards open faster." }],
  version: "0.9",
  status: "published",
  ...over,
});

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, email] of [
    [customer, "customer@example.test"],
    [admin, "admin@example.test"],
  ]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    providerUsers.set(id, { id, email, email_confirmed_at: "2026-11-01T00:00:00Z", app_metadata: {}, user_metadata: {}, factors: [] });
  }
  await db.query("select public.ensure_account($1)", [admin]);
  await db.query("select public.set_platform_role('admin@example.test','admin')");
  originals.user = identity.user;
  identity.user = async (value) => {
    const user = providerUsers.get(subject(value));
    return user ? { data: { user }, error: null } : { data: { user: null }, error: { status: 401 } };
  };
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  identity.user = originals.user;
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

test("only admins can write Updates; drafts stay hidden from readers", async () => {
  assert.equal((await call(null, "/api/admin/updates", { body: post() })).status, 401);
  assert.equal((await call(customer, "/api/admin/updates", { body: post() })).status, 403);
  assert.equal((await call(customer, "/api/admin/updates")).status, 403);
  const draft = await call(admin, "/api/admin/updates", { body: post({ title: "Secret plans", status: "draft" }) });
  assert.equal(draft.status, 201);
  assert.equal(draft.data.update.slug, "secret-plans");
  assert.equal(draft.data.update.publishedAt, null);
  assert.equal((await call(null, "/api/updates/secret-plans")).status, 404);
  assert.equal((await call(customer, "/api/updates")).data.updates.length, 0);
  const listed = await call(admin, "/api/admin/updates");
  assert.equal(listed.data.updates.length, 1);
  assert.equal(listed.data.updates[0].status, "draft");
  // "View as: Customer" removes posting rights too.
  await db.query("select public.set_account_acting_role($1,'customer')", [admin]);
  assert.equal((await call(admin, "/api/admin/updates", { body: post() })).status, 403);
  await db.query("update public.accounts set acting_role = null where id = $1", [admin]);
});

test("published posts reach guests and members; members-only posts need an account", async () => {
  const pub = await call(admin, "/api/admin/updates", { body: post() });
  assert.equal(pub.status, 201);
  assert.ok(pub.data.update.publishedAt);
  const members = await call(admin, "/api/admin/updates", {
    body: post({ kind: "announcement", title: "Team notes", audience: "members", pinned: true, items: [], summary: "Inside info." }),
  });
  assert.equal(members.status, 201);
  const guest = await call(null, "/api/updates");
  assert.equal(guest.status, 200);
  assert.deepEqual(guest.data.updates.map((u) => u.slug), ["faster-racecards"]);
  assert.equal(guest.data.signedIn, false);
  assert.equal(guest.data.updates[0].body, undefined, "lists leave the long text out");
  // A broken or expired cookie still gets the public feed.
  const stale = await call(null, "/api/updates", { cookie: "stayblz_access=not.a.token" });
  assert.equal(stale.status, 200);
  assert.equal(stale.data.updates.length, 1);
  const member = await call(customer, "/api/updates");
  assert.equal(member.data.signedIn, true);
  assert.deepEqual(member.data.updates.map((u) => u.slug).sort(), ["faster-racecards", "team-notes"]);
  assert.deepEqual(member.data.pinned.map((u) => u.slug), ["team-notes"]);
  assert.equal((await call(null, "/api/updates/team-notes")).status, 404);
  const detail = await call(customer, "/api/updates/faster-racecards");
  assert.equal(detail.status, 200);
  assert.match(detail.data.update.body, /twice/);
  assert.equal(detail.data.newer.slug, "team-notes");
  assert.equal(detail.data.older, null);
});

test("readers can filter by type, search and page through older posts", async () => {
  for (let i = 1; i <= 3; i++)
    assert.equal(
      (
        await call(admin, "/api/admin/updates", {
          body: post({ title: `Maintenance window ${i}`, kind: "maintenance", publishedAt: `2026-10-0${i}T10:00:00Z`, items: [], body: "" }),
        })
      ).status,
      201,
    );
  const kind = await call(null, "/api/updates?kind=maintenance&limit=2");
  assert.deepEqual(kind.data.updates.map((u) => u.slug), ["maintenance-window-3", "maintenance-window-2"]);
  assert.equal(kind.data.hasMore, true);
  const older = await call(null, "/api/updates?kind=maintenance&limit=2&before=" + encodeURIComponent(kind.data.updates[1].publishedAt));
  assert.deepEqual(older.data.updates.map((u) => u.slug), ["maintenance-window-1"]);
  assert.equal(older.data.hasMore, false);
  const search = await call(null, "/api/updates?q=twice");
  assert.deepEqual(search.data.updates.map((u) => u.slug), ["faster-racecards"], "search reads the post text");
  assert.equal((await call(null, "/api/updates?q=100%25")).data.updates.length, 0, "wildcards are plain text");
  for (const bad of ["?kind=gossip", "?limit=500", "?before=yesterday"])
    assert.equal((await call(null, "/api/updates" + bad)).status, 400);
});

test("posts are validated, editing keeps the date, and changes are audited", async () => {
  for (const bad of [
    post({ title: "" }),
    post({ title: "<img src=x>" }),
    post({ body: "<script>alert(1)</script>" }),
    post({ kind: "gossip" }),
    post({ items: [{ tag: "hype", text: "x" }] }),
    post({ slug: "Bad Slug" }),
    post({ summary: "", body: "", items: [] }),
  ])
    assert.equal((await call(admin, "/api/admin/updates", { body: bad })).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await call(admin, "/api/admin/updates", { body: post() })).status, 409, "web addresses are unique");
  const list = (await call(admin, "/api/admin/updates")).data.updates;
  const original = list.find((u) => u.slug === "faster-racecards");
  const edited = await call(admin, "/api/admin/updates/" + original.id, {
    method: "PUT",
    body: post({ title: "Faster racecards and results", slug: "faster-racecards" }),
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.update.title, "Faster racecards and results");
  assert.equal(edited.data.update.publishedAt, original.publishedAt);
  const archived = await call(admin, "/api/admin/updates/" + original.id, { method: "PUT", body: post({ status: "archived" }) });
  assert.equal(archived.status, 200);
  assert.equal((await call(null, "/api/updates/faster-racecards")).status, 404, "archived posts leave the feed");
  assert.equal((await call(customer, "/api/admin/updates/" + original.id, { method: "DELETE" })).status, 403);
  assert.equal((await call(admin, "/api/admin/updates/" + original.id, { method: "DELETE" })).status, 200);
  assert.equal((await call(admin, "/api/admin/updates/" + original.id, { method: "DELETE" })).status, 404);
  const { rows } = await db.query(
    "select event from public.account_events where actor_id=$1 and event like 'update.%' order by id",
    [admin],
  );
  const events = rows.map((r) => r.event);
  assert.ok(events.includes("update.created") && events.includes("update.edited") && events.includes("update.deleted"));
});

test("the release script can publish without an admin session; readers never can", async () => {
  const { rows } = await db.query("select public.save_site_update(null, null, $1::jsonb) as saved", [
    JSON.stringify({ slug: "release-notes", kind: "update", title: "Release notes", summary: "Hi", status: "published" }),
  ]);
  assert.equal(rows[0].saved.authorLabel, "Stayblz team");
  await assert.rejects(
    db.query("select public.save_site_update($1, null, $2::jsonb)", [
      customer,
      JSON.stringify({ slug: "x", kind: "news", title: "x", status: "draft" }),
    ]),
    /not_allowed/,
  );
  const grants = await db.query(
    "select has_table_privilege('anon','public.site_updates','select') a, has_table_privilege('authenticated','public.site_updates','select') b, has_table_privilege('service_role','public.site_updates','insert') c",
  );
  assert.deepEqual(grants.rows[0], { a: false, b: false, c: false });
});
