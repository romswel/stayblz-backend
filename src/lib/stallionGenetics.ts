/**
 * Stayblz Stallions: genetic test results the owner (or breeder) enters, and what they mean for a mating.
 * Simple single-gene inheritance only: each parent passes one of its two copies at random. Results are what
 * people state, not lab reports, so the app always says to confirm with the lab and a vet.
 *
 * A result is the number of copies of the variant: 0 (N/N, clear), 1 (one copy, e.g. N/GBED), 2 (two copies).
 * Keep the keys in step with the frontend (components/stallions/options.ts).
 */
export type Copies = 0 | 1 | 2;
export type Genetics = Record<string, Copies>;

export interface GeneticTest {
  key: string;
  label: string;
  name: string;
  inheritance: "recessive" | "dominant";
  /** The variant's symbol in lab results (N/<allele>). */
  allele: string;
  /** Two copies: the foal dies or doesn't survive long. */
  lethal?: boolean;
}

export const GENETIC_TESTS: GeneticTest[] = [
  { key: "GBED", label: "GBED", name: "Glycogen branching enzyme deficiency", inheritance: "recessive", allele: "GBED", lethal: true },
  { key: "HERDA", label: "HERDA", name: "Hereditary equine regional dermal asthenia", inheritance: "recessive", allele: "HRD" },
  { key: "LWO", label: "LWO", name: "Overo lethal white syndrome (frame overo)", inheritance: "recessive", allele: "O", lethal: true },
  { key: "WFFS", label: "WFFS", name: "Warmblood fragile foal syndrome", inheritance: "recessive", allele: "WFFS", lethal: true },
  { key: "SCID", label: "SCID", name: "Severe combined immunodeficiency", inheritance: "recessive", allele: "SCID", lethal: true },
  { key: "CA", label: "CA", name: "Cerebellar abiotrophy", inheritance: "recessive", allele: "CA" },
  { key: "LFS", label: "LFS", name: "Lavender foal syndrome", inheritance: "recessive", allele: "LFS", lethal: true },
  { key: "HYPP", label: "HYPP", name: "Hyperkalemic periodic paralysis", inheritance: "dominant", allele: "H" },
  { key: "PSSM1", label: "PSSM1", name: "Polysaccharide storage myopathy type 1", inheritance: "dominant", allele: "P1" },
  { key: "MH", label: "MH", name: "Malignant hyperthermia", inheritance: "dominant", allele: "MH" },
  { key: "IMM", label: "IMM", name: "Immune-mediated myositis (MYH1)", inheritance: "dominant", allele: "My" },
];
const TESTS = new Map(GENETIC_TESTS.map((t) => [t.key, t]));

/** Reads {GBED: 0|1|2, …}; unknown tests and other values are dropped. */
export function cleanGenetics(value: unknown): Genetics {
  const out: Genetics = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, copies] of Object.entries(value as Record<string, unknown>))
    if (TESTS.has(key) && (copies === 0 || copies === 1 || copies === 2)) out[key] = copies;
  return out;
}

export interface GeneticCheck {
  key: string;
  label: string;
  name: string;
  inheritance: "recessive" | "dominant";
  stallion: Copies | null;
  mare: Copies | null;
  /** danger: affected foals possible · warn: foals may inherit it · test: test the other parent · clear */
  level: "danger" | "warn" | "test" | "clear";
  /** Chance (0 to 1) of a foal with two copies (recessive) or at least one copy (dominant), when both are known. */
  chance: number | null;
  message: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const resultText = (t: GeneticTest, c: Copies) => (c === 0 ? "N/N" : c === 1 ? `N/${t.allele}` : `${t.allele}/${t.allele}`);
export const geneticResult = (key: string, copies: Copies) => {
  const t = TESTS.get(key);
  return t ? resultText(t, copies) : String(copies);
};

/** What each test means for a foal from this stallion and this mare. Tests neither of them has are left out. */
export function geneticsCheck(stallion: Genetics, mare: Genetics): GeneticCheck[] {
  const out: GeneticCheck[] = [];
  for (const t of GENETIC_TESTS) {
    const s = stallion[t.key] ?? null;
    const m = mare[t.key] ?? null;
    if (s === null && m === null) continue;
    const base = { key: t.key, label: t.label, name: t.name, inheritance: t.inheritance, stallion: s, mare: m };
    const ps = s === null ? null : s / 2;
    const pm = m === null ? null : m / 2;
    if (t.inheritance === "recessive") {
      if (ps !== null && pm !== null) {
        const affected = ps * pm;
        const carrier = ps * (1 - pm) + (1 - ps) * pm;
        if (affected > 0)
          out.push({ ...base, level: "danger", chance: affected,
            message: `About ${pct(affected)} of foals would get two copies${t.lethal ? " (these foals don't survive)" : " (affected)"}. Talk to your vet before booking.` });
        else if (carrier > 0)
          out.push({ ...base, level: "warn", chance: 0, message: `No affected foals, but about ${pct(carrier)} would carry one copy.` });
        else out.push({ ...base, level: "clear", chance: 0, message: "Both clear: no foal can be affected." });
      } else {
        const known = (ps ?? pm)!;
        const who = ps === null ? "stallion" : "mare";
        if (known > 0)
          out.push({ ...base, level: "test", chance: null,
            message: `The ${who === "mare" ? "stallion" : "mare"} has ${known === 1 ? "two copies" : "one copy"}. Test the ${who} before breeding.` });
        else out.push({ ...base, level: "clear", chance: 0, message: `No foal can be affected (one parent is clear). The ${who} isn't tested.` });
      }
    } else {
      if (ps !== null && pm !== null) {
        const any = 1 - (1 - ps) * (1 - pm);
        out.push({
          ...base,
          level: any >= 0.5 ? "danger" : any > 0 ? "warn" : "clear",
          chance: any,
          message: any > 0 ? `About ${pct(any)} of foals would have at least one copy (one copy is enough to show it).` : "Both clear: no foal can have it.",
        });
      } else {
        const known = (ps ?? pm)!;
        const who = ps === null ? "stallion" : "mare";
        if (known > 0)
          out.push({ ...base, level: known >= 0.5 ? "danger" : "warn", chance: null,
            message: `At least ${pct(known)} of foals would have it (from the ${who === "mare" ? "stallion" : "mare"}). The ${who} isn't tested.` });
        else out.push({ ...base, level: "test", chance: null, message: `One parent is clear. Test the ${who} to know for sure.` });
      }
    }
  }
  const order = { danger: 0, test: 1, warn: 2, clear: 3 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
