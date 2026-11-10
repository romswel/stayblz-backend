// Publishes (or refreshes) one Stayblz Update from a JSON file, for release notes.
// Usage: npm run build && node scripts/post-update.cjs path/to/update.json [--dry-run]
// Uses SUPABASE_URL + SUPABASE_SECRET_KEY from .env (never printed). Same checks as the
// admin editor (lib/updates.ts). An existing post with the same slug is edited in place,
// keeping its original publish date. Only run as part of an approved release.
const fs = require("node:fs");
const path = require("node:path");
const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scripts/post-update.cjs <update.json> [--dry-run]");
  process.exit(2);
}
const { updateInput } = require(path.join(__dirname, "../dist/lib/updateInput"));
const parsed = updateInput(JSON.parse(fs.readFileSync(file, "utf8")));
if ("error" in parsed) {
  console.error("Not posted: " + parsed.error);
  process.exit(1);
}
const value = parsed.value;
if (flag === "--dry-run") {
  console.log(`OK (dry run): "${value.title}" -> /updates/${value.slug} [${value.kind}, ${value.audience}, ${value.status}]`);
  process.exit(0);
}
(async () => {
  const { supabase } = require(path.join(__dirname, "../dist/lib/supabase"));
  const existing = await supabase.from("site_updates").select("id").eq("slug", value.slug).maybeSingle();
  if (existing.error) throw new Error("Could not read Updates (is migration 202611100003 applied?)");
  const { data, error } = await supabase.rpc("save_site_update", {
    p_actor: null,
    p_id: existing.data?.id ?? null,
    p_data: value,
  });
  if (error) throw new Error("Not posted: " + (error.message ?? "database error"));
  console.log(`${existing.data ? "Updated" : "Posted"}: "${data.title}" (${data.status}) -> /updates/${data.slug}`);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
