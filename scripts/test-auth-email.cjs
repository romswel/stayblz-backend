// Opt-in integration test against the existing project. Never prints credentials.
require('dotenv/config');
const crypto = require('node:crypto');
const readline = require('node:readline');
const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');
const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  throw new Error(
    'Pass an authorized organization test email. Never pass a password.',
  );
process.env.ENABLE_PUBLIC_DEMO = 'false';
process.env.NODE_ENV = 'development';
const { app } = require('../dist/app');
const provider = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const password = () => `Aa1!${crypto.randomBytes(28).toString('base64url')}`;
let testPassword = password();
let cookies = '';
let server;
let origin;
let userId;
let verified = false;
const output = (value) => console.log(JSON.stringify(value));
async function findUser() {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await provider.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw error;
    const user = data.users.find((user) => user.email?.toLowerCase() === email);
    if (user) return user;
    if (data.users.length < 100) return null;
  }
  throw new Error('User lookup exceeded the test bound.');
}
async function call(path, body) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  const jar = new Map(
    cookies
      .split('; ')
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf('=');
        return [part.slice(0, i), part.slice(i + 1)];
      }),
  );
  for (const value of response.headers.getSetCookie()) {
    const part = value.split(';')[0];
    const i = part.indexOf('=');
    if (part.slice(i + 1)) jar.set(part.slice(0, i), part.slice(i + 1));
    else jar.delete(part.slice(0, i));
  }
  cookies = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  return {
    status: response.status,
    data,
    cookieHeaders: response.headers.getSetCookie(),
  };
}
async function runVerified() {
  const { data, error } = await provider.auth.admin.getUserById(userId);
  if (error) throw error;
  if (!data.user.email_confirmed_at) {
    output({
      stage: 'confirmation',
      status: 'waiting-for-owner-to-click-email-link',
    });
    return;
  }
  let response = await call('/api/auth/login', {
    username: email,
    password: testPassword,
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.user.role, 'member');
  assert.equal(response.data.user.emailVerified, true);
  assert.ok(
    response.cookieHeaders.every((cookie) => cookie.includes('HttpOnly')),
  );
  assert.equal(response.data.token, undefined);
  output({ stage: 'verified-login', status: 200, httpOnlyCookies: true });
  response = await call('/api/auth/me');
  assert.equal(response.status, 200);
  output({ stage: 'session-restore', status: 200 });
  response = await call('/api/inventory');
  assert.equal(response.status, 403);
  output({ stage: 'private-workspace', status: 403 });
  const nextPassword = password();
  response = await call('/api/auth/password', {
    password: nextPassword,
    confirmPassword: nextPassword,
  });
  assert.equal(response.status, 200);
  response = await call('/api/auth/login', {
    username: email,
    password: testPassword,
  });
  assert.equal(response.status, 401);
  testPassword = nextPassword;
  response = await call('/api/auth/login', {
    username: email,
    password: testPassword,
  });
  assert.equal(response.status, 200);
  output({ stage: 'password-change', status: 200, oldPasswordRejected: true });
  response = await call('/api/auth/logout', {});
  assert.equal(response.status, 200);
  response = await call('/api/auth/me');
  assert.equal(response.status, 401);
  output({ stage: 'logout', status: 200, sessionRemoved: true });
  verified = true;
  output({
    stage: 'verification-complete',
    note: 'Only the isolated test account was used. Type reset to request one recovery email, or quit to stop.',
  });
}
async function main() {
  const settings = await fetch(process.env.SUPABASE_URL + '/auth/v1/settings', {
    headers: { apikey: process.env.SUPABASE_SECRET_KEY },
    signal: AbortSignal.timeout(10000),
  });
  const config = await settings.json();
  assert.equal(settings.status, 200);
  assert.equal(config.mailer_autoconfirm, false);
  const existing = await findUser();
  output({
    stage: 'preflight',
    emailConfirmationEnabled: true,
    testAccountExists: !!existing,
    callbackOrigin: process.env.AUTH_SITE_URL || 'http://localhost:5173',
  });
  if (!process.argv.includes('--send')) return;
  if (existing) {
    output({
      stage: 'stopped',
      reason:
        'The test account already exists. Its password, profile, and role were not changed.',
    });
    return;
  }
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  let response = await call('/api/auth/signup', {
    firstName: 'Email',
    lastName: 'Verification Test',
    country: 'PH',
    racingRole: 'fan',
    email,
    password: testPassword,
    confirmPassword: testPassword,
  });
  output({
    stage: 'registration',
    status: response.status,
    code: response.data.code ?? null,
    requiresVerification: response.data.requiresVerification ?? false,
    message: response.data.error ?? response.data.message,
  });
  if (response.status !== 202) {
    server.close();
    return;
  }
  const created = await findUser();
  assert.ok(created);
  assert.notEqual(created.app_metadata?.stayblz_role, 'superadmin');
  userId = created.id;
  response = await call('/api/auth/login', {
    username: email,
    password: testPassword,
  });
  assert.equal(response.status, 403);
  assert.equal(response.data.code, 'email_not_confirmed');
  response = await call('/api/inventory');
  assert.equal(response.status, 401);
  output({
    stage: 'unverified-access',
    loginStatus: 403,
    privateWorkspaceStatus: 401,
  });
  output({
    stage: 'waiting',
    instruction:
      'Click the real verification email link in a private browser window. Do not share the link or any password. Then type check here. No verification token is generated or bypassed by this test.',
  });
  const input = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  let pending = Promise.resolve();
  input.on('line', (line) => {
    pending = pending
      .then(async () => {
        if (line.trim() === 'check') await runVerified();
        else if (line.trim() === 'reset') {
          if (!verified) {
            output({ stage: 'recovery', status: 'verify-first' });
            return;
          }
          const response = await call('/api/auth/forgot-password', { email });
          output({
            stage: 'recovery-email',
            status: response.status,
            code: response.data.code ?? null,
            message: response.data.error ?? response.data.message,
          });
        } else if (line.trim() === 'quit') {
          input.close();
          server.close();
        }
      })
      .catch((error) =>
        output({
          stage: 'failed',
          error: error.name,
          assertion:
            'A test expectation failed; no credential values are logged.',
        }),
      );
  });
  const timer = setTimeout(() => {
    input.close();
    server.close();
  }, 15 * 60_000);
  timer.unref();
}
main().catch((error) => {
  output({
    stage: 'failed',
    error: error.code || error.name || 'provider-error',
    message:
      'Check the provider and local configuration. No credentials are logged.',
  });
  if (server) server.close();
  process.exitCode = 1;
});
