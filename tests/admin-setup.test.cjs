const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only-placeholder";
process.env.NODE_ENV = "test";
process.env.ENABLE_PUBLIC_DEMO = "false";
delete process.env.SUPERADMIN_EMAIL;
const { app } = require("../dist/app");
const { supabase } = require("../dist/lib/supabase");
const { identity, resolveEmail } = require("../dist/lib/identity");

test("pending trusted admin alias reports incomplete setup without issuing a session", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const originalList = supabase.auth.admin.listUsers;
  const originalClient = identity.client;
  let users = [
    {
      id: "member",
      email: "member@example.test",
      app_metadata: {},
      user_metadata: { role: "superadmin" },
    },
  ];
  let passwordRequests = 0;
  supabase.auth.admin.listUsers = async () => ({
    data: { users },
    error: null,
  });
  identity.client = () => ({
    auth: {
      signInWithPassword: async () => {
        passwordRequests++;
        throw new Error(
          "Should not request a password session during pending setup",
        );
      },
    },
  });
  try {
    const call = () =>
      fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "SuperAdmin",
          password: "test-placeholder",
        }),
      });
    let response = await call();
    assert.equal(response.status, 401);
    users = [
      {
        id: "admin",
        email: "admin@example.test",
        app_metadata: { stayblz_role: "superadmin" },
        user_metadata: {},
      },
    ];
    response = await call();
    const body = await response.json();
    assert.equal(response.status, 403);
    assert.equal(body.code, "admin_setup_required");
    assert.match(body.error, /invitation.*password/);
    assert.ok(!JSON.stringify(body).includes("admin@example.test"));
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(passwordRequests, 0);
    users[0].email_confirmed_at = "2026-11-02T00:00:00Z";
    assert.equal(await resolveEmail("superadmin"), "admin@example.test");
  } finally {
    supabase.auth.admin.listUsers = originalList;
    identity.client = originalClient;
    await new Promise((resolve) => server.close(resolve));
  }
});
