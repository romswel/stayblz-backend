/**
 * Race history: every finished US/Canada day from the A–Z index (lib/formFavIndex.ts), kept in Postgres for a rolling
 * year (migration 202611280001_formfav_history.sql), so horses, jockeys and trainers stay findable, with their runs,
 * after they leave FormFav's ~30-day window.
 *
 *   archiveDays()       after each index refresh: finished days (complete, before yesterday) not stored yet.
 *   backfillFromStore() once after the first refresh: days saved to R2 (lib/formFavIndex.ts) that already left the
 *                       window (they were saved from 2026-10-26).
 *   pruneHistory()      at most once a day: keeps FORMFAV_HISTORY_DAYS (default 365, at least 30).
 *
 * Writing is on in production, or with FORMFAV_HISTORY=on; FORMFAV_HISTORY=off turns it off everywhere (e.g. if FormFav
 * doesn't allow keeping their data). Reading is always tried; a database without the tables just has no history
 * (checked again after a few minutes). No FormFav calls here: everything comes from what the index already read.
 */
import { supabase } from "./supabase";
import * as idx from "./formFavIndex";

/** The first day saved to R2 (nothing earlier exists anywhere). */
export const FIRST_SAVED_DAY = "2026-10-26";
const DAYS_PER_RUN = 60;
const DAY_MS = 86_400_000;
const RETRY_MS = 5 * 60_000;

let enabledOverride: boolean | undefined;
/** For tests: force writing on/off (undefined goes back to the environment). */
export function setHistoryEnabled(on: boolean | undefined) {
  enabledOverride = on;
}
export function historyEnabled() {
  if (enabledOverride !== undefined) return enabledOverride;
  const v = process.env.FORMFAV_HISTORY?.trim().toLowerCase();
  if (v === "off") return false;
  if (v === "on") return true;
  return process.env.NODE_ENV === "production";
}
export function keepDays() {
  const n = Number(process.env.FORMFAV_HISTORY_DAYS);
  return Number.isInteger(n) && n >= 30 && n <= 3650 ? n : 365;
}
/** The oldest day the history can hold now. */
export function historySince() {
  const byKeep = idx.shiftDay(idx.indexToday(), -keepDays());
  return byKeep > FIRST_SAVED_DAY ? byKeep : FIRST_SAVED_DAY;
}

// ── writing ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One finished day as formfav_history_save_day takes it: final races only, scratchings left out. */
export function dayPayload(day: idx.Day) {
  return day.meetings
    .filter((m) => m.country === "us" || m.country === "ca")
    .flatMap((m) =>
      m.races
        .filter((r) => r.status === "final" && !r.abandoned)
        .map((r) => {
          const runners = r.runners.filter((x) => !x.scratched && x.name);
          return {
            slug: m.slug,
            track: m.track,
            country: m.country,
            number: r.number,
            name: r.name,
            class: r.raceClass ?? null,
            distance: r.distance ?? null,
            startTime: r.startTime,
            fieldSize: runners.length || null,
            runners: runners.map((x) => ({
              key: idx.horseKey(x.name, day.code),
              name: x.name,
              position: x.position,
              jockey: x.jockey,
              jockeyKey: idx.personKey(x.jockey) || null,
              trainer: x.trainer,
              trainerKey: idx.personKey(x.trainer) || null,
            })),
          };
        })
        .filter((r) => r.runners.length),
    );
}

async function saveDay(day: idx.Day) {
  const { error } = await supabase.rpc("formfav_history_save_day", { p_code: day.code, p_date: day.date, p_races: dayPayload(day) });
  if (error) throw error;
}

/** `${code}/${date}` of every stored day from `from` on. */
async function storedDays(from: string) {
  const { data, error } = await supabase.from("formfav_history_days").select("code,race_date").gte("race_date", from).limit(5000);
  if (error) throw error;
  return new Set((data ?? []).map((d: any) => `${d.code}/${String(d.race_date).slice(0, 10)}`));
}

export interface ArchiveResult {
  saved: number;
  backfilled: number;
  pruned: boolean;
  failed: number;
}
let running: Promise<ArchiveResult> | null = null;
let backfillDone = false;
let lastPrune = 0;

