// Horse marketplace: the fixed choice lists and input checks.
// Keep the keys in step with the frontend (src/components/marketplace/options.ts).

export const BREEDS = [
  "thoroughbred", "quarter-horse", "standardbred", "arabian", "appaloosa", "paint",
  "warmblood", "andalusian", "friesian", "morgan", "tennessee-walker", "mustang",
  "draft", "pony", "other",
] as const;
export const DISCIPLINES = [
  "flat-racing", "harness-racing", "jump-racing", "barrel-racing", "show-jumping",
  "dressage", "eventing", "hunter", "western-pleasure", "reining", "ranch",
  "endurance", "polo", "trail", "breeding", "unstarted",
] as const;
export const TYPES = [
  "racehorse", "racing-prospect", "retired-racehorse", "broodmare", "stallion",
  "yearling", "weanling", "foal", "sport-horse", "riding-horse", "companion",
] as const;
export const GENDERS = ["mare", "filly", "gelding", "stallion", "colt", "ridgling"] as const;
export const COLORS = [
  "bay", "dark-bay-brown", "chestnut", "gray", "roan", "black", "palomino",
  "buckskin", "dun", "grullo", "pinto", "appaloosa", "white", "cremello", "other",
] as const;

export const LIMITS = {
  price: [1, 100_000_000],
  age: [0, 40],
  heightIn: [24, 80],
  description: 2000,
} as const;

const invalid = () => new Error("invalid_input");

function choice(value: unknown, list: readonly string[]) {
  if (typeof value !== "string" || !list.includes(value)) throw invalid();
  return value;
}
function line(value: unknown, min: number, max: number) {
  if (typeof value !== "string") throw invalid();
  const clean = value.replace(/\s+/g, " ").trim();
  // Plain text only: no markup characters in names or places.
  if (clean.length < min || clean.length > max || /[<>]/.test(clean)) throw invalid();
  return clean;
}
/** Free text that keeps its line breaks: optional, trimmed, at most `max` characters. */
function paragraph(value: unknown, max: number) {
  if (value === null) return "";
  if (typeof value !== "string") throw invalid();
  const clean = value
    .replace(/\r\n?/g, "\n")
    // Control characters (except line breaks and tabs) have no place in a description.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length > max) throw invalid();
  return clean;
}
function whole(value: unknown, [min, max]: readonly [number, number]) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw invalid();
  return value;
}

/** A complete listing from the request body, as table columns. Throws "invalid_input". */
export function listingInput(body: any) {
  return {
    name: line(body?.name, 1, 80),
    price: whole(body?.price, LIMITS.price),
    breed: choice(body?.breed, BREEDS),
    discipline: choice(body?.discipline, DISCIPLINES),
    horse_type: choice(body?.type, TYPES),
    gender: choice(body?.gender, GENDERS),
    color: choice(body?.color, COLORS),
    age: whole(body?.age, LIMITS.age),
    height_in: whole(body?.heightIn, LIMITS.heightIn),
    location: line(body?.location, 2, 80),
    // Left out by older clients: an edit from them keeps the saved description.
    ...(body?.description === undefined ? {} : { description: paragraph(body.description, LIMITS.description) }),
  };
}

export type ListingSort = "newest" | "price-asc" | "price-desc" | "age-asc";
export interface ListingFilters {
  breed?: string;
  discipline?: string;
  type?: string;
  gender?: string;
  color?: string;
  priceMin?: number;
  priceMax?: number;
  ageMin?: number;
  ageMax?: number;
  heightMin?: number;
  heightMax?: number;
  /** Words to find in the location, with SQL wildcards removed. */
  location?: string;
  mine: boolean;
  sort: ListingSort;
}

/** Browse filters from the query string. Empty values mean "any". Throws "invalid_input". */
export function listingFilters(query: Record<string, unknown>): ListingFilters {
  const one = (key: string) => {
    const value = query[key];
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string") throw invalid();
    return value;
  };
  const pick = (key: string, list: readonly string[]) => {
    const value = one(key);
    return value === undefined ? undefined : choice(value, list);
  };
  const num = (key: string, range: readonly [number, number]) => {
    const value = one(key);
    if (value === undefined) return undefined;
    if (!/^\d{1,9}$/.test(value)) throw invalid();
    return whole(Number(value), range);
  };
  const filters: ListingFilters = {
    breed: pick("breed", BREEDS),
    discipline: pick("discipline", DISCIPLINES),
    type: pick("type", TYPES),
    gender: pick("gender", GENDERS),
    color: pick("color", COLORS),
    priceMin: num("priceMin", [0, LIMITS.price[1]]),
    priceMax: num("priceMax", [0, LIMITS.price[1]]),
    ageMin: num("ageMin", LIMITS.age),
    ageMax: num("ageMax", LIMITS.age),
    heightMin: num("heightMin", LIMITS.heightIn),
    heightMax: num("heightMax", LIMITS.heightIn),
    mine: one("mine") === "1",
    sort: (pick("sort", ["newest", "price-asc", "price-desc", "age-asc"]) ?? "newest") as ListingSort,
  };
  const location = one("location");
  if (location !== undefined) {
    if (location.length > 80) throw invalid();
    const words = location.replace(/[%_*\\,()."':]/g, " ").replace(/\s+/g, " ").trim();
    if (words) filters.location = words;
  }
  return filters;
}

/* ---------- Photos and documents ---------- */

/** A problem with the listing's files, with a message the seller can act on. */
export class MediaInputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The listing's photos and videos (one list, in display order; item 0 is the cover) and its
 * documents. Ids are files the seller already uploaded; the route checks how many of each kind.
 * Older clients send `photoIds`, which is read the same way. Throws MediaInputError.
 */
export function mediaInput(body: any, limits: { minMedia: number; maxMedia: number; maxDocuments: number }) {
  const ids = (value: unknown, min: number, max: number, tooFew: string, tooMany: string) => {
    const list = value === undefined || value === null ? [] : value;
    if (!Array.isArray(list) || !list.every((id) => typeof id === "string" && UUID.test(id)))
      throw new MediaInputError("Some files couldn't be read. Remove them and add them again.");
    const unique = [...new Set(list.map((id: string) => id.toLowerCase()))];
    if (unique.length !== list.length) throw new MediaInputError("The same file was added twice.");
    if (unique.length < min) throw new MediaInputError(tooFew);
    if (unique.length > max) throw new MediaInputError(tooMany);
    return unique;
  };
  const mediaIds = ids(
    body?.mediaIds ?? body?.photoIds,
    limits.minMedia,
    limits.maxMedia,
    `Add at least ${limits.minMedia} photo or video.`,
    `A listing can have up to ${limits.maxMedia} photos and videos.`,
  );
  const documentIds = ids(
    body?.documentIds,
    0,
    limits.maxDocuments,
    "",
    `A listing can have up to ${limits.maxDocuments} documents.`,
  );
  return { mediaIds, documentIds };
}
