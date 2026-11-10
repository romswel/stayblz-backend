/**
 * Validation for the racing publishing tool. Every function returns either { error } with a
 * plain-English message or { value } with clean database columns. The database repeats the
 * important checks, so a bad value can never be stored even if this layer misses it.
 */
export const BREEDS = ["thoroughbred", "harness", "quarter_horse"] as const;
export const SURFACES = ["dirt", "turf", "synthetic", "all_weather"] as const;
export const UNITS = ["furlongs", "miles", "yards", "meters"] as const;
export const RACE_TYPES = [
  "maiden", "maiden_claiming", "claiming", "allowance", "optional_claiming",
  "starter", "stakes", "handicap", "trial", "other",
] as const;
export const CONDITIONS = [
  "", "fast", "good", "firm", "yielding", "soft", "sloppy", "muddy", "sealed", "heavy", "wet_fast", "standard",
] as const;
export const PERSON_KINDS = ["jockey", "driver", "trainer", "owner"] as const;
export const SEXES = ["", "colt", "filly", "gelding", "horse", "mare", "ridgling"] as const;
export const RACE_STATUSES = ["scheduled", "official", "cancelled"] as const;

type Result<T> = { error: string } | { value: T };
type Body = Record<string, unknown>;
const unsafe = /[\u0000-\u001f\u007f<>]/;
const unsafeBlock = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/;

class Invalid extends Error {}
const fail = (message: string): never => {
  throw new Invalid(message);
};
const run = <T>(build: () => T): Result<T> => {
  try {
    return { value: build() };
  } catch (error) {
    if (error instanceof Invalid) return { error: error.message };
    throw error;
  }
};

function text(body: Body, key: string, label: string, max: number, opts: { min?: number; multiline?: boolean } = {}) {
  const value = body[key];
  if (value === undefined || value === null) {
    if (opts.min) fail(`${label} is required.`);
    return "";
  }
  if (typeof value !== "string") return fail(`${label} must be text.`);
  const clean = opts.multiline ? value.replace(/\r\n?/g, "\n").trim() : value.trim();
  if (clean.length < (opts.min ?? 0)) fail(`${label} is required.`);
  if (clean.length > max) fail(`${label} can be up to ${max} characters.`);
  if ((opts.multiline ? unsafeBlock : unsafe).test(clean)) fail(`${label} can't contain < or > or control characters.`);
  return clean;
}
function oneOf<T extends readonly string[]>(body: Body, key: string, label: string, options: T, fallback: T[number]): T[number] {
  const value = body[key] ?? fallback;
  if (!options.includes(value as string)) fail(`Choose a valid ${label}.`);
  return value as T[number];
}
function int(body: Body, key: string, label: string, min: number, max: number, required = false): number | null {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === "") {
    if (required) fail(`${label} is required.`);
    return null;
  }
  const value = typeof raw === "string" ? Number(raw.replace(/[,$\s]/g, "")) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    fail(`${label} must be a whole number from ${min} to ${max}.`);
  return value as number;
}
function decimal(body: Body, key: string, label: string, min: number, max: number, required = false): number | null {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === "") {
    if (required) fail(`${label} is required.`);
    return null;
  }
  const value = typeof raw === "string" ? Number(raw.replace(/[,$\s]/g, "")) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    fail(`${label} must be a number from ${min} to ${max}.`);
  return Math.round((value as number) * 100) / 100;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(body: Body, key: string, label: string, required = false): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === "") {
    if (required) fail(`Choose a ${label}.`);
    return null;
  }
  if (typeof value !== "string" || !uuid.test(value)) fail(`Choose a valid ${label}.`);
  return value as string;
}
const isoDate = (value: unknown, label: string) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + "T00:00:00Z")))
    fail(`${label} must be a date (YYYY-MM-DD).`);
  const year = Number((value as string).slice(0, 4));
  if (year < 1980 || year > 2100) fail(`${label} must be between 1980 and 2100.`);
  return value as string;
};
/** Distances like "6", "8.5" or fractions "1 1/16" (miles). */
function distance(body: Body, key: string, required: boolean): number | null {
  const raw = body[key];
  if (typeof raw === "string") {
    const match = raw.trim().match(/^(\d+)(?:\s+(\d+)\/(\d+))?$|^(\d+)\/(\d+)$|^(\d+(?:\.\d+)?)$/);
    if (raw.trim() && !match) fail("Distance must be a number like 6, 8.5 or 1 1/16.");
    if (match) {
      const value = match[2]
        ? Number(match[1]) + Number(match[2]) / Number(match[3])
        : match[4]
          ? Number(match[4]) / Number(match[5])
          : Number(match[1] ?? match[6]);
      return decimal({ v: value }, "v", "Distance", 0.01, 9999, required);
    }
  }
  return decimal(body, key, "Distance", 0.01, 9999, required);
}
const postTime = (body: Body) => {
  const value = text(body, "postTime", "Post time", 5);
  if (value && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) fail("Post time must look like 13:05 (24-hour, track time).");
  return value;
};
const country = (body: Body, key: string, pattern: RegExp) => {
  const value = text(body, key, "Country", 3).toUpperCase();
  if (value && !pattern.test(value)) fail("Country must be a 2-letter code like US or GB.");
  return value;
};

