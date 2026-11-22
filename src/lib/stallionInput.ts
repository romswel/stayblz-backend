// Stayblz Stallions: fixed choice lists and input checks. Keep the keys in step with the frontend
// (src/components/stallions/options.ts).
import { isUuid } from "../middleware/stable";
import { cleanGenetics, type Genetics } from "./stallionGenetics";
import { MARE_DEPTH, STALLION_DEPTH, pedigreePaths, type Pedigree } from "./stallionPedigree";

export const BREEDS = ["thoroughbred", "quarter_horse", "standardbred", "arabian", "paint", "appaloosa", "warmblood", "other"] as const;
export const AVAILABILITY = ["open", "limited", "full", "private", "closed"] as const;
export const FEE_TERMS = ["live_foal", "return_privilege", "no_guarantee", "other"] as const;
export const METHODS = ["live_cover", "cooled", "frozen"] as const;
export const CURRENCIES = ["USD", "CAD", "GBP", "EUR", "AUD", "NZD", "JPY", "AED", "ZAR"] as const;
export const SORTS = ["popular", "newest", "fee-asc", "fee-desc", "name", "runners", "young"] as const;
export const MARE_STATUS = ["", "maiden", "barren", "in_foal", "foaled", "slipped", "unknown"] as const;
export const REQUEST_STATUS = ["new", "talking", "booked", "declined", "closed"] as const;

const US = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(" ");
const CANADA = "AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" ");
const COUNTRIES = "US CA GB IE FR DE IT AU NZ JP HK AE SA QA ZA AR BR CL UY PE MX KR IN TR".split(" ");
/** "US-KY", "CA-ON", or a country code ("GB"). A plain "US" or "CA" is accepted for the whole country. */
export const REGIONS = new Set([...COUNTRIES, ...US.map((s) => `US-${s}`), ...CANADA.map((p) => `CA-${p}`)]);

/** Thoroughbreds can only be registered from live cover (registry rule). */
export const LIVE_COVER_ONLY = new Set(["thoroughbred"]);

export class StallionInputError extends Error {}
const bad = (message: string) => new StallionInputError(message);

function line(value: unknown, max: number, label: string, min = 0) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw bad(`Check ${label}.`);
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length < min) throw bad(min > 1 ? `${label[0].toUpperCase()}${label.slice(1)} needs at least ${min} characters.` : `Add ${label}.`);
  if (clean.length > max) throw bad(`${label[0].toUpperCase()}${label.slice(1)} can be up to ${max} characters.`);
  if (/[<>]/.test(clean)) throw bad(`${label[0].toUpperCase()}${label.slice(1)} can't contain < or >.`);
  return clean;
}
function paragraph(value: unknown, max: number, label: string) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw bad(`Check ${label}.`);
  const clean = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length > max) throw bad(`${label[0].toUpperCase()}${label.slice(1)} can be up to ${max.toLocaleString("en-US")} characters.`);
  return clean;
}
function choice<T extends string>(value: unknown, list: readonly T[], label: string, fallback?: T): T {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !list.includes(value as T)) throw bad(`Choose ${label}.`);
  return value as T;
}
function whole(value: unknown, min: number, max: number, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw bad(`Check ${label}.`);
  return value;
}
/** A horse name: plain text up to 40 characters (racing names are 18; older registries allow more). */
export function horseName(value: unknown, label = "the name", max = 40) {
  return line(value, max, label);
}

/** {s: "Sire", d: "Dam", ds: …} keeping only real positions up to `depth` generations. */
export function pedigreeInput(value: unknown, depth: number): Pedigree {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw bad("Check the pedigree.");
  const allowed = new Set(pedigreePaths(depth));
  const out: Pedigree = {};
  for (const [path, name] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(path)) continue;
    const clean = horseName(name, "pedigree names");
    if (clean) out[path] = clean;
  }
  return out;
}

const thisYear = () => new Date().getUTCFullYear();

