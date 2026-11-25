const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SECRET_KEY = 'test-only-placeholder';
process.env.NODE_ENV = 'test';
process.env.FORMFAV_API_KEY = 'fk_test_only_index_key';
const { app } = require('../dist/app');
const auth = require('../dist/middleware/auth');
const formFav = require('../dist/lib/formFav');
const index = require('../dist/lib/formFavIndex');

// New York noon on 2026-11-24: the window is 2026-10-26 … 2026-11-26, yesterday is 2026-11-23.
const NOW = () => new Date('2026-11-24T17:00:00Z');
const TODAY = '2026-11-24';
const shift = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const WINDOW = [];
for (let d = '2026-10-26'; d <= '2026-11-26'; d = shift(d, 1)) WINDOW.push(d);

const NAMED = ['apple Pie', 'Zephyr', 'Bold Ruler', 'Émile', 'Secretariat', 'Mighty Toro'];
const POOL = [...NAMED, ...Array.from({ length: 44 }, (_, i) => `Horse ${i + 1}`)];
const JOCKEYS = ['Joel Rosario', 'Irad Ortiz Jr.', 'Flavien Prat', 'John Velazquez'];
const TRAINERS = ['Bob Baffert', 'Todd Pletcher', 'D. Wayne Lukas', 'Andres Adame (Jnr)'];

let calls = [];
let fail = null; // (url) => status | null
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fakeFormFav(url) {
  const u = new URL(url);
  const p = Object.fromEntries(u.searchParams);
  calls.push(u.pathname + '|' + p.date + '|' + (p.race_code ?? '') + '|' + (p.track ?? ''));
  const bad = fail?.(u);
  if (bad) return reply(bad, { detail: 'nope' });
  const k = WINDOW.indexOf(p.date);
  const past = p.date < TODAY;
  if (u.pathname === '/v1/form/meetings') {
    const meetings = p.race_code === 'harness'
      ? [{ track: 'Mohawk', slug: 'mohawk', country: 'ca', abandoned: false }, { track: 'Vincennes', slug: 'vincennes', country: 'fr' }]
      : [{ track: 'Del Mar', slug: 'del-mar', country: 'us', abandoned: false }, { track: 'Woodbine', slug: 'woodbine', country: 'ca' }, { track: 'Ballina', slug: 'ballina', country: 'au' }];
    return reply(200, { date: p.date, raceType: p.race_code, meetings });
  }
  if (u.pathname === '/v1/results/meeting') {
    assert.notEqual(p.track, 'ballina', 'non-North-American meetings are never read');
    assert.equal(p.timezone, 'America/New_York');
    // A race that never shows final: long ago (settled anyway) and two days ago (still re-read).
    const status = !past ? 'pending' : (p.track === 'woodbine' && (p.date === '2026-11-01' || p.date === '2026-11-22')) ? 'interim' : 'final';
    const runner = (name, j, t, pos, extra = {}) => ({ name, jockey: j, trainer: t, number: pos, position: past ? pos : null, scratched: false, ...extra });
    let placings;
    if (p.track === 'del-mar')
      placings = [0, 1, 2, 3].map((j) => runner(POOL[(k * 3 + j) % POOL.length], JOCKEYS[j], TRAINERS[j % 3], j + 1))
        .concat([runner('Scratched Sam', 'Joel Rosario', 'Bob Baffert', 5, { scratched: true, position: null })]);
    else if (p.track === 'woodbine') placings = [runner(p.date === TODAY ? 'Entered Today' : 'Northern Dancer Two', 'Patrick Husbands', 'Andres Adame (Jnr)', 1)];
    else if (p.track === 'mohawk') placings = [runner('Pacer Uno', 'Doug McNair', 'Richard Moreau', 1)];
    return reply(200, { date: p.date, track: p.track, races: [{ raceNumber: 1, raceName: 'R1 ' + p.track, startTime: p.date + 'T20:00:00Z', resultStatus: status, abandoned: false, placings }] });
  }
  // Stats for people and tracks (FormFav's are worldwide; Stayblz shows only those in the US/Canada window).
  const path = decodeURIComponent(u.pathname);
  if (path === '/v1/stats/jockey/search')
    return reply(200, { query: p.q, results: [{ name: 'Joel Rosario', totalStarts: 900 }, { name: 'James McDonald', totalStarts: 3874 }] });
  if (path === '/v1/stats/jockey/Joel Rosario' || path === '/v1/stats/jockey/James McDonald')
    return reply(200, { jockeyName: path.split('/').pop(), totalStarts: 900, totalWins: 200, trackStats: [{ venue: 'Del Mar', totalStarts: 80 }], conditionStats: [] });
  if (path === '/v1/stats/trainer/Bob Baffert') return reply(200, { trainerName: 'Bob Baffert', totalStarts: 500, trackStats: [], conditionStats: [] });
  if (path === '/v1/stats/track-bias/del-mar' || path === '/v1/stats/track-bias/ballina')
    return reply(200, { venue: path.split('/').pop(), totalRaces: 100, strongestBarrier: 1, barrierStats: [], distanceStats: [] });
  return reply(404, { detail: 'Not Found' });
}

