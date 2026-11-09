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
  admin = "22222222-2222-4222-8222-222222222222",
  superadmin = "33333333-3333-4333-8333-333333333333",
  guarded = "44444444-4444-4444-8444-444444444444";
const providerUsers = new Map();
let database, db, server, origin;
const originals = {};

// Access tokens are opaque to the API except for the 2-step level, which it reads
// only after the (stubbed) provider has verified the token.
const token = (id, aal = "aal1") =>
  "h." + Buffer.from(JSON.stringify({ sub: id, aal })).toString("base64url") + ".s";
const subject = (value) =>
  JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString()).sub;

async function call(id, path, { body, aal, method } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      Cookie: "stayblz_access=" + token(id, aal),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json(), response };
}

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  const people = [
    [customer, "customer@example.test", { first_name: "Casey<script>", last_name: "Buyer", country: "ph", racing_role: "fan" }],
    [admin, "admin@example.test", { first_name: "Ada", last_name: "Admin", country: "US", racing_role: "superadmin" }],
    [superadmin, "owner@example.test", { first_name: "Sam", last_name: "Super", country: "GB", racing_role: "owner" }],
    [guarded, "guarded@example.test", { first_name: "Gus", last_name: "Guarded", country: "PH", racing_role: "trainer" }],
  ];
  for (const [id, email, meta] of people) {
    await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)", [id, email, JSON.stringify(meta)]);
    providerUsers.set(id, {
      id,
      email,
      email_confirmed_at: "2026-11-01T00:00:00Z",
      app_metadata: {},
      user_metadata: meta,
      factors: [],
    });
  }
  // Roles can only be granted by the database owner (SQL editor).
  await db.query("select public.set_platform_role('ADMIN@example.test','admin')");
  await db.query("select public.set_platform_role('owner@example.test','superadmin')");
  originals.user = identity.user;
  originals.gotrue = identity.gotrue;
  originals.updateUserById = supabase.auth.admin.updateUserById;
  originals.listUsers = supabase.auth.admin.listUsers;
  identity.user = async (value) => {
    const user = providerUsers.get(subject(value));
    return user ? { data: { user }, error: null } : { data: { user: null }, error: { status: 401 } };
  };
  supabase.auth.admin.updateUserById = async () => ({ data: { user: {} }, error: null });
  supabase.auth.admin.listUsers = async () => ({ data: { users: [...providerUsers.values()] }, error: null });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  identity.user = originals.user;
  identity.gotrue = originals.gotrue;
  supabase.auth.admin.updateUserById = originals.updateUserById;
  supabase.auth.admin.listUsers = originals.listUsers;
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

