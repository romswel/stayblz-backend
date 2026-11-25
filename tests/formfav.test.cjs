const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SECRET_KEY = 'test-only-placeholder';
process.env.NODE_ENV = 'test';
const KEY = 'fk_test_only_key_never_in_responses';
process.env.FORMFAV_API_KEY = KEY;
const { app } = require('../dist/app');
const auth = require('../dist/middleware/auth');
const formFav = require('../dist/lib/formFav');

let server, origin, token;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  token = auth.createSession(auth.mockUser);
});
after(() => {
  formFav.setFormFavFetch(null);
  auth.destroySession(token);
  return new Promise(resolve => server.close(resolve));
});

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const TODAY = iso(0);
const get = (path) => fetch(origin + '/api/stayblz-data/formfav' + path, { headers: { Authorization: 'Bearer ' + token } });
const json = async (path, status = 200) => {
  const r = await get(path);
  const text = await r.text();
  assert.equal(r.status, status, path + ' → ' + text);
  assert.ok(!text.includes(KEY), 'the key never reaches the browser');
  return JSON.parse(text);
};

// A stand-in for FormFav: answers by path, records every call.
let calls = [];
let answers = {};
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  calls = [];
  answers = {
    '/v1/form/meetings': (u) => {
      const date = u.searchParams.get('date'), code = u.searchParams.get('race_code');
      const meeting = (track, slug, country, hour) => ({ track, slug, country, abandoned: false, extra: 'dropped',
        races: [{ raceNumber: 1, raceName: track + ' Opener', distance: '1200m', raceClass: 'MDN', abandoned: false, startTime: date + 'T' + hour + ':00:00Z', timezone: 'America/New_York', numberOfRunners: 8 }] });
      const byCode = {
        gallops: [meeting('Ballina', 'ballina', 'au', '02'), meeting('Woodbine', 'woodbine', 'ca', '18'), meeting('Del Mar', 'del-mar', 'us', '20')],
        harness: [meeting('Mohawk', 'mohawk', 'ca', '23'), meeting('Vincennes', 'vincennes', 'fr', '12')],
        greyhounds: [meeting('Romford', 'romford', 'gb', '11')],
      };
      return reply(200, { date, raceType: code, meetings: byCode[code] });
    },
    '/v1/form': () => reply(200, {
      date: TODAY, track: 'Ballina', raceNumber: 1, raceName: 'BM66 Handicap', distance: '1260m', condition: 'Good 4', numberOfRunners: 2,
      runners: [
        { number: 1, name: 'Jewels Statement', jockey: 'Ben Looker', trainer: 'Samantha McGuren', weight: 59, barrier: 7, form: '617X3', scratched: false,
          stats: { overall: { starts: 26, wins: 5, places: 13, winPercent: 0.19, placePercent: 0.5 } },
          decorators: [{ label: 'First-Up Specialist', sentiment: '+', detail: '40% first-up win rate', description: 'dropped' }] },
        { number: 2, name: 'Scratched Horse', scratched: true },
      ],
    }),
    '/v1/predictions': () => reply(200, { confidence: 'medium', modelVersion: '2026-11-21', predictedAt: TODAY + 'T09:00:00Z',
      predictions: [{ number: 1, name: 'Jewels Statement', winProb: 0.34, placeProb: 0.6, modelRank: 1 }] }),
    '/v1/results': () => reply(404, { detail: 'Race not found' }),
    '/v1/stats/jockey/search': () => reply(200, { query: 'mcd', results: [{ name: 'James McDonald', totalStarts: 3874, isAmbiguous: false }] }),
    // FormFav's runner search is worldwide: Stayblz keeps the US and Canada ones.
    '/v1/stats/runner/search': () => reply(200, { query: 'bel', results: [
      { runnerId: 340236, name: 'Bellarata', country: 'AUS', totalStarts: 10, sire: 'Pierata', dam: 'Bellevue Girl' },
      { runnerId: 400001, name: 'Bel Air Kid', country: 'USA', totalStarts: 6, sire: 'Gun Runner', dam: 'Kid Sister' },
      { runnerId: 400002, name: 'Belle Of Woodbine', country: 'CAN', totalStarts: 2 },
      { runnerId: 297209, name: 'Bel Robot', country: 'HKG', totalStarts: 4 },
    ] }),
    '/v1/stats/runner/400001': () => reply(200, { runner: { runnerId: 400001, name: 'Bel Air Kid', country: 'USA' }, career: { totalStarts: 6, wins: 3 }, distanceStats: [], recentStats: null }),
    '/v1/stats/jockey/James McDonald': () => reply(200, { jockeyName: 'James McDonald', totalStarts: 2645, totalWins: 645, overallWinRate: 0.2439, overallPlaceRate: 0.52,
      trackStats: [{ venue: 'Small', totalStarts: 2 }, { venue: 'Randwick', totalStarts: 428, wins: 111 }], conditionStats: [], isAmbiguous: false, recentStats: null }),
    '/v1/stats/runner/340236': () => reply(200, { runner: { runnerId: 340236, name: 'Bellarata', country: 'AUS' }, career: { totalStarts: 10, wins: 3 }, distanceStats: [], recentStats: null }),
    '/v1/stats/track-bias/ballina': () => reply(200, { venue: 'Ballina', totalRaces: 385, strongestBarrier: 6, weakestBarrier: 9, biasStrength: 'none',
      barrierStats: [{ barrierNumber: 1, totalStarts: 341, winRate: 0.15, advantage: 0.03 }], distanceStats: [] }),
  };
  formFav.setFormFavFetch(async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.formfav.com');
    calls.push({ path: decodeURIComponent(u.pathname), params: Object.fromEntries(u.searchParams), key: new Headers(init?.headers).get('X-API-Key') });
    const answer = answers[decodeURIComponent(u.pathname)];
    return answer ? answer(u) : reply(404, { detail: 'Not Found' });
  });
});

