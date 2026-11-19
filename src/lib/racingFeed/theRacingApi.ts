import { clean, MAX_RUNNERS, refInput } from "./card";

/**
 * The Racing API (https://api.theracingapi.com, docs/racing-data-feed.md): the racing data login the boss gave us
 * (RACING_API_USERNAME / RACING_API_PASSWORD, HTTP Basic). The plan reads racecards, results and each horse's earlier
 * starts for Great Britain, Ireland, France, Hong Kong and other regions; North America needs the provider's add-on.
 *
 * This file only talks to the API and turns its answers into Stayblz cards (lib/racingFeed/card.ts). It never keeps
 * the provider's ratings (RPR, Topspeed, "performance"/"speed" ratings), race comments, tips, silks or bookmaker odds:
 * those are other companies' products. Starting prices, tote dividends and the facts of each race are kept.
 */
export const RACING_API_SOURCE = "theracingapi";
const BASE = "https://api.theracingapi.com";

export function racingApiLogin() {
  // Tests load the local .env too: they must never call the real API (the offline dry run opts in).
  if (process.env.NODE_ENV === "test" && process.env.RACING_API_IN_TESTS !== "1") return null;
  const username = process.env.RACING_API_USERNAME?.trim();
  const password = process.env.RACING_API_PASSWORD?.trim();
  return username && password ? { username, password } : null;
}

export class RacingApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lastCall = 0;
/** The plan allows 5 requests a second; stay under 4. */
const GAP_MS = 260;

export async function racingApiGet(path: string, params: Record<string, string | number> = {}, attempt = 0): Promise<any> {
  const login = racingApiLogin();
  if (!login) throw new RacingApiError(0, "not_configured");
  const wait = lastCall + GAP_MS - Date.now();
  lastCall = Math.max(Date.now(), lastCall + GAP_MS);
  if (wait > 0) await sleep(wait);
  const url = new URL(path, BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: "Basic " + Buffer.from(`${login.username}:${login.password}`).toString("base64"),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    if (attempt < 2) {
      await sleep(2000 * (attempt + 1));
      return racingApiGet(path, params, attempt + 1);
    }
    throw new RacingApiError(0, "unreachable");
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(2500 * (attempt + 1));
    return racingApiGet(path, params, attempt + 1);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = String((await res.json())?.detail ?? "");
    } catch {
      /* not JSON */
    }
    throw new RacingApiError(res.status, detail.slice(0, 200) || `HTTP ${res.status}`);
  }
  return res.json();
}

async function allPages(path: string, params: Record<string, string | number>, key: string, maxPages: number, pageSize?: number) {
  const out: any[] = [];
  let skip = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await racingApiGet(path, { ...params, ...(pageSize ? { limit: pageSize } : {}), ...(skip ? { skip } : {}) });
    const list: any[] = Array.isArray(data?.[key]) ? data[key] : [];
    out.push(...list);
    skip += list.length;
    const total = Number(data?.total);
    if (!list.length || !Number.isFinite(total) || skip >= total) break;
  }
  return out;
}

/** Every racecard for one day (the plan's full cards: runners, pedigree, trainers, owners). */
export const fetchRacecards = (date: string) => allPages("/v1/racecards/pro", { date }, "racecards", 10);
/** Every result for one day. */
export const fetchResults = (date: string) =>
  allPages("/v1/results", { start_date: date, end_date: date }, "results", 20, 50);
/** One horse's results, newest first (up to 200). */
export const fetchHorseResults = (horseId: string) =>
  allPages(`/v1/horses/${encodeURIComponent(horseId)}/results`, {}, "results", 4, 50);

/** Is the login accepted, and does it include North America? */
export async function checkRacingApi(today: string) {
  await racingApiGet("/v1/courses/regions");
  let northAmerica = false;
  try {
    await racingApiGet("/v1/north-america/meets", { start_date: today, end_date: today });
    northAmerica = true;
  } catch (error) {
    if (!(error instanceof RacingApiError) || (error.status !== 401 && error.status !== 403)) throw error;
  }
  return { northAmerica };
}

