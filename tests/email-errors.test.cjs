const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only-placeholder";
process.env.NODE_ENV = "test";
process.env.RENDER = "true";
const { app } = require("../dist/app");
const { identity } = require("../dist/lib/identity");
let server,
  origin,
  requestId = 0;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));
const profile = {
  firstName: "Email",
  lastName: "Test",
  country: "PH",
  racingRole: "fan",
  email: "authorized@example.test",
  password: "TestOnlyPassword123",
  confirmPassword: "TestOnlyPassword123",
  acceptTerms: true,
  ageConfirmed: true,
  termsVersion: "2026-11-10",
};
const post = (body, ip) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Forwarded-For": ip ?? `203.0.113.${++requestId}`,
  },
  body: JSON.stringify(body),
});

test("signup, resend and reset report recipient restrictions and provider rate limits", async () => {
  const originalClient = identity.client,
    originalFetch = global.fetch;
  let error;
  identity.client = () => ({
    auth: {
      signUp: async () => ({ error }),
      resend: async () => ({ error }),
      resetPasswordForEmail: async () => ({ error }),
    },
  });
  global.fetch = (url, options) =>
    String(url).endsWith("/auth/v1/settings")
      ? Promise.resolve(
          new Response(JSON.stringify({ mailer_autoconfirm: false }), {
            status: 200,
          }),
        )
      : originalFetch(url, options);
  try {
    for (const endpoint of ["signup", "resend", "forgot-password"])
      for (const code of [
        "email_address_not_authorized",
        "over_email_send_rate_limit",
        "over_request_rate_limit",
      ]) {
        error = {
          code,
          status: code === "email_address_not_authorized" ? 422 : 429,
          message: "private-provider-details",
        };
        const response = await fetch(
          origin + "/api/auth/" + endpoint,
          post(endpoint === "signup" ? profile : { email: profile.email }),
        );
        const body = await response.json();
        assert.equal(
          response.status,
          code === "email_address_not_authorized" ? 403 : 429,
        );
        assert.equal(body.code, code);
        assert.equal(body.ok, undefined);
        assert.ok(!JSON.stringify(body).includes("private-provider-details"));
        if (code === "email_address_not_authorized")
          assert.match(body.error, /authorized organization email/);
        else {
          assert.equal(response.headers.get("retry-after"), "60");
          assert.equal(body.retryAfterSeconds, 60);
        }
      }
  } finally {
    identity.client = originalClient;
    global.fetch = originalFetch;
  }
});
test("unknown addresses keep generic responses while delivery failures never claim success", async () => {
  const original = identity.client;
  let failure;
  identity.client = () => ({
    auth: {
      resend: async () => ({ error: failure }),
      resetPasswordForEmail: async () => ({ error: failure }),
    },
  });
  try {
    for (const endpoint of ["resend", "forgot-password"]) {
      failure = { code: "user_not_found", status: 404 };
      let response = await fetch(
        origin + "/api/auth/" + endpoint,
        post({ email: profile.email }),
      );
      assert.equal(response.status, 202);
      assert.match((await response.json()).message, /If the address/);
      failure = {
        code: "unexpected_failure",
        status: 500,
        message: "secret SMTP password",
      };
      response = await fetch(
        origin + "/api/auth/" + endpoint,
        post({ email: profile.email }),
      );
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.ok, undefined);
      assert.ok(!JSON.stringify(body).includes("secret SMTP password"));
    }
  } finally {
    identity.client = original;
  }
});

test("thrown provider delivery errors retain safe recipient and quota classification", async () => {
  const originalClient = identity.client,
    originalFetch = global.fetch;
  let failure;
  const fail = async () => {
    throw failure;
  };
  identity.client = () => ({
    auth: { signUp: fail, resend: fail, resetPasswordForEmail: fail },
  });
  global.fetch = (url, options) =>
    String(url).endsWith("/auth/v1/settings")
      ? Promise.resolve(
          new Response(JSON.stringify({ mailer_autoconfirm: false }), {
            status: 200,
          }),
        )
      : originalFetch(url, options);
  try {
    for (const endpoint of ["signup", "resend", "forgot-password"]) {
      for (const code of [
        "email_address_not_authorized",
        "over_email_send_rate_limit",
      ]) {
        failure = {
          code,
          status: code === "email_address_not_authorized" ? 422 : 429,
          message: "private-provider-details",
        };
        const response = await fetch(
          origin + "/api/auth/" + endpoint,
          post(endpoint === "signup" ? profile : { email: profile.email }),
        );
        const body = await response.json();
        assert.equal(
          response.status,
          code === "email_address_not_authorized" ? 403 : 429,
        );
        assert.equal(body.code, code);
        assert.ok(!JSON.stringify(body).includes("private-provider-details"));
        assert.equal(response.headers.getSetCookie().length, 0);
      }
    }
  } finally {
    identity.client = originalClient;
    global.fetch = originalFetch;
  }
});
test("application email throttling includes a matching Retry-After body and header", async () => {
  const original = identity.client;
  identity.client = () => ({ auth: { resend: async () => ({ error: null }) } });
  try {
    let response;
    for (let i = 0; i < 4; i++)
      response = await fetch(
        origin + "/api/auth/resend",
        post({ email: profile.email }, "203.0.113.230"),
      );
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(body.code, "auth_rate_limited");
    assert.equal(
      body.retryAfterSeconds,
      Number(response.headers.get("retry-after")),
    );
    assert.ok(body.retryAfterSeconds > 0);
  } finally {
    identity.client = original;
  }
});
test("unconfirmed credentials have a clear message and never issue cookies", async () => {
  const original = identity.client;
  identity.client = () => ({
    auth: {
      signInWithPassword: async () => ({
        data: { user: null, session: null },
        error: { code: "email_not_confirmed", status: 400 },
      }),
    },
  });
  try {
    const response = await fetch(
      origin + "/api/auth/login",
      post({ username: profile.email, password: profile.password }),
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "email_not_confirmed");
    assert.equal(response.headers.getSetCookie().length, 0);
  } finally {
    identity.client = original;
  }
});

test("provider login and confirmation rate limits are not reported as invalid credentials or expired links", async () => {
  const original = identity.client;
  identity.client = () => ({
    auth: {
      signInWithPassword: async () => ({
        data: { user: null, session: null },
        error: { code: "over_request_rate_limit", status: 429 },
      }),
      verifyOtp: async () => ({
        data: { user: null, session: null },
        error: { code: "over_request_rate_limit", status: 429 },
      }),
    },
  });
  try {
    for (const [path, body] of [
      ["login", { username: profile.email, password: profile.password }],
      ["confirm", { tokenHash: "test-token-hash-long-enough", type: "email" }],
    ]) {
      const response = await fetch(origin + "/api/auth/" + path, post(body));
      assert.equal(response.status, 429);
      assert.equal((await response.json()).code, "over_request_rate_limit");
      assert.equal(response.headers.getSetCookie().length, 0);
    }
  } finally {
    identity.client = original;
  }
});
