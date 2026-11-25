/**
 * FormFav (https://formfav.com/docs): racing form, results, model predictions and jockey/trainer/runner/track stats,
 * shown in Stayblz Data → FormFav. The browser never talks to FormFav: it asks our server, which adds the key
 * (FORMFAV_API_KEY, kept on Render) and returns trimmed shapes. Without a key the tab says the data isn't available.
 *
 * The quota is per FormFav account (Premium: 100,000 requests per rolling 24 h, 250 per 10 s), shared by every
 * member, so answers are cached in memory and identical requests in flight share one call. Live prices are not used.
 * Tests never reach FormFav (see setFormFavFetch).
 */
const API = "https://api.formfav.com/v1";
const TIMEOUT_MS = 8000;
const MAX_CACHE = 500;
const MIN = 60_000;

/** A FormFav answer we can't use: 400 = FormFav refused the request, 404 = no such race/person/venue, 503 = unavailable. */
export class FormFavError extends Error {
  constructor(readonly status: number) {
    super(`formfav_${status}`);
  }
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher | null = null;
/** For tests: stand in for FormFav. */
export function setFormFavFetch(fn: Fetcher | null) {
  fetcher = fn;
  cache.clear();
  inflight.clear();
}

/**
 * The FormFav quota is shared by every member, so each person gets 60 FormFav-backed requests a minute (cached answers
 * count too), across Stayblz Data and Virtual Stayblz's Racing horses.
 */
const recent = new Map<string, number[]>();
export function formFavAllowed(id: string) {
  const now = Date.now();
  const hits = (recent.get(id) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= 60) return false;
  hits.push(now);
  recent.set(id, hits);
  if (recent.size > 5000) recent.delete(recent.keys().next().value as string);
  return true;
}

export function formFavKey() {
  if (process.env.NODE_ENV === "test" && !fetcher) return null;
  const key = process.env.FORMFAV_API_KEY?.trim();
  return key || null;
}

const cache = new Map<string, { until: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export type Params = Record<string, string | number | undefined>;

function urlFor(path: string, params: Params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const query = qs.toString();
  return `${API}${path}${query ? `?${query}` : ""}`;
}

async function fetchUrl(url: string): Promise<any> {
  const key = formFavKey();
  if (!key) throw new FormFavError(503);
  let res: Response;
  try {
    res = await (fetcher ?? fetch)(url, { headers: { "X-API-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new FormFavError(503);
  }
  if (!res.ok) throw new FormFavError(res.status === 404 ? 404 : res.status === 400 || res.status === 422 ? 400 : 503);
  try {
    return await res.json();
  } catch {
    throw new FormFavError(503);
  }
}

/** One uncached GET (for the A–Z index in lib/formFavIndex.ts, which keeps its own copy of what it reads). */
export const fetchJson = (path: string, params: Params) => fetchUrl(urlFor(path, params));

/** GET path?params → shape(body), cached for ttl(body) ms. */
async function call<T>(path: string, params: Params, ttl: number | ((body: any) => number), shape: (body: any) => T): Promise<T> {
  if (!formFavKey()) throw new FormFavError(503);
  const url = urlFor(path, params);
  const hit = cache.get(url);
  if (hit && Date.now() < hit.until) return hit.value as T;
  const running = inflight.get(url);
  if (running) return running as Promise<T>;
  const job = (async () => {
    const body = await fetchUrl(url);
    const value = shape(body);
    cache.set(url, { until: Date.now() + (typeof ttl === "function" ? ttl(body) : ttl), value });
    while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
    return value;
  })();
  inflight.set(url, job);
  try {
    return await job;
  } finally {
    inflight.delete(url);
  }
}

// ── small helpers: copy only what we expect, with the type we expect ──────────────────────────────────────────────
export const str = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 300) : null);
export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const bool = (v: unknown) => v === true;
export const list = (v: unknown, max = 200): any[] => (Array.isArray(v) ? v.slice(0, max) : []);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);
/** A plain JSON stats block (numbers/strings/bools, nested once), or null. */
function block(v: unknown, depth = 2): any {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.slice(0, 300);
  if (typeof v === "boolean") return v;
  if (depth <= 0) return null;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => block(x, depth - 1));
  const o = obj(v);
  if (!o) return null;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).slice(0, 60)) out[k] = block(o[k], depth - 1);
  return out;
}

