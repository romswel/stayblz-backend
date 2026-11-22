/**
 * Stayblz Stallions: pedigree arithmetic for the mating check. Pure functions (no database), tested in
 * tests/stallion_pedigree.test.cjs.
 *
 * A pedigree is a map from a position to a name. Positions are paths from the horse: "s" = sire, "d" = dam,
 * "ds" = dam's sire, "sss" = sire's sire's sire. Generation = path length (1 = parents).
 * Stallions carry 4 generations (30 names), mares 3 (14). A foal's pedigree is the stallion under "s"
 * and the mare under "d", so a stallion's 4th generation is the foal's 5th.
 *
 * Names identify horses: the same name (ignoring case, spacing and a country suffix such as "(IRE)") is taken to be
 * the same horse. Ancestors nobody entered count as unrelated, so the inbreeding figure is a floor for the
 * generations given, never an overestimate.
 */
export type Pedigree = Record<string, string>;

export const STALLION_DEPTH = 4;
export const MARE_DEPTH = 3;

/** Every position up to `depth` generations, nearest first: s, d, ss, sd, ds, dd, sss, … */
export function pedigreePaths(depth: number): string[] {
  const out: string[] = [];
  let level = [""];
  for (let g = 1; g <= depth; g++) {
    level = level.flatMap((p) => [`${p}s`, `${p}d`]);
    out.push(...level);
  }
  return out;
}

