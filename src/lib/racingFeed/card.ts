/**
 * The one card format every racing data source is converted to before import (SQL racing_feed_import,
 * migration 202611190005_racing_feed.sql). One card = one track's race day.
 *
 * cardInput() checks and cleans a card so every value fits the racing tables' rules; anything that can't be fixed is
 * dropped (a runner without a program number, a bad workout) and counted in `skipped`, never guessed.
 */
export type Breed = "thoroughbred" | "harness" | "quarter_horse";
export interface CardHorse {
  ref: string | null;
  name: string;
  country: string;
  sex: string;
  foaled: number | null;
  sire: string;
  dam: string;
  damSire: string;
  breeder: string;
}
export interface CardRunner {
  program: string;
  post: number | null;
  horse: CardHorse;
  jockey: string;
  trainer: string;
  owner: string;
  /** The provider's ids for the people, when it has them. */
  jockeyRef: string | null;
  trainerRef: string | null;
  ownerRef: string | null;
  weight: number | null;
  medication: string;
  equipment: string;
  morningLine: string;
  scratched: boolean;
  scratchReason: string;
  finish: number | null;
  odds: number | null;
  earnings: number | null;
}
export interface CardRace {
  number: number;
  /** The provider's race id: re-imports find the race by it even if the numbering changed. */
  ref: string | null;
  postTime: string;
  name: string;
  type: string;
  grade: number | null;
  breed: Breed;
  distanceValue: number | null;
  distanceUnit: string;
  surface: string;
  condition: string;
  purse: number | null;
  currency: string;
  conditions: string;
  status: "scheduled" | "official" | "cancelled";
  winningTime: string;
  payouts: { pool: string; combination: string; amount: number }[];
  runners: CardRunner[];
}
export interface CardHistory {
  date: string;
  trackCode: string;
  trackName: string;
  race: number | null;
  name: string;
  type: string;
  breed: Breed;
  distanceValue: number | null;
  distanceUnit: string;
  surface: string;
  fieldSize: number | null;
  finish: number | null;
  /** Final odds to 1 (decimal odds minus one). */
  odds: number | null;
  rider: string;
}
export interface CardWorkout {
  date: string;
  trackCode: string;
  trackName: string;
  distanceValue: number;
  distanceUnit: string;
  surface: string;
  timeSeconds: number;
  rank: number | null;
  rankOf: number | null;
  note: string;
}
export interface Card {
  source: string;
  date: string;
  track: { code: string; name: string; country: string; breed: Breed; ref: string | null };
  races: CardRace[];
  horses: (Pick<CardHorse, "ref" | "name" | "country"> & { history: CardHistory[]; workouts: CardWorkout[] })[];
}

const RACE_TYPES = ["maiden", "maiden_claiming", "claiming", "allowance", "optional_claiming", "starter", "stakes", "handicap", "trial", "other"];
const SURFACES = ["dirt", "turf", "synthetic", "all_weather"];
const UNITS = ["furlongs", "miles", "yards", "meters"];
const CONDITIONS = ["", "fast", "good", "firm", "yielding", "soft", "sloppy", "muddy", "sealed", "heavy", "wet_fast", "standard"];
const SEXES = ["", "colt", "filly", "gelding", "horse", "mare", "ridgling"];
const BREEDS: Breed[] = ["thoroughbred", "harness", "quarter_horse"];
/** Most runners in one race (the biggest fields, e.g. the Grand National, have 40). */
export const MAX_RUNNERS = 40;

/** Plain text: no control characters or angle brackets, single spaces, cut to length. */
export function clean(value: unknown, max: number) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}
const int = (value: unknown, min: number, max: number) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const num = (value: unknown, min: number, max: number, places = 2) => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10 ** places) / 10 ** places : null;
};
const oneOf = <T extends string>(value: unknown, list: readonly T[], fallback: T): T =>
  list.includes(value as T) ? (value as T) : fallback;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));
/** A provider id: letters, numbers, ':', '_' or '-', up to 40 characters. */
export const refInput = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9:_-]{1,40}$/.test(v) ? v : null);