export type RaceCode = "gallops" | "harness" | "greyhounds";
export interface Where {
  date: string;
  raceCode: RaceCode;
  timezone: string;
}
export interface RaceWhere extends Where {
  track: string;
  race: number;
  country: string;
}

function raceHead(b: any) {
  return {
    date: str(b?.date),
    track: str(b?.track),
    raceNumber: num(b?.raceNumber),
    raceName: str(b?.raceName),
    distance: str(b?.distance),
    condition: str(b?.condition),
    weather: str(b?.weather),
    raceClass: str(b?.raceClass),
    abandoned: bool(b?.abandoned),
    startTime: str(b?.startTime),
    timezone: str(b?.timezone),
    prizeMoney: str(b?.prizeMoney),
    numberOfRunners: num(b?.numberOfRunners),
  };
}

export async function status() {
  return { enabled: !!formFavKey() };
}

/** Meetings on a day for one race code; `timezone` decides which racing falls on `date`. */
function meetingsOn(w: Where) {
  // A day that's over doesn't change much any more; today and later can (scratchings, abandonments).
  const past = w.date < new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return call("/form/meetings", { date: w.date, race_code: w.raceCode, timezone: w.timezone }, past ? 60 * MIN : 5 * MIN, (b) => ({
    date: str(b?.date),
    raceCode: str(b?.raceType),
    meetings: list(b?.meetings, 300).map((m) => ({
      track: str(m?.track),
      slug: str(m?.slug),
      country: str(m?.country),
      abandoned: bool(m?.abandoned),
      races: list(m?.races, 30).map((r) => ({
        number: num(r?.raceNumber),
        name: str(r?.raceName),
        distance: str(r?.distance),
        raceClass: str(r?.raceClass),
        abandoned: bool(r?.abandoned),
        startTime: str(r?.startTime),
        timezone: str(r?.timezone),
        runners: num(r?.numberOfRunners),
      })),
    })),
  }));
}

/** Stayblz Data shows North American racing only, by New York or Los Angeles days. */
export const COUNTRIES = ["us", "ca"] as const;
/**
 * Stayblz only shows United States and Canada racing. FormFav writes countries as "us"/"ca" on meetings and as
 * "USA"/"CAN" on runners; both count, any case.
 */
export const isNorthAmerica = (country: unknown) => typeof country === "string" && ["us", "ca", "usa", "can"].includes(country.trim().toLowerCase());
export const TIMEZONES = ["America/New_York", "America/Los_Angeles"] as const;
export const RACE_CODES = ["gallops", "harness", "greyhounds"] as const;
/** Longest range of days one request may cover (days × codes × zones FormFav calls). */
export const MAX_RANGE_DAYS = 7;
const PARALLEL = 6;

export interface MeetingsQuery {
  from: string;
  to: string;
  raceCodes: RaceCode[];
  timezones: string[];
  countries: string[];
}

function days(from: string, to: string) {
  const out: string[] = [];
  for (let at = Date.parse(`${from}T12:00:00Z`); out.length < MAX_RANGE_DAYS; at += 86_400_000) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (day > to) break;
    out.push(day);
  }
  return out;
}

/**
 * Meetings for every day in from…to, every chosen code and time zone, kept to the chosen countries. The same meeting
 * seen under both zones (or both sides of midnight) is listed once, under the first day/zone it was found. Each meeting
 * carries the date, code and zone FormFav knows it by, which is what opening one of its races needs.
 * Some lookups failing still returns the rest (`partial: true`); all failing is an error.
 */
