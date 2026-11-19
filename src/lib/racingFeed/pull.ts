import { supabase } from "../supabase";
import { importCards, type CardResult } from "./importCards";
import { sourceLicensed } from "./licence";
import {
  RACING_API_SOURCE,
  RacingApiError,
  cardsFromRacingApi,
  checkRacingApi,
  fetchHorseResults,
  fetchRacecards,
  fetchResults,
  historyFromRacingApi,
  racingApiLogin,
} from "./theRacingApi";

/**
 * Pulling racing data from The Racing API into Stayblz (docs/racing-data-feed.md):
 *  - pullDay(date): that day's racecards + results → one card per track, imported (published: the provider's terms
 *    allow websites) with follower alerts;
 *  - pullHistories(n): earlier starts for up to n horses running around today;
 *  - jobs run one at a time in the background; admins start them from Publishing → Data feed, the schedule starts
 *    them while the server is awake (Render's free plan sleeps, so every wake-up catches up).
 */

/** Today on British racing's clock, as YYYY-MM-DD (most of the provider's racing is in Europe). */
export function racingToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
export function shiftISO(iso: string, days: number) {
  const date = new Date(iso + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** RACING_API_REGIONS (e.g. "gb,ire,fr") narrows what is imported; empty = every region the plan includes. */
function wantRegion(region: string) {
  const list = (process.env.RACING_API_REGIONS ?? "").split(",").map((r) => r.trim().toUpperCase()).filter(Boolean);
  return !list.length || list.includes(region.toUpperCase());
}

const failureText = (error: unknown) => {
  if (error instanceof RacingApiError) {
    if (error.status === 401 || error.status === 403) return "The Racing API refused the login (check RACING_API_USERNAME / RACING_API_PASSWORD).";
    if (error.status === 0 && error.message === "not_configured") return "The Racing API login isn't set on the server.";
    if (error.status === 0) return "The Racing API couldn't be reached.";
    return `The Racing API answered ${error.status}.`;
  }
  return "The pull stopped on an unexpected error.";
};

export interface DaySummary {
  date: string;
  cards: number;
  imported: number;
  failed: number;
  races: number;
  runners: number;
  officialRaces: number;
  published: boolean;
  error?: string;
}

const summarise = (date: string, results: CardResult[], published: boolean): DaySummary => ({
  date,
  cards: results.length,
  imported: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  races: results.reduce((n, r) => n + (r.races ?? 0), 0),
  runners: results.reduce((n, r) => n + (r.runners ?? 0), 0),
  officialRaces: results.reduce((n, r) => n + (r.officialRaces ?? 0), 0),
  published,
});

/** One day from the provider into Stayblz. */
export async function pullDay(date: string, actor: string | null): Promise<DaySummary & { results: CardResult[] }> {
  const racecards = await fetchRacecards(date);
  // Results only exist for days that have started.
  const results = date <= racingToday() ? await fetchResults(date) : [];
  const cards = cardsFromRacingApi(racecards, results, wantRegion);
  const publish = sourceLicensed(RACING_API_SOURCE);
  const imported = await importCards(actor, cards, publish);
  return { ...summarise(date, imported, publish), results: imported };
}

/** Earlier starts for up to `limit` horses running from 3 days ago to 3 days ahead (not read in the last week). */
export async function pullHistories(limit: number) {
  const { data, error } = await supabase.rpc("racing_feed_history_due", { p_source: RACING_API_SOURCE, p_limit: limit });
  if (error) throw new Error("history_due_failed");
  const due = (Array.isArray(data) ? data : []) as { id: string; ref: string }[];
  let horses = 0;
  let starts = 0;
  let batch: unknown[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const saved = await supabase.rpc("racing_feed_histories", { p_source: RACING_API_SOURCE, p_items: batch });
    if (saved.error) throw new Error("history_save_failed");
    starts += Number(saved.data ?? 0);
    batch = [];
  };
  for (const horse of due) {
    const record = historyFromRacingApi(horse.ref, await fetchHorseResults(horse.ref));
    // A horse with no results yet is still stamped as read, so it isn't asked for again this week.
    batch.push(record ?? { horse: { ref: horse.ref, name: "" }, history: [] });
    horses++;
    if (batch.length >= 20) await flush();
  }
  await flush();
  return { horses, starts, due: due.length };
}

// ---------- Background jobs ----------
export interface PullJob {
  id: string;
  kind: "days" | "histories" | "automatic";
  by: "admin" | "automatic";
  dates: string[];
  startedAt: string;
  finishedAt: string | null;
  done: number;
  total: number;
  days: DaySummary[];
  histories: { horses: number; starts: number } | null;
  error: string | null;
}
let running: PullJob | null = null;
const recentJobs: PullJob[] = [];

export const pullState = () => ({ running, recent: recentJobs.slice(0, 6) });

function finish(job: PullJob, error: string | null) {
  job.finishedAt = new Date().toISOString();
  job.error = error;
  if (running === job) running = null;
  recentJobs.unshift(job);
  recentJobs.splice(10);
}

/**
 * Starts a pull in the background (one at a time). dates: the days to pull, oldest first; histories: how many horses'
 * earlier starts to read afterwards (0 = none). Returns the job, or null if one is already running.
 */
export function startPull(options: { dates: string[]; histories: number; actor: string | null; kind?: PullJob["kind"] }) {
  if (running) return null;
  const job: PullJob = {
    id: Math.random().toString(36).slice(2, 10),
    kind: options.kind ?? (options.dates.length ? "days" : "histories"),
    by: options.actor ? "admin" : "automatic",
    dates: options.dates,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    done: 0,
    total: options.dates.length + (options.histories > 0 ? 1 : 0),
    days: [],
    histories: null,
    error: null,
  };
  running = job;
  void (async () => {
    try {
      for (const date of options.dates) {
        try {
          const outcome: Partial<Awaited<ReturnType<typeof pullDay>>> = await pullDay(date, options.actor);
          delete outcome.results;
          job.days.push(outcome as DaySummary);
        } catch (error) {
          job.days.push({ ...summarise(date, [], false), error: failureText(error) });
          // A refused login or an unreachable API won't fix itself on the next day: stop here.
          if (error instanceof RacingApiError && (error.status === 0 || error.status === 401 || error.status === 403)) throw error;
        }
        job.done++;
      }
      if (options.histories > 0) {
        const { horses, starts } = await pullHistories(options.histories);
        job.histories = { horses, starts };
        job.done++;
      }
      finish(job, null);
    } catch (error) {
      finish(job, failureText(error));
    }
  })();
  return job;
}

/** Wait for the running job (tests and the command-line puller). */
export async function pullSettled() {
  while (running) await new Promise((resolve) => setTimeout(resolve, 100));
}

// ---------- Provider status (cached: the admin page polls) ----------
let status: { at: number; value: { connected: boolean; northAmerica: boolean; error: string | null; checkedAt: string } } | null = null;
export async function racingApiStatus(force = false) {
  const configured = !!racingApiLogin();
  if (!configured) return { configured, connected: false, northAmerica: false, error: null, checkedAt: null };
  if (!force && status && Date.now() - status.at < 15 * 60_000) return { configured, ...status.value };
  try {
    const { northAmerica } = await checkRacingApi(racingToday());
    status = { at: Date.now(), value: { connected: true, northAmerica, error: null, checkedAt: new Date().toISOString() } };
  } catch (error) {
    status = { at: Date.now(), value: { connected: false, northAmerica: false, error: failureText(error), checkedAt: new Date().toISOString() } };
  }
  return { configured, ...status.value };
}

// ---------- Schedule ----------
const EVERY_MINUTES = 20;
let scheduleOn = false;
let lastTomorrow = 0;
let yesterdayDone = "";
export const scheduleState = () => ({ on: scheduleOn, everyMinutes: EVERY_MINUTES });

/**
 * While the server is awake: every 20 minutes pull today (cards, changes, results as they come in) and the 120
 * horses most due for their earlier starts; tomorrow's cards every 3 hours; yesterday once a day (late corrections).
 * Off when the login is missing, in tests, or with RACING_FEED_AUTO=off.
 */
export function startRacingSchedule() {
  if (scheduleOn || !racingApiLogin() || process.env.NODE_ENV === "test" || process.env.RACING_FEED_AUTO === "off") return false;
  scheduleOn = true;
  const tick = () => {
    const today = racingToday();
    const dates: string[] = [];
    if (yesterdayDone !== today) {
      dates.push(shiftISO(today, -1));
      yesterdayDone = today;
    }
    dates.push(today);
    if (Date.now() - lastTomorrow > 3 * 3600_000) {
      dates.push(shiftISO(today, 1));
      lastTomorrow = Date.now();
    }
    startPull({ dates, histories: 120, actor: null, kind: "automatic" });
  };
  setTimeout(tick, 45_000).unref();
  setInterval(tick, EVERY_MINUTES * 60_000).unref();
  return true;
}