export const trackInput = (body: Body) =>
  run(() => {
    const code = text(body, "code", "Track code", 6, { min: 2 }).toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(code)) fail("Track code must be 2–6 letters or numbers, like SA or BEL.");
    return {
      code,
      name: text(body, "name", "Track name", 80, { min: 2 }),
      country: country(body, "country", /^[A-Z]{2}$/),
      region: text(body, "region", "Region", 60),
      breed: oneOf(body, "breed", "breed", BREEDS, "thoroughbred"),
    };
  });

export const personInput = (body: Body) =>
  run(() => ({
    name: text(body, "name", "Name", 80, { min: 2 }),
    kind: oneOf(body, "kind", "role", PERSON_KINDS, "jockey"),
    country: country(body, "country", /^[A-Z]{2}$/),
  }));

export const horseInput = (body: Body) =>
  run(() => ({
    name: text(body, "name", "Horse name", 40, { min: 1 }),
    country: country(body, "country", /^[A-Z]{2,3}$/),
    foaled_year: int(body, "foaled", "Year foaled", 1980, 2100),
    sex: oneOf(body, "sex", "sex", SEXES, ""),
    color: text(body, "color", "Colour", 30),
    sire: text(body, "sire", "Sire", 40),
    dam: text(body, "dam", "Dam", 40),
    dam_sire: text(body, "damSire", "Dam's sire", 40),
    breeder: text(body, "breeder", "Breeder", 80),
    breed: oneOf(body, "breed", "breed", BREEDS, "thoroughbred"),
  }));

export const dayInput = (body: Body) =>
  run(() => ({
    track_id: id(body, "trackId", "track", true) as string,
    race_date: isoDate(body.date, "Race date"),
    notes: text(body, "notes", "Notes", 1000, { multiline: true }),
  }));

export const raceInput = (body: Body) =>
  run(() => {
    const raceType = oneOf(body, "type", "race type", RACE_TYPES, "other");
    const grade = int(body, "grade", "Grade", 1, 3);
    if (grade !== null && raceType !== "stakes") fail("Only stakes races can have a grade.");
    const currency = (text(body, "currency", "Currency", 3) || "USD").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) fail("Currency must be a 3-letter code like USD.");
    return {
      race_number: int(body, "number", "Race number", 1, 40, true) as number,
      post_time: postTime(body),
      name: text(body, "name", "Race name", 100),
      race_type: raceType,
      grade,
      breed: oneOf(body, "breed", "breed", BREEDS, "thoroughbred"),
      distance_value: distance(body, "distance", false),
      distance_unit: oneOf(body, "unit", "distance unit", UNITS, "furlongs"),
      surface: oneOf(body, "surface", "surface", SURFACES, "dirt"),
      track_condition: oneOf(body, "condition", "track condition", CONDITIONS, ""),
      purse: int(body, "purse", "Purse", 0, 2_000_000_000),
      currency,
      conditions: text(body, "conditions", "Conditions", 500, { multiline: true }),
    };
  });