test('formfav requires sign-in', async () => {
  assert.equal((await fetch(origin + '/api/stayblz-data/formfav/status')).status, 401);
  assert.equal((await fetch(origin + '/api/stayblz-data/formfav/meetings?from=' + TODAY)).status, 401);
});

test('without a key the section is off and reads are a friendly 503', async () => {
  formFav.setFormFavFetch(null); // in tests, no fake = no key
  assert.deepEqual(await json('/status'), { enabled: false });
  const body = await json('/meetings?from=' + TODAY, 503);
  assert.equal(body.error, "FormFav data isn't available right now.");
  assert.equal(calls.length, 0);
});

test('meetings: one day, every code and both zones by default, US and Canada only, merged once', async () => {
  assert.deepEqual(await json('/status'), { enabled: true });
  const body = await json('/meetings?from=' + TODAY);
  // 1 day × 3 codes × 2 zones
  assert.equal(calls.length, 6);
  for (const c of calls) assert.equal(c.key, KEY);
  assert.deepEqual(
    calls.map(c => c.params.race_code + '|' + c.params.timezone).sort(),
    ['gallops|America/Los_Angeles', 'gallops|America/New_York', 'greyhounds|America/Los_Angeles', 'greyhounds|America/New_York', 'harness|America/Los_Angeles', 'harness|America/New_York'],
  );
  assert.equal(body.partial, false);
  // The same meeting under both zones is listed once; foreign meetings are left out; sorted by first race.
  assert.deepEqual(body.meetings.map(m => m.slug), ['woodbine', 'del-mar', 'mohawk']);
  assert.deepEqual(
    body.meetings.map(m => [m.date, m.raceCode, m.timezone, m.country]),
    [[TODAY, 'gallops', 'America/New_York', 'ca'], [TODAY, 'gallops', 'America/New_York', 'us'], [TODAY, 'harness', 'America/New_York', 'ca']],
  );
  assert.equal(body.meetings[0].extra, undefined);
  assert.deepEqual(body.meetings[0].races[0], { number: 1, name: 'Woodbine Opener', distance: '1200m', raceClass: 'MDN', abandoned: false, startTime: TODAY + 'T18:00:00Z', timezone: 'America/New_York', runners: 8 });
  // Same request again: served from the cache, FormFav not asked twice.
  await json('/meetings?from=' + TODAY);
  assert.equal(calls.length, 6);
});

test('meetings: a range, chosen codes, one zone and one country', async () => {
  const to = iso(2);
  const body = await json('/meetings?from=' + TODAY + '&to=' + to + '&race_codes=gallops,harness&timezones=America/Los_Angeles&countries=ca');
  // 3 days × 2 codes × 1 zone
  assert.equal(calls.length, 6);
  assert.ok(calls.every(c => c.params.timezone === 'America/Los_Angeles' && c.params.race_code !== 'greyhounds'));
  assert.deepEqual([...new Set(calls.map(c => c.params.date))].sort(), [TODAY, iso(1), to]);
  assert.ok(body.meetings.every(m => m.country === 'ca'));
  assert.equal(body.meetings.length, 6, 'Woodbine and Mohawk on each of 3 days');
  assert.deepEqual([...new Set(body.meetings.map(m => m.date))].sort(), [TODAY, iso(1), to]);
});