function horseInput(raw: any): CardHorse | null {
  const name = clean(raw?.name, 40);
  if (!name) return null;
  const ref = refInput(raw?.ref);
  const country = typeof raw?.country === "string" && /^[A-Z]{2,3}$/.test(raw.country) ? raw.country : "";
  return {
    ref,
    name,
    country,
    sex: oneOf(raw?.sex, SEXES, ""),
    foaled: int(raw?.foaled, 1980, 2100),
    sire: clean(raw?.sire, 40),
    dam: clean(raw?.dam, 40),
    damSire: clean(raw?.damSire, 40),
    breeder: clean(raw?.breeder, 80),
  };
}

export function cardInput(raw: any): { value: Card; skipped: number } | { error: string } {
  let skipped = 0;
  const source = typeof raw?.source === "string" && /^[a-z0-9_-]{2,30}$/.test(raw.source) ? raw.source : null;
  if (!source) return { error: "Each card needs a source (lowercase letters, numbers, - or _)." };
  if (!isDate(raw?.date)) return { error: "Each card needs a date (YYYY-MM-DD)." };
  const code = typeof raw?.track?.code === "string" ? raw.track.code.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{2,6}$/.test(code)) return { error: "Each card needs a track code of 2–6 letters or numbers." };
  const track = {
    code,
    name: clean(raw.track.name, 80).length >= 2 ? clean(raw.track.name, 80) : code,
    country: typeof raw.track.country === "string" && /^[A-Z]{2}$/.test(raw.track.country) ? raw.track.country : "",
    breed: oneOf(raw.track.breed, BREEDS, "thoroughbred"),
    ref: refInput(raw.track.ref),
  };
  if (!Array.isArray(raw?.races) || raw.races.length > 40) return { error: `${code} ${raw.date}: a card has up to 40 races.` };

  const races: CardRace[] = [];
  const numbers = new Set<number>();
  for (const r of raw.races) {
    const number = int(r?.number, 1, 40);
    if (number === null || numbers.has(number)) {
      skipped++;
      continue;
    }
    numbers.add(number);
    const status = oneOf(r?.status, ["scheduled", "official", "cancelled"] as const, "scheduled");
    const runners: CardRunner[] = [];
    const programs = new Set<string>();
    const horsesSeen = new Set<string>();
    for (const x of Array.isArray(r?.runners) ? r.runners.slice(0, MAX_RUNNERS) : []) {
      const program = typeof x?.program === "string" ? x.program.trim().toUpperCase() : typeof x?.program === "number" ? String(x.program) : "";
      const horse = horseInput(x?.horse);
      const horseKey = horse ? (horse.ref ?? `${horse.name.toLowerCase()}|${horse.country}`) : "";
      // A non-runner that lost its number can still scratch the runner already on the card (program left blank).
      const scratchOnly = program === "" && x?.scratched === true;
      if ((!scratchOnly && !/^[0-9]{1,2}[A-Z]?$/.test(program)) || !horse || (program && programs.has(program)) || horsesSeen.has(horseKey)) {
        skipped++;
        continue;
      }
      if (program) programs.add(program);
      horsesSeen.add(horseKey);
      const scratched = x?.scratched === true;
      const ml = typeof x?.morningLine === "string" ? x.morningLine.trim() : "";
      runners.push({
        program,
        post: int(x?.post, 1, MAX_RUNNERS),
        horse,
        jockey: clean(x?.jockey, 80),
        trainer: clean(x?.trainer, 80),
        owner: clean(x?.owner, 80),
        jockeyRef: refInput(x?.jockeyRef),
        trainerRef: refInput(x?.trainerRef),
        ownerRef: refInput(x?.ownerRef),
        weight: int(x?.weight, 50, 200),
        medication: clean(x?.medication, 10),
        equipment: clean(x?.equipment, 20),
        morningLine: /^[0-9]{1,3}-[0-9]{1,2}$/.test(ml) ? ml : "",
        scratched,
        scratchReason: clean(x?.scratchReason, 80),
        finish: scratched ? null : int(x?.finish, 1, MAX_RUNNERS),
        odds: num(x?.odds, 0, 99999),
        earnings: int(x?.earnings, 0, 2_000_000_000),
      });
    }
    // An official result needs a winner; without one the race stays scheduled.
    const official = status === "official" && runners.some((x) => x.finish === 1);
    const postTime = typeof r?.postTime === "string" && /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(r.postTime) ? r.postTime : "";
    races.push({
      number,
      ref: refInput(r?.ref),
      postTime,
      name: clean(r?.name, 100),
      type: oneOf(r?.type, RACE_TYPES, "other"),
      grade: int(r?.grade, 1, 3),
      breed: oneOf(r?.breed, BREEDS, track.breed),
      distanceValue: num(r?.distanceValue, 0.01, 9999),
      distanceUnit: oneOf(r?.distanceUnit, UNITS, "furlongs"),
      surface: oneOf(r?.surface, SURFACES, "dirt"),
      condition: oneOf(r?.condition, CONDITIONS, ""),
      purse: int(r?.purse, 0, 2_000_000_000),
      currency: typeof r?.currency === "string" && /^[A-Z]{3}$/.test(r.currency) ? r.currency : "USD",
      conditions: clean(r?.conditions, 500),
      status: status === "official" && !official ? "scheduled" : status,
      winningTime: clean(r?.winningTime, 20),
      payouts: (Array.isArray(r?.payouts) ? r.payouts : [])
        .map((p: any) => ({ pool: clean(p?.pool, 40), combination: clean(p?.combination, 40), amount: num(p?.amount, 0, 10_000_000) }))
        .filter((p: { pool: string; amount: number | null }) => p.pool && p.amount !== null)
        .slice(0, 40),
      runners,
    });
  }

  const horses: Card["horses"] = [];
  for (const h of Array.isArray(raw?.horses) ? raw.horses.slice(0, 600) : []) {
    const horse = horseInput(h);
    if (!horse) {
      skipped++;
      continue;
    }
    const history: CardHistory[] = [];
    const seen = new Set<string>();
    for (const x of Array.isArray(h.history) ? h.history.slice(0, 200) : []) {
      const trackCode = typeof x?.trackCode === "string" ? x.trackCode.trim().toUpperCase() : "";
      // A horse runs at most once a day at one track; the race number is optional (not every provider gives it).
      const key = `${x?.date}|${trackCode}`;
      if (!isDate(x?.date) || !/^[A-Z0-9]{2,6}$/.test(trackCode) || seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
      const distanceValue = num(x?.distanceValue, 0.01, 9999);
      history.push({
        date: x.date,
        trackCode,
        trackName: clean(x.trackName, 80),
        race: int(x?.race, 1, 40),
        name: clean(x?.name, 100),
        type: clean(x.type, 60),
        breed: oneOf(x.breed, BREEDS, "thoroughbred"),
        distanceValue,
        distanceUnit: oneOf(x?.distanceUnit, UNITS, "furlongs"),
        surface: oneOf(x?.surface, ["", ...SURFACES], ""),
        fieldSize: int(x?.fieldSize, 1, 60),
        finish: int(x.finish, 1, 60),
        odds: num(x?.odds, 0, 99999),
        rider: clean(x?.rider, 80),
      });
    }
    const workouts: CardWorkout[] = [];
    const days = new Set<string>();
    for (const x of Array.isArray(h.workouts) ? h.workouts.slice(0, 60) : []) {
      const trackCode = typeof x?.trackCode === "string" ? x.trackCode.trim().toUpperCase() : "";
      const distanceValue = num(x?.distanceValue, 0.01, 9999);
      const timeSeconds = num(x?.timeSeconds, 0.01, 599.99);
      let rank = int(x?.rank, 1, 9999);
      let rankOf = int(x?.rankOf, 1, 9999);
      if (rank !== null && rankOf !== null && rank > rankOf) rank = rankOf = null;
      const key = `${x?.date}|${trackCode}`;
      if (!isDate(x?.date) || !/^[A-Z0-9]{2,6}$/.test(trackCode) || distanceValue === null || timeSeconds === null || days.has(key)) {
        skipped++;
        continue;
      }
      days.add(key);
      workouts.push({
        date: x.date,
        trackCode,
        trackName: clean(x.trackName, 80),
        distanceValue,
        distanceUnit: oneOf(x.distanceUnit, UNITS, "furlongs"),
        surface: oneOf(x.surface, SURFACES, "dirt"),
        timeSeconds,
        rank,
        rankOf,
        note: clean(x.note, 20),
      });
    }
    horses.push({ ref: horse.ref, name: horse.name, country: horse.country, history, workouts });
  }
  return { value: { source, date: raw.date, track, races, horses }, skipped };
}
