/**
 * Input checks for Stayblz Community (horse profiles, race records, posts, settings).
 * Every function returns clean values for the database or throws InputError with a
 * message that can be shown to the person as-is.
 */

export class InputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuidValue = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const HORSE_SEXES = ["", "colt", "filly", "mare", "stallion", "gelding", "ridgling"] as const;
export const HORSE_STATUSES = ["racing", "training", "resting", "injured", "retired", "for_sale", "breeding"] as const;
export const HORSE_VISIBILITY = ["inherit", "members", "followers", "private"] as const;
export const INVENTORY_VISIBILITY = ["members", "followers", "private"] as const;
export const POST_VISIBILITY = ["members", "followers"] as const;
export const POST_KINDS = ["update", "horse_update", "announcement"] as const;
export const SURFACES = ["", "dirt", "turf", "synthetic"] as const;

/** Trimmed text without control characters; empty allowed unless `min` is set. */
function clean(value: unknown, max: number, label: string, min = 0, multiline = false): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new InputError(`Check the ${label}.`);
  const stripped = value
    .replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (stripped.length < min) throw new InputError(min === 1 ? `Enter the ${label}.` : `The ${label} is too short.`);
  if (stripped.length > max) throw new InputError(`The ${label} can be up to ${max.toLocaleString("en-US")} characters.`);
  return stripped;
}

function oneOf<T extends readonly string[]>(value: unknown, options: T, label: string, fallback?: T[number]): T[number] {
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) throw new InputError(`Choose a valid ${label}.`);
  return value as T[number];
}

function optionalInt(value: unknown, min: number, max: number, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
    throw new InputError(`Enter a ${label} between ${min} and ${max}.`);
  return n;
}

export function horseInput(body: Record<string, unknown>) {
  const thisYear = new Date().getUTCFullYear();
  return {
    name: clean(body.name, 80, "horse's name", 1),
    breed: clean(body.breed, 60, "breed"),
    sex: oneOf(body.sex, HORSE_SEXES, "sex", ""),
    foaled_year: optionalInt(body.foaledYear, 1980, thisYear, "foaling year"),
    color: clean(body.color, 40, "colour"),
    sire: clean(body.sire, 80, "sire"),
    dam: clean(body.dam, 80, "dam"),
    status: oneOf(body.status, HORSE_STATUSES, "status", "racing"),
    trainer: clean(body.trainer, 80, "trainer"),
    location: clean(body.location, 80, "location"),
    description: clean(body.description, 4000, "description", 0, true),
    visibility: oneOf(body.visibility, HORSE_VISIBILITY, "visibility", "inherit"),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Prize money is entered in dollars (up to 2 decimals) and stored in cents. */
export function moneyToCents(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1_000_000_000)
    throw new InputError("Enter earnings as an amount between 0 and 1,000,000,000.");
  const cents = Math.round(n * 100);
  if (Math.abs(cents / 100 - n) > 1e-6) throw new InputError("Earnings can have up to 2 decimal places.");
  return cents;
}

export function recordInput(body: Record<string, unknown>) {
  const date = body.raceDate;
  const parsed = typeof date === "string" && DAY.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  // Round-trip check: JavaScript quietly turns "2026-02-30" into 2 March.
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== date ||
    parsed < Date.UTC(1980, 0, 1) ||
    parsed > Date.now() + 366 * 864e5
  )
    throw new InputError("Enter a valid race date.");
  const finish = optionalInt(body.finish, 1, 30, "finishing position");
  const fieldSize = optionalInt(body.fieldSize, 1, 30, "field size");
  if (finish !== null && fieldSize !== null && finish > fieldSize)
    throw new InputError("The finishing position can't be higher than the number of runners.");
  return {
    race_date: date as string,
    track: clean(body.track, 80, "track", 1),
    race_name: clean(body.raceName, 120, "race name"),
    distance: clean(body.distance, 40, "distance"),
    surface: oneOf(body.surface, SURFACES, "surface", ""),
    finish,
    field_size: fieldSize,
    earnings_cents: moneyToCents(body.earnings),
    notes: clean(body.notes, 500, "notes", 0, true),
  };
}

export function postInput(body: Record<string, unknown>) {
  const imageIds = body.imageIds ?? [];
  if (!Array.isArray(imageIds) || imageIds.length > 4 || !imageIds.every(isUuidValue) || new Set(imageIds).size !== imageIds.length)
    throw new InputError("Add up to 4 photos to a post.");
  const horseId = body.horseId ?? null;
  if (horseId !== null && !isUuidValue(horseId)) throw new InputError("Choose one of your horses.");
  const text = clean(body.body, 2000, "post", 0, true);
  if (!text && !imageIds.length) throw new InputError("Write something or add a photo.");
  return {
    body: text,
    kind: oneOf(body.kind, POST_KINDS, "post type", "update"),
    horse_id: horseId as string | null,
    visibility: oneOf(body.visibility, POST_VISIBILITY, "audience", "members"),
    imageIds: imageIds as string[],
  };
}

/** Sharing one of your horses to the Feed: an optional caption and who sees the post. */
export function horseShareInput(body: Record<string, unknown>) {
  return {
    body: clean(body.body, 2000, "caption", 0, true),
    visibility: oneOf(body.visibility, POST_VISIBILITY, "audience", "members"),
    /** Switch a private horse to "Everyone" first (the owner said yes in the share dialog). */
    makeVisible: body.makeVisible === true,
  };
}

export function postEditInput(body: Record<string, unknown>) {
  return { body: clean(body.body, 2000, "post", 0, true) };
}

export function commentInput(body: Record<string, unknown>) {
  return { body: clean(body.body, 1000, "comment", 1, true) };
}

/** Partial update: only the keys that were sent are changed. */
export function settingsInput(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if ("headline" in body) out.headline = clean(body.headline, 120, "headline");
  if ("inventoryVisibility" in body)
    out.inventory_visibility = oneOf(body.inventoryVisibility, INVENTORY_VISIBILITY, "inventory visibility");
  for (const [key, column] of [
    ["showEarnings", "show_earnings"],
    ["listed", "listed"],
  ] as const)
    if (key in body) {
      if (typeof body[key] !== "boolean") throw new InputError("Those settings couldn't be saved.");
      out[column] = body[key];
    }
  if (!Object.keys(out).length) throw new InputError("Nothing to save.");
  return out;
}

/** Search text for SQL ILIKE: trimmed, with % _ and \ escaped. */
export function searchText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Feed paging cursor: "<ISO time>~<uuid>". */
export function readCursor(value: unknown): { time: string; id: string } | null {
  if (typeof value !== "string") return null;
  const [time, id] = value.split("~");
  if (!time || !isUuidValue(id) || !Number.isFinite(Date.parse(time))) return null;
  return { time, id };
}