test("every sign-in identity gets its own cleaned account row with the customer role", async () => {
  const { rows } = await db.query("select * from public.accounts where id=$1", [customer]);
  assert.equal(rows[0].platform_role, "customer");
  assert.equal(rows[0].first_name, "Caseyscript");
  assert.equal(rows[0].country, "", "invalid country codes are dropped");
  assert.equal(rows[0].racing_role, "fan");
  const admins = await db.query("select racing_role from public.accounts where id=$1", [admin]);
  assert.equal(admins.rows[0].racing_role, "", "a metadata 'superadmin' is not a racing role");
  const me = await call(customer, "/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.role, "member");
  assert.equal(me.data.user.platformRole, "member");
  assert.equal(me.data.user.displayName, "Caseyscript Buyer");
});

test("admin and superadmin access are separate tiers", async () => {
  assert.equal((await call(customer, "/api/admin/stables")).status, 403);
  assert.equal((await call(admin, "/api/admin/stables")).status, 200);
  assert.equal((await call(admin, "/api/admin/accounts")).status, 403);
  assert.equal((await call(admin, "/api/admin/events")).status, 403);
  const listed = await call(superadmin, "/api/admin/accounts");
  assert.equal(listed.status, 200);
  assert.equal(listed.data.accounts.length, 4);
  assert.equal(listed.data.accounts.find((a) => a.id === admin).role, "admin");
  assert.equal(listed.data.accounts[0].mfaEnabled, false);
});

test("View as lowers access until switched back, and can never raise it", async () => {
  let r = await call(admin, "/api/auth/view-as", { body: { role: "member" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, "member");
  assert.equal(r.data.user.platformRole, "admin");
  assert.equal(r.data.user.actingRole, "member");
  assert.equal((await call(admin, "/api/admin/stables")).status, 403);
  r = await call(admin, "/api/auth/view-as", { body: { role: "superadmin" } });
  assert.equal(r.status, 403);
  r = await call(customer, "/api/auth/view-as", { body: { role: "admin" } });
  assert.equal(r.status, 403);
  r = await call(admin, "/api/auth/view-as", { body: { role: "admin" } });
  assert.equal(r.data.user.actingRole, null);
  assert.equal((await call(admin, "/api/admin/stables")).status, 200);
  r = await call(superadmin, "/api/auth/view-as", { body: { role: "admin" } });
  assert.equal(r.data.user.role, "admin");
  assert.equal((await call(superadmin, "/api/admin/accounts")).status, 403);
  await call(superadmin, "/api/auth/view-as", { body: { role: "superadmin" } });
});

test("a superadmin can suspend and restore accounts, which applies on the next request", async () => {
  let r = await call(superadmin, `/api/admin/accounts/${guarded}/status`, { body: { status: "suspended", reason: "Spam" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.account.status, "suspended");
  r = await call(guarded, "/api/auth/me");
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "account_suspended");
  // Superadmins cannot be suspended through the website, nor can you suspend yourself.
  assert.equal((await call(superadmin, `/api/admin/accounts/${superadmin}/status`, { body: { status: "suspended" } })).status, 403);
  assert.equal((await call(admin, `/api/admin/accounts/${customer}/status`, { body: { status: "suspended" } })).status, 403);
  assert.equal((await call(superadmin, `/api/admin/accounts/not-a-uuid/status`, { body: { status: "suspended" } })).status, 400);
  r = await call(superadmin, `/api/admin/accounts/${guarded}/status`, { body: { status: "active" } });
  assert.equal(r.status, 200);
  assert.equal((await call(guarded, "/api/auth/me")).status, 200);
  const events = await call(superadmin, "/api/admin/events");
  const changes = events.data.events.filter((e) => e.event === "account.status_changed");
  assert.equal(changes.length, 2);
  assert.equal(changes[0].actorId, superadmin);
});

test("suspended accounts cannot start a session", async () => {
  await db.query("update public.accounts set status='suspended' where id=$1", [guarded]);
  const originalClient = identity.client;
  identity.client = () => ({
    auth: {
      signInWithPassword: async () => ({
        data: { user: providerUsers.get(guarded), session: { access_token: token(guarded), refresh_token: "r", expires_in: 3600 } },
        error: null,
      }),
    },
  });
  const originalSignOut = supabase.auth.admin.signOut;
  let revoked = 0;
  supabase.auth.admin.signOut = async () => { revoked++; return { error: null }; };
  try {
    const response = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "guarded@example.test", password: "unused" }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "account_suspended");
    assert.ok(response.headers.getSetCookie().every((c) => c.includes("Expires=Thu, 01 Jan 1970")));
    assert.equal(revoked, 1);
  } finally {
    identity.client = originalClient;
    supabase.auth.admin.signOut = originalSignOut;
    await db.query("update public.accounts set status='active' where id=$1", [guarded]);
  }
});

test("the old shared 'superadmin' username no longer signs anyone in", async () => {
  const response = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "superadmin", password: "anything" }),
  });
  assert.equal(response.status, 401);
});

