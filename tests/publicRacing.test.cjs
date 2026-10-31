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

test('public overview reads published database records with bounds and safe projections', async () => {
  const original = supabase.from;
  const queries = [];
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
        const kind = query.filters.find(([key]) => key === 'kind')[1];
        return Promise.resolve({
          data:
            kind === 'horses'
              ? [
                  {
                    id: 'h1',
                    payload: {
                      name: 'Database horse',
                      starts: 8,
                      wins: 3,
                      figure: 100,
                      private_cost: 999,
                      owner_email: 'private@example.test',
                      body: 'private notes',
                    },
                  },
                  {
                    id: 'invalid',
                    payload: {
                      name: 'Invalid',
                      starts: -1,
                      wins: 2,
                      figure: 90,
                    },
                  },
                ]
              : [],
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
    assert.deepEqual(data.sections.horses, [
      { id: 'h1', name: 'Database horse', starts: 8, wins: 3, figure: 100 },
    ]);
    assert.equal(Object.keys(data.sections).length, 8);
    assert.ok(!JSON.stringify(data).includes('private'));
    for (const query of queries) {
      assert.ok(
        query.filters.some(
          ([k, v]) => k === 'publication_status' && v === 'published',
        ),
      );
      assert.equal(query.before[0], 'published_at');
      assert.ok(Number.isFinite(Date.parse(query.before[1])));
      assert.equal(query.limit, 30);
    }
  } finally {
    supabase.from = original;
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
