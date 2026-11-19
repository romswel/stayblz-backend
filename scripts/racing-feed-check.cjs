#!/usr/bin/env node
/**
 * Dry run of a racing data file, entirely offline: builds the API (npm run build first), creates a throwaway
 * in-memory database with every migration (PGlite), imports the file as drafts with a test admin, and prints what
 * would change. Nothing is sent anywhere and no real database is touched.
 *
 *   npm run racing:check -- data/horse-racing/equibase-full-2026-11-18.json [--publish] [--json]
 *
 * --publish also imports as published (to see alerts/workouts behave); --json prints the full result.
 */
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "offline-check";
process.env.NODE_ENV = "test";
process.env.RACING_FEED_DEBUG = "1";
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: npm run racing:check -- <file.json> [--publish] [--json]");
    process.exit(2);
  }
  const { supabase } = require("../dist/lib/supabase");
  const { cardsFromFile, importCards } = require("../dist/lib/racingFeed/importCards");
  const { racingAlertsSettled } = require("../dist/lib/racingAlerts");
  const { installDatabase } = require("../tests/support/pgrest.cjs");

  const started = Date.now();
  const data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const parsed = cardsFromFile(data);
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exit(1);
  }
  const database = await installDatabase(supabase);
  const admin = "00000000-0000-4000-8000-0000000000ad";
  await database.db.query("insert into auth.users(id,email) values($1,'feed-check@example.test')", [admin]);
  await database.db.query("select public.ensure_account($1)", [admin]);
  await database.db.query("select public.set_platform_role('feed-check@example.test','admin')");

  const results = await importCards(admin, parsed.cards, args.includes("--publish"));
  await racingAlertsSettled();
  const again = await importCards(admin, parsed.cards, args.includes("--publish"));
  const count = async (sql) => Number((await database.db.query(sql)).rows[0].n);
  const totals = {
    tracks: await count("select count(*) n from racing_tracks"),
    raceDays: await count("select count(*) n from racing_days"),
    races: await count("select count(*) n from racing_races"),
    officialRaces: await count("select count(*) n from racing_races where status = 'official'"),
    runners: await count("select count(*) n from racing_runners"),
    scratched: await count("select count(*) n from racing_runners where scratched"),
    horses: await count("select count(*) n from racing_horses"),
    horsesWithProviderId: await count("select count(*) n from racing_horses where source_ref is not null"),
    people: await count("select count(*) n from racing_people"),
    earlierStarts: await count("select count(*) n from racing_horse_history"),
    workouts: await count("select count(*) n from racing_workouts"),
    publishedDays: await count("select count(*) n from racing_days where status = 'published'"),
  };
  await database.close();

  if (args.includes("--json")) {
    console.log(JSON.stringify({ format: parsed.format, results, totals }, null, 2));
    return;
  }
  console.log(`File: ${file}  (format: ${parsed.format}, ${parsed.cards.length} cards${parsed.unplacedHorses ? `, ${parsed.unplacedHorses} horses not on any card` : ""})`);
  for (const r of results)
    console.log(
      r.ok
        ? `  ✔ ${r.track.padEnd(5)} ${r.date}  ${r.races} races, ${r.runners} runners (${r.officialRaces} official), ${r.history} earlier starts, ${r.workouts} workouts, skipped ${r.skipped}`
        : `  ✖ ${r.track.padEnd(5)} ${r.date}  ${r.error}${r.detail ? ` (${r.detail})` : ""}`,
    );
  const failed = results.filter((r) => !r.ok).length;
  const changedOnRepeat = again.reduce((n, r) => n + (r.horsesCreated ?? 0) + (r.peopleCreated ?? 0), 0);
  console.log("Totals in the database:", totals);
  console.log(`Importing the same file again created ${changedOnRepeat} new horses/people (should be 0).`);
  console.log(`${failed ? `${failed} card(s) failed` : "All cards imported"} in ${((Date.now() - started) / 1000).toFixed(1)} s. Nothing left this computer.`);
  process.exit(failed ? 1 : 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