test("with 2-step login on, a password-only session can do nothing until the code is entered", async () => {
  const user = providerUsers.get(customer);
  user.factors = [{ id: "factor-1", factor_type: "totp", status: "verified", created_at: "2026-11-09T00:00:00Z" }];
  const calls = [];
  identity.gotrue = async (path, _token, method, body) => {
    calls.push([path, method]);
    if (path.endsWith("/challenge")) return { ok: true, status: 200, data: { id: "challenge-1" } };
    if (path.endsWith("/verify"))
      return body.code === "123456"
        ? { ok: true, status: 200, data: { access_token: token(customer, "aal2"), refresh_token: "r2", expires_in: 3600, user } }
        : { ok: false, status: 422, data: { code: "mfa_verification_failed" } };
    return { ok: false, status: 404, data: {} };
  };
  try {
    let r = await call(customer, "/api/auth/me");
    assert.equal(r.status, 200);
    assert.equal(r.data.user.mfaPending, true);
    r = await call(customer, "/api/my-racing/notes");
    assert.equal(r.status, 403);
    assert.equal(r.data.code, "mfa_required");
    r = await call(customer, "/api/auth/mfa/verify", { body: { code: "000000" } });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, "mfa_invalid");
    r = await call(customer, "/api/auth/mfa/verify", { body: { code: "12345" } });
    assert.equal(r.status, 400);
    r = await call(customer, "/api/auth/mfa/verify", { body: { code: "123456" } });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.mfaPending, false);
    assert.equal(r.data.user.mfa.verified, true);
    assert.equal(r.response.headers.getSetCookie().filter((c) => /^stayblz_(access|refresh)=/.test(c)).length, 2);
    assert.notEqual((await call(customer, "/api/my-racing/notes", { aal: "aal2" })).status, 403);
    const events = (await db.query("select event from public.account_events where account_id=$1", [customer])).rows.map((e) => e.event);
    assert.ok(events.includes("auth.mfa_failed"));
    assert.ok(events.includes("auth.mfa_passed"));
  } finally {
    user.factors = [];
    identity.gotrue = originals.gotrue;
  }
});

test("REQUIRE_STAFF_MFA makes 2-step login mandatory for administration only", async () => {
  process.env.REQUIRE_STAFF_MFA = "true";
  try {
    const r = await call(admin, "/api/admin/stables");
    assert.equal(r.status, 403);
    assert.equal(r.data.code, "mfa_setup_required");
    assert.equal((await call(admin, "/api/auth/me")).status, 200);
    assert.equal((await call(admin, "/api/admin/stables", { aal: "aal2" })).status, 200);
  } finally {
    delete process.env.REQUIRE_STAFF_MFA;
  }
});

test("the activity log is append-only and the server key cannot grant roles", async () => {
  await assert.rejects(db.query("update public.account_events set event='edited'"), /append-only/);
  await assert.rejects(db.query("delete from public.account_events"), /append-only/);
  await db.exec("set role service_role");
  try {
    await assert.rejects(db.query("update public.accounts set platform_role='superadmin' where id=$1", [customer]), /permission denied/);
    await assert.rejects(db.query("insert into public.accounts(id) values($1)", [customer]), /permission denied/);
    await assert.rejects(db.query("select public.set_platform_role('customer@example.test','superadmin')"), /permission denied/);
    // The checked functions are still available to it.
    const { rows } = await db.query("select platform_role from public.ensure_account($1)", [customer]);
    assert.equal(rows[0].platform_role, "customer");
  } finally {
    await db.exec("reset role");
  }
  await db.exec("set role anon");
  try {
    await assert.rejects(db.query("select * from public.accounts"), /permission denied/);
    await assert.rejects(db.query("select public.ensure_account($1)", [customer]), /permission denied/);
  } finally {
    await db.exec("reset role");
  }
});

test("tables created later get row level security automatically", async () => {
  await db.exec("create table public.future_feature(id int)");
  const { rows } = await db.query("select relrowsecurity from pg_class where oid='public.future_feature'::regclass");
  assert.equal(rows[0].relrowsecurity, true);
  await db.exec("drop table public.future_feature");
});