// ---------- Turning answers into cards ----------

/** Provider region → ISO country (tracks) and time zone (post times are shown in the track's local time). */
const REGIONS: Record<string, [string, string]> = {
  GB: ["GB", "Europe/London"], IRE: ["IE", "Europe/Dublin"], FR: ["FR", "Europe/Paris"], HK: ["HK", "Asia/Hong_Kong"],
  USA: ["US", "America/New_York"], CAN: ["CA", "America/Toronto"], AUS: ["AU", "Australia/Sydney"],
  NZ: ["NZ", "Pacific/Auckland"], UAE: ["AE", "Asia/Dubai"], JPN: ["JP", "Asia/Tokyo"], SAF: ["ZA", "Africa/Johannesburg"],
  GER: ["DE", "Europe/Berlin"], ITY: ["IT", "Europe/Rome"], SPA: ["ES", "Europe/Madrid"], SWE: ["SE", "Europe/Stockholm"],
  NOR: ["NO", "Europe/Oslo"], DEN: ["DK", "Europe/Copenhagen"], BEL: ["BE", "Europe/Brussels"], HOL: ["NL", "Europe/Amsterdam"],
  SWI: ["CH", "Europe/Zurich"], AUT: ["AT", "Europe/Vienna"], CZE: ["CZ", "Europe/Prague"], SLO: ["SK", "Europe/Bratislava"],
  SVN: ["SI", "Europe/Ljubljana"], POL: ["PL", "Europe/Warsaw"], HUN: ["HU", "Europe/Budapest"], BUL: ["BG", "Europe/Sofia"],
  GR: ["GR", "Europe/Athens"], CYP: ["CY", "Asia/Nicosia"], TUR: ["TR", "Europe/Istanbul"], RUS: ["RU", "Europe/Moscow"],
  ISR: ["IL", "Asia/Jerusalem"], QA: ["QA", "Asia/Qatar"], KSA: ["SA", "Asia/Riyadh"], BHR: ["BH", "Asia/Bahrain"],
  OMN: ["OM", "Asia/Muscat"], MOR: ["MA", "Africa/Casablanca"], MAU: ["MU", "Indian/Mauritius"], IND: ["IN", "Asia/Kolkata"],
  SIN: ["SG", "Asia/Singapore"], MAL: ["MY", "Asia/Kuala_Lumpur"], MAC: ["MO", "Asia/Macau"], CHN: ["CN", "Asia/Shanghai"],
  KOR: ["KR", "Asia/Seoul"], ARG: ["AR", "America/Argentina/Buenos_Aires"], BRZ: ["BR", "America/Sao_Paulo"],
  CHI: ["CL", "America/Santiago"], URU: ["UY", "America/Montevideo"], PER: ["PE", "America/Lima"], PAN: ["PA", "America/Panama"],
  PR: ["PR", "America/Puerto_Rico"], BAR: ["BB", "America/Barbados"], JER: ["JE", "Europe/Jersey"], GUE: ["GG", "Europe/Guernsey"],
};
export const regionCountry = (region: unknown) => REGIONS[String(region ?? "").toUpperCase()]?.[0] ?? "";

/** "2026-11-18T20:30:00+00:00" at a GB track → "20:30" (the track's own clock). */
export function localTime(offDt: unknown, region: unknown, fallback?: unknown) {
  const zone = REGIONS[String(region ?? "").toUpperCase()]?.[1];
  const when = typeof offDt === "string" ? new Date(offDt) : null;
  if (zone && when && !Number.isNaN(when.getTime())) {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(when);
    const hour = parts.find((p) => p.type === "hour")?.value;
    const minute = parts.find((p) => p.type === "minute")?.value;
    if (hour && minute) return `${hour}:${minute}`;
  }
  return typeof fallback === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(fallback) ? fallback : "";
}

