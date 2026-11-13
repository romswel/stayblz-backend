// 6-digit email codes: per-address limits, password reset errors, and where email links point.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only-placeholder";
process.env.NODE_ENV = "test";
// Render mode: the app trusts one proxy hop, so X-Forwarded-For stands in for different visitors.
process.env.RENDER = "true";
process.env.FRONTEND_URL = "https://stayblz-app.com";
const { app } = require("../dist/app");
const { identity } = require("../dist/lib/identity");
const { accountStore } = require("../dist/lib/accounts");
const site = require("../dist/lib/site");

let server, origin;
const originalStore = { ...accountStore };
const member = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "member@example.test",
  email_confirmed_at: "2026-11-01T00:00:00Z",
  app_metadata: {},
  user_metadata: {},
};
before(async () => {
  accountStore.load = async (id) => ({
    id,
    email: member.email,
    first_name: "Member",
    last_name: "User",
    country: "PH",
    racing_role: "trainer",
    platform_role: "customer",
    acting_role: null,
    status: "active",
    status_reason: "",
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  });
  accountStore.record = async () => {};
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(() => {
  Object.assign(accountStore, originalStore);
  return new Promise((resolve) => server.close(resolve));
});
const from = (ip, body, extra = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Forwarded-For": ip, ...extra },
  body: JSON.stringify(body),
});
function mockClient(auth) {
  const original = identity.client;
  identity.client = () => ({ auth });
  return () => {
    identity.client = original;
  };
}

test("code guesses for one address are capped even when they come from different networks", async () => {
  let checks = 0;
  const restore = mockClient({
    verifyOtp: async () => {
      checks++;
      return { data: {}, error: { status: 403, code: "otp_expired", message: "expired" } };
    },
  });
  try {
    const guess = (ip, email = "target@example.test") =>
      fetch(origin + "/api/auth/confirm", from(ip, { email, code: "111111", type: "recovery" }));
    for (let i = 1; i <= 5; i++) {
      const r = await guess(`203.0.113.${i}`);
      assert.equal(r.status, 400, `guess ${i}`);
      assert.equal((await r.json()).code, "code_invalid");
    }
    const blocked = await guess("203.0.113.99");
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, "auth_rate_limited");
    assert.ok(Number(blocked.headers.get("Retry-After")) > 0);
    assert.equal(checks, 5, "the blocked guess never reaches the provider");
    // Same address in other letter case is the same address.
    assert.equal((await guess("203.0.113.100", " Target@Example.test ")).status, 429);
    // Other people are unaffected.
    assert.equal((await guess("203.0.113.101", "someone@example.test")).status, 400);
  } finally {
    restore();
  }
});

test("emailed links are not limited by the code cap", async () => {
  const restore = mockClient({
    verifyOtp: async () => ({ data: {}, error: { status: 403, code: "otp_expired", message: "expired" } }),
  });
  try {
    for (let i = 0; i < 6; i++) {
      const r = await fetch(
        origin + "/api/auth/confirm",
        from(`198.51.100.${i}`, { tokenHash: "x".repeat(40), type: "recovery", email: "links@example.test" }),
      );
      assert.equal(r.status, 400);
    }
  } finally {
    restore();
  }
});

test("one inbox can't be flooded with codes requested from many networks", async () => {
  const sent = [];
  const restore = mockClient({
    resend: async ({ email }) => {
      sent.push(email);
      return { error: null };
    },
    resetPasswordForEmail: async (email) => {
      sent.push(email);
      return { error: null };
    },
  });
  try {
    const ask = (path, ip) =>
      fetch(origin + "/api/auth/" + path, from(ip, { email: "victim@example.test" }));
    assert.equal((await ask("resend", "192.0.2.1")).status, 202);
    assert.equal((await ask("forgot-password", "192.0.2.2")).status, 202);
    assert.equal((await ask("resend", "192.0.2.3")).status, 202);
    const blocked = await ask("forgot-password", "192.0.2.4");
    assert.equal(blocked.status, 429);
    assert.equal(sent.length, 3);
    assert.equal(
      (await fetch(origin + "/api/auth/resend", from("192.0.2.5", { email: "other@example.test" }))).status,
      202,
    );
  } finally {
    restore();
  }
});

test("a reset explains a reused or weak password instead of asking for a new email", async () => {
  const originalUser = identity.user;
  const originalFetch = global.fetch;
  let reason = "same_password";
  identity.user = async () => ({ data: { user: member }, error: null });
  global.fetch = (url, options) =>
    String(url).endsWith("/auth/v1/user") && options?.method === "PUT"
      ? Promise.resolve(
          new Response(JSON.stringify({ code: 422, error_code: reason, msg: "provider text never shown" }), {
            status: 422,
          }),
        )
      : originalFetch(url, options);
  try {
    const change = () =>
      fetch(
        origin + "/api/auth/password",
        from("192.0.2.50", { password: "NewTestOnlyPassword123", confirmPassword: "NewTestOnlyPassword123" }, {
          Cookie: "stayblz_access=fixture.payload.signature",
        }),
      );
    let r = await change();
    assert.equal(r.status, 400);
    let body = await r.json();
    assert.equal(body.code, "same_password");
    assert.doesNotMatch(body.error, /provider text/);
    // The session is kept so the person can try another password without a new code.
    assert.equal(r.headers.getSetCookie().filter((c) => /^stayblz_(access|refresh)=;/.test(c)).length, 0);
    reason = "weak_password";
    body = await (await change()).json();
    assert.equal(body.code, "weak_password");
    reason = "something_else";
    body = await (await change()).json();
    assert.equal(body.code, undefined);
    assert.match(body.error, /could not be changed/);
  } finally {
    identity.user = originalUser;
    global.fetch = originalFetch;
  }
});

test("email links and allowed origins default to the Stayblz domain, never the old Vercel address", () => {
  const saved = { ...process.env };
  try {
    delete process.env.FRONTEND_URL;
    delete process.env.AUTH_SITE_URL;
    process.env.RENDER = "true";
    assert.deepEqual(site.frontendOrigins(), ["https://stayblz-app.com"]);
    assert.equal(site.siteOrigin(), "https://stayblz-app.com");
    process.env.RENDER = "false";
    process.env.NODE_ENV = "development";
    assert.deepEqual(site.frontendOrigins(), ["http://localhost:5173"]);
    process.env.FRONTEND_URL = " https://stayblz-app.com/ , http://localhost:5173 ,";
    assert.deepEqual(site.frontendOrigins(), ["https://stayblz-app.com", "http://localhost:5173"]);
    assert.equal(site.siteOrigin(), "https://stayblz-app.com");
    process.env.AUTH_SITE_URL = "https://stayblz-app.com/";
    assert.equal(site.siteOrigin(), "https://stayblz-app.com");
  } finally {
    for (const key of ["FRONTEND_URL", "AUTH_SITE_URL", "RENDER", "NODE_ENV"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
