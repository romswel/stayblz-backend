const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SECRET_KEY = 'test-only-placeholder';
process.env.NODE_ENV = 'test';
const { app } = require('../dist/app');
const auth = require('../dist/middleware/auth');
let server, origin, token;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  token = auth.createSession(auth.mockUser);
});
after(() => { auth.destroySession(token); return new Promise(resolve => server.close(resolve)); });
const get = (path) => fetch(origin + '/api/stayblz-data' + path, { headers: { Authorization: 'Bearer ' + token } });
const json = async (path) => { const r = await get(path); assert.equal(r.status, 200, path); return r.json(); };

test('stayblz data requires sign-in', async () => {
  assert.equal((await fetch(origin + '/api/stayblz-data/races')).status, 401);
});
test('races page through the whole race day without overlap', async () => {
  const seen = new Set();
  let offset = 0, total;
  while (offset !== null) {
    const page = await json('/races?limit=20&offset=' + offset);
    total = page.total;
    assert.ok(page.records.length <= 20);
    for (const r of page.records) { assert.ok(!seen.has(r.race_id)); seen.add(r.race_id); assert.equal(r.entries_detail, undefined); }
    offset = page.nextOffset;
  }
  assert.equal(seen.size, total);
  assert.equal(total, 74);
});
test('horses default to 20 per page and filter by track and name', async () => {
  const first = await json('/horses');
  assert.equal(first.records.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(first.total, 544);
  assert.equal(first.records[0].past_starts, undefined);
  const prx = await json('/races?track=prx&limit=50');
  assert.ok(prx.total > 0 && prx.records.every(r => r.track_code === 'PRX'));
  const named = await json('/horses?q=' + encodeURIComponent(first.records[0].horse_name.slice(0, 5)));
  assert.ok(named.records.some(h => h.horse_refno === first.records[0].horse_refno));
});
test('meta names every track and details load by id', async () => {
  const m = await json('/meta');
  assert.equal(m.race_date, '2026-11-18');
  assert.ok(m.tracks.some(t => t.code === 'CD' && t.name === 'Churchill Downs'));
  const race = await json('/races/CD-2026-11-18-R1');
  assert.ok(Array.isArray(race.entries_detail) && race.entries_detail.length > 0);
  const { records: [h] } = await json('/horses?limit=1');
  const horse = await json('/horses/' + h.horse_refno);
  assert.equal(horse.past_starts.length, h.starts);
  assert.equal((await get('/races/NOPE')).status, 404);
});
test('bad paging input is rejected', async () => {
  for (const q of ['offset=-1', 'limit=0', 'limit=51', 'offset=abc', 'track=%3Cx%3E', 'offset=1&offset=2'])
    assert.equal((await get('/races?' + q)).status, 400, q);
});