/** Same as the SQL function stallion_key(): the name used to match horses. */
export const nameKey = (name: unknown) =>
  typeof name === "string"
    ? name.replace(/\s*\([A-Za-z]{2,3}\)\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase()
    : "";

/** The foal's pedigree: the stallion and his ancestors on top, the mare and hers below. */
export function foalPedigree(stallion: { name: string; pedigree: Pedigree }, mare: { name: string; pedigree: Pedigree }): Pedigree {
  const foal: Pedigree = {};
  if (stallion.name.trim()) foal.s = stallion.name.trim();
  if (mare.name.trim()) foal.d = mare.name.trim();
  for (const [path, name] of Object.entries(stallion.pedigree)) if (name?.trim()) foal[`s${path}`] = name.trim();
  for (const [path, name] of Object.entries(mare.pedigree)) if (name?.trim()) foal[`d${path}`] = name.trim();
  return foal;
}

export interface SharedAncestor {
  name: string;
  /** Generations where the horse appears on the sire's side and on the dam's side (1 = parent). */
  sire: number[];
  dam: number[];
  /** "3×4", "2,4×3", or "3,4" for a horse repeated on one side only. */
  notation: string;
  /** On both sides (true inbreeding) or only within one parent's pedigree. */
  bothSides: boolean;
  /** Every appearance comes through another repeated horse (e.g. the sire of a 3×3 ancestor shows up 4×4). */
  through: boolean;
}

const prefixes = (path: string) => Array.from({ length: path.length - 1 }, (_, i) => path.slice(0, i + 1));

/** Horses that appear more than once in the foal's pedigree, closest (and both-sided) first. */
export function repeatedAncestors(foal: Pedigree): SharedAncestor[] {
  const groups = new Map<string, { name: string; paths: string[] }>();
  for (const [path, name] of Object.entries(foal)) {
    const key = nameKey(name);
    if (!key) continue;
    const g = groups.get(key) ?? { name, paths: [] };
    g.paths.push(path);
    groups.set(key, g);
  }
  const repeated = new Set([...groups].filter(([, g]) => g.paths.length > 1).map(([k]) => k));
  const out: SharedAncestor[] = [];
  for (const key of repeated) {
    const g = groups.get(key)!;
    const sire = g.paths.filter((p) => p[0] === "s").map((p) => p.length).sort((a, b) => a - b);
    const dam = g.paths.filter((p) => p[0] === "d").map((p) => p.length).sort((a, b) => a - b);
    const independent = g.paths.filter((p) => !prefixes(p).some((q) => repeated.has(nameKey(foal[q]))));
    const bothSides = sire.length > 0 && dam.length > 0;
    out.push({
      name: g.name,
      sire,
      dam,
      notation: bothSides ? `${sire.join(",")}×${dam.join(",")}` : [...sire, ...dam].join(","),
      bothSides,
      through: independent.length === 0,
    });
  }
  const closest = (a: SharedAncestor) => Math.min(...a.sire, ...a.dam);
  return out.sort(
    (a, b) =>
      Number(a.through) - Number(b.through) ||
      Number(b.bothSides) - Number(a.bothSides) ||
      closest(a) - closest(b) ||
      a.sire.length + a.dam.length - (b.sire.length + b.dam.length) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Wright's coefficient of inbreeding for the foal (0 to 1), from the names given. Computed exactly over the
 * pedigree graph (kinship recursion), so repeated horses that are related to each other are counted correctly.
 */
export function inbreedingCoefficient(foal: Pedigree): number {
  const ROOT = "\u0000foal";
  const keyAt = (path: string) => nameKey(foal[path]);
  const parents = new Map<string, { s?: string; d?: string }>();
  parents.set(ROOT, { s: keyAt("s") || undefined, d: keyAt("d") || undefined });
  for (const path of Object.keys(foal)) {
    const key = keyAt(path);
    if (!key) continue;
    const entry = parents.get(key) ?? {};
    const s = keyAt(`${path}s`);
    const d = keyAt(`${path}d`);
    if (s && !entry.s) entry.s = s;
    if (d && !entry.d) entry.d = d;
    parents.set(key, entry);
  }
  // Rank: founders 0, every horse above its parents. A horse typed as its own ancestor (bad data) loses that link.
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (key: string): number => {
    const known = rank.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return -1;
    visiting.add(key);
    const entry = parents.get(key);
    let r = 0;
    if (entry)
      for (const side of ["s", "d"] as const) {
        const parent = entry[side];
        if (!parent) continue;
        const pr = rankOf(parent);
        if (pr < 0) delete entry[side];
        else r = Math.max(r, pr + 1);
      }
    visiting.delete(key);
    rank.set(key, r);
    return r;
  };
  rankOf(ROOT);
  for (const key of parents.keys()) rankOf(key);

  const kinship = new Map<string, number>();
  const selfF = new Map<string, number>();
  const F = (key: string): number => {
    const known = selfF.get(key);
    if (known !== undefined) return known;
    const entry = parents.get(key);
    const v = entry ? phi(entry.s, entry.d) : 0;
    selfF.set(key, v);
    return v;
  };
  function phi(a?: string, b?: string): number {
    if (!a || !b) return 0;
    if (a === b) return (1 + F(a)) / 2;
    const memo = a < b ? `${a}|${b}` : `${b}|${a}`;
    const known = kinship.get(memo);
    if (known !== undefined) return known;
    // Expand the younger horse (an ancestor always ranks below its descendants).
    const [young, other] = (rank.get(a) ?? 0) >= (rank.get(b) ?? 0) ? [a, b] : [b, a];
    const entry = parents.get(young) ?? {};
    const v = (phi(entry.s, other) + phi(entry.d, other)) / 2;
    kinship.set(memo, v);
    return v;
  }
  return F(ROOT);
}

/** How complete a pedigree is: names given out of the positions possible. */
export function completeness(foal: Pedigree, sireDepth = STALLION_DEPTH + 1, damDepth = MARE_DEPTH + 1) {
  const sirePaths = pedigreePaths(sireDepth).filter((p) => p[0] === "s");
  const damPaths = pedigreePaths(damDepth).filter((p) => p[0] === "d");
  const all = [...sirePaths, ...damPaths];
  return { named: all.filter((p) => !!foal[p]?.trim()).length, possible: all.length };
}

/** The sire line (sire, his sire, his sire…) from a stallion's own pedigree, nearest first. */
export function sireLine(pedigree: Pedigree, depth = STALLION_DEPTH): string[] {
  const out: string[] = [];
  for (let g = 1; g <= depth; g++) {
    const name = pedigree["s".repeat(g)];
    if (!name) break;
    out.push(name);
  }
  return out;
}
