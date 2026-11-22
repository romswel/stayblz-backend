// Stayblz Stallions: pedigree arithmetic and genetics checks (pure functions, no database).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const ped = require("../dist/lib/stallionPedigree");
const gen = require("../dist/lib/stallionGenetics");

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

test("pedigree positions: 30 for four generations, 14 for three, nearest first", () => {
  assert.equal(ped.pedigreePaths(4).length, 30);
  assert.equal(ped.pedigreePaths(3).length, 14);
  assert.deepEqual(ped.pedigreePaths(2), ["s", "d", "ss", "sd", "ds", "dd"]);
});

test("names match without case, spacing or a country suffix", () => {
  assert.equal(ped.nameKey("  Frankel   (GB) "), "frankel");
  assert.equal(ped.nameKey("Sea The Stars (IRE)"), "sea the stars");
  assert.equal(ped.nameKey("Tapit"), ped.nameKey("TAPIT"));
  assert.equal(ped.nameKey(null), "");
});

test("the foal's pedigree puts the stallion on top and the mare below", () => {
  const foal = ped.foalPedigree({ name: "Stallion", pedigree: { s: "Sire A", ds: "Damsire B" } }, { name: "Mare", pedigree: { s: "Sire C" } });
  assert.deepEqual(foal, { s: "Stallion", d: "Mare", ss: "Sire A", sds: "Damsire B", ds: "Sire C" });
});

test("unrelated parents: no inbreeding", () => {
  const foal = ped.foalPedigree({ name: "A", pedigree: { s: "B", d: "C" } }, { name: "D", pedigree: { s: "E", d: "F" } });
  assert.equal(ped.inbreedingCoefficient(foal), 0);
  assert.deepEqual(ped.repeatedAncestors(foal), []);
});

test("half-sibling parents (same sire): 12.5%, shown as 2×2", () => {
  const foal = ped.foalPedigree({ name: "Colt", pedigree: { s: "Big Sire", d: "Mare One" } }, { name: "Filly", pedigree: { s: "Big Sire (USA)", d: "Mare Two" } });
  close(ped.inbreedingCoefficient(foal), 0.125);
  const [shared] = ped.repeatedAncestors(foal);
  assert.equal(shared.notation, "2×2");
  assert.equal(shared.bothSides, true);
});

test("full-sibling parents: 25%; their shared parents are listed and their own parents marked as coming through them", () => {
  const sib = { s: "Father", d: "Mother", ss: "Grandsire", sd: "Granddam" };
  const foal = ped.foalPedigree({ name: "Brother", pedigree: sib }, { name: "Sister", pedigree: sib });
  close(ped.inbreedingCoefficient(foal), 0.25);
  const list = ped.repeatedAncestors(foal);
  const father = list.find((a) => a.name === "Father");
  const grandsire = list.find((a) => a.name === "Grandsire");
  assert.equal(father.notation, "2×2");
  assert.equal(father.through, false);
  assert.equal(grandsire.notation, "3×3");
  assert.equal(grandsire.through, true, "Grandsire only appears through Father");
  assert.ok(list.indexOf(father) < list.indexOf(grandsire));
});

test("a 3×3 ancestor gives 3.125%; 4×4 gives 0.78125%; they add up", () => {
  // X sits at sss (3rd generation on the sire's side) and dds (3rd on the dam's side).
  const foal = ped.foalPedigree({ name: "S", pedigree: { s: "A", ss: "X" } }, { name: "M", pedigree: { d: "B", ds: "X" } });
  close(ped.inbreedingCoefficient(foal), 1 / 32);
  assert.equal(ped.repeatedAncestors(foal)[0].notation, "3×3");
  const deeper = ped.foalPedigree({ name: "S", pedigree: { s: "A", ss: "C", sss: "Z" } }, { name: "M", pedigree: { d: "B", dd: "D", ddd: "Z" } });
  close(ped.inbreedingCoefficient(deeper), 1 / 128);
  const both = ped.foalPedigree({ name: "S", pedigree: { s: "A", ss: "X", d: "E", dd: "Z" } }, { name: "M", pedigree: { d: "B", ds: "X", s: "F", sd: "Z" } });
  close(ped.inbreedingCoefficient(both), 1 / 32 + 1 / 32);
});

test("the stallion appearing in the mare's pedigree (father × daughter) is 25%", () => {
  const foal = ped.foalPedigree({ name: "Big Sire", pedigree: { s: "Old Sire", d: "Old Dam" } }, { name: "His Daughter", pedigree: { s: "Big Sire", d: "Other Mare" } });
  close(ped.inbreedingCoefficient(foal), 0.25);
  assert.equal(ped.repeatedAncestors(foal)[0].notation, "1×2");
});

test("bad data (a horse listed as its own ancestor) doesn't hang or crash", () => {
  const foal = ped.foalPedigree({ name: "Loop", pedigree: { s: "Loop", ss: "Loop" } }, { name: "Mare", pedigree: {} });
  const f = ped.inbreedingCoefficient(foal);
  assert.ok(Number.isFinite(f) && f >= 0 && f < 1);
});

test("sire line and completeness", () => {
  assert.deepEqual(ped.sireLine({ s: "A", ss: "B", sss: "C", d: "X" }), ["A", "B", "C"]);
  const c = ped.completeness({ s: "A", d: "B", ss: "C" });
  assert.equal(c.named, 3);
  assert.equal(c.possible, 46, "5 generations on the sire's side (31 names), 4 on the dam's (15)");
});

test("genetics: two carriers of a recessive condition is a danger (25%)", () => {
  const [g] = gen.geneticsCheck({ GBED: 1 }, { GBED: 1 });
  assert.equal(g.level, "danger");
  close(g.chance, 0.25);
  assert.match(g.message, /25%/);
});

test("genetics: one carrier and one clear horse can't make an affected foal", () => {
  const [g] = gen.geneticsCheck({ HERDA: 1 }, { HERDA: 0 });
  assert.equal(g.level, "warn");
  assert.equal(g.chance, 0);
});

test("genetics: a carrier stallion with an untested mare asks for a test", () => {
  const [g] = gen.geneticsCheck({ LWO: 1 }, {});
  assert.equal(g.level, "test");
  assert.match(g.message, /Test the mare/);
});

test("genetics: dominant conditions (one copy is enough)", () => {
  const [hypp] = gen.geneticsCheck({ HYPP: 1 }, { HYPP: 0 });
  assert.equal(hypp.level, "danger");
  close(hypp.chance, 0.5);
  const [clear] = gen.geneticsCheck({ PSSM1: 0 }, { PSSM1: 0 });
  assert.equal(clear.level, "clear");
});

test("genetics: unknown tests and values are dropped; results are written like a lab's", () => {
  assert.deepEqual(gen.cleanGenetics({ GBED: 1, FAKE: 1, HERDA: 3, HYPP: "1" }), { GBED: 1 });
  assert.equal(gen.geneticResult("GBED", 1), "N/GBED");
  assert.equal(gen.geneticResult("HERDA", 0), "N/N");
  assert.deepEqual(gen.geneticsCheck({}, {}), []);
});
