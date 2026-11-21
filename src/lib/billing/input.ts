import { BillingError } from "./errors";

/**
 * Request checks for Stayblz Billing. The SQL functions check everything again (they're the last line);
 * these give clear words early and never pass anything unexpected through.
 */
const bad = (message: string, code = "invalid_input") => new BillingError(400, code, message);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export function text(value: unknown, max: number, { required = false, label = "This field" } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(`${label} is required.`);
    return "";
  }
  if (typeof value !== "string") throw bad(`${label} must be text.`);
  // Control characters out, spaces collapsed at the ends.
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (required && !clean) throw bad(`${label} is required.`);
  if (clean.length > max) throw bad(`${label} can be up to ${max} characters.`);
  return clean;
}

export function email(value: unknown, { required = false } = {}) {
  const v = text(value, 254, { required, label: "Email" }).toLowerCase();
  if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw bad("Enter a valid email address.");
  return v;
}

/** Whole cents. `allowNegative` only for credits. */
export function cents(value: unknown, { min = 0, max = 100_000_000, label = "Amount" } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw bad(`${label} must be in whole cents.`);
  if (value < min || value > max) throw bad(`${label} is out of range.`);
  return value;
}

/** A quantity with up to two decimals (e.g. 30 days, 0.5 hours). */
export function quantity(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 10_000) throw bad("Quantity must be between 0.01 and 10,000.");
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(rounded - value) > 1e-9) throw bad("Quantity can have up to two decimals.");
  return rounded;
}

export function date(value: unknown, { required = false, label = "Date" } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw bad(`${label} is required.`);
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad(`${label} must be a date.`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw bad(`${label} must be a real date.`);
  const year = d.getUTCFullYear();
  if (year < 2000 || year > 2100) throw bad(`${label} is out of range.`);
  return value;
}

export function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

/** Idempotency key from the browser: one per attempt, reused when the same attempt is retried. */
export function key(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(value)) throw bad("Refresh the page and try again.", "invalid_key");
  return value;
}

export const CATEGORIES = ["training", "board", "vet", "farrier", "transport", "race_fees", "jockey", "supplies", "breeding", "sale", "other", "credit"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface LineInput {
  category: Category;
  description: string;
  quantity: number;
  unitCents: number;
  taxable: boolean;
  horseId: string | null;
  serviceOn: string | null;
  shareBps: number | null;
  chargeId: string | null;
}

export function line(value: unknown): LineInput {
  if (!value || typeof value !== "object") throw bad("Check the invoice lines.");
  const v = value as Record<string, unknown>;
  const category = v.category as Category;
  if (!CATEGORIES.includes(category)) throw bad("Choose a type for each line.");
  const credit = category === "credit";
  const unitCents = cents(v.unitCents, { min: credit ? -100_000_000 : 0, max: credit ? 0 : 100_000_000, label: "Price" });
  const shareBps = v.shareBps === undefined || v.shareBps === null ? null : bps(v.shareBps, { min: 1, max: 10_000, label: "Share" });
  return {
    category,
    description: text(v.description, 200, { required: true, label: "Description" }),
    quantity: quantity(v.quantity),
    unitCents,
    taxable: bool(v.taxable, false),
    horseId: v.horseId ? (isUuid(v.horseId) ? v.horseId : (() => { throw bad("Choose one of this stable's horses."); })()) : null,
    serviceOn: date(v.serviceOn, { label: "Service date" }),
    shareBps,
    chargeId: v.chargeId && isUuid(v.chargeId) ? v.chargeId : null,
  };
}

export function lines(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw bad("An invoice needs 1 to 100 lines.");
  return value.map(line);
}

export function bps(value: unknown, { min = 0, max = 10_000, label = "Rate" } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw bad(`${label} is out of range.`);
  return value;
}

/** A fee table: { card: {bps, fixed, cap}, bank: …, keyed: …, reader: … }. */
export function rates(value: unknown) {
  if (!value || typeof value !== "object") throw bad("Check the rates.");
  const out: Record<string, { bps: number; fixed: number; cap: number }> = {};
  for (const channel of ["card", "bank", "keyed", "reader"]) {
    const r = (value as Record<string, unknown>)[channel] as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") throw bad(`Set a rate for ${channel}.`);
    out[channel] = {
      bps: bps(r.bps, { min: 0, max: 2000, label: "Percentage" }),
      fixed: cents(r.fixed ?? 0, { min: 0, max: 500, label: "Fixed fee" }),
      cap: cents(r.cap ?? 0, { min: 0, max: 100_000, label: "Cap" }),
    };
  }
  return out;
}

export function cardExpiry(month: unknown, year: unknown, now = new Date()) {
  if (typeof month !== "number" || !Number.isInteger(month) || month < 1 || month > 12) throw bad("Enter the card's expiry month.");
  if (typeof year !== "number" || !Number.isInteger(year)) throw bad("Enter the card's expiry year.");
  const full = year < 100 ? 2000 + year : year;
  const thisYear = now.getUTCFullYear();
  if (full < thisYear || (full === thisYear && month < now.getUTCMonth() + 1)) throw bad("This card has expired.", "expired_card");
  if (full > thisYear + 20) throw bad("Check the expiry year.");
  return { expMonth: month, expYear: full };
}

/** Invoice number prefix from a stable name: "Bishop Racing" → "BR". */
export function prefixFrom(name: string) {
  const letters = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 4);
  return letters.length >= 2 ? letters : (name.toUpperCase().replace(/[^A-Z0-9]/g, "") + "SB").slice(0, 4);
}

export function csvCell(value: unknown) {
  const s = value === null || value === undefined ? "" : String(value);
  // Spreadsheet formula injection guard, then normal CSV quoting.
  const safe = /^-?\d+(\.\d+)?$/.test(s) || !/^[=+\-@\t\r]/.test(s) ? s : `'${s}`;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const dollars = (cents: number) => (cents / 100).toFixed(2);
