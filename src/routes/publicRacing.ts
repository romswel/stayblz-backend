import { Router, type Response } from 'express';
import { BREEDS, dateRange } from '../lib/racingInput';
import { supabase } from '../lib/supabase';

const router = Router();
export const kinds = [
  'racecards',
  'results',
  'workouts',
  'horses',
  'jockeys',
  'trainers',
  'stakes',
  'notes',
] as const;
export type Kind = (typeof kinds)[number];
const textFields = [
  'name',
  'detail',
  'track',
  'date',
  'time',
  'race',
  'surface',
  'distance',
  'margin',
  'category',
  'summary',
  'body',
] as const;
const numberFields = ['runners', 'starts', 'wins', 'figure'] as const;
const allowed: Record<Kind, readonly string[]> = {
  racecards: [
    'name',
    'track',
    'date',
    'time',
    'race',
    'surface',
    'distance',
    'runners',
  ],
  results: ['name', 'track', 'date', 'time', 'race', 'margin', 'detail'],
  workouts: ['name', 'track', 'date', 'time', 'distance', 'detail'],
  horses: ['name', 'detail', 'starts', 'wins', 'figure'],
  jockeys: ['name', 'detail', 'starts', 'wins'],
  trainers: ['name', 'detail', 'starts', 'wins'],
  stakes: ['name', 'track', 'date', 'surface', 'distance', 'runners'],
  notes: ['name', 'category', 'summary', 'body'],
};
const required: Record<Kind, readonly string[]> = {
  racecards: [
    'name',
    'track',
    'time',
    'race',
    'surface',
    'distance',
    'runners',
  ],
  results: ['name', 'track', 'time', 'race'],
  workouts: ['name', 'track', 'time', 'distance'],
  horses: ['name', 'starts', 'wins', 'figure'],
  jockeys: ['name', 'starts', 'wins'],
  trainers: ['name', 'starts', 'wins'],
  stakes: ['name', 'track', 'date'],
  notes: ['name', 'category', 'summary', 'body'],
};

// Project only reviewed public fields, even when a payload has extra properties.
export function publicRecord(
  row: { id: unknown; payload: unknown },
  kind: Kind,
) {
  if (
    typeof row.id !== 'string' ||
    !row.payload ||
    typeof row.payload !== 'object' ||
    Array.isArray(row.payload)
  )
    return null;
  const payload = row.payload as Record<string, unknown>;
  const record: Record<string, string | number> = { id: row.id };
  for (const field of textFields) {
    const value = payload[field];
    if (
      allowed[kind].includes(field) &&
      typeof value === 'string' &&
      value.trim()
    ) {
      record[field] = value.trim().slice(0, field === 'body' ? 5000 : 500);
    }
  }
  for (const field of numberFields) {
    const value = payload[field];
    if (
      allowed[kind].includes(field) &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0
    )
      record[field] = value;
  }
  if (required[kind].some((field) => record[field] === undefined)) return null;
  if (kind === 'stakes' && !Number.isFinite(Date.parse(String(record.date))))
    return null;
  return record;
}

/** Overview rows. Racing sections come from published race days; racing notes from site records. */
export async function racingSection(kind: Kind, offset: number, limit: number) {
  if (kind === 'notes') {
    const { data, error } = await supabase
      .from('site_racing_records')
      .select('id,payload')
      .eq('kind', 'notes')
      .eq('publication_status', 'published')
      .lte('published_at', new Date().toISOString())
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })
      .limit(offset + limit);
    if (error) throw error;
    return (data ?? [])
      .slice(offset)
      .map((row) => publicRecord(row, 'notes'))
      .filter(Boolean);
  }
  const { data, error } = await supabase.rpc('racing_section', {
    p_kind: kind,
    p_offset: offset,
    p_limit: limit,
  });
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

router.get('/racing-overview', async (_req, res) => {
  try {
    const now = new Date().toISOString();
    const sections = await Promise.all(
      kinds.map(async (kind) => [kind, await racingSection(kind, 0, 30)] as const),
    );
    res.json({ sections: Object.fromEntries(sections), fetchedAt: now });
  } catch {
    res
      .status(503)
      .json({ error: 'Racing data is unavailable. Please try again later.' });
  }
});

