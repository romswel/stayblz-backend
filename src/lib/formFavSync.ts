import { supabase } from "./supabase";
import * as ff from "./formFav";
import * as idx from "./formFavIndex";
import {
  breedFor,
  distanceLabel,
  foaledFrom,
  personKey,
  refFor,
  sexFrom,
  startBase,
} from "./formFavLink";
import { groupedPushes, pushSaved, type SavedRacingAlert } from "./racingAlerts";
import type { Target } from "./push";

/**
 * Keeps race-data-linked horses up to date and tells their followers what happened (migration
 * 202611240001_virtual_racing_horses.sql). Runs after every A–Z index refresh (about every 30 minutes while the server
 * is awake; startFormFavSync in index.ts), and once for a horse right after it's linked (syncLinkedHorse).
 *
 * For each linked horse found in the index (last 30 days … next 2 days, US/Canada):
 *   - details: trainer from the latest start; sex, foaling year, sire and dam from a race card when the horse has a
 *     new entry (one cached FormFav call); breed from the code. Only values race data has are written.
 *   - log: every final result becomes a race row once (formfav_ref), or completes a hand-written row of that day.
 *   - alerts: entered (first time an entry is seen), jockey/driver or trainer change on an entry, scratched or race
 *     abandoned (from yesterday on), result (final, last 2 days). The SQL picks who hears about it, skips events from
 *     before the horse was linked and never saves the same alert twice, so restarts and catch-ups are safe.
 * Never throws (a failing step is counted and the rest goes on).
 */

interface Linked {
  kind: "virtual" | "owned";
  id: string;
  key: string;
  name: string;
  code: idx.IndexCode;
  runnerId: number | null;
  linkedAt: string;
  sire: string;
  dam: string;
  sex: string;
  foaledYear: number | null;
}
type Horse = NonNullable<ReturnType<typeof idx.getHorse>>;
type Start = idx.Start;

interface Event {
  key: string;
  ref: string;
  kind: "race_entry" | "race_scratch" | "race_result" | "race_change";
  horse: string;
  title: string;
  body: string;
  at: string;
}

const MAX_CARDS_PER_RUN = 30;
const DAY = 86_400_000;
const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const isFinal = (s: Start) => !s.scratched && s.status === "final" && s.position !== null;
const isUpcoming = (s: Start, today: string) => !s.scratched && s.status !== "final" && s.status !== "abandoned" && s.date >= today;
const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

// ── words ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const dayFormat = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
function ordinal(n: number) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}
/** "Race 4 · Parx · Mon, Nov 24" (+ " · post 3:05 PM ET"). */
function when(s: Start, withPost = false) {
  const parts = [s.raceNumber ? `Race ${s.raceNumber}` : null, s.track ?? s.slug, dayFormat.format(new Date(`${s.date}T12:00:00Z`))];
  if (withPost && s.startTime) {
    const at = new Date(s.startTime);
    if (!Number.isNaN(at.getTime())) parts.push(`post ${timeFormat.format(at)} ET`);
  }
  return parts.filter(Boolean).join(" · ");
}
const rider = (code: string) => (code === "harness" ? "Driver" : "Jockey");
const raceTime = (s: Start) => (s.startTime && !Number.isNaN(Date.parse(s.startTime)) ? new Date(s.startTime).toISOString() : `${s.date}T23:59:00Z`);

// ── what race data says about a horse ────────────────────────────────────────────────────────────────────────────────
export function runsOf(h: Horse) {
  return h.history.filter(isFinal).map((s) => ({
    ref: refFor(`${startBase(s, h.name)}|run`),
    date: s.date,
    track: s.track ?? s.slug,
    raceName: s.raceName ?? "",
    distance: distanceLabel(s.distance),
    finish: s.position,
    fieldSize: s.fieldSize,
  }));
}

/** Sex, foaling year, sire and dam from one race card (null when FormFav can't say). */
async function cardDetails(h: Horse, s: Start) {
  if (!s.raceNumber) return null;
  try {
    const card = await ff.raceCard({
      date: s.date,
      track: s.slug,
      race: s.raceNumber,
      raceCode: s.code,
      country: s.country,
      timezone: s.timezone,
    });
    const runner = card.runners.find((r) => r.name && fold(r.name) === fold(h.name));
    if (!runner) return null;
    const out: Record<string, unknown> = {};
    const sex = sexFrom(runner.sex);
    if (sex) out.sex = sex;
    const year = foaledFrom(runner.age, s.date);
    if (year) out.foaledYear = year;
    if (runner.sire) out.sire = runner.sire;
    if (runner.dam) out.dam = runner.dam;
    return out;
  } catch {
    return null;
  }
}

