// Checks the Cloudflare R2 connection using the R2_* settings in .env (keys are never printed).
// Usage: npm run r2:check              read-only: proves the keys and buckets work, changes nothing
//        npm run r2:check -- --write   also saves, reads back and deletes one tiny text file
//                                      under stayblz/_checks/ in each bucket
// Stayblz shares Suprah's buckets; this script, like the app, can only touch keys under stayblz/.
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });
const { r2Storage } = require(path.join(__dirname, "../dist/lib/r2Storage"));

(async () => {
  const write = process.argv.includes("--write");
  const status = r2Storage.status();
  console.log(`Stayblz folder: ${status.folder}`);
  console.log(`Private bucket: ${status.private.bucket ?? "(not set)"}`);
  console.log(`Public bucket:  ${status.public.bucket ?? "(not set)"}  public URL ${status.public.publicUrl ? "set" : "not set"}`);
  for (const problem of status.problems) console.log(`  ! ${problem}`);

  const report = await r2Storage.check({ write });
  for (const bucket of ["private", "public"]) {
    const r = report[bucket];
    const steps = [
      `connected ${r.connected ? "yes" : "no"}`,
      ...(write && r.connected
        ? [`write ${r.wrote ? "ok" : "no"}`, `read back ${r.readBack ? "ok" : "no"}`, `deleted ${r.deleted ? "ok" : "no"}`]
        : []),
      ...(r.publicUrl !== undefined ? [`public link ${r.publicUrl ? "ok" : "no"}`] : []),
    ];
    console.log(`${r.ok ? "OK  " : "FAIL"} ${bucket}: ${steps.join(", ")}${r.error ? ` (${r.error})` : ""}`);
  }
  console.log(report.ok ? `R2 storage works${write ? "" : " (read-only check; add -- --write to test uploads)"}.` : "R2 storage is not working yet.");
  process.exit(report.ok ? 0 : 1);
})().catch((error) => {
  console.error("Check failed:", error?.code ?? error?.name ?? "error");
  process.exit(1);
});
