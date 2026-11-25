/**
 * The A–Z index behind Stayblz Data → Horses and Stats (jockeys, trainers). FormFav has no "list everyone" endpoint,
 * so we read every US/Canada meeting in FormFav's window (New York days today−29 … today+2, thoroughbreds + harness;
 * FormFav has no North American greyhounds) with one `/results/meeting` call per meeting: past meetings come back
 * final with finishing positions, upcoming ones pending with their entries.
 *
 * Cost: a full build is ≈ 66 meeting lists + ≈ 430 meeting results ≈ 500 FormFav calls; a refresh only re-reads days
 * that aren't final yet (at most the last 3 days) plus yesterday … +2 (≈ 60 calls). Refreshes run 30 s after boot and every 30 min while the
 * server is awake (Render's free plan sleeps). Finished days older than yesterday are saved once to R2
 * (stayblz/formfav/days/<code>/<date>.json, never overwritten) and read back on the next boot instead of calling
 * FormFav — only in production or with FORMFAV_INDEX_PERSIST=on, so local development doesn't write to the shared
 * bucket. FORMFAV_INDEX=off stops the automatic refreshes.
 */
import { FormFavError, bool, fetchJson, formFavKey, list, num, str } from "./formFav";
import { r2Storage, StorageError } from "./r2Storage";

const TZ = "America/New_York";
const BACK_DAYS = 29;
const AHEAD_DAYS = 2;
const SETTLE_DAYS = 3;
const PARALLEL = 4;
const EVERY_MS = 30 * 60_000;
const FIRST_RUN_MS = 30_000;
export const INDEX_CODES = ["gallops", "harness"] as const;
export type IndexCode = (typeof INDEX_CODES)[number];
const COUNTRIES = new Set(["us", "ca"]);

// ── stored shape ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface Runner {
  name: string;
  jockey: string | null;
  trainer: string | null;
  number: number | null;
  position: number | null;
  scratched: boolean;
}
interface Race {
  number: number | null;
  name: string | null;
  distance: string | null;
  startTime: string | null;
  status: string | null;
  abandoned: boolean;
  runners: Runner[];
}
interface Meeting {
  track: string | null;
  slug: string;
  country: string;
  races: Race[];
}
interface Day {
  v: 1;
  date: string;
  code: IndexCode;
  complete: boolean;
  meetings: Meeting[];
}

// ── persistence ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface IndexStore {
  /** The saved day, or null when there is none. */
  get(key: string): Promise<string | null>;
  /** Save a finished day (an existing copy is left as it is). */
  put(key: string, body: string): Promise<void>;
}
const r2Store: IndexStore = {
  async get(key) {
    try {
      return (await r2Storage.get("private", `formfav/days/${key}.json`)).body.toString("utf8");
    } catch (e) {
      if (e instanceof StorageError && e.code === "not_found") return null;
      throw e;
    }
  },
  async put(key, body) {
    try {
      await r2Storage.put("private", `formfav/days/${key}.json`, Buffer.from(body), "application/json");
    } catch (e) {
      if (e instanceof StorageError && e.code === "exists") return;
      throw e;
    }
  },
};
let storeOverride: IndexStore | null | undefined;
/** For tests: an in-memory store (or null for none); undefined goes back to R2 rules. */
export function setIndexStore(s: IndexStore | null | undefined) {
  storeOverride = s;
}
function store(): IndexStore | null {
  if (storeOverride !== undefined) return storeOverride;
  const setting = process.env.FORMFAV_INDEX_PERSIST?.trim().toLowerCase();
  if (setting === "off") return null;
  if (process.env.NODE_ENV !== "production" && setting !== "on") return null;
  return r2Storage.isConfigured("private") ? r2Store : null;
}

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const days = new Map<string, Day>(); // `${code}/${date}`
let running: Promise<void> | null = null;
let everRefreshed = false;
let updatedAt: string | null = null;
let lastRun: { startedAt: string; finishedAt: string | null; calls: number; daysRead: number; daysLoaded: number; failed: number } | null =
  null;
let clock: () => Date = () => new Date();

/** For tests: forget everything (and optionally pretend it's another moment). */
export function resetIndex(now?: () => Date) {
  days.clear();
  running = null;
  everRefreshed = false;
  updatedAt = null;
  lastRun = null;
  clock = now ?? (() => new Date());
  derived = emptyDerived();
}

const nyDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
function span() {
  const today = nyDate(clock());
  return { today, from: shift(today, -BACK_DAYS), to: shift(today, AHEAD_DAYS) };
}
function windowDays() {
  const { from, to } = span();
  const out: string[] = [];
  for (let d = from; d <= to; d = shift(d, 1)) out.push(d);
  return out;
}

// ── reading FormFav ──────────────────────────────────────────────────────────────────────────────────────────────────
function toRace(r: any): Race {
  return {
    number: num(r?.raceNumber),
    name: str(r?.raceName),
    distance: str(r?.distance),
    startTime: str(r?.startTime),
    status: str(r?.resultStatus),
    abandoned: bool(r?.abandoned),
    runners: list(r?.placings, 40)
      .map((p) => ({
        name: str(p?.name) ?? "",
        jockey: str(p?.jockey),
        trainer: str(p?.trainer),
        number: num(p?.number),
        position: num(p?.position),
        scratched: bool(p?.scratched),
      }))
      .filter((p) => p.name),
  };
}
const raceDone = (r: Race) => r.abandoned || r.status === "final" || r.status === "abandoned";

async function readDay(date: string, code: IndexCode, count: () => void): Promise<Day> {
  count();
  const listing = await fetchJson("/form/meetings", { date, race_code: code, timezone: TZ });
  const wanted = list(listing?.meetings, 300).filter((m) => COUNTRIES.has(str(m?.country) ?? "") && str(m?.slug));
  const meetings: Meeting[] = [];
  let complete = true;
  for (const m of wanted) {
    const slug = str(m.slug)!;
    const country = str(m.country)!;
    let races: Race[] = [];
    try {
      count();
      const body = await fetchJson("/results/meeting", { date, track: slug, country, race_code: code, timezone: TZ });
      races = list(body?.races, 30).map(toRace);
    } catch (e) {
      if (!(e instanceof FormFavError && e.status === 404)) throw e;
      complete = false; // nothing for this meeting yet
    }
    if (!races.length || !races.every(raceDone)) complete = complete && bool(m.abandoned);
    meetings.push({ track: str(m.track), slug, country, races });
  }
  // Today and later can still change even when every race shows final. Some races never show final in FormFav
  // (a race taken off the card, a result that never arrives): days older than SETTLE_DAYS count as finished anyway,
  // so refreshes don't keep re-reading them.
  const { today } = span();
  if (date >= today) complete = false;
  else if (date < shift(today, -SETTLE_DAYS)) complete = true;
  return { v: 1, date, code, complete, meetings };
}

function parseSaved(body: string, date: string, code: IndexCode): Day | null {
  try {
    const d = JSON.parse(body);
    if (d?.v !== 1 || d.date !== date || d.code !== code || !Array.isArray(d.meetings)) return null;
    return {
      v: 1,
      date,
      code,
      complete: true,
      meetings: list(d.meetings, 300).map((m) => ({
        track: str(m?.track),
        slug: str(m?.slug) ?? "",
        country: str(m?.country) ?? "",
        races: list(m?.races, 30).map((r) => ({
          number: num(r?.number),
          name: str(r?.name),
          distance: str(r?.distance),
          startTime: str(r?.startTime),
          status: str(r?.status),
          abandoned: bool(r?.abandoned),
          runners: list(r?.runners, 40)
            .map((p) => ({ name: str(p?.name) ?? "", jockey: str(p?.jockey), trainer: str(p?.trainer), number: num(p?.number), position: num(p?.position), scratched: bool(p?.scratched) }))
            .filter((p) => p.name),
        })),
      })),
    };
  } catch {
    return null;
  }
}

