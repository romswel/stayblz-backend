const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SECRET_KEY = 'test-only-placeholder';
const { app } = require('../dist/app');
const { supabase } = require('../dist/lib/supabase');
let server, origin;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('public overview builds racing sections from published race days and projects notes safely', async () => {
  const originalFrom = supabase.from;
  const originalRpc = supabase.rpc;
  const queries = [];
  const rpcCalls = [];
  supabase.rpc = async (name, args) => {
    rpcCalls.push([name, args]);
    assert.equal(name, 'racing_section');
    return {
      data: args.p_kind === 'racecards' ? [{ id: 'r1', name: 'Race 1', track: 'Test Park', runners: 3 }] : [],
      error: null,
    };
  };
  supabase.from = (table) => {
    assert.equal(table, 'site_racing_records');
    const query = { filters: [], orders: [] };
    queries.push(query);
    const builder = {
      select(value) {
        assert.equal(value, 'id,payload');
        return this;
      },
      eq(key, value) {
        query.filters.push([key, value]);
        return this;
      },
      lte(key, value) {
        query.before = [key, value];
        return this;
      },
      order(key, options) {
        query.orders.push([key, options]);
        return this;
      },
      limit(count) {
        query.limit = count;
        return Promise.resolve({
          data: [
            {
              id: 'n1',
              payload: { name: 'Track note', category: 'News', summary: 'Short', body: 'Long', owner_email: 'private@example.test' },
            },
            { id: 'bad', payload: { name: 'Missing fields' } },
          ],
          error: null,
        });
      },
    };
    return builder;
  };
  try {
    const response = await fetch(origin + '/api/public/racing-overview');
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(Object.keys(data.sections).length, 8);
    assert.deepEqual(data.sections.racecards, [{ id: 'r1', name: 'Race 1', track: 'Test Park', runners: 3 }]);
    assert.deepEqual(data.sections.notes, [{ id: 'n1', name: 'Track note', category: 'News', summary: 'Short', body: 'Long' }]);
    assert.ok(!JSON.stringify(data).includes('private'));
    assert.deepEqual(
      rpcCalls.map(([, args]) => args.p_kind).sort(),
      ['horses', 'jockeys', 'racecards', 'results', 'stakes', 'trainers', 'workouts'],
    );
    assert.ok(rpcCalls.every(([, args]) => args.p_offset === 0 && args.p_limit === 30));
    assert.equal(queries.length, 1, 'only racing notes still come from site records');
    assert.ok(queries[0].filters.some(([k, v]) => k === 'publication_status' && v === 'published'));
    assert.equal(queries[0].before[0], 'published_at');
  } finally {
    supabase.from = originalFrom;
    supabase.rpc = originalRpc;
  }
});

test('missing schema and database failures never fall back to mock racing arrays', async () => {
  const original = supabase.from;
  supabase.from = () => {
    throw new Error('internal database credentials');
  };
  try {
    const response = await fetch(origin + '/api/public/racing-overview');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Racing data is unavailable. Please try again later.',
    });
    assert.equal((await fetch(origin + '/api/racing/entries')).status, 401);
    assert.equal((await fetch(origin + '/api/inventory')).status, 401);
  } finally {
    supabase.from = original;
  }
});