// ----- Linked racing pages (published race days only; no sign-in needed) -----
const unavailable = (res: Response) =>
  res.status(503).json({ error: 'Racing data is unavailable. Please try again later.' });
const notFound = (res: Response, what: string) =>
  res.status(404).json({ error: `That ${what} isn't published on Stayblz.` });
const isDay = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + 'T00:00:00Z'));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rpc(res: Response, name: string, args: Record<string, unknown>, what?: string) {
  let result;
  try {
    result = await supabase.rpc(name, args);
  } catch {
    unavailable(res);
    return undefined;
  }
  const { data, error } = result;
  if (error) {
    unavailable(res);
    return undefined;
  }
  if (what && !data) {
    notFound(res, what);
    return undefined;
  }
  return data;
}

router.get('/racing/calendar', async (req, res) => {
  const range = dateRange(req.query.from, req.query.to, 42, 400);
  if (!range) return res.status(400).json({ error: 'Choose a valid date range.' });
  const data = await rpc(res, 'racing_calendar', { p_from: range.from, p_to: range.to });
  if (data !== undefined) res.json({ days: data ?? [], ...range });
});
router.get('/racing/days', async (req, res) => {
  const date = req.query.date ?? new Date().toISOString().slice(0, 10);
  if (!isDay(date)) return res.status(400).json({ error: 'Choose a valid date.' });
  const data = await rpc(res, 'racing_days_on', { p_date: date });
  if (data !== undefined) res.json({ date, days: data ?? [] });
});
for (const [path, fn, what] of [
  ['/racing/days/:id', 'racing_day', 'race day'],
  ['/racing/races/:id', 'racing_race', 'race'],
  ['/racing/horses/:id', 'racing_horse', 'horse'],
  ['/racing/people/:id', 'racing_person', 'person'],
] as const)
  router.get(path, async (req, res) => {
    const id = String(req.params.id);
    if (!uuidPattern.test(id)) return notFound(res, what);
    const data = await rpc(res, fn, fn === 'racing_day' ? { p_id: id, p_admin: false } : { p_id: id }, what);
    if (data !== undefined) res.json(fn === 'racing_day' ? { day: data } : data);
  });
router.get('/racing/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  const data = await rpc(res, 'racing_search', { p_query: q });
  if (data !== undefined) res.json(data);
});
router.get('/racing/leaders', async (req, res) => {
  const role = String(req.query.role ?? 'jockey');
  const year = req.query.year === undefined || req.query.year === '' ? null : Number(req.query.year);
  const breed = req.query.breed === undefined || req.query.breed === '' ? null : String(req.query.breed);
  if (
    !['jockey', 'trainer', 'owner', 'horse'].includes(role) ||
    (year !== null && (!Number.isInteger(year) || year < 1980 || year > 2100)) ||
    (breed !== null && !BREEDS.includes(breed as (typeof BREEDS)[number]))
  )
    return res.status(400).json({ error: "Those filters aren't valid." });
  const data = await rpc(res, 'racing_leaders', { p_role: role, p_year: year, p_breed: breed, p_limit: 50 });
  if (data !== undefined) res.json({ role, year, breed, leaders: data ?? [] });
});
router.get('/racing/stakes', async (req, res) => {
  const range = dateRange(req.query.from, req.query.to, 120, 400);
  if (!range) return res.status(400).json({ error: 'Choose a valid date range.' });
  const data = await rpc(res, 'racing_stakes', { p_from: range.from, p_to: range.to });
  if (data !== undefined) res.json({ races: data ?? [], ...range });
});
router.get('/racing/workouts', async (req, res) => {
  const range = dateRange(
    req.query.from ?? new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10),
    req.query.to ?? new Date().toISOString().slice(0, 10),
    7,
    100,
  );
  const track =
    typeof req.query.track === 'string' && req.query.track ? req.query.track.toUpperCase() : null;
  if (!range || (track && !/^[A-Z0-9]{2,6}$/.test(track)))
    return res.status(400).json({ error: 'Choose a valid date range (up to 100 days) and track.' });
  const data = await rpc(res, 'racing_workouts_list', {
    p_from: range.from,
    p_to: range.to,
    p_track: track,
    p_admin: false,
  });
  if (data !== undefined) res.json({ workouts: data ?? [], ...range, track });
});

export default router;