export const runnerInput = (body: Body) =>
  run(() => {
    const program = text(body, "program", "Program number", 3, { min: 1 }).toUpperCase();
    if (!/^\d{1,2}[A-Z]?$/.test(program)) fail("Program number must look like 1, 12 or 1A.");
    const ml = text(body, "morningLine", "Morning line", 6);
    if (ml && !/^\d{1,3}-\d{1,2}$/.test(ml)) fail("Morning line odds must look like 5-2 or 10-1.");
    const scratched = body.scratched === true;
    if (body.scratched !== undefined && typeof body.scratched !== "boolean") fail("Scratched must be yes or no.");
    return {
      horse_id: id(body, "horseId", "horse", true) as string,
      program_number: program,
      post_position: int(body, "post", "Post position", 1, 30),
      jockey_id: id(body, "jockeyId", "jockey or driver"),
      trainer_id: id(body, "trainerId", "trainer"),
      owner_id: id(body, "ownerId", "owner"),
      weight: int(body, "weight", "Weight", 50, 200),
      medication: text(body, "medication", "Medication", 10),
      equipment: text(body, "equipment", "Equipment", 20),
      morning_line: ml,
      scratched,
      scratch_reason: scratched ? text(body, "scratchReason", "Scratch reason", 80) : "",
    };
  });

export const workoutInput = (body: Body) =>
  run(() => {
    const status = oneOf(body, "status", "status", ["draft", "published"] as const, "draft");
    const rank = int(body, "rank", "Rank", 1, 999);
    const rankOf = int(body, "rankOf", "Number of works", 1, 999);
    if (rank !== null && rankOf !== null && rank > rankOf) fail("Rank can't be higher than the number of works.");
    return {
      horse_id: id(body, "horseId", "horse", true) as string,
      track_id: id(body, "trackId", "track", true) as string,
      work_date: isoDate(body.date, "Workout date"),
      distance_value: distance(body, "distance", true) as number,
      distance_unit: oneOf(body, "unit", "distance unit", UNITS, "furlongs"),
      surface: oneOf(body, "surface", "surface", SURFACES, "dirt"),
      time_seconds: workTime(body.time),
      rank,
      rank_of: rankOf,
      note: text(body, "note", "Note", 20),
      status,
    };
  });

/** "48.2", "1:12.40" or a number of seconds. */
function workTime(raw: unknown): number {
  if (typeof raw === "number") return decimal({ v: raw }, "v", "Time", 1, 599, true) as number;
  if (typeof raw !== "string" || !raw.trim()) return fail("Time is required, like 48.20 or 1:12.40.");
  const match = raw.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}(?:\.\d{1,2})?)$/);
  if (!match) return fail("Time must look like 48.20 or 1:12.40.");
  const seconds = (match[1] ? Number(match[1]) * 60 : 0) + Number(match[2]);
  return decimal({ v: seconds }, "v", "Time", 1, 599, true) as number;
}

export const resultsInput = (body: Body) =>
  run(() => {
    const status = oneOf(body, "status", "race status", RACE_STATUSES, "official");
    const payouts = body.payouts ?? [];
    if (!Array.isArray(payouts) || payouts.length > 40) fail("Use up to 40 payout lines.");
    const cleanPayouts = (payouts as Body[]).map((item) => ({
      pool: text(item ?? {}, "pool", "Payout pool", 30, { min: 1 }),
      combination: text(item ?? {}, "combination", "Payout combination", 30),
      amount: decimal(item ?? {}, "amount", "Payout amount", 0, 10_000_000, true),
    }));
    const runners = body.runners ?? [];
    if (!Array.isArray(runners) || runners.length > 40) fail("Too many runners.");
    const cleanRunners = (runners as Body[]).map((item) => ({
      id: id(item ?? {}, "id", "runner", true),
      finish: int(item ?? {}, "finish", "Finish position", 1, 30),
      lengths: decimal(item ?? {}, "lengths", "Beaten lengths", 0, 999),
      odds: decimal(item ?? {}, "odds", "Final odds", 0, 9999),
      earnings: int(item ?? {}, "earnings", "Earnings", 0, 2_000_000_000),
      comment: text(item ?? {}, "comment", "Comment", 200),
    }));
    const winningTime = text(body, "winningTime", "Winning time", 20);
    return {
      status,
      winningTime,
      condition: oneOf(body, "condition", "track condition", CONDITIONS, ""),
      footnotes: text(body, "footnotes", "Footnotes", 2000, { multiline: true }),
      payouts: cleanPayouts,
      runners: cleanRunners,
    };
  });

