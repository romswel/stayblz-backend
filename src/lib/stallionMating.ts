import { supabase } from "./supabase";
import { geneticsCheck, type Genetics } from "./stallionGenetics";
import { LIVE_COVER_ONLY } from "./stallionInput";
import {
  completeness,
  foalPedigree,
  inbreedingCoefficient,
  nameKey,
  repeatedAncestors,
  type Pedigree,
} from "./stallionPedigree";

/**
 * Stayblz Stallions: the mating check. Everything here is arithmetic on the names and test results people
 * entered, plus counts from Stayblz racing data. No ratings, no predictions of value.
 */
export interface StallionForMating {
  id: string;
  name: string;
  breed: string;
  methods: string[];
  pedigree: Pedigree;
  genetics: Genetics;
}
export interface MareForMating {
  name: string;
  breed: string;
  pedigree: Pedigree;
  genetics: Genetics;
}

const MARE_PLACEHOLDER = "Your mare";
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

async function cross(sire: string, damSire: string) {
  if (!nameKey(damSire) || (!nameKey(sire) && sire !== "")) return null;
  const { data, error } = await supabase.rpc("stallion_cross", { p_sire: sire, p_damsire: damSire });
  if (error) throw error;
  return data ?? null;
}

/** The full check of one stallion with one mare. */
export async function matingReport(stallion: StallionForMating, mare: MareForMating) {
  const mareName = mare.name.trim() || MARE_PLACEHOLDER;
  const foal = foalPedigree({ name: stallion.name, pedigree: stallion.pedigree }, { name: mareName, pedigree: mare.pedigree });
  const coefficient = inbreedingCoefficient(foal);
  const shared = repeatedAncestors(foal);
  const mareSire = mare.pedigree.s ?? "";
  const [exact, sireLine, asDamSire] = await Promise.all([
    mareSire ? cross(stallion.name, mareSire) : null,
    mareSire && stallion.pedigree.s ? cross(stallion.pedigree.s, mareSire) : null,
    mareSire ? cross("", mareSire) : null,
  ]);
  const notes: string[] = [];
  if (stallion.breed !== mare.breed && mare.breed !== "other" && stallion.breed !== "other")
    notes.push("The stallion and the mare are different breeds. Check with your registry which foals it will register.");
  if (LIVE_COVER_ONLY.has(stallion.breed) || LIVE_COVER_ONLY.has(mare.breed))
    notes.push("Thoroughbred foals are only registered from live cover, so the mare goes to the stallion.");
  if (!mareSire) notes.push("Add the mare's sire to see how this cross has done in Stayblz racing data.");
  const known = completeness(foal);
  return {
    stallion: { id: stallion.id, name: stallion.name, breed: stallion.breed },
    mare: { name: mareName, breed: mare.breed, pedigree: mare.pedigree },
    foal,
    shared,
    inbreeding: {
      percent: round(coefficient * 100, 2),
      named: known.named,
      possible: known.possible,
    },
    genetics: geneticsCheck(stallion.genetics, mare.genetics),
    crosses: { exact, sireLine, sireLineName: stallion.pedigree.s ?? "", asDamSire, mareSire },
    notes,
  };
}

/** A quick check against many stallions at once (inbreeding, closest shared horses, genetics, cross runners). */
export function quickMatch(stallion: StallionForMating, mare: MareForMating, crossCounts: Record<string, { runners: number; winners: number; wins: number }>) {
  const foal = foalPedigree({ name: stallion.name, pedigree: stallion.pedigree }, { name: mare.name.trim() || MARE_PLACEHOLDER, pedigree: mare.pedigree });
  const shared = repeatedAncestors(foal).filter((a) => a.bothSides && !a.through);
  const genetics = geneticsCheck(stallion.genetics, mare.genetics);
  const worst = genetics[0]?.level ?? null;
  return {
    inbreeding: round(inbreedingCoefficient(foal) * 100, 2),
    shared: shared.slice(0, 3).map((a) => ({ name: a.name, notation: a.notation })),
    sharedCount: shared.length,
    genetics: worst && worst !== "clear" ? { level: worst, tests: genetics.filter((g) => g.level === worst).map((g) => g.label) } : null,
    cross: crossCounts[nameKey(stallion.name)] ?? null,
  };
}