test('meetings: some FormFav lookups failing still lists the rest', async () => {
  const meetings = answers['/v1/form/meetings'];
  answers['/v1/form/meetings'] = (u) => (u.searchParams.get('race_code') === 'harness' ? reply(500, { detail: 'boom' }) : meetings(u));
  const body = await json('/meetings?from=' + iso(-3));
  assert.equal(body.partial, true);
  assert.deepEqual(body.meetings.map(m => m.slug), ['woodbine', 'del-mar']);
});

test('a race combines form, predictions and results (missing results → null)', async () => {
  const body = await json('/race?date=' + TODAY + '&track=woodbine&race=1&country=ca&timezone=America/Los_Angeles');
  assert.deepEqual(calls.map(c => c.path).sort(), ['/v1/form', '/v1/predictions', '/v1/results']);
  for (const c of calls) assert.deepEqual(c.params, { date: TODAY, track: 'woodbine', race: '1', race_code: 'gallops', country: 'ca', timezone: 'America/Los_Angeles' });
  assert.equal(body.form.runners.length, 2);
  assert.equal(body.form.runners[0].stats.overall.wins, 5);
  assert.deepEqual(body.form.runners[0].badges, [{ label: 'First-Up Specialist', sentiment: '+', detail: '40% first-up win rate' }]);
  assert.equal(body.form.runners[1].scratched, true);
  assert.equal(body.predictions.runners[0].rank, 1);
  assert.equal(body.predictions.confidence, 'medium');
  assert.equal(body.results, null);
});

test('a race FormFav has no form for is a 404; FormFav trouble is a friendly 503', async () => {
  answers['/v1/form'] = () => reply(404, { detail: 'Race not found' });
  assert.equal((await json('/race?date=' + TODAY + '&track=nowhere&race=3', 404)).error, 'Not found.');
  answers['/v1/form/meetings'] = () => reply(429, { detail: 'Rate limit exceeded (daily quota).' });
  assert.equal((await json('/meetings?from=' + iso(-5), 503)).error, "FormFav data isn't available right now.");
  answers['/v1/form/meetings'] = () => reply(500, { detail: 'boom' });
  await json('/meetings?from=' + iso(-6), 503);
  answers['/v1/form/meetings'] = () => { throw new Error('network down'); };
  await json('/meetings?from=' + iso(-7), 503);
  answers['/v1/form/meetings'] = () => reply(422, { detail: [] });
  await json('/meetings?from=' + iso(-8) + '&race_codes=gallops&timezones=America/New_York', 400);
});

// Jockeys, trainers and track bias (US/Canada index only) are covered in formfav_index.test.cjs.
test('runners: US and Canada only, in search and career stats', async () => {
  const runners = await json('/search?kind=runner&q=bel');
  assert.deepEqual(runners.results.map((r) => [r.id, r.country]), [[400001, 'USA'], [400002, 'CAN']], 'AUS and HKG dropped');
  assert.equal((await json('/runner/400001?window=30')).career.wins, 3);
  assert.equal(calls.at(-1).params.window, '30');
  assert.equal((await json('/runner/340236', 404)).error, 'Not found.', 'an Australian runner');
});

test('bad requests are 400 and never reach FormFav', async () => {
  const bad = [
    '/meetings',
    '/meetings?from=2026-13-01',
    '/meetings?from=' + iso(-40),
    '/meetings?from=' + iso(20),
    '/meetings?from=' + TODAY + '&to=' + iso(-1),
    '/meetings?from=' + iso(-10) + '&to=' + iso(-3),
    '/meetings?from=' + TODAY + '&race_codes=camels',
    '/meetings?from=' + TODAY + '&race_codes=gallops,,harness',
    '/meetings?from=' + TODAY + '&timezones=Australia/Sydney',
    '/meetings?from=' + TODAY + '&countries=au',
    '/meetings?from=' + TODAY + '&countries=us,gb',
    '/meetings?from=' + TODAY + '&from=' + TODAY,
    '/race?date=' + TODAY + '&track=ballina&race=1&country=au',
    '/race?date=' + TODAY + '&track=ballina&race=1&timezone=Europe/London',
    '/race?date=' + TODAY + '&track=ballina&race=0',
    '/race?date=' + TODAY + '&track=ballina&race=21',
    '/race?date=' + TODAY + '&track=Ballina!&race=1',
    '/race?date=' + TODAY + '&track=ballina&race=1&country=aus',
    '/search?kind=jockey&q=ab',
    '/search?kind=owner&q=abc',
    '/runner/abc',
    '/jockey/' + encodeURIComponent('<script>') ,
    '/track-bias/ballina?window=7',
    '/track-bias/ballina?distance=short',
  ];
  for (const path of bad) assert.equal((await json(path, 400)).error, 'Invalid FormFav request.', path);
  assert.equal(calls.length, 0);
});