/** FormFav's runner id (career stats) plus sire/dam, from an exact-name runner search (US and Canada only). */
async function runnerMatch(h: Horse) {
  if (h.name.length < 3) return null;
  try {
    const found = await ff.search("runner", h.name, h.code);
    // US and Canada only (ff.search already drops the rest); two North American horses of that name = no guess.
    const exact = found.results.filter((r: any) => r.name && fold(r.name) === fold(h.name) && ff.isNorthAmerica(r.country));
    const pick = exact.length === 1 ? exact[0] : null;
    if (!pick || typeof pick.id !== "number") return null;
    const out: Record<string, unknown> = { runnerId: pick.id };
    if (pick.sire) out.sire = pick.sire;
    if (pick.dam) out.dam = pick.dam;
    return out;
  } catch {
    return null;
  }
}

/** Trainer (latest start) and breed: what the index alone says. */
function baseFields(h: Horse) {
  const out: Record<string, unknown> = { breed: breedFor(h.code) };
  if (h.trainer) out.trainer = h.trainer;
  return out;
}

async function apply(kind: Linked["kind"], id: string, fields: Record<string, unknown>, runs: ReturnType<typeof runsOf>) {
  const { data, error } = await supabase.rpc("formfav_apply", { p_kind: kind, p_id: id, p_fields: fields, p_runs: runs });
  if (error) throw error;
  return data as { added: number; attached: number } | null;
}

/**
 * Right after a horse is linked: details (race card of its latest start + runner search) and the whole window's
 * results in its log. No alerts (everything so far happened before the link). Never throws.
 */
export async function syncLinkedHorse(kind: Linked["kind"], id: string, link: { name: string; code: string }) {
  try {
    const h = idx.getHorse(link.name, link.code as idx.IndexCode);
    if (!h) return null;
    const latest = h.history.find((s) => !s.scratched && s.raceNumber);
    const [card, runner] = await Promise.all([latest ? cardDetails(h, latest) : null, runnerMatch(h)]);
    // The race card is the better source for the pedigree; the runner search fills in what it doesn't have.
    return await apply(kind, id, { ...baseFields(h), ...(runner ?? {}), ...(card ?? {}) }, runsOf(h));
  } catch {
    return null;
  }
}

// ── the run after each index refresh ─────────────────────────────────────────────────────────────────────────────────
export interface SyncResult {
  horses: number;
  inIndex: number;
  applied: number;
  events: number;
  saved: number;
  pushed: number;
  failed: number;
}
let running: Promise<SyncResult> | null = null;

/** One sync at a time; a second call while one runs gets the same result. */
export function syncFormFav(): Promise<SyncResult> {
  if (running) return running;
  running = runSync().finally(() => {
    running = null;
  });
  return running;
}