/** The form for one stallion. Returns the database columns. */
export function stallionInput(body: any) {
  if (!body || typeof body !== "object") throw bad("Fill in the form.");
  const name = line(body.name, 60, "the stallion's name", 1);
  const breed = choice(body.breed, BREEDS, "a breed");
  const methods = Array.isArray(body.methods)
    ? [...new Set((body.methods as unknown[]).filter((m): m is (typeof METHODS)[number] => METHODS.includes(m as any)))]
    : ["live_cover" as const];
  if (!methods.length) throw bad("Choose how he breeds (live cover, cooled or frozen semen).");
  if (LIVE_COVER_ONLY.has(breed) && (methods.length !== 1 || methods[0] !== "live_cover"))
    throw bad("Thoroughbreds can only be registered from live cover. Remove cooled and frozen semen.");
  const region = typeof body.region === "string" ? body.region.trim().toUpperCase() : "";
  if (!REGIONS.has(region)) throw bad("Choose where he stands (state, province or country).");
  const seasonYear = whole(body.seasonYear, thisYear() - 1, thisYear() + 2, "the breeding season");
  if (seasonYear === null) throw bad("Choose the breeding season.");
  const fee = whole(body.fee, 0, 10_000_000, "the fee (whole amounts, up to 10,000,000)");
  const bookingFee = whole(body.bookingFee, 0, 1_000_000, "the booking fee");
  const foaled = whole(body.foaled, 1980, thisYear(), "the year he was foaled");
  const firstSeason = whole(body.firstSeason, 1980, thisYear() + 1, "his first season at stud");
  if (foaled !== null && firstSeason !== null && firstSeason < foaled + 2) throw bad("His first season at stud is before he was 2.");
  const pedigree = pedigreeInput(body.pedigree, STALLION_DEPTH);
  if (pedigree.s && pedigree.s.toLowerCase() === name.toLowerCase()) throw bad("A stallion can't be his own sire.");

  const record = body.raceRecord && typeof body.raceRecord === "object" ? body.raceRecord : {};
  const starts = whole(record.starts, 0, 999, "starts");
  const wins = whole(record.wins, 0, 999, "wins");
  const places = whole(record.places, 0, 999, "seconds");
  const shows = whole(record.shows, 0, 999, "thirds");
  if (starts !== null && (wins ?? 0) + (places ?? 0) + (shows ?? 0) > starts) throw bad("Wins, seconds and thirds add up to more than his starts.");
  const earnings = whole(record.earnings, 0, 1_000_000_000, "earnings (whole amounts)");
  const raceRecord: Record<string, unknown> = {};
  for (const [k, v] of Object.entries({ starts, wins, places, shows })) if (v !== null) raceRecord[k] = v;
  if (earnings !== null) {
    raceRecord.earnings = earnings * 100;
    raceRecord.currency = choice(record.currency, CURRENCIES, "the earnings currency", "USD");
  }

  const highlights = Array.isArray(body.highlights)
    ? (body.highlights as unknown[]).map((h) => line(h, 120, "each race highlight")).filter(Boolean)
    : [];
  if (highlights.length > 8) throw bad("Up to 8 race highlights.");
  const heightIn = whole(body.heightIn, 48, 80, "his height");
  const fertility = whole(body.fertilityRate, 0, 100, "the live foal rate (0 to 100%)");
  const racingHorseId = body.racingHorseId === null || body.racingHorseId === undefined || body.racingHorseId === "" ? null : body.racingHorseId;
  if (racingHorseId !== null && !isUuid(racingHorseId)) throw bad("Pick his racing record again.");
  const country = typeof body.country === "string" ? body.country.trim().toUpperCase() : "";
  if (country && !/^[A-Z]{2}$/.test(country)) throw bad("Check the country he was foaled in.");
  if (body.confirm !== true) throw bad("Confirm that you own or manage this stallion and the details are true.");

  return {
    name,
    breed,
    registry: line(body.registry, 60, "the registry"),
    registration: line(body.registration, 40, "the registration number"),
    foaled_year: foaled,
    country,
    color: line(body.color, 30, "the colour"),
    height_in: heightIn,
    farm: line(body.farm, 80, "the farm"),
    location: line(body.location, 80, "the location (town and state)", 2),
    region,
    season_year: seasonYear,
    fee_cents: fee === null ? null : fee * 100,
    fee_currency: choice(body.feeCurrency, CURRENCIES, "the fee currency", "USD"),
    fee_terms: choice(body.feeTerms, FEE_TERMS, "the fee terms", "live_foal"),
    fee_note: line(body.feeNote, 300, "the fee note"),
    booking_fee_cents: bookingFee === null ? null : bookingFee * 100,
    availability: choice(body.availability, AVAILABILITY, "whether he's taking bookings", "open"),
    methods,
    shipping_note: line(body.shippingNote, 300, "the shipping note"),
    first_season: firstSeason,
    programs: line(body.programs, 300, "the breeders' programs"),
    pedigree,
    race_record: raceRecord,
    highlights,
    genetics: cleanGenetics(body.genetics),
    fertility_rate: fertility,
    fertility_note: line(body.fertilityNote, 300, "the fertility note"),
    description: paragraph(body.description, 4000, "the description"),
    racing_horse_id: racingHorseId,
    inquiries_open: body.inquiriesOpen !== false,
  };
}

