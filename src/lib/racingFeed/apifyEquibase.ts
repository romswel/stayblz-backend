import type { Breed } from "./card";

/**
 * Converts the co-dev's collected files (data/horse-racing/*.json, made with the Apify actor
 * "jungle_synthesizer/equibase-us-horse-racing-scraper") into Stayblz cards (lib/racingFeed/card.ts), one per track
 * and day. Accepts the combined file ({ races, horses }) or a plain list of race and horse records.
 *
 * Left out on purpose: speed figures (another company's rating), links back to the source site, live odds before the
 * race is final, and scratched entries that have no program number. Track names are only filled from a short list of
 * public track names when the file gives just the code.
 *
 * This is a stop-gap for local testing. The licensed Equibase feed gets its own adapter to the same card format.
 */
const TRACK_NAMES: Record<string, string> = {
  CD: "Churchill Downs",
  TAM: "Tampa Bay Downs",
  PRX: "Parx Racing",
  CT: "Charles Town",
  DED: "Delta Downs",
  EVD: "Evangeline Downs",
  FL: "Finger Lakes",
  MNR: "Mountaineer",
  MVR: "Mahoning Valley",
  AQU: "Aqueduct",
  BEL: "Belmont Park",
  SA: "Santa Anita",
  GP: "Gulfstream Park",
  KEE: "Keeneland",
  DMR: "Del Mar",
  SAR: "Saratoga",
  OP: "Oaklawn Park",
  FG: "Fair Grounds",
  LRL: "Laurel Park",
  PIM: "Pimlico",
};
// Two-letter suffixes that are US states / Canadian provinces (state-bred), not countries.
const REGIONS = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA " +
    "RI SC SD TN TX UT VT VA WA WV WI WY AB BC MB NB NL NS ON PE QC SK").split(" "),
);
const SEX: Record<string, string> = { G: "gelding", F: "filly", M: "mare", C: "colt", H: "horse", R: "ridgling" };
const REGISTRY_BREED: Record<string, Breed> = { T: "thoroughbred", Q: "quarter_horse", TB: "thoroughbred", QH: "quarter_horse" };

