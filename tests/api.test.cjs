const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Never connect to a real database during this suite.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SECRET_KEY = 'test-only-placeholder';
const { app } = require('../dist/app');
const auth = require('../dist/middleware/auth');
const { supabase } = require('../dist/lib/supabase');
let server;
let origin;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(() => new Promise(resolve => server.close(resolve)));
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health responds without caching or framework disclosure', async () => {
  const res = await fetch(origin + '/api/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-powered-by'), null);
});
test('private routes reject unauthenticated requests', async () => {
  for (const path of ['/api/inventory', '/api/horses', '/api/feed', '/api/messages', '/api/betting/wallet']) {
    assert.equal((await fetch(origin + path)).status, 401);
  }
});
test('malformed and oversized JSON return safe JSON errors', async () => {
  let res = await fetch(origin + '/api/auth/login', { ...post({}), body: '{' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON body.');
  res = await fetch(origin + '/api/auth/login', post({ password: 'a'.repeat(40000) }));
  assert.equal(res.status, 413);
});
test('demo sign-in restores session and logout revokes it', async () => {
  const login = await fetch(origin + '/api/auth/login', post({ username: auth.MOCK_USERNAME, password: auth.MOCK_PASSWORD }));
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const headers = { Authorization: 'Bearer ' + token };
  assert.equal((await fetch(origin + '/api/auth/me', { headers })).status, 200);
  await fetch(origin + '/api/auth/logout', { method: 'POST', headers });
  assert.equal((await fetch(origin + '/api/auth/me', { headers })).status, 401);
});
test('sessions expire after one hour', () => {
  const token = auth.createSession(auth.mockUser);
  const original = Date.now;
  try {
    Date.now = () => original() + 60 * 60 * 1000 + 1;
    assert.equal(auth.getSessionUser(token), undefined);
  } finally { Date.now = original; }
});
test('rejected database operations are caught and internals stay private', async () => {
  const original = supabase.from;
  const token = auth.createSession(auth.mockUser);
  supabase.from = () => { throw new Error('private database detail'); };
  try {
    for (const path of ['/api/inventory', '/api/horses', '/api/feed', '/api/db-health']) {
      const res = await fetch(origin + path, { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(res.status, 500);
      assert.equal((await res.text()).includes('private database detail'), false);
    }
    assert.equal((await fetch(origin + '/api/health')).status, 200);
  } finally { supabase.from = original; auth.destroySession(token); }
});
test('tracking handles a missing inventory relationship without crashing', async () => {
  const original = supabase.from;
  const token = auth.createSession(auth.mockUser);
  supabase.from = () => ({ select: async () => ({ data: [{ id: 'orphan', horse_inventory: null }], error: null }) });
  try {
    const res = await fetch(origin + '/api/horses', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).horses, []);
  } finally { supabase.from = original; auth.destroySession(token); }
});
test('login attempts are bounded', async () => {
  let response;
  for (let i = 0; i < 21; i++) response = await fetch(origin + '/api/auth/login', post({ username: 'invalid', password: 'invalid' }));
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});
