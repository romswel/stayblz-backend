/** Input checks for Virtual Stayblz (tracked horses and their logged entries). Messages are shown to members. */

export class VirtualInputError extends Error {}

const fail = (message: string): never => {
  throw new VirtualInputError(message);
};

/** Optional trimmed text: missing means "", too long is an error. */
function opt(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return fail(`Check the ${label}.`);
  const v = value.trim();
  if (v.length > max) fail(`Keep the ${label} to ${max} characters.`);
  return v;
}

function optInt(value: unknown, min: number, max: number, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) fail(`Enter a ${label} from ${min} to ${max}.`);
  return n as number;
}

const MAX_CENTS = 100_000_000_000;

/** The details a person can type for a horse that isn't linked to anything on Stayblz. */
export const MANUAL_FIELDS = ["name", "breed", "sex", "foaledYear", "color", "sire", "dam", "trainer", "ownerName", "location"] as const;

export function virtualHorseInput(body: any, { partial = false } = {}) {
  const out: Record<string, unknown> = {};
  const has = (k: string) => !partial || body?.[k] !== undefined;
  if (has("name")) {
    const name = opt(body?.name, 80, "horse's name");
    if (!name) fail("Enter the horse's name.");
    out.name = name;
  }
  if (has("breed")) out.breed = opt(body?.breed, 60, "breed");
  if (has("sex")) out.sex = opt(body?.sex, 20, "sex");
  if (has("foaledYear")) out.foaled_year = optInt(body?.foaledYear, 1900, 2100, "foaling year");
  if (has("color")) out.color = opt(body?.color, 40, "color");
  if (has("sire")) out.sire = opt(body?.sire, 80, "sire");
  if (has("dam")) out.dam = opt(body?.dam, 80, "dam");
  if (has("trainer")) out.trainer = opt(body?.trainer, 80, "trainer");
  if (has("ownerName")) out.owner_name = opt(body?.ownerName, 80, "owner");
  if (has("location")) out.location = opt(body?.location, 80, "location");
  if (has("notes")) out.notes = opt(body?.notes, 4000, "notes");
  return out;
}

export const ENTRY_KINDS = ["workout", "race", "sale", "note"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];
export const SALE_RESULTS = ["entered", "sold", "rna", "withdrawn", "private"] as const;

function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= "1950-01-01" && v <= "2100-12-31";
}

/**
 * One logged entry. Only the fields that belong to its kind are kept; the rest are cleared, so switching an
 * entry's kind can't leave stale values behind.
 */
export function virtualEntryInput(body: any) {
  const kind = body?.kind;
  if (!ENTRY_KINDS.includes(kind)) fail("Choose a workout, race, sales entry or note.");
  if (!isDate(body?.entryDate)) fail("Choose a valid date.");
  const blank = {
    title: "",
    track: "",
    distance: "",
    surface: "",
    time_text: "",
    finish: null as number | null,
    field_size: null as number | null,
    result: "",
    hip_number: "",
    amount_cents: null as number | null,
  };
  const notes = opt(body?.notes, 2000, "notes");
  const fields = { ...blank, kind: kind as EntryKind, entry_date: body.entryDate as string, notes };
  if (kind === "workout") {
    fields.track = opt(body?.track, 80, "track");
    fields.distance = opt(body?.distance, 40, "distance");
    fields.surface = opt(body?.surface, 40, "surface");
    fields.time_text = opt(body?.timeText, 20, "time");
    fields.result = opt(body?.result, 40, "rank or result");
    fields.title = opt(body?.title, 120, "label");
  } else if (kind === "race") {
    fields.title = opt(body?.title, 120, "race name");
    fields.track = opt(body?.track, 80, "track");
    fields.distance = opt(body?.distance, 40, "distance");
    fields.surface = opt(body?.surface, 40, "surface");
    fields.finish = optInt(body?.finish, 1, 40, "finish position");
    fields.field_size = optInt(body?.fieldSize, 1, 40, "field size");
    if (fields.finish !== null && fields.field_size !== null && fields.finish > fields.field_size)
      fail("The finish position can't be more than the field size.");
    fields.amount_cents = optInt(body?.amountCents, 0, MAX_CENTS, "earnings amount");
  } else if (kind === "sale") {
    fields.title = opt(body?.title, 120, "sale name");
    if (!fields.title) fail("Enter the sale or auction name.");
    fields.track = opt(body?.track, 80, "location");
    fields.hip_number = opt(body?.hipNumber, 20, "hip number");
    const result = body?.result ?? "entered";
    if (!SALE_RESULTS.includes(result)) fail("Choose the sale status.");
    fields.result = result;
    fields.amount_cents = optInt(body?.amountCents, 0, MAX_CENTS, "price");
  } else {
    fields.title = opt(body?.title, 120, "title");
    if (!notes) fail("Write the note.");
  }
  return fields;
}