type RaceValue = Extract<ReturnType<typeof raceInput>, { value: unknown }>["value"];

const IMPORT_KEYS = [
  "race", "postTime", "raceName", "raceType", "grade", "distance", "unit", "surface", "purse", "conditions",
  "program", "post", "horse", "country", "sire", "dam", "sex", "foaled", "jockey", "trainer", "owner",
  "weight", "ml", "medication", "equipment",
] as const;

/** One imported runner per row (already split from CSV in the browser). Row numbers start at 2 (after the header). */
export const importInput = (body: Body) =>
  run(() => {
    const rows = body.rows;
    if (!Array.isArray(rows) || !rows.length) fail("The file has no rows to import.");
    if ((rows as unknown[]).length > 400) fail("Import up to 400 runners at a time.");
    return (rows as Body[]).map((row, index) => {
      const at = `Row ${index + 2}: `;
      try {
        if (!row || typeof row !== "object") fail("is empty.");
        const unknown = Object.keys(row).filter((key) => !(IMPORT_KEYS as readonly string[]).includes(key));
        if (unknown.length) fail(`unknown column "${unknown[0]}".`);
        const race = raceInput({ ...row, number: row.race, name: row.raceName, type: row.raceType || "other" });
        if ("error" in race) fail(race.error);
        const program = text(row, "program", "Program number", 3, { min: 1 }).toUpperCase();
        if (!/^\d{1,2}[A-Z]?$/.test(program)) fail("Program number must look like 1, 12 or 1A.");
        const ml = text(row, "ml", "Morning line", 6);
        if (ml && !/^\d{1,3}-\d{1,2}$/.test(ml)) fail("Morning line odds must look like 5-2.");
        const value = (race as { value: RaceValue }).value;
        return {
          race: value.race_number,
          postTime: value.post_time,
          raceName: value.name,
          raceType: value.race_type,
          grade: value.grade,
          distance: value.distance_value,
          unit: value.distance_unit,
          surface: value.surface,
          purse: value.purse,
          conditions: value.conditions,
          program,
          post: int(row, "post", "Post position", 1, 30),
          horse: text(row, "horse", "Horse", 40, { min: 1 }),
          country: country(row, "country", /^[A-Z]{2,3}$/),
          sire: text(row, "sire", "Sire", 40),
          dam: text(row, "dam", "Dam", 40),
          sex: oneOf(row, "sex", "sex", SEXES, ""),
          foaled: int(row, "foaled", "Year foaled", 1980, 2100),
          jockey: text(row, "jockey", "Jockey/driver", 80),
          trainer: text(row, "trainer", "Trainer", 80),
          owner: text(row, "owner", "Owner", 80),
          weight: int(row, "weight", "Weight", 50, 200),
          ml,
          medication: text(row, "medication", "Medication", 10),
          equipment: text(row, "equipment", "Equipment", 20),
        };
      } catch (error) {
        if (error instanceof Invalid) fail(at + error.message.charAt(0).toLowerCase() + error.message.slice(1));
        throw error;
      }
    });
  });

export const dateRange = (from: unknown, to: unknown, fallbackDays: number, maxDays: number) => {
  const today = new Date().toISOString().slice(0, 10);
  const start = typeof from === "string" && from ? from : today;
  const end =
    typeof to === "string" && to
      ? to
      : new Date(Date.parse(start + "T00:00:00Z") + fallbackDays * 864e5).toISOString().slice(0, 10);
  const ok = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));
  if (!ok(start) || !ok(end)) return null;
  const span = (Date.parse(end) - Date.parse(start)) / 864e5;
  if (span < 0 || span > maxDays) return null;
  return { from: start, to: end };
};