/** "Dust Cover (GB)" → { name: "Dust Cover", country: "GB" }. */
export function splitSuffix(raw: unknown) {
  const text = clean(raw, 60);
  const match = /^(.*?)\s*\(([A-Z]{2,3})\)$/.exec(text);
  return match && match[2] !== "AW" ? { name: match[1].trim().slice(0, 40), country: match[2] } : { name: text.slice(0, 40), country: "" };
}
const plainName = (raw: unknown) => splitSuffix(raw).name;

/** "Dundalk (AW) (IRE)" → "Dundalk (AW)": the provider tags tracks outside Britain with their country. */
export function trackName(course: unknown) {
  return clean(course, 80).replace(/\s*\(([A-Z]{2,3})\)\s*$/, (whole, tag) => (tag === "AW" ? whole : "")).trim();
}

/** A short, readable track code: "Kempton (AW)" → KEMPAW, "Happy Valley" → HAVA, "Newmarket (July)" → NEWMJ. */
export function trackCode(name: string) {
  const plain = name.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const tags = [...plain.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim().toUpperCase());
  const words = plain
    .replace(/\([^)]*\)/g, " ")
    .toUpperCase()
    .replace(/[^A-Z0-9\s-]/g, "")
    .split(/[\s-]+/)
    .filter(Boolean);
  let code =
    words.length === 0 ? "" : words.length === 1 ? words[0].slice(0, 4) : words.length === 2 ? words[0].slice(0, 2) + words[1].slice(0, 2) : words.slice(0, 4).map((w) => w[0]).join("");
  for (const tag of tags) code += tag === "AW" ? "AW" : tag.replace(/[^A-Z0-9]/g, "").slice(0, 1);
  code = code.slice(0, 6);
  return code.length >= 2 ? code : (code + "TRK").slice(0, 3);
}

export function trackOf(course: unknown, courseId: unknown, region: unknown) {
  const name = trackName(course);
  return { code: trackCode(name), name: name.length >= 2 ? name : clean(course, 80), country: regionCountry(region), breed: "thoroughbred" as const, ref: refInput(courseId) };
}