let server, origin, token;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  token = auth.createSession(auth.mockUser);
});
after(() => {
  formFav.setFormFavFetch(null);
  index.setIndexStore(undefined);
  index.resetIndex();
  auth.destroySession(token);
  return new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  calls = [];
  fail = null;
  formFav.setFormFavFetch(async (url) => fakeFormFav(url));
  index.setIndexStore(null);
  index.resetIndex(NOW);
});

const get = (path) => fetch(origin + '/api/stayblz-data/formfav' + path, { headers: { Authorization: 'Bearer ' + token } });
const json = async (path, status = 200) => {
  const r = await get(path);
  const text = await r.text();
  assert.equal(r.status, status, path + ' → ' + text);
  return JSON.parse(text);
};
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

test('the lists need sign-in', async () => {
  for (const p of ['/horses', '/horse?name=Zephyr&code=gallops', '/people?kind=jockey'])
    assert.equal((await fetch(origin + '/api/stayblz-data/formfav' + p)).status, 401);
});

test('a build reads every window day × code once, only US/Canada meetings', async () => {
  await index.refreshIndex();
  const lists = calls.filter(c => c.startsWith('/v1/form/meetings'));
  assert.equal(lists.length, WINDOW.length * 2);
  // gallops: Del Mar + Woodbine; harness: Mohawk (Ballina, Vincennes never read)
  assert.equal(calls.filter(c => c.startsWith('/v1/results/meeting')).length, WINDOW.length * 3);
  assert.equal(calls.length, WINDOW.length * 5);
  const status = index.indexStatus();
  assert.equal(status.building, false);
  assert.deepEqual(status.coverage, { from: '2026-10-26', to: '2026-11-26' });
  assert.equal(status.lastRun.calls, WINDOW.length * 5);
});

test('asking for a list before the first build starts it; building until done', async () => {
  const first = await json('/horses');
  assert.equal(first.building, true);
  await index.indexSettled();
  const ready = await json('/horses');
  assert.equal(ready.building, false);
  assert.equal(ready.records.length, 20);
});

test('horses: A–Z, 20 per page, pages cover everyone once', async () => {
  await index.refreshIndex();
  const seen = [];
  let offset = 0, total;
  while (offset !== null) {
    const page = await json('/horses?offset=' + offset);
    assert.ok(page.records.length <= 20);
    total = page.total;
    seen.push(...page.records.map(h => h.name));
    offset = page.nextOffset;
  }
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
  assert.deepEqual(seen, [...seen].sort(collator.compare));
  for (const name of ['apple Pie', 'Émile', 'Zephyr', 'Pacer Uno', 'Northern Dancer Two', 'Entered Today', 'Scratched Sam']) assert.ok(seen.includes(name), name);
  assert.ok(seen.indexOf('Horse 2') < seen.indexOf('Horse 10'), 'numbers sort as numbers');
  // 50 pool horses + Northern Dancer Two + Entered Today + Scratched Sam + Pacer Uno
  assert.equal(total, 54);
});