test("the superadmin profile is locked, while other profiles can still be edited", async () => {
  const body = { firstName: "Renamed", lastName: "Boss", country: "PH", racingRole: "fan" };
  const locked = await call(superadmin, "/api/auth/profile", { body, method: "PATCH" });
  assert.equal(locked.status, 403);
  assert.equal(locked.data.code, "profile_locked");
  // "View as: Customer" must not unlock it.
  await call(superadmin, "/api/auth/view-as", { body: { role: "member" } });
  assert.equal((await call(superadmin, "/api/auth/profile", { body, method: "PATCH" })).status, 403);
  await call(superadmin, "/api/auth/view-as", { body: { role: "superadmin" } });
  const { rows } = await db.query("select first_name from public.accounts where id=$1", [superadmin]);
  assert.equal(rows[0].first_name, "Sam");
  const ok = await call(admin, "/api/auth/profile", { body, method: "PATCH" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.displayName, "Renamed Boss");
});

test("finishing 2-step set-up reports it as on even if the verify response omits the factor", async () => {
  const user = providerUsers.get(guarded);
  user.factors = [{ id: "factor-new", factor_type: "totp", status: "unverified", created_at: "2026-11-09T00:00:00Z" }];
  const originalGet = supabase.auth.admin.getUserById;
  identity.gotrue = async (path) => {
    if (path.endsWith("/challenge")) return { ok: true, status: 200, data: { id: "c" } };
    // Response user has no factor list at all.
    return { ok: true, status: 200, data: { access_token: token(guarded, "aal2"), refresh_token: "r", expires_in: 3600, user: { ...user, factors: undefined } } };
  };
  supabase.auth.admin.getUserById = async () => ({
    data: { user: { ...user, factors: [{ ...user.factors[0], status: "verified" }] } },
    error: null,
  });
  try {
    const r = await call(guarded, "/api/auth/mfa/verify", { body: { code: "123456", factorId: "factor-new" } });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.mfa.enabled, true);
    assert.equal(r.data.user.mfaPending, false);
  } finally {
    user.factors = [];
    identity.gotrue = originals.gotrue;
    supabase.auth.admin.getUserById = originalGet;
  }
});

test("sign-up details (community roles, Terms) are copied once into the new account", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const meta = {
    first_name: "Fia", last_name: "Farrier", country: "IE", racing_role: "farrier",
    community_roles: ["vet", "farrier", "wizard", "media", "breeder", "owner"],
    organisation: "Kildare Forge", city: "Naas",
    terms_version: "2026-11-10", terms_accepted_at: "2026-11-10T08:00:00Z", marketing_opt_in: true,
  };
  await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)", [id, "fia@example.test", JSON.stringify(meta)]);
  const { rows } = await db.query("select * from public.accounts where id=$1", [id]);
  assert.equal(rows[0].racing_role, "farrier");
  assert.equal(rows[0].community_roles.length, 3, "at most three extra roles, primary and unknown roles dropped");
  assert.ok(!rows[0].community_roles.includes("farrier") && !rows[0].community_roles.includes("wizard"));
  assert.equal(rows[0].organisation, "Kildare Forge");
  assert.equal(rows[0].terms_version, "2026-11-10");
  assert.ok(rows[0].terms_accepted_at);
  assert.equal(rows[0].marketing_opt_in, true);
  assert.equal(rows[0].updates_popup, true);
  assert.equal(rows[0].updates_seen_at, null);
});