/** Reads what's due (unfinished days, yesterday … +2, anything missing), keeping old data for days that fail. */
export function refreshIndex(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const run = { startedAt: clock().toISOString(), finishedAt: null as string | null, calls: 0, daysRead: 0, daysLoaded: 0, failed: 0 };
    lastRun = run;
    const all = windowDays();
    const keep = new Set(all.flatMap((d) => INDEX_CODES.map((c) => `${c}/${d}`)));
    for (const k of [...days.keys()]) if (!keep.has(k)) days.delete(k);
    const yesterday = shift(span().today, -1);
    const jobs = all.flatMap((date) => INDEX_CODES.map((code) => ({ date, code })));
    const saved = store();
    let next = 0;
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        while (next < jobs.length) {
          const { date, code } = jobs[next++];
          const key = `${code}/${date}`;
          const have = days.get(key);
          if (have?.complete && date < yesterday) continue;
          if (!have && saved && date < yesterday) {
            const body = await saved.get(key).catch(() => null);
            const day = body ? parseSaved(body, date, code) : null;
            if (day) {
              days.set(key, day);
              run.daysLoaded++;
              rebuild();
              continue;
            }
          }
          try {
            const day = await readDay(date, code, () => run.calls++);
            days.set(key, day);
            run.daysRead++;
            if (saved && day.complete && date < yesterday) await saved.put(key, JSON.stringify(day)).catch(() => undefined);
          } catch {
            run.failed++;
          }
          rebuild();
        }
      }),
    );
    everRefreshed = true;
    updatedAt = clock().toISOString();
    run.finishedAt = updatedAt;
    rebuild();
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // a listener's problem never fails the refresh
      }
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