/** Race kind for the racing tables: pattern races are stakes (Group/Grade 1–3), then maiden, claiming, handicap. */
export function raceTypeOf(name: unknown, pattern: unknown): { type: string; grade: number | null } {
  const p = String(pattern ?? "").toLowerCase();
  const n = String(name ?? "").toLowerCase();
  const graded = /(group|grade)\s*([123])\b/.exec(p);
  if (graded) return { type: "stakes", grade: Number(graded[2]) };
  if (p.includes("listed")) return { type: "stakes", grade: null };
  if (n.includes("maiden") && /claim/.test(n)) return { type: "maiden_claiming", grade: null };
  if (n.includes("maiden")) return { type: "maiden", grade: null };
  if (/claim|selling|seller/.test(n)) return { type: "claiming", grade: null };
  if (/handicap|h'cap/.test(n)) return { type: "handicap", grade: null };
  return { type: "other", grade: null };
}

export function surfaceOf(raw: unknown) {
  const s = String(raw ?? "").toLowerCase();
  if (/\baw\b|all.?weather|polytrack|tapeta|fibresand|synthetic/.test(s)) return "all_weather";
  if (s.includes("dirt")) return "dirt";
  return "turf";
}

/** Going → the nearest track condition (the exact going is also kept in the race's conditions). */
export function goingOf(raw: unknown) {
  const g = String(raw ?? "").toLowerCase().replace(/\s*\/\s*/g, " to ").replace(/\s+/g, " ").trim();
  if (!g) return "";
  if (g.startsWith("standard")) return "standard";
  if (g.includes("heavy")) return "heavy";
  if (g === "good to soft" || g.startsWith("yielding") || g === "good to yielding") return g === "yielding to soft" ? "soft" : "yielding";
  if (g.includes("soft")) return "soft";
  if (g === "good to firm" || g.includes("firm") || g === "hard") return "firm";
  if (g.startsWith("good")) return "good";
  if (["fast", "muddy", "sloppy"].includes(g)) return g;
  if (g === "slow") return "standard";
  return "";
}

const furlongs = (raw: unknown) => {
  const n = parseFloat(String(raw ?? ""));
  return Number.isFinite(n) && n > 0 && n < 100 ? Math.round(n * 100) / 100 : null;
};
const amount = (raw: unknown) => {
  const n = Number(String(raw ?? "").replace(/[^0-9.]/g, ""));
  return String(raw ?? "").match(/\d/) && Number.isFinite(n) ? n : null;
};
const amounts = (raw: unknown) => (String(raw ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const position = (raw: unknown) => (/^\d{1,2}$/.test(String(raw ?? "")) ? Number(raw) : null);
/** Decimal odds 5.50 → 4.5 to 1. */
const oddsToOne = (raw: unknown) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.round((n - 1) * 100) / 100 : null;
};
const year = (raw: unknown) => (/^\d{4}-/.test(String(raw ?? "")) ? Number(String(raw).slice(0, 4)) : null);
const SEX: Record<string, string> = { G: "gelding", C: "colt", F: "filly", M: "mare", H: "horse", R: "ridgling", S: "horse" };
const sexOf = (code: unknown, word: unknown) =>
  SEX[String(code ?? "").toUpperCase()] ?? (["colt", "filly", "gelding", "horse", "mare", "ridgling"].includes(String(word ?? "").toLowerCase()) ? String(word).toLowerCase() : "");
/** "Joe Anderson(3)" → "Joe Anderson" (the allowance is not part of the name). */
const personName = (raw: unknown) => clean(raw, 80).replace(/\s*\(\d+\)$/, "");

function horseOf(r: any) {
  const named = splitSuffix(r.horse);
  return {
    ref: refInput(r.horse_id),
    name: named.name,
    // Where the horse was bred: the suffix on its name, or the racecard's region for it.
    country: named.country || (/^[A-Z]{2,3}$/.test(String(r.region ?? "")) ? String(r.region) : ""),
    sex: sexOf(r.sex_code ?? r.sex, r.sex),
    foaled: year(r.dob),
    sire: plainName(r.sire),
    dam: plainName(r.dam),
    damSire: plainName(r.damsire),
    breeder: clean(r.breeder, 80),
  };
}

function racecardRunner(r: any) {
  const number = String(r.number ?? "").trim().toUpperCase();
  const nonRunner = number === "NR";
  return {
    // A non-runner has lost its number; the import scratches it on the card it was entered on.
    program: nonRunner ? "" : number,
    post: Number(r.draw) > 0 ? Number(r.draw) : null,
    horse: horseOf(r),
    jockey: personName(r.jockey),
    jockeyRef: refInput(r.jockey_id),
    trainer: personName(r.trainer),
    trainerRef: refInput(r.trainer_id),
    owner: clean(r.owner, 80),
    ownerRef: refInput(r.owner_id),
    weight: Number(r.lbs) > 0 ? Number(r.lbs) : null,
    medication: "",
    equipment: clean(r.headgear, 20),
    morningLine: "",
    scratched: nonRunner,
    scratchReason: nonRunner ? "Non-runner" : "",
    finish: null as number | null,
    odds: null as number | null,
    earnings: null as number | null,
  };
}

function payoutsOf(result: any) {
  const placed = (Array.isArray(result.runners) ? result.runners : [])
    .filter((r: any) => position(r.position) !== null)
    .sort((a: any, b: any) => Number(a.position) - Number(b.position))
    .map((r: any) => String(r.number ?? "").trim());
  const lines: { pool: string; combination: string; amount: number }[] = [];
  const add = (pool: string, combination: string, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value) && combination) lines.push({ pool, combination, amount: value });
  };
  add("Win", placed[0], amounts(result.tote_win)[0]);
  amounts(result.tote_pl).forEach((value, i) => add("Place", placed[i], value));
  add("Exacta", placed.slice(0, 2).join("-"), amounts(result.tote_ex)[0]);
  add("Straight forecast", placed.slice(0, 2).join("-"), amounts(result.tote_csf)[0]);
  add("Tricast", placed.slice(0, 3).join("-"), amounts(result.tote_tricast)[0]);
  add("Trifecta", placed.slice(0, 3).join("-"), amounts(result.tote_trifecta)[0]);
  return lines.filter((line) => line.combination.split("-").every((n) => /^\d{1,2}$/.test(n)));
}