export async function meetings(q: MeetingsQuery) {
  const jobs: Where[] = [];
  for (const date of days(q.from, q.to))
    for (const raceCode of q.raceCodes) for (const timezone of q.timezones) jobs.push({ date, raceCode, timezone });
  const settled: PromiseSettledResult<Awaited<ReturnType<typeof meetingsOn>>>[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        settled[i] = await meetingsOn(jobs[i]).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason) => ({ status: "rejected" as const, reason }),
        );
      }
    }),
  );
  const failed = settled.filter((s) => s.status === "rejected");
  if (jobs.length && failed.length === jobs.length) throw (failed[0] as PromiseRejectedResult).reason;

  const seen = new Set<string>();
  const out = [];
  for (let i = 0; i < jobs.length; i++) {
    const s = settled[i];
    if (s.status !== "fulfilled") continue;
    for (const m of s.value.meetings) {
      if (!m.slug || !m.country || !q.countries.includes(m.country)) continue;
      const first = m.races.find((r) => r.startTime)?.startTime ?? jobs[i].date;
      const key = `${jobs[i].raceCode}|${m.country}|${m.slug}|${first.slice(0, 13)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...m, date: jobs[i].date, raceCode: jobs[i].raceCode, timezone: jobs[i].timezone, firstStart: first });
    }
  }
  out.sort((a, b) => a.firstStart.localeCompare(b.firstStart) || (a.track ?? "").localeCompare(b.track ?? ""));
  return { from: q.from, to: q.to, partial: failed.length > 0, meetings: out.map(({ firstStart: _f, ...m }) => m) };
}

const raceParams = (w: RaceWhere): Params => ({ date: w.date, track: w.track, race: w.race, race_code: w.raceCode, country: w.country, timezone: w.timezone });

function form(w: RaceWhere) {
  return call("/form", raceParams(w), 5 * MIN, (b) => ({
    ...raceHead(b),
    runners: list(b?.runners, 40).map((r) => ({
      number: num(r?.number),
      name: str(r?.name),
      jockey: str(r?.jockey),
      trainer: str(r?.trainer),
      weight: num(r?.weight),
      claim: num(r?.claim),
      barrier: num(r?.barrier),
      age: num(r?.age),
      sex: str(r?.sex),
      sire: str(r?.sire),
      dam: str(r?.dam),
      careerPrizeMoney: str(r?.careerPrizeMoney),
      form: str(r?.form),
      last20Starts: str(r?.last20Starts),
      scratched: bool(r?.scratched),
      stats: block(r?.stats, 3),
      speedMap: block(r?.speedMap, 1),
      classProfile: block(r?.classProfile, 1),
      badges: list(r?.decorators, 12).map((d) => ({ label: str(d?.label), sentiment: str(d?.sentiment), detail: str(d?.detail) })),
    })),
  }));
}

function predictions(w: RaceWhere) {
  return call("/predictions", raceParams(w), 5 * MIN, (b) => ({
    confidence: str(b?.confidence),
    modelVersion: str(b?.modelVersion),
    predictedAt: str(b?.predictedAt),
    runners: list(b?.predictions, 40).map((p) => ({
      number: num(p?.number),
      name: str(p?.name),
      winProb: num(p?.winProb),
      placeProb: num(p?.placeProb),
      rank: num(p?.modelRank),
    })),
  }));
}

function results(w: RaceWhere) {
  // A race still running changes quickly; a final result practically never does.
  const ttl = (b: any) => (b?.resultStatus === "final" ? 60 * MIN : MIN);
  return call("/results", raceParams(w), ttl, (b) => ({
    status: str(b?.resultStatus),
    updatedAt: str(b?.resultUpdatedAt),
    revised: bool(b?.resultRevised),
    placings: list(b?.placings, 40).map((p) => ({
      number: num(p?.number),
      name: str(p?.name),
      jockey: str(p?.jockey),
      trainer: str(p?.trainer),
      barrier: num(p?.barrier),
      position: num(p?.position),
      margin: str(p?.margin),
      scratched: bool(p?.scratched),
      startingPrice: num(p?.startingPrice),
    })),
  }));
}

/** The race card alone (cached like the rest): what lib/formFavSync.ts reads a horse's sex, age and pedigree from. */
export const raceCard = (w: RaceWhere) => form(w);

/** One race: form (required) plus predictions and results when FormFav has them (else null). */
export async function race(w: RaceWhere) {
  const [f, p, r] = await Promise.allSettled([form(w), predictions(w), results(w)]);
  if (f.status === "rejected") throw f.reason;
  // Predictions and results are extras: missing (404), not on the plan, or a hiccup there shouldn't hide the form.
  const optional = <T>(s: PromiseSettledResult<T>) => (s.status === "fulfilled" ? s.value : null);
  return { form: f.value, predictions: optional(p), results: optional(r) };
}

export type SearchKind = "jockey" | "trainer" | "runner";

export function search(kind: SearchKind, q: string, raceCode?: RaceCode) {
  const params: Params = { q };
  // Jockey/trainer stats exist for gallops and harness only.
  if (raceCode && (kind === "runner" || raceCode !== "greyhounds")) params.race_code = raceCode;
  return call(`/stats/${kind}/search`, params, 60 * MIN, (b) => ({
    query: str(b?.query),
    results: list(b?.results, 50).map((x) =>
      kind === "runner"
        ? { id: num(x?.runnerId), name: str(x?.name), country: str(x?.country), totalStarts: num(x?.totalStarts), lastRaceDate: str(x?.lastRaceDate), sire: str(x?.sire), dam: str(x?.dam) }
        : { name: str(x?.name), totalStarts: num(x?.totalStarts), ambiguous: bool(x?.isAmbiguous) },
    ).filter((x: any) => kind !== "runner" || isNorthAmerica(x.country)), // FormFav's runner search is worldwide
  }));
}

const sortByStarts = (rows: any[]) => [...rows].sort((a, b) => (b?.totalStarts ?? 0) - (a?.totalStarts ?? 0));

function person(kind: "jockey" | "trainer", name: string, raceCode?: RaceCode, window?: number) {
  const params: Params = { window };
  if (raceCode && raceCode !== "greyhounds") params.race_code = raceCode;
  return call(`/stats/${kind}/${encodeURIComponent(name)}`, params, 60 * MIN, (b) => ({
    kind,
    name: str(kind === "jockey" ? b?.jockeyName : b?.trainerName),
    raceCode: str(b?.raceType),
    totalStarts: num(b?.totalStarts),
    totalWins: num(b?.totalWins),
    winRate: num(b?.overallWinRate),
    placeRate: num(b?.overallPlaceRate),
    ambiguous: bool(b?.isAmbiguous),
    bestCondition: str(b?.bestCondition),
    worstCondition: str(b?.worstCondition),
    tracks: block(sortByStarts(list(b?.trackStats)).slice(0, 40), 2),
    conditions: block(list(b?.conditionStats, 20), 2),
    recent: block(b?.recentStats, 2),
  }));
}
export const jockey = (name: string, raceCode?: RaceCode, window?: number) => person("jockey", name, raceCode, window);
export const trainer = (name: string, raceCode?: RaceCode, window?: number) => person("trainer", name, raceCode, window);

/** One runner's career stats; a runner from outside the US and Canada is "not found" here. */
export async function runner(id: number, window?: number) {
  const stats = await runnerStats(id, window);
  if (!isNorthAmerica((stats.runner as any)?.country)) throw new FormFavError(404);
  return stats;
}
function runnerStats(id: number, window?: number) {
  return call(`/stats/runner/${id}`, { window }, 60 * MIN, (b) => ({
    runner: block(b?.runner, 1),
    career: block(b?.career, 1),
    distances: block(list(b?.distanceStats, 40), 2),
    conditions: block(list(b?.conditionStats, 20), 2),
    venues: block(sortByStarts(list(b?.venueStats)).slice(0, 30), 2),
    spells: block(list(b?.spellStats, 10), 2),
    jockeys: block(sortByStarts(list(b?.jockeyStats)).slice(0, 20), 2),
    classProfile: block(b?.classProfile, 1),
    runningStyle: block(b?.runningStyle, 1),
    formTrend: block(b?.formTrend, 1),
    trialForm: block(b?.trialForm, 1),
    sire: block(b?.sireProfile, 1),
    recent: block(b?.recentStats, 2),
  }));
}

export function trackBias(track: string, o: { raceCode?: RaceCode; country?: string; window?: number; distance?: string }) {
  const params: Params = { race_code: o.raceCode, country: o.country, window: o.window, distance: o.distance };
  return call(`/stats/track-bias/${encodeURIComponent(track)}`, params, 60 * MIN, (b) => ({
    venue: str(b?.venue),
    raceCode: str(b?.raceType),
    totalRaces: num(b?.totalRaces),
    expectedWinRate: num(b?.expectedWinRate),
    strongestBarrier: num(b?.strongestBarrier),
    weakestBarrier: num(b?.weakestBarrier),
    biasStrength: str(b?.biasStrength),
    barriers: block(list(b?.barrierStats, 30), 2),
    distances: list(b?.distanceStats, 10).map((d) => ({
      category: str(d?.category),
      minDistance: num(d?.minDistance),
      maxDistance: num(d?.maxDistance),
      totalRaces: num(d?.totalRaces),
      strongestBarrier: num(d?.strongestBarrier),
      weakestBarrier: num(d?.weakestBarrier),
      biasStrength: str(d?.biasStrength),
    })),
  }));
}