const listeners = new Set<() => void>();
/** Runs `fn` after every finished refresh (lib/formFavSync.ts). Returns a function that stops it. */
export function onIndexRefreshed(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** For tests and the CLI: wait for the refresh in progress, if any. */
export const indexSettled = () => running ?? Promise.resolve();

/** Starts a first refresh when a list is asked for before the schedule has run (or with the schedule off in dev). */
export function ensureIndex() {
  if (!everRefreshed && !running && formFavKey() && process.env.FORMFAV_INDEX?.trim().toLowerCase() !== "off") void refreshIndex();
}

let scheduleOn = false;
export function startFormFavIndex(): boolean {
  if (scheduleOn || process.env.NODE_ENV === "test" || !formFavKey()) return false;
  if (process.env.FORMFAV_INDEX?.trim().toLowerCase() === "off") return false;
  scheduleOn = true;
  const tick = () => void refreshIndex().catch(() => undefined);
  setTimeout(tick, FIRST_RUN_MS).unref();
  setInterval(tick, EVERY_MS).unref();
  return true;
}

export function indexStatus() {
  const { from, to } = span();
  return { building: !everRefreshed, updatedAt, coverage: { from, to }, lastRun };
}

// ── derived A–Z lists ────────────────────────────────────────────────────────────────────────────────────────────────
export interface Start {
  date: string;
  code: IndexCode;
  timezone: string;
  track: string | null;
  slug: string;
  country: string;
  raceNumber: number | null;
  raceName: string | null;
  /** As FormFav writes it, e.g. "1308m" (null in days saved before it was kept). */
  distance: string | null;
  startTime: string | null;
  status: string | null;
  position: number | null;
  /** Runners not scratched. */
  fieldSize: number | null;
  scratched: boolean;
  jockey: string | null;
  trainer: string | null;
}
type Bucket = { rides: number; wins: number; places: number; upcoming: number; tracks: Set<string>; last: string | null };
interface HorseEntry {
  name: string;
  code: IndexCode;
  starts: Start[];
}
interface PersonEntry {
  kind: "jockey" | "trainer";
  name: string;
  sortKey: string;
  buckets: Map<string, Bucket>; // `${code}|${country}`
}
function emptyDerived() {
  return { horses: [] as HorseEntry[], horseByKey: new Map<string, HorseEntry>(), jockeys: [] as PersonEntry[], trainers: [] as PersonEntry[] };
}
let derived = emptyDerived();

const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
/** How a race-data horse is keyed everywhere outside this file (virtual_horses.formfav_key, follower counts). */
export const horseKey = (name: string, code: string) => `${code}|${fold(name)}`;
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const SUFFIX = /^\(?(jr|jnr|sr|snr|ii|iii|iv)\.?\)?$/i;
/** "Joel Rosario" → "Rosario, Joel"; "Robert Medina Jr." / "Andres Adame (Jnr)" → "Medina, Robert Jr." (for sorting only). */
export function surnameKey(name: string) {
  const words = name.trim().split(/\s+/);
  let i = words.length - 1;
  while (i > 0 && SUFFIX.test(words[i])) i--;
  if (i <= 0) return name.trim();
  return `${words[i]}, ${[...words.slice(0, i), ...words.slice(i + 1)].join(" ")}`;
}
const isRide = (s: Start) => !s.scratched && s.status === "final";
const isUpcoming = (s: Start, today: string) => !s.scratched && s.status !== "final" && s.status !== "abandoned" && s.date >= today;

function rebuild() {
  const horseByKey = new Map<string, HorseEntry>();
  const people = new Map<string, PersonEntry>();
  const { today } = span();
  const person = (kind: "jockey" | "trainer", name: string | null, s: Start) => {
    if (!name) return;
    const key = `${kind}|${fold(name)}`;
    let p = people.get(key);
    if (!p) people.set(key, (p = { kind, name, sortKey: surnameKey(name), buckets: new Map() }));
    const bk = `${s.code}|${s.country}`;
    let b = p.buckets.get(bk);
    if (!b) p.buckets.set(bk, (b = { rides: 0, wins: 0, places: 0, upcoming: 0, tracks: new Set(), last: null }));
    if (isRide(s)) {
      b.rides++;
      if (s.position === 1) b.wins++;
      if (s.position !== null && s.position <= 3) b.places++;
      b.tracks.add(s.slug);
      if (!b.last || s.date > b.last) b.last = s.date;
    } else if (isUpcoming(s, today)) b.upcoming++;
  };
  for (const day of days.values())
    for (const m of day.meetings)
      for (const r of m.races) {
        const fieldSize = r.runners.filter((x) => !x.scratched).length || null;
        for (const p of r.runners) {
          const s: Start = {
            date: day.date,
            code: day.code,
            timezone: TZ,
            track: m.track,
            slug: m.slug,
            country: m.country,
            raceNumber: r.number,
            raceName: r.name,
            distance: r.distance ?? null,
            startTime: r.startTime,
            status: r.abandoned ? "abandoned" : r.status,
            position: p.position,
            fieldSize,
            scratched: p.scratched,
            jockey: p.jockey,
            trainer: p.trainer,
          };
          const hk = `${fold(p.name)}|${day.code}`;
          let h = horseByKey.get(hk);
          if (!h) horseByKey.set(hk, (h = { name: p.name, code: day.code, starts: [] }));
          h.starts.push(s);
          if (!p.scratched) {
            person("jockey", p.jockey, s);
            person("trainer", p.trainer, s);
          }
        }
      }
  const byTime = (a: Start, b: Start) => (b.date + (b.startTime ?? "")).localeCompare(a.date + (a.startTime ?? ""));
  for (const h of horseByKey.values()) h.starts.sort(byTime);
  const horses = [...horseByKey.values()].sort((a, b) => collator.compare(a.name, b.name) || a.code.localeCompare(b.code));
  const sortPeople = (kind: "jockey" | "trainer") =>
    [...people.values()].filter((p) => p.kind === kind).sort((a, b) => collator.compare(a.sortKey, b.sortKey) || collator.compare(a.name, b.name));
  derived = { horses, horseByKey, jockeys: sortPeople("jockey"), trainers: sortPeople("trainer") };
}

// ── queries ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ListQuery {
  offset: number;
  limit: number;
  q?: string;
  codes: IndexCode[];
  countries: string[];
}
function page<T>(rows: T[], offset: number, limit: number) {
  return { records: rows.slice(offset, offset + limit), nextOffset: offset + limit < rows.length ? offset + limit : null, total: rows.length };
}

function horseSummary(h: HorseEntry, today: string) {
  const rides = h.starts.filter(isRide);
  const last = rides[0] ?? null;
  const next = [...h.starts].reverse().find((s) => isUpcoming(s, today)) ?? null;
  const latest = h.starts.find((s) => !s.scratched) ?? h.starts[0];
  return {
    name: h.name,
    code: h.code,
    countries: [...new Set(h.starts.map((s) => s.country))].sort(),
    starts: rides.length,
    wins: rides.filter((s) => s.position === 1).length,
    places: rides.filter((s) => s.position !== null && s.position <= 3).length,
    lastStart: last && { date: last.date, track: last.track, slug: last.slug, position: last.position },
    nextEntry: next && {
      date: next.date,
      track: next.track,
      slug: next.slug,
      country: next.country,
      code: next.code,
      timezone: next.timezone,
      raceNumber: next.raceNumber,
      startTime: next.startTime,
    },
    jockey: latest?.jockey ?? null,
    trainer: latest?.trainer ?? null,
  };
}