/** Stores finished days not stored yet (and, the first time, the R2 backfill; at most daily, the prune). */
export function archiveDays(): Promise<ArchiveResult> {
  if (running) return running;
  running = (async () => {
    const result: ArchiveResult = { saved: 0, backfilled: 0, pruned: false, failed: 0 };
    if (!historyEnabled()) return result;
    const since = historySince();
    const have = await storedDays(since);
    for (const day of idx.finishedDays()) {
      if (result.saved >= DAYS_PER_RUN) break;
      if (day.date < since || have.has(`${day.code}/${day.date}`)) continue;
      try {
        await saveDay(day);
        have.add(`${day.code}/${day.date}`);
        result.saved++;
      } catch (e) {
        console.error("[formfav-history] saving", day.code, day.date, "failed:", (e as { message?: string })?.message ?? "no detail");
        result.failed++;
      }
    }
    if (!backfillDone) {
      const b = await backfillFromStore(have);
      result.backfilled = b.saved;
      result.failed += b.failed;
      backfillDone = b.failed === 0;
    }
    if (Date.now() - lastPrune > DAY_MS) {
      const { error } = await supabase.rpc("formfav_history_prune", { p_keep_days: keepDays() });
      if (!error) {
        lastPrune = Date.now();
        result.pruned = true;
      } else result.failed++;
    }
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Days saved to R2 that are already before the window (and so not in memory): from FIRST_SAVED_DAY / the keep limit. */
export async function backfillFromStore(have?: Set<string>) {
  const out = { saved: 0, failed: 0 };
  const store = idx.savedDayStore();
  if (!store || !historyEnabled()) return out;
  const known = have ?? (await storedDays(historySince()));
  const end = idx.windowStart();
  for (let date = historySince(); date < end; date = idx.shiftDay(date, 1))
    for (const code of idx.INDEX_CODES) {
      if (known.has(`${code}/${date}`)) continue;
      try {
        const body = await store.get(`${code}/${date}`);
        const day = body ? idx.parseSaved(body, date, code) : null;
        if (!day) continue;
        await saveDay(day);
        known.add(`${code}/${date}`);
        out.saved++;
      } catch (e) {
        console.error("[formfav-history] backfill", code, date, "failed:", (e as { message?: string })?.message ?? "no detail");
        out.failed++;
      }
    }
  return out;
}

/** For tests: forget the backfill and prune state. */
export function resetHistory() {
  backfillDone = false;
  lastPrune = 0;
  running = null;
  unavailableUntil = 0;
}

let stop: (() => void) | null = null;
/** Archive after every index refresh (index.ts, with the index schedule). */
export function startFormFavHistory() {
  if (stop || !historyEnabled()) return false;
  stop = idx.onIndexRefreshed(() => void archiveDays().catch(() => undefined));
  return true;
}

// ── reading ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let unavailableUntil = 0;
async function read<T>(name: string, args: Record<string, unknown>): Promise<T | null> {
  if (Date.now() < unavailableUntil) return null;
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    // No history tables on this database (not migrated yet) or a hiccup: no history for a few minutes.
    unavailableUntil = Date.now() + RETRY_MS;
    return null;
  }
  return (data ?? null) as T | null;
}

export interface HistoryStart {
  date: string;
  code: idx.IndexCode;
  track: string | null;
  slug: string;
  country: string;
  raceNumber: number | null;
  raceName: string | null;
  raceClass: string | null;
  distance: string | null;
  startTime: string | null;
  position: number | null;
  fieldSize: number | null;
  jockey: string | null;
  trainer: string | null;
}
export interface HistoryHorse {
  key: string;
  name: string;
  code: idx.IndexCode;
  lastDate: string;
  starts: HistoryStart[];
}
const iso = (v: unknown) => (v ? String(v).slice(0, 10) : "");

/** A horse's stored runs, newest first (only those before `before` when given), or null. */
export async function historyHorse(key: string, before: string | null): Promise<HistoryHorse | null> {
  const h = await read<any>("formfav_history_horse", { p_key: key, p_before: before });
  if (!h || typeof h.name !== "string") return null;
  return {
    key: h.key,
    name: h.name,
    code: h.code,
    lastDate: iso(h.lastDate),
    starts: (Array.isArray(h.starts) ? h.starts : []).map((s: any) => ({
      date: iso(s.date),
      code: s.code,
      track: s.track ?? null,
      slug: s.slug,
      country: s.country,
      raceNumber: s.raceNumber ?? null,
      raceName: s.raceName ?? null,
      raceClass: s.raceClass ?? null,
      distance: s.distance ?? null,
      startTime: s.startTime ? new Date(s.startTime).toISOString() : null,
      position: s.position ?? null,
      fieldSize: s.fieldSize ?? null,
      jockey: s.jockey ?? null,
      trainer: s.trainer ?? null,
    })),
  };
}

export interface HistoryPerson {
  name: string;
  rides: number;
  wins: number;
  places: number;
  tracks: number;
  firstRide: string | null;
  lastRide: string | null;
}
export async function historyPerson(kind: "jockey" | "trainer", name: string): Promise<HistoryPerson | null> {
  const key = idx.personKey(name);
  if (!key) return null;
  const p = await read<any>("formfav_history_person", { p_kind: kind, p_key: key });
  if (!p || typeof p.name !== "string") return null;
  return {
    name: p.name,
    rides: Number(p.rides) || 0,
    wins: Number(p.wins) || 0,
    places: Number(p.places) || 0,
    tracks: Number(p.tracks) || 0,
    firstRide: p.firstRide ? iso(p.firstRide) : null,
    lastRide: p.lastRide ? iso(p.lastRide) : null,
  };
}

export type HistoryHit =
  | { kind: "horse"; key: string; name: string; code: idx.IndexCode; lastDate: string; starts: number; wins: number; places: number }
  | { kind: "jockey" | "trainer"; key: string; name: string; lastDate: string; rides: number; wins: number };
export async function historySearch(kind: "horse" | "jockey" | "trainer", q: string, codes: readonly string[], limit: number): Promise<HistoryHit[]> {
  const rows = await read<any[]>("formfav_history_search", { p_kind: kind, p_q: q, p_codes: codes.join(","), p_limit: limit });
  return (Array.isArray(rows) ? rows : []).map((r: any) =>
    kind === "horse"
      ? { kind, key: r.key, name: r.name, code: r.code, lastDate: iso(r.lastDate), starts: Number(r.starts) || 0, wins: Number(r.wins) || 0, places: Number(r.places) || 0 }
      : { kind, key: r.key, name: r.name, lastDate: iso(r.lastDate), rides: Number(r.rides) || 0, wins: Number(r.wins) || 0 },
  );
}