test("profiles save community roles, organisation, city and bio with validation", async () => {
  const body = {
    firstName: "Casey", lastName: "Buyer", country: "PH", racingRole: "owner",
    communityRoles: ["syndicate", "fan"], organisation: "Manila Racing Club", city: "Manila",
    bio: "Part-owner of two sprinters.\nAlways at the track on Sundays.",
  };
  const r = await call(customer, "/api/auth/profile", { body, method: "PATCH" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.user.profile.communityRoles, ["syndicate", "fan"]);
  assert.equal(r.data.user.profile.organisation, "Manila Racing Club");
  assert.match(r.data.user.profile.bio, /Sundays/);
  for (const bad of [
    { ...body, communityRoles: ["owner"] },
    { ...body, communityRoles: ["fan", "vet", "media", "breeder"] },
    { ...body, bio: "<script>" },
    { ...body, bio: "x".repeat(281) },
  ])
    assert.equal((await call(customer, "/api/auth/profile", { body: bad, method: "PATCH" })).status, 400);
});

test("preferences save per account and reject bad values", async () => {
  let r = await call(customer, "/api/auth/me");
  const firstSeen = r.data.user.preferences.updatesSeenAt;
  assert.ok(Date.parse(firstSeen) < Date.now() - 6 * 864e5, "unread counts start a week before sign-up");
  r = await call(customer, "/api/auth/preferences", { body: { updatesSeen: true, updatesPopup: false }, method: "PATCH" });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.preferences.updatesPopup, false);
  assert.ok(Date.parse(r.data.user.preferences.updatesSeenAt) > Date.now() - 60_000, "seen time is the server's now");
  r = await call(customer, "/api/auth/preferences", { body: { marketingOptIn: true }, method: "PATCH" });
  assert.equal(r.data.user.preferences.marketingOptIn, true);
  assert.equal(r.data.user.preferences.updatesPopup, false);
  for (const bad of [{ updatesSeen: "2030-01-01T00:00:00Z" }, { updatesSeen: false }, { updatesPopup: "no" }, { marketingOptIn: 1 }])
    assert.equal((await call(customer, "/api/auth/preferences", { body: bad, method: "PATCH" })).status, 400);
});

test("'This wasn't me' removes a brand-new customer sign-up but never staff accounts", async () => {
  const id = "66666666-6666-4666-8666-666666666666";
  await db.query("insert into auth.users(id,email) values($1,$2)", [id, "victim@example.test"]);
  const originalClient = identity.client;
  const originalDelete = supabase.auth.admin.deleteUser;
  const originalSignOut = supabase.auth.admin.signOut;
  const deleted = [];
  let verifiedUser;
  identity.client = () => ({
    auth: {
      verifyOtp: async ({ token_hash }) =>
        token_hash === "used-token-hash-0000"
          ? { data: {}, error: { status: 403, code: "otp_expired" } }
          : { data: { user: verifiedUser, session: { access_token: "a.b.c" } }, error: null },
    },
  });
  supabase.auth.admin.deleteUser = async (userId) => { deleted.push(userId); return { error: null }; };
  supabase.auth.admin.signOut = async () => ({ error: null });
  const notMe = (tokenHash) =>
    fetch(origin + "/api/auth/not-me", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenHash }) });
  try {
    verifiedUser = { id, created_at: new Date().toISOString() };
    let r = await notMe("fresh-token-hash-0000");
    assert.equal(r.status, 200);
    assert.equal(r.headers.getSetCookie().length, 0, "never signs the person in");
    assert.deepEqual(deleted, [id]);
    const events = await db.query("select event from public.account_events where account_id=$1", [id]);
    assert.ok(events.rows.some((e) => e.event === "account.disowned"));
    verifiedUser = { id: admin, created_at: new Date().toISOString() };
    r = await notMe("fresh-token-hash-0001");
    assert.equal(r.status, 409);
    verifiedUser = { id: customer, created_at: "2026-01-01T00:00:00Z" };
    assert.equal((await notMe("fresh-token-hash-0002")).status, 409, "old accounts are not removed");
    assert.equal((await notMe("used-token-hash-0000")).status, 400);
    assert.equal((await notMe("short")).status, 400);
    assert.deepEqual(deleted, [id]);
  } finally {
    identity.client = originalClient;
    supabase.auth.admin.deleteUser = originalDelete;
    supabase.auth.admin.signOut = originalSignOut;
  }
});