function conditionsOf(src: any, going: string) {
  return [
    src.type,
    src.pattern,
    src.race_class ?? src.class,
    src.age_band,
    src.rating_band ? `Rated ${src.rating_band}` : "",
    src.sex_restriction ?? src.sex_rest,
    src.distance ?? src.dist,
    going ? `Going: ${going}` : "",
  ]
    .map((part) => clean(part, 60))
    .filter(Boolean)
    .join(" · ")
    .slice(0, 500);
}

function raceOf(number: number, card: any | undefined, result: any | undefined) {
  const src = card ?? result;
  const region = String(src.region ?? "").toUpperCase();
  const name = clean(src.race_name, 100);
  const { type, grade } = raceTypeOf(name, src.pattern);
  const going = clean(result?.going || card?.going_detailed || card?.going, 40);
  const runners = new Map<string, ReturnType<typeof racecardRunner>>();
  for (const r of Array.isArray(card?.runners) ? card.runners : []) {
    const runner = racecardRunner(r);
    if (runner.horse.ref) runners.set(runner.horse.ref, runner);
  }
  let official = false;
  let winningTime = "";
  if (result && Array.isArray(result.runners)) {
    const ran = new Set<string>();
    for (const r of result.runners) {
      const ref = refInput(r.horse_id);
      if (!ref) continue;
      ran.add(ref);
      const base = runners.get(ref) ?? racecardRunner({ ...r, lbs: r.weight_lbs });
      const named = splitSuffix(r.horse);
      runners.set(ref, {
        ...base,
        program: String(r.number ?? base.program).trim().toUpperCase(),
        post: Number(r.draw) > 0 ? Number(r.draw) : base.post,
        horse: { ...base.horse, name: base.horse.name || named.name, country: base.horse.country || named.country },
        jockey: personName(r.jockey) || base.jockey,
        jockeyRef: refInput(r.jockey_id) ?? base.jockeyRef,
        trainer: personName(r.trainer) || base.trainer,
        trainerRef: refInput(r.trainer_id) ?? base.trainerRef,
        owner: clean(r.owner, 80) || base.owner,
        ownerRef: refInput(r.owner_id) ?? base.ownerRef,
        weight: Number(r.weight_lbs) > 0 ? Number(r.weight_lbs) : base.weight,
        equipment: clean(r.headgear, 20) || base.equipment,
        scratched: false,
        scratchReason: "",
        finish: position(r.position),
        odds: oddsToOne(r.sp_dec),
        earnings: amount(r.prize) !== null ? Math.round(amount(r.prize)!) : null,
      });
      if (position(r.position) === 1 && !winningTime) winningTime = clean(r.time, 20);
    }
    official = result.runners.some((r: any) => position(r.position) === 1);
    if (official) {
      // On the card but not in the result: a non-runner.
      for (const [ref, runner] of runners) {
        if (ran.has(ref)) continue;
        runner.scratched = true;
        runner.scratchReason = "Non-runner";
        runner.finish = null;
      }
    }
  }
  const currency =
    (/^[A-Z]{3}$/.test(String(card?.prize_currency ?? "")) && card.prize_currency) ||
    (result?.runners ?? []).map((r: any) => r.prize_currency).find((c: unknown) => /^[A-Z]{3}$/.test(String(c ?? ""))) ||
    "";
  const purse = amount(card?.prize);
  return {
    number,
    ref: refInput(src.race_id),
    postTime: localTime(src.off_dt, region, card?.off_time),
    name,
    type,
    grade,
    breed: "thoroughbred",
    distanceValue: furlongs(card?.distance_f ?? result?.dist_f),
    distanceUnit: "furlongs",
    surface: surfaceOf(src.surface),
    condition: goingOf(going),
    purse: purse !== null ? Math.round(purse) : null,
    currency,
    conditions: conditionsOf(src, going),
    status: card?.is_abandoned === true ? "cancelled" : official ? "official" : "scheduled",
    winningTime: winningTime || clean(result?.winning_time_detail, 20),
    payouts: official ? payoutsOf(result) : [],
    runners: [...runners.values()].slice(0, MAX_RUNNERS),
  };
}

