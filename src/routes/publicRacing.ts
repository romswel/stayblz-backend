import { Router } from 'express';
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

router.get('/racing-overview', async (_req, res) => {
  try {
    const now = new Date().toISOString();
    const sections = await Promise.all(
      kinds.map(async (kind) => {
        const { data, error } = await supabase
          .from('site_racing_records')
          .select('id,payload')
          .eq('kind', kind)
          .eq('publication_status', 'published')
          .lte('published_at', now)
          .order('sort_order', { ascending: true })
          .order('id', { ascending: true })
          .limit(30);
        if (error) throw error;
        return [
          kind,
          (data ?? []).map((row) => publicRecord(row, kind)).filter(Boolean),
        ] as const;
      }),
    );
    res.json({ sections: Object.fromEntries(sections), fetchedAt: now });
  } catch {
    res
      .status(503)
      .json({ error: 'Racing data is unavailable. Please try again later.' });
  }
});

export default router;