/**
 * Horses A–Z (Stayblz Data), or with `rank` (follower counts by horseKey) the most followed first, then A–Z
 * (Virtual Stayblz → Racing horses). `only` keeps just those keys. Records carry `followers` when ranked.
 */
export function listHorses(q: ListQuery, opts: { rank?: Map<string, number>; only?: Set<string> } = {}) {
  const { today } = span();
  const needle = q.q ? fold(q.q) : "";
  let rows = derived.horses.filter(
    (h) =>
      q.codes.includes(h.code) &&
      h.starts.some((s) => q.countries.includes(s.country)) &&
      (!needle || fold(h.name).includes(needle)) &&
      (!opts.only || opts.only.has(horseKey(h.name, h.code))),
  );
  const rank = opts.rank;
  if (rank) {
    // Followed horses (few) by count, the rest keep their A–Z order; ties stay A–Z (stable sort).
    const followed = rows.filter((h) => (rank.get(horseKey(h.name, h.code)) ?? 0) > 0);
    followed.sort((a, b) => (rank.get(horseKey(b.name, b.code)) ?? 0) - (rank.get(horseKey(a.name, a.code)) ?? 0));
    rows = [...followed, ...rows.filter((h) => !((rank.get(horseKey(h.name, h.code)) ?? 0) > 0))];
  }
  const p = page(rows, q.offset, q.limit);
  return {
    ...p,
    records: p.records.map((h) => ({
      ...horseSummary(h, today),
      ...(rank ? { followers: rank.get(horseKey(h.name, h.code)) ?? 0 } : {}),
    })),
    ...indexStatus(),
    lastRun: undefined,
  };
}

/** Did this jockey/driver or trainer ride or train in the US/Canada window? (Their FormFav stats are shown only then.) */
export function knownPerson(kind: "jockey" | "trainer", name: string) {
  const needle = fold(name);
  return (kind === "jockey" ? derived.jockeys : derived.trainers).some((p) => fold(p.name) === needle);
}
/** Is this a US/Canada track in the window (by FormFav slug)? */
export function knownTrack(slug: string) {
  for (const day of days.values()) if (day.meetings.some((m) => m.slug === slug)) return true;
  return false;
}

/** New York "today" as the index sees it (its clock can be moved in tests). */
export const indexToday = () => span().today;

export function getHorse(name: string, code: IndexCode) {
  const h = derived.horseByKey.get(`${fold(name)}|${code}`);
  if (!h) return null;
  return { ...horseSummary(h, span().today), history: h.starts };
}

export function listPeople(kind: "jockey" | "trainer", q: ListQuery) {
  const needle = q.q ? fold(q.q) : "";
  const wanted = (bk: string) => {
    const [code, country] = bk.split("|");
    return (q.codes as string[]).includes(code) && q.countries.includes(country);
  };
  const rows = [];
  for (const p of kind === "jockey" ? derived.jockeys : derived.trainers) {
    if (needle && !fold(p.name).includes(needle)) continue;
    const picked = [...p.buckets.entries()].filter(([bk]) => wanted(bk)).map(([, b]) => b);
    if (!picked.length) continue;
    const rides = picked.reduce((n, b) => n + b.rides, 0);
    const upcoming = picked.reduce((n, b) => n + b.upcoming, 0);
    if (!rides && !upcoming) continue;
    const wins = picked.reduce((n, b) => n + b.wins, 0);
    rows.push({
      kind,
      name: p.name,
      rides,
      wins,
      places: picked.reduce((n, b) => n + b.places, 0),
      winRate: rides ? wins / rides : null,
      upcoming,
      tracks: new Set(picked.flatMap((b) => [...b.tracks])).size,
      lastRide: picked.reduce<string | null>((d, b) => (b.last && (!d || b.last > d) ? b.last : d), null),
    });
  }
  return { ...page(rows, q.offset, q.limit), ...indexStatus(), lastRun: undefined };
}