test('horse counts skip scratchings and races not run yet; filters by name, code and country', async () => {
  await index.refreshIndex();
  const sam = (await json('/horses?q=scratched')).records;
  assert.equal(sam.length, 1);
  assert.equal(sam[0].starts, 0, 'scratched every time');
  const pacer = (await json('/horses?codes=harness')).records;
  assert.deepEqual(pacer.map(h => h.name), ['Pacer Uno']);
  assert.equal(pacer[0].code, 'harness');
  // Pacer Uno raced every day before today: 29 runs, all won.
  assert.equal(pacer[0].starts, 29);
  assert.equal(pacer[0].wins, 29);
  assert.deepEqual(pacer[0].nextEntry && [pacer[0].nextEntry.date, pacer[0].nextEntry.track, pacer[0].nextEntry.timezone], [TODAY, 'Mohawk', 'America/New_York']);
  const canada = await json('/horses?countries=ca&codes=gallops');
  assert.deepEqual(canada.records.map(h => h.name), ['Entered Today', 'Northern Dancer Two']);
  const entered = canada.records[0];
  assert.equal(entered.starts, 0);
  assert.equal(entered.nextEntry.date, TODAY);
  assert.equal((await json('/horses?q=HORSE 1')).records[0].name, 'Horse 1');
});

test('one horse: every start and entry, newest first; unknown horse is 404', async () => {
  await index.refreshIndex();
  const h = await json('/horse?name=' + encodeURIComponent('pacer uno') + '&code=harness');
  assert.equal(h.name, 'Pacer Uno');
  assert.equal(h.history.length, WINDOW.length);
  assert.equal(h.history[0].date, '2026-11-26');
  assert.equal(h.history.at(-1).date, '2026-10-26');
  assert.deepEqual(Object.keys(h.history[0]).sort(), ['code', 'country', 'date', 'distance', 'fieldSize', 'jockey', 'position', 'raceName', 'raceNumber', 'scratched', 'slug', 'startTime', 'status', 'timezone', 'track', 'trainer']);
  assert.equal((await json('/horse?name=Nobody&code=gallops', 404)).error, 'Not found.');
  assert.equal((await json('/horse?name=Pacer%20Uno&code=gallops', 404)).error, 'Not found.');
});

test('jockeys and trainers: A–Z by surname, with ride counts', async () => {
  await index.refreshIndex();
  const jockeys = await json('/people?kind=jockey');
  assert.deepEqual(jockeys.records.map(p => p.name), ['Patrick Husbands', 'Doug McNair', 'Irad Ortiz Jr.', 'Flavien Prat', 'Joel Rosario', 'John Velazquez']);
  const rosario = jockeys.records.find(p => p.name === 'Joel Rosario');
  // Del Mar: one ride a day before today (his scratched mount doesn't count); always 1st.
  assert.equal(rosario.rides, 29);
  assert.equal(rosario.wins, 29);
  assert.equal(rosario.winRate, 1);
  assert.equal(rosario.upcoming, 3);
  assert.equal(rosario.lastRide, '2026-11-23');
  const trainers = await json('/people?kind=trainer&countries=us');
  assert.deepEqual(trainers.records.map(p => p.name), ['Bob Baffert', 'D. Wayne Lukas', 'Todd Pletcher']);
  assert.deepEqual((await json('/people?kind=trainer')).records.map(p => p.name), ['Andres Adame (Jnr)', 'Bob Baffert', 'D. Wayne Lukas', 'Richard Moreau', 'Todd Pletcher']);
  const harness = await json('/people?kind=jockey&codes=harness');
  assert.deepEqual(harness.records.map(p => p.name), ['Doug McNair']);
  assert.equal((await json('/people?kind=jockey&q=ortiz')).records[0].name, 'Irad Ortiz Jr.');
  const paged = await json('/people?kind=jockey&limit=2&offset=2');
  assert.deepEqual(paged.records.map(p => p.name), ['Irad Ortiz Jr.', 'Flavien Prat']);
  assert.equal(paged.nextOffset, 4);
  assert.equal(paged.total, 6);
});

