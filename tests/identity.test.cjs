const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SECRET_KEY = 'test-placeholder';
process.env.NODE_ENV = 'test';
process.env.ENABLE_PUBLIC_DEMO = 'true';
const { app } = require('../dist/app');
const { identity } = require('../dist/lib/identity');
const { supabase } = require('../dist/lib/supabase');
let server, origin;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));
const member = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'member@example.test',
  email_confirmed_at: '2026-11-01T00:00:00Z',
  app_metadata: {},
  user_metadata: {
    first_name: 'Member',
    last_name: 'User',
    country: 'PH',
    racing_role: 'trainer',
    role: 'superadmin',
  },
};
const session = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_in: 3600,
};
const post = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const signup = {
  firstName: 'Member',
  lastName: 'User',
  country: 'PH',
  racingRole: 'fan',
  email: 'new@example.test',
  password: 'TestOnlyPassword123',
  confirmPassword: 'TestOnlyPassword123',
};
function mockClient(auth) {
  const original = identity.client;
  identity.client = () => ({ auth });
  return () => {
    identity.client = original;
  };
}

test('verified login uses HttpOnly cookies and never returns provider tokens', async () => {
  const restore = mockClient({
    signInWithPassword: async () => ({
      data: { user: member, session },
      error: null,
    }),
  });
  try {
    const r = await fetch(
      origin + '/api/auth/login',
      post({ username: member.email, password: 'unused' }),
    );
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.user.role, 'member');
    assert.equal(body.token, undefined);
    assert.equal(body.session, undefined);
    const cookies = r.headers.getSetCookie();
    assert.ok(
      cookies.some(
        (c) =>
          c.startsWith('stayblz_access=') &&
          c.includes('HttpOnly') &&
          c.includes('SameSite=Lax'),
      ),
    );
    assert.ok(
      cookies.some(
        (c) => c.startsWith('stayblz_refresh=') && c.includes('Path=/api/auth'),
      ),
    );
  } finally {
    restore();
  }
});
test('unverified accounts cannot sign in and user metadata cannot grant admin', async () => {
  const restore = mockClient({
    signInWithPassword: async () => ({
      data: { user: { ...member, email_confirmed_at: null }, session },
      error: null,
    }),
  });
  try {
    const r = await fetch(
      origin + '/api/auth/login',
      post({ username: member.email, password: 'unused' }),
    );
    assert.equal(r.status, 401);
    assert.equal(r.headers.getSetCookie().length, 0);
  } finally {
    restore();
  }
});
test('member sessions cannot query any shared stable data or legacy racing mocks', async () => {
  const original = identity.user;
  const originalFrom = supabase.from;
  identity.user = async () => ({ data: { user: member }, error: null });
  supabase.from = () => {
    throw new Error('private query must never run');
  };
  try {
    for (const path of [
      '/api/inventory',
      '/api/horses',
      '/api/messages',
      '/api/feed',
      '/api/dashboard',
      '/api/betting/wallet',
      '/api/racing/entries',
    ]) {
      const r = await fetch(origin + path, {
        headers: { Cookie: 'stayblz_access=fixture.payload.signature' },
      });
      assert.equal(r.status, 403, path);
    }
    const r = await fetch(origin + '/api/auth/me', {
      headers: { Cookie: 'stayblz_access=fixture.payload.signature' },
    });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.user.role, 'member');
    assert.equal(d.user.emailVerified, true);
    const invalid = await fetch(origin + '/api/auth/me', {
      headers: {
        Cookie: 'stayblz_access=fixture.payload.signature',
        Authorization: 'Basic invalid',
      },
    });
    assert.equal(invalid.status, 401);
  } finally {
    identity.user = original;
    supabase.from = originalFrom;
  }
});
test('signup validates profile, password, and role injection before provider calls', async () => {
  for (const body of [
    { ...signup, role: 'superadmin' },
    { ...signup, password: 'short', confirmPassword: 'short' },
  ]) {
    const r = await fetch(origin + '/api/auth/signup', post(body));
    assert.equal(r.status, 400);
  }
});
test('signup saves only profile fields and requires a confirmation before any session', async () => {
  const originalFetch = global.fetch;
  let saved;
  global.fetch = (url, options) =>
    String(url).endsWith('/auth/v1/settings')
      ? Promise.resolve(
          new Response(JSON.stringify({ mailer_autoconfirm: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      : originalFetch(url, options);
  const restore = mockClient({
    signUp: async (input) => {
      saved = input;
      return { data: { user: member, session: null }, error: null };
    },
  });
  try {
    const r = await fetch(origin + '/api/auth/signup', post(signup));
    assert.equal(r.status, 202);
    assert.equal((await r.json()).requiresVerification, true);
    assert.equal(r.headers.getSetCookie().length, 0);
    assert.deepEqual(saved.options.data, {
      first_name: 'Member',
      last_name: 'User',
      country: 'PH',
      racing_role: 'fan',
    });
    assert.equal(
      saved.options.emailRedirectTo,
      'http://localhost:5173/auth/confirm',
    );
  } finally {
    restore();
    global.fetch = originalFetch;
  }
});
test('signup fails closed if provider email confirmation is disabled', async () => {
  const originalFetch = global.fetch;
  global.fetch = (url, options) =>
    String(url).endsWith('/auth/v1/settings')
      ? Promise.resolve(
          new Response(JSON.stringify({ mailer_autoconfirm: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
      : originalFetch(url, options);
  try {
    const r = await fetch(origin + '/api/auth/signup', post(signup));
    assert.equal(r.status, 503);
  } finally {
    global.fetch = originalFetch;
  }
});
test('profile writes are tied to the verified user and ignore permissions in the request', async () => {
  const originalUser = identity.user,
    originalUpdate = supabase.auth.admin.updateUserById;
  let saved;
  identity.user = async () => ({ data: { user: member }, error: null });
  supabase.auth.admin.updateUserById = async (id, input) => {
    saved = { id, input };
    return { data: { user: member }, error: null };
  };
  try {
    const r = await fetch(origin + '/api/auth/profile', {
      ...post({ ...signup, id: 'another-user', role: 'superadmin' }),
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'stayblz_access=fixture.payload.signature',
      },
    });
    assert.equal(r.status, 200);
    assert.equal(saved.id, member.id);
    assert.deepEqual(Object.keys(saved.input), ['user_metadata']);
    assert.equal(saved.input.user_metadata.role, undefined);
    assert.equal((await r.json()).user.role, 'member');
  } finally {
    identity.user = originalUser;
    supabase.auth.admin.updateUserById = originalUpdate;
  }
});
test('confirmation consumes provider verification and returns only the verified profile', async () => {
  const restore = mockClient({
    verifyOtp: async () => ({ data: { user: member, session }, error: null }),
  });
  try {
    const r = await fetch(
      origin + '/api/auth/confirm',
      post({ tokenHash: 'test-hash-at-least-16-characters', type: 'email' }),
    );
    assert.equal(r.status, 200);
    assert.equal((await r.json()).user.emailVerified, true);
    assert.ok(r.headers.getSetCookie().length === 2);
  } finally {
    restore();
  }
});
test('refresh rotates cookies, and expired tokens clear cookies without a mock fallback', async () => {
  let fail = false;
  const restore = mockClient({
    refreshSession: async () =>
      fail
        ? { data: {}, error: { message: 'expired' } }
        : { data: { user: member, session }, error: null },
  });
  try {
    const options = {
      ...post({}),
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'stayblz_refresh=test-refresh-token',
      },
    };
    let r = await fetch(origin + '/api/auth/refresh', options);
    assert.equal(r.status, 200);
    assert.ok(r.headers.getSetCookie().length === 2);
    fail = true;
    r = await fetch(origin + '/api/auth/refresh', options);
    assert.equal(r.status, 401);
    assert.ok(
      r.headers
        .getSetCookie()
        .every((c) => c.includes('Expires=Thu, 01 Jan 1970')),
    );
  } finally {
    restore();
  }
});
test('cross-origin and form account writes are rejected', async () => {
  let r = await fetch(origin + '/api/auth/login', {
    ...post({}),
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://untrusted.example',
    },
  });
  assert.equal(r.status, 403);
  r = await fetch(origin + '/api/auth/login', {
    method: 'POST',
    body: 'username=anything',
  });
  assert.equal(r.status, 415);
});

test('provider outages do not clear a valid browser refresh credential',async()=>{
 const restore=mockClient({refreshSession:async()=>({data:{},error:{name:'AuthRetryableFetchError',status:0}})});
 try{const response=await fetch(origin+'/api/auth/refresh',{...post({}),headers:{'Content-Type':'application/json',Cookie:'stayblz_refresh=still-valid'}});assert.equal(response.status,503);assert.equal(response.headers.getSetCookie().length,0);}finally{restore();}
});
test('identity provider outages are distinguished from invalid user credentials',async()=>{
 const original=identity.user;identity.user=async()=>({data:{user:null},error:{status:503,name:'AuthApiError'}});
 try{const response=await fetch(origin+'/api/auth/me',{headers:{Cookie:'stayblz_access=outage.payload.signature'}});assert.equal(response.status,503);assert.equal(response.headers.getSetCookie().length,0);}finally{identity.user=original;}
});
test('production never accepts the old demo session or publishes insecure cookies', async () => {
  const auth = require('../dist/middleware/auth');
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const restore = mockClient({
    signInWithPassword: async () => ({
      data: { user: member, session },
      error: null,
    }),
  });
  try {
    assert.equal(auth.demoEnabled(), false);
    const r = await fetch(
      origin + '/api/auth/login',
      post({ username: member.email, password: 'unused' }),
    );
    assert.equal(r.status, 200);
    assert.ok(r.headers.getSetCookie().every((c) => c.includes('Secure')));
  } finally {
    process.env.NODE_ENV = originalEnv;
    restore();
  }
});

test('admin password setup preserves its server role and unrelated provider metadata',async()=>{
 const originalUser=identity.user,originalUpdate=supabase.auth.admin.updateUserById,originalFetch=global.fetch;let saved;
 identity.user=async()=>({data:{user:{...member,app_metadata:{stayblz_role:'superadmin',stayblz_require_password_setup:true,provider:'email'}}},error:null});
 supabase.auth.admin.updateUserById=async(id,details)=>{saved={id,details};return{data:{user:member},error:null};};
 global.fetch=(url,options)=>String(url).endsWith('/auth/v1/user')&&options?.method==='PUT'?Promise.resolve(new Response('{}',{status:200})):originalFetch(url,options);
 try{
   const before=await fetch(origin+'/api/dashboard',{headers:{Cookie:'stayblz_access=fixture.payload.signature'}});assert.equal(before.status,403);
   const response=await fetch(origin+'/api/auth/password',{...post({password:'NewTestOnlyPassword123',confirmPassword:'NewTestOnlyPassword123'}),headers:{'Content-Type':'application/json',Cookie:'stayblz_access=fixture.payload.signature'}});assert.equal(response.status,200);assert.equal(saved.id,member.id);assert.deepEqual(saved.details.app_metadata,{stayblz_role:'superadmin',stayblz_require_password_setup:false,provider:'email'});assert.equal(response.headers.getSetCookie().length,2);
 }finally{identity.user=originalUser;supabase.auth.admin.updateUserById=originalUpdate;global.fetch=originalFetch;}
});