const offOf = (race: any) => {
  const t = Date.parse(String(race?.off_dt ?? ""));
  return Number.isFinite(t) ? t : 0;
};

/**
 * One day's racecards and results → one Stayblz card per track. Races are numbered in post-time order; the provider's
 * race id travels with each race so a later import (results, changes) finds the same race.
 */
export function cardsFromRacingApi(racecards: any[], results: any[], wantRegion: (region: string) => boolean = () => true) {
  type Group = { track: ReturnType<typeof trackOf>; date: string; races: Map<string, { off: number; card?: any; result?: any }> };
  const groups = new Map<string, Group>();
  const add = (race: any, kind: "card" | "result") => {
    const region = String(race?.region ?? "").toUpperCase();
    if (!race?.race_id || !race?.date || !wantRegion(region)) return;
    const courseKey = String(race.course_id || race.course || "");
    const key = `${courseKey}|${race.date}`;
    let group = groups.get(key);
    if (!group) {
      group = { track: trackOf(race.course, race.course_id, region), date: String(race.date), races: new Map() };
      groups.set(key, group);
    } else if (kind === "card") {
      // Racecards carry the cleaner track name.
      group.track = trackOf(race.course, race.course_id, region);
    }
    const entry = group.races.get(race.race_id) ?? { off: offOf(race) };
    entry[kind] = race;
    if (!entry.off) entry.off = offOf(race);
    group.races.set(race.race_id, entry);
  };
  for (const race of racecards ?? []) add(race, "card");
  for (const race of results ?? []) add(race, "result");
  return [...groups.values()].map((group) => ({
    source: RACING_API_SOURCE,
    date: group.date,
    track: group.track,
    races: [...group.races.values()]
      .sort((a, b) => a.off - b.off)
      .slice(0, 40)
      .map((entry, i) => raceOf(i + 1, entry.card, entry.result)),
    horses: [],
  }));
}

/** One horse's results from the provider → the horse (pedigree) and its earlier starts in Stayblz's history format. */
export function historyFromRacingApi(horseId: string, results: any[]) {
  let horse: ReturnType<typeof horseOf> | null = null;
  const history = [];
  for (const race of results ?? []) {
    const me = (Array.isArray(race?.runners) ? race.runners : []).find((r: any) => r.horse_id === horseId);
    if (!me || !race.date) continue;
    const region = String(race.region ?? "").toUpperCase();
    horse ??= horseOf(me);
    const track = trackOf(race.course, race.course_id, region);
    history.push({
      date: String(race.date),
      trackCode: track.code,
      trackName: track.name,
      race: null,
      name: clean(race.race_name, 100),
      type: [race.pattern || race.class, race.type].map((p) => clean(p, 30)).filter(Boolean).join(" · ").slice(0, 60),
      breed: "thoroughbred",
      distanceValue: furlongs(race.dist_f),
      distanceUnit: "furlongs",
      surface: surfaceOf(race.surface),
      fieldSize: Array.isArray(race.runners) ? race.runners.length : null,
      finish: position(me.position),
      odds: oddsToOne(me.sp_dec),
      rider: personName(me.jockey),
    });
  }
  return horse ? { horse, history } : null;
}