test('finished days are saved once and read back instead of asking FormFav', async () => {
  const saved = new Map();
  const puts = [];
  index.setIndexStore({ get: async k => saved.get(k) ?? null, put: async (k, body) => { puts.push(k); if (!saved.has(k)) saved.set(k, body); } });
  await index.refreshIndex();
  // Every code/day before yesterday (2026-10-26 … 2026-11-22).
  // 2026-11-01 never showed final but is old enough to count as settled; 2026-11-22 (two days ago) isn't.
  const before = WINDOW.filter(d => d < '2026-11-23');
  assert.equal(puts.length, before.length * 2 - 1);
  assert.ok(saved.has('gallops/2026-11-01') && saved.has('harness/2026-11-22') && !saved.has('gallops/2026-11-22'));
  assert.ok(!saved.has('gallops/2026-11-23') && !saved.has('harness/' + TODAY));
  const total = (await json('/horses')).total;

  // A fresh server (same store): only the unfinished day and yesterday … +2 come from FormFav.
  index.resetIndex(NOW);
  calls = [];
  await index.refreshIndex();
  const read = () => [...new Set(calls.map(c => c.split('|')[1] + '|' + c.split('|')[2]))].sort();
  const due = ['2026-11-22|gallops', ...['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'].flatMap(d => [d + '|gallops', d + '|harness'])];
  assert.deepEqual(read(), due.sort());
  assert.equal(index.indexStatus().lastRun.daysLoaded, before.length * 2 - 1);
  assert.equal((await json('/horses')).total, total);
  assert.equal(puts.length, before.length * 2 - 1, 'nothing saved twice');

  // A later refresh in the same process re-reads only what can still change.
  calls = [];
  await index.refreshIndex();
  assert.deepEqual(read(), due);
});

test('a day FormFav fails on keeps what we had', async () => {
  await index.refreshIndex();
  const before = (await json('/horses?codes=gallops&countries=ca')).records.map(h => h.name);
  fail = (u) => (u.searchParams.get('track') === 'woodbine' ? 500 : null);
  await index.refreshIndex();
  assert.ok(index.indexStatus().lastRun.failed > 0);
  assert.deepEqual((await json('/horses?codes=gallops&countries=ca')).records.map(h => h.name), before);
});

test('bad list requests are 400', async () => {
  for (const p of ['/horses?limit=0', '/horses?limit=51', '/horses?offset=-1', '/horses?offset=abc', '/horses?codes=greyhounds', '/horses?countries=au',
    '/horses?q=a&q=b', '/people', '/people?kind=owner', '/horse?name=Zephyr', '/horse?code=gallops', '/horse?name=Zephyr&code=camels'])
    assert.equal((await json(p, 400)).error, 'Invalid FormFav request.', p);
});

test('jockey, trainer and track stats only for people and tracks in the US/Canada window', async () => {
  assert.equal((await json('/jockey/' + encodeURIComponent('Joel Rosario'), 503)).error, "FormFav data isn't available right now.", 'while the first build runs');
  await index.indexSettled();
  assert.equal((await json('/jockey/' + encodeURIComponent('Joel Rosario'))).name, 'Joel Rosario');
  assert.equal((await json('/jockey/' + encodeURIComponent('James McDonald'), 404)).error, 'Not found.', 'rides outside North America only');
  assert.equal((await json('/trainer/' + encodeURIComponent('Bob Baffert'))).name, 'Bob Baffert');
  assert.deepEqual((await json('/search?kind=jockey&q=jam')).results.map((r) => r.name), ['Joel Rosario']);
  assert.equal((await json('/track-bias/del-mar')).venue, 'del-mar');
  const bias = calls.find((c) => c.startsWith('/v1/stats/track-bias/del-mar'));
  assert.ok(bias, 'asked FormFav');
  assert.equal((await json('/track-bias/ballina', 404)).error, 'Not found.', 'an Australian track');
});