/** Publishing needs the basics breeders look for first. Returns what's missing, or null. */
export function publishProblem(row: { pedigree: Pedigree; location: string; farm: string }) {
  if (!row.pedigree.s || !row.pedigree.d) return "Add his sire and dam before publishing.";
  return null;
}

/** Directory filters from the query string (the SQL function reads the same names). */
export function searchInput(query: Record<string, unknown>) {
  const text = (v: unknown, max = 40) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const num = (v: unknown, max: number) => {
    if (typeof v !== "string" || !/^\d{1,10}$/.test(v)) return null;
    const n = Number(v);
    return n <= max ? n : null;
  };
  const flag = (v: unknown) => v === "1" || v === "true";
  const breed = text(query.breed);
  const region = text(query.region).toUpperCase();
  const availability = text(query.availability);
  const method = text(query.method);
  const sort = text(query.sort);
  const feeMin = num(query.feeMin, 10_000_000);
  const feeMax = num(query.feeMax, 10_000_000);
  return {
    q: text(query.q, 60),
    breed: BREEDS.includes(breed as any) ? breed : "",
    region: REGIONS.has(region) ? region : "",
    availability: AVAILABILITY.includes(availability as any) ? availability : "",
    method: METHODS.includes(method as any) ? method : "",
    sire: text(query.sire),
    ancestor: text(query.ancestor),
    // Fees in whole amounts on the page; cents in the database.
    feeMin: feeMin === null ? "" : String(feeMin * 100),
    feeMax: feeMax === null ? "" : String(feeMax * 100),
    privateFee: flag(query.privateFee),
    saved: flag(query.saved),
    video: flag(query.video),
    inData: flag(query.inData),
    sort: SORTS.includes(sort as any) ? sort : "popular",
    page: String(num(query.page, 200) ?? 0),
  };
}

/** A mare, typed in a mating check or a breeding request, or saved under My mares. */
export function mareInput(body: any, { needName = true } = {}) {
  if (!body || typeof body !== "object") throw bad("Tell us about the mare.");
  const name = line(body.name, 60, "the mare's name", needName ? 1 : 0);
  const pedigree = pedigreeInput(body.pedigree, MARE_DEPTH);
  // The simple form sends sire / dam / dam's sire separately.
  for (const [field, path] of [["sire", "s"], ["dam", "d"], ["damSire", "ds"]] as const)
    if (typeof body[field] === "string" && body[field].trim() && !pedigree[path]) pedigree[path] = horseName(body[field], "the mare's pedigree");
  const racingHorseId = body.racingHorseId && isUuid(body.racingHorseId) ? (body.racingHorseId as string) : null;
  return {
    name,
    breed: choice(body.breed, BREEDS, "the mare's breed", "thoroughbred"),
    foaled_year: whole(body.foaled, 1980, thisYear(), "the year she was foaled"),
    color: line(body.color, 30, "her colour"),
    registration: line(body.registration, 40, "her registration number"),
    racing_horse_id: racingHorseId,
    pedigree,
    genetics: cleanGenetics(body.genetics) as Genetics,
    notes: paragraph(body.notes, 500, "the notes"),
  };
}

/** A breeding request: the message plus the mare's details. */
export function requestInput(body: any) {
  const message = paragraph(body?.message, 1000, "the message");
  if (!message) throw bad("Write a short message to the owner.");
  if (!isUuid(body?.clientId)) throw bad("Something went wrong. Try again.");
  const mare = mareInput(body?.mare ?? {}, { needName: true });
  const status = choice(body?.mare?.status, MARE_STATUS, "the mare's status", "");
  const season = whole(body?.seasonYear, thisYear() - 1, thisYear() + 2, "the season");
  const method = body?.method ? choice(body.method, METHODS, "how you'd like to breed") : "";
  return {
    message,
    clientId: body.clientId as string,
    season,
    method,
    mare: {
      name: mare.name,
      breed: mare.breed,
      foaled: mare.foaled_year,
      sire: mare.pedigree.s ?? "",
      dam: mare.pedigree.d ?? "",
      damSire: mare.pedigree.ds ?? "",
      registration: mare.registration,
      status,
    },
  };
}