/** "Zara's Empire (KY)" → name + country ('' for US/Canadian state-bred, else the country code). */
export function splitName(raw: unknown) {
  const text = typeof raw === "string" ? raw.trim() : "";
  const m = text.match(/^(.*?)\s*\(([A-Z]{2,3})\)$/);
  if (!m) return { name: text, country: "" };
  return { name: m[1].trim(), country: REGIONS.has(m[2]) ? "" : m[2] };
}
/** "1:00 PM" → "13:00". */
export function clock(raw: unknown) {
  const m = typeof raw === "string" ? raw.trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?M\.?$/i) : null;
  if (!m) return "";
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "P") h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
/** "8/1" → "8-1" (morning line text). */
const ml = (raw: unknown) => (typeof raw === "string" && /^\d{1,3}\/\d{1,2}$/.test(raw.trim()) ? raw.trim().replace("/", "-") : "");
/** "3/5" → 0.6 (odds to 1). */
export function oddsValue(raw: unknown) {
  const m = typeof raw === "string" ? raw.trim().match(/^(\d{1,4})\/(\d{1,3})$/) : null;
  return m && Number(m[2]) > 0 ? Math.round((Number(m[1]) / Number(m[2])) * 100) / 100 : null;
}
export function raceType(raw: unknown) {
  const t = String(raw ?? "").toLowerCase();
  if (/stakes|grade|derby|oaks|futurity|handicap stakes/.test(t)) return "stakes";
  if (/maiden/.test(t)) return /claim/.test(t) ? "maiden_claiming" : "maiden";
  if (/optional claim/.test(t)) return "optional_claiming";
  if (/starter/.test(t)) return "starter";
  if (/claim/.test(t)) return "claiming";
  if (/allowance/.test(t)) return "allowance";
  if (/handicap/.test(t)) return "handicap";
  if (/trial/.test(t)) return "trial";
  return "other";
}
const SURFACE: Record<string, string> = { dirt: "dirt", turf: "turf", synthetic: "synthetic", "all weather": "all_weather", "all-weather": "all_weather", tapeta: "synthetic", polytrack: "synthetic" };
const surface = (raw: unknown) => SURFACE[String(raw ?? "").toLowerCase().trim()] ?? "dirt";
const CONDITIONS = ["fast", "good", "firm", "yielding", "soft", "sloppy", "muddy", "sealed", "heavy", "wet_fast", "standard"];
const condition = (raw: unknown) => {
  const c = String(raw ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  return CONDITIONS.includes(c) ? c : "";
};
/** Furlongs, or miles when that's an exact, short number (8 f → 1 mi, 10 f → 1.25 mi). */
export function distance(furlongs: unknown) {
  const f = typeof furlongs === "number" ? furlongs : Number(furlongs);
  if (!Number.isFinite(f) || f <= 0) return { distanceValue: null, distanceUnit: "furlongs" };
  const miles = f / 8;
  if (f >= 8 && Math.round(miles * 100) === miles * 100) return { distanceValue: miles, distanceUnit: "miles" };
  return { distanceValue: f, distanceUnit: "furlongs" };
}
/** Workout "4F" / "1M" / "300Y" / "1M70Y"-style distances. */
export function workDistance(raw: unknown) {
  const t = String(raw ?? "").toUpperCase().replace(/\s+/g, "");
  let m = t.match(/^(\d+(?:\.\d+)?)F$/);
  if (m) return { distanceValue: Number(m[1]), distanceUnit: "furlongs" };
  m = t.match(/^(\d+(?:\.\d+)?)Y$/);
  if (m) return { distanceValue: Number(m[1]), distanceUnit: "yards" };
  m = t.match(/^(\d+(?:\.\d+)?)M$/);
  if (m) return { distanceValue: Number(m[1]), distanceUnit: "miles" };
  return null;
}
/** "47.95" or "1:00.20" → seconds. */
export function seconds(raw: unknown) {
  const t = String(raw ?? "").trim();
  const m = t.match(/^(?:(\d{1,2}):)?(\d{1,2}(?:\.\d{1,2})?)$/);
  if (!m) return null;
  const value = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return value > 0 && value < 600 ? value : null;
}
const ref = (refno: unknown, registry: unknown) =>
  /^\d{1,20}$/.test(String(refno ?? "")) ? `${/^[A-Z]{1,2}$/.test(String(registry ?? "")) ? registry : "X"}:${refno}` : null;
const yearOf = (date: string) => Number(date.slice(0, 4));

function runnerOf(e: any, race: any) {
  const { name, country } = splitName(e?.horse_name);
  const age = Number(String(e?.age_sex ?? e?.age ?? "").split("/")[0]);
  const sexCode = String(e?.sex ?? String(e?.age_sex ?? "").split("/")[1] ?? "").toUpperCase();
  return {
    program: e?.program_number == null ? "" : String(e.program_number),
    post: e?.post_position ?? null,
    horse: {
      ref: ref(e?.horse_refno, e?.horse_registry),
      name,
      country,
      sex: SEX[sexCode] ?? "",
      foaled: Number.isInteger(age) && age > 0 && age < 40 ? yearOf(race.race_date) - age : null,
    },
    jockey: e?.jockey ?? "",
    trainer: e?.trainer ?? "",
    weight: e?.weight_lbs ?? null,
    medication: e?.medication ?? "",
    morningLine: ml(e?.ml_odds),
    scratched: e?.is_scratched === true,
    finish: e?.finish_position ?? null,
    odds: race.live_odds_final ? oddsValue(e?.live_odds) : null,
  };
}

function raceOf(r: any) {
  const runners = (Array.isArray(r?.entries_detail) ? r.entries_detail : []).map((e: any) => runnerOf(e, r));
  const breeds = (Array.isArray(r?.entries_detail) ? r.entries_detail : []).map((e: any) => REGISTRY_BREED[e?.horse_registry] ?? "thoroughbred");
  const breed: Breed = breeds.filter((b: Breed) => b === "quarter_horse").length > breeds.length / 2 ? "quarter_horse" : "thoroughbred";
  const payouts: { pool: string; combination: string; amount: number }[] = [];
  for (const p of Array.isArray(r?.payouts_by_horse) ? r.payouts_by_horse : [])
    for (const [pool, key] of [["Win", "win_payout"], ["Place", "place_payout"], ["Show", "show_payout"]] as const)
      if (typeof p?.[key] === "number") payouts.push({ pool, combination: String(p.program_number ?? ""), amount: p[key] });
  for (const [kind, x] of Object.entries((r?.exotic_payouts_by_type ?? {}) as Record<string, any>))
    for (const pay of Array.isArray(x?.payoffs) && x.payoffs.length ? x.payoffs : [x])
      if (typeof pay?.payoff === "number")
        payouts.push({ pool: String(x?.raw_label || kind.replace(/_/g, " ")), combination: String(pay.winning_numbers ?? ""), amount: pay.payoff });
  const name = String(r?.race_name ?? "").trim();
  return {
    number: r?.race_number,
    postTime: clock(r?.post_time),
    name: name.toLowerCase() === String(r?.race_type ?? "").trim().toLowerCase() ? "" : name,
    type: raceType(r?.race_type ?? r?.race_name),
    breed,
    ...distance(r?.distance_furlongs),
    surface: surface(r?.surface),
    condition: condition(r?.track_condition),
    purse: r?.purse_usd ?? null,
    currency: "USD",
    status: r?.race_cancelled ? "cancelled" : r?.results_available ? "official" : "scheduled",
    winningTime: typeof r?.winning_time === "string" ? r.winning_time : "",
    payouts,
    runners,
  };
}

function horseOf(h: any) {
  const { name, country } = splitName(h?.horse_name);
  return {
    ref: ref(h?.horse_refno, h?.horse_registry),
    name,
    country,
    history: (Array.isArray(h?.past_starts) ? h.past_starts : []).map((s: any) => ({
      date: s?.race_date,
      trackCode: s?.track_code,
      trackName: s?.track_name ?? "",
      race: s?.race_number,
      type: s?.race_type ?? "",
      breed: REGISTRY_BREED[s?.breed] ?? "thoroughbred",
      finish: s?.finish_position ?? null,
      // s.speed_figure is deliberately not copied.
    })),
    workouts: (Array.isArray(h?.workouts) ? h.workouts : [])
      .map((w: any) => {
        const d = workDistance(w?.distance);
        const t = seconds(w?.time);
        const [rank, rankOf] = String(w?.rank ?? "").split("/").map((v) => Number(v));
        return d && t
          ? {
              date: w?.workout_date,
              trackCode: w?.track_code,
              trackName: w?.track_name ?? "",
              ...d,
              surface: surface(w?.surface),
              timeSeconds: t,
              rank: Number.isInteger(rank) ? rank : null,
              rankOf: Number.isInteger(rankOf) ? rankOf : null,
              note: w?.note ?? "",
            }
          : null;
      })
      .filter(Boolean),
  };
}

/** True when this looks like one of the co-dev's collected files. */
export function isApifyEquibase(data: unknown) {
  const list = Array.isArray(data) ? data : Array.isArray((data as any)?.races) ? (data as any).races : null;
  return !!list?.some((r: any) => r && typeof r === "object" && "race_id" in r && "entries_detail" in r);
}

/** The collected file → one card per track and day. */
export function cardsFromApifyEquibase(data: unknown) {
  const records: any[] = Array.isArray(data)
    ? data
    : [...((data as any)?.races ?? []), ...((data as any)?.horses ?? [])];
  const races = records.filter((r) => r && typeof r === "object" && "race_number" in r && "entries_detail" in r);
  const horses = records.filter((r) => r && typeof r === "object" && "horse_refno" in r && ("past_starts" in r || "workouts" in r));
  const cards = new Map<string, any>();
  const cardOfRace = new Map<string, string>();
  for (const r of races) {
    const code = String(r.track_code ?? "").toUpperCase();
    const key = `${code}|${r.race_date}`;
    if (!cards.has(key))
      cards.set(key, {
        source: "equibase",
        date: r.race_date,
        track: { code, name: r.track_name && r.track_name !== code ? r.track_name : (TRACK_NAMES[code] ?? code), country: "US", breed: "thoroughbred" },
        races: [],
        horses: [],
      });
    const card = cards.get(key);
    if (!card.races.some((x: any) => x.number === r.race_number)) card.races.push(raceOf(r));
    cardOfRace.set(String(r.race_id), key);
  }
  for (const card of cards.values()) {
    const qh = card.races.filter((r: any) => r.breed === "quarter_horse").length;
    if (qh > card.races.length / 2) card.track.breed = "quarter_horse";
  }
  let unplaced = 0;
  for (const h of horses) {
    const key = (Array.isArray(h.entered_race_ids) ? h.entered_race_ids : []).map((id: string) => cardOfRace.get(String(id))).find(Boolean);
    if (key) cards.get(key).horses.push(horseOf(h));
    else unplaced++;
  }
  return { cards: [...cards.values()], unplacedHorses: unplaced };
}
