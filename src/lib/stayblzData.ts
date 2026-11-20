import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Stayblz Data: the Equibase race day scraped through Apify and kept as JSON in data/horse-racing.
 * The file (~4 MB) is read once on first use and kept in memory; list endpoints only ever send
 * small summary rows, one page at a time.
 */
const DATA_FILE =
  process.env.STAYBLZ_DATA_FILE ||
  path.resolve(__dirname, '../../data/horse-racing/equibase-full-2026-11-18.json');

/** Some tracks only come through as their code. */
const TRACK_NAMES: Record<string, string> = {
  CD: 'Churchill Downs',
  TAM: 'Tampa Bay Downs',
  MVR: 'Mahoning Valley',
};

type Raw = Record<string, unknown>;
type RawHorse = Raw & { past_starts: Raw[]; workouts: Raw[] };
export interface RaceSummary {
  race_id: string;
  race_date: string;
  track_code: string;
  track_name: string;
  race_number: number;
  race_name: string | null;
  race_type: string | null;
  distance: string | null;
  surface: string | null;
  purse_usd: number | null;
  post_time: string | null;
  track_condition: string | null;
  entries_count: number;
  race_cancelled: boolean;
  results_available: boolean;
  winner_horse: string | null;
  winner_jockey: string | null;
  winning_time: string | null;
}
export interface HorseSummary {
  horse_refno: string;
  horse_name: string;
  starts: number;
  wins: number;
  best_speed_figure: number | null;
  last_start: { race_date: string; track_code: string; track_name: string; finish_position: number | null; speed_figure: number | null } | null;
  workouts: number;
  entered_race_ids: string[];
}
interface Store {
  raceDate: string;
  source: string;
  races: Raw[];
  horses: RawHorse[];
  raceRows: RaceSummary[];
  horseRows: HorseSummary[];
}

let store: Store | null = null;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? (v as Raw[]) : []);
export const trackName = (code: string, name: unknown) =>
  TRACK_NAMES[code] ?? (str(name) && name !== code ? (name as string) : code);

function load(): Store {
  if (store) return store;
  const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Raw;
  const races = arr(parsed.races)
    .filter((r) => typeof r.race_id === 'string')
    .map((r): Raw => ({ ...r, track_name: trackName(String(r.track_code), r.track_name) }))
    .sort(
      (a, b) =>
        String(a.track_name).localeCompare(String(b.track_name)) ||
        Number(a.race_number) - Number(b.race_number),
    );
  const horses = arr(parsed.horses)
    .filter((h) => typeof h.horse_refno === 'string')
    .map((h): RawHorse => ({
      ...h,
      profile_url: str(h.profile_url)?.replace(/&amp;/g, '&') ?? null,
      past_starts: arr(h.past_starts)
        .map((s): Raw => ({ ...s, track_name: trackName(String(s.track_code), s.track_name) }))
        .sort((a, b) => String(b.race_date).localeCompare(String(a.race_date))),
      workouts: arr(h.workouts)
        .map((w): Raw => ({ ...w, track_name: trackName(String(w.track_code), w.track_name) }))
        .sort((a, b) => String(b.workout_date).localeCompare(String(a.workout_date))),
    }))
    .sort((a, b) => String(a.horse_name).localeCompare(String(b.horse_name)));

  const raceRows: RaceSummary[] = races.map((r) => ({
    race_id: String(r.race_id),
    race_date: String(r.race_date),
    track_code: String(r.track_code),
    track_name: String(r.track_name),
    race_number: Number(r.race_number),
    race_name: str(r.race_name),
    race_type: str(r.race_type),
    distance: str(r.distance),
    surface: str(r.surface),
    purse_usd: num(r.purse_usd),
    post_time: str(r.post_time),
    track_condition: str(r.track_condition),
    entries_count: num(r.entries_count) ?? arr(r.entries_detail).length,
    race_cancelled: r.race_cancelled === true,
    results_available: r.results_available === true,
    winner_horse: str(r.winner_horse),
    winner_jockey: str(r.winner_jockey),
    winning_time: str(r.winning_time),
  }));
  const horseRows: HorseSummary[] = horses.map((h) => {
    const starts = h.past_starts;
    const figures = starts.map((s) => num(s.speed_figure)).filter((n): n is number => n !== null);
    // The race day itself may be listed without a finish yet; the last start is the latest finished one.
    const last = starts.find((s) => num(s.finish_position) !== null) ?? starts[0];
    return {
      horse_refno: String(h.horse_refno),
      horse_name: String(h.horse_name ?? 'Unnamed'),
      starts: starts.length,
      wins: starts.filter((s) => s.finish_position === 1).length,
      best_speed_figure: figures.length ? Math.max(...figures) : null,
      last_start: last
        ? {
            race_date: String(last.race_date),
            track_code: String(last.track_code),
            track_name: String(last.track_name),
            finish_position: num(last.finish_position),
            speed_figure: num(last.speed_figure),
          }
        : null,
      workouts: h.workouts.length,
      entered_race_ids: Array.isArray(h.entered_race_ids) ? h.entered_race_ids.map(String) : [],
    };
  });
  store = {
    raceDate: String(parsed.race_date ?? ''),
    source: String(parsed.source ?? 'Equibase'),
    races,
    horses,
    raceRows,
    horseRows,
  };
  return store;
}

export interface ListQuery {
  offset: number;
  limit: number;
  track?: string;
  q?: string;
}
export interface Page<T> {
  records: T[];
  nextOffset: number | null;
  total: number;
}

const matches = (q: string | undefined, ...fields: (string | null)[]) => {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(needle));
};
function page<T>(rows: T[], { offset, limit }: ListQuery): Page<T> {
  const records = rows.slice(offset, offset + limit);
  return { records, nextOffset: offset + limit < rows.length ? offset + limit : null, total: rows.length };
}

export function listRaces(query: ListQuery): Page<RaceSummary> {
  const rows = load().raceRows.filter(
    (r) =>
      (!query.track || r.track_code === query.track) &&
      matches(query.q, r.race_name, r.race_type, r.track_name, r.winner_horse),
  );
  return page(rows, query);
}

export function listHorses(query: ListQuery): Page<HorseSummary> {
  const { horseRows, raceRows } = load();
  const raceTrack = new Map(raceRows.map((r) => [r.race_id, r.track_code]));
  const rows = horseRows.filter(
    (h) =>
      (!query.track || h.entered_race_ids.some((id) => raceTrack.get(id) === query.track)) &&
      matches(query.q, h.horse_name),
  );
  return page(rows, query);
}

export function getRace(id: string) {
  const race = load().races.find((r) => r.race_id === id);
  if (!race) return null;
  // The pipe-delimited entries and the JSON-string payouts repeat the structured fields.
  const { entries: _entries, exotic_payouts: _exotic, ...rest } = race;
  return rest;
}

export function getHorse(refno: string) {
  return load().horses.find((h) => h.horse_refno === refno) ?? null;
}

export function meta() {
  const { raceDate, source, raceRows, horseRows } = load();
  const tracks = new Map<string, { code: string; name: string; races: number }>();
  for (const r of raceRows) {
    const t = tracks.get(r.track_code) ?? { code: r.track_code, name: r.track_name, races: 0 };
    t.races += 1;
    tracks.set(r.track_code, t);
  }
  return {
    race_date: raceDate,
    source,
    races: raceRows.length,
    horses: horseRows.length,
    tracks: [...tracks.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