async function runSync(): Promise<SyncResult> {
  const result: SyncResult = { horses: 0, inIndex: 0, applied: 0, events: 0, saved: 0, pushed: 0, failed: 0 };
  let linked: Linked[];
  try {
    const { data, error } = await supabase.rpc("formfav_linked_horses", {});
    if (error) throw error;
    linked = (Array.isArray(data) ? data : []) as Linked[];
  } catch {
    result.failed++;
    return result;
  }
  result.horses = linked.length;
  if (!linked.length) return result;

  const today = idx.indexToday();
  const yesterday = shift(today, -1);
  const twoDaysAgo = shift(today, -2);
  const groups = new Map<string, { horse: Horse; links: Linked[] }>();
  for (const l of linked) {
    const g = groups.get(l.key);
    if (g) {
      g.links.push(l);
      continue;
    }
    const horse = idx.getHorse(l.name, l.code);
    if (horse) groups.set(l.key, { horse, links: [l] });
  }
  result.inIndex = [...groups.values()].reduce((n, g) => n + g.links.length, 0);

  // Upcoming entries: which are new, and whose rider or trainer changed since they were first seen.
  const entries = [];
  for (const { horse } of groups.values())
    for (const s of horse.history.filter((x) => isUpcoming(x, today)))
      entries.push({
        ref: refFor(`${startBase(s, horse.name)}|entry`),
        date: s.date,
        jockey: s.jockey ?? "",
        jockeyKey: personKey(s.jockey),
        trainer: s.trainer ?? "",
        trainerKey: personKey(s.trainer),
      });
  const seen = new Map<string, any>();
  if (entries.length) {
    try {
      const { data, error } = await supabase.rpc("formfav_entries_seen", { p_entries: entries });
      if (error) throw error;
      for (const row of Array.isArray(data) ? data : []) if (row?.ref) seen.set(row.ref, row);
    } catch {
      result.failed++;
    }
  }

  const events: Event[] = [];
  let cards = 0;
  const now = new Date().toISOString();
  for (const [key, { horse, links }] of groups) {
    const base = (s: Start) => startBase(s, horse.name);
    const lastRide = horse.history.find(isFinal) ?? null;
    let card: Record<string, unknown> | null = null;
    for (const s of horse.history.filter((x) => isUpcoming(x, today))) {
      const ref = refFor(`${base(s)}|entry`);
      const state = seen.get(ref);
      if (!state) continue;
      const role = rider(s.code);
      if (state.new) {
        const newRider = s.jockey && lastRide?.jockey && personKey(s.jockey) !== personKey(lastRide.jockey);
        events.push({
          key,
          ref,
          kind: "race_entry",
          horse: horse.name,
          title: `${horse.name} is entered`,
          body: [when(s, true), s.jockey ? `${role}: ${s.jockey}${newRider ? ` (new, last time ${lastRide!.jockey})` : ""}` : null]
            .filter(Boolean)
            .join(" · "),
          at: now,
        });
        if (!card && cards < MAX_CARDS_PER_RUN) {
          cards++;
          card = await cardDetails(horse, s);
        }
      }
      if (state.jockey || state.trainer) {
        const [oldJ, newJ] = (state.jockey ?? []) as string[];
        const [oldT, newT] = (state.trainer ?? []) as string[];
        const what = state.jockey && state.trainer ? `${role} and trainer` : state.jockey ? role : "Trainer";
        events.push({
          key,
          ref: refFor(`${base(s)}|change|${personKey(s.jockey)}|${personKey(s.trainer)}`),
          kind: "race_change",
          horse: horse.name,
          title: `${what} change for ${horse.name}`,
          body: [
            when(s),
            state.jockey ? `${role}: ${newJ} (was ${oldJ})` : null,
            state.trainer ? `Trainer: ${newT} (was ${oldT})` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          at: now,
        });
      }
    }
    for (const s of horse.history.filter((x) => x.date >= yesterday && (x.scratched || x.status === "abandoned"))) {
      events.push({
        key,
        ref: refFor(`${base(s)}|scratch`),
        kind: "race_scratch",
        horse: horse.name,
        title: s.scratched ? `${horse.name} was scratched` : `${horse.name}'s race was abandoned`,
        body: when(s),
        at: raceTime(s),
      });
    }
    for (const s of horse.history.filter((x) => isFinal(x) && x.date >= twoDaysAgo)) {
      events.push({
        key,
        ref: refFor(`${base(s)}|result`),
        kind: "race_result",
        horse: horse.name,
        title: s.position === 1 ? `${horse.name} won` : `${horse.name} finished ${ordinal(s.position!)}`,
        body: [when(s), s.fieldSize ? `${s.fieldSize} ran` : null].filter(Boolean).join(" · "),
        at: raceTime(s),
      });
    }

    const runs = runsOf(horse);
    const fields = { ...baseFields(horse), ...(card ?? {}) };
    for (const l of links) {
      try {
        if (await apply(l.kind, l.id, fields, runs)) result.applied++;
      } catch {
        result.failed++;
      }
    }
  }

  result.events = events.length;
  if (!events.length) return result;
  try {
    const { data, error } = await supabase.rpc("formfav_notify", { p_events: events });
    if (error) throw error;
    const alerts = ((data as any)?.alerts ?? []) as SavedRacingAlert[];
    const targets = ((data as any)?.targets ?? []) as (Target & { alertId?: string })[];
    result.saved = alerts.length;
    if (alerts.length) {
      const payloads = groupedPushes(alerts, { tag: `racing-data-${today}`, url: "/my-racing?tab=alerts" });
      result.pushed = await pushSaved(payloads, targets);
    }
  } catch {
    result.failed++;
  }
  return result;
}

let stop: (() => void) | null = null;
/** Sync after every index refresh (server start; not in tests, which call syncFormFav themselves). */
export function startFormFavSync() {
  if (stop || process.env.NODE_ENV === "test") return false;
  stop = idx.onIndexRefreshed(() => void syncFormFav().catch(() => undefined));
  return true;
}
