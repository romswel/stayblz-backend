#!/usr/bin/env node
/**
 * Pull racing data from The Racing API (docs/racing-data-feed.md) from the command line.
 *
 *   npm run racing:pull -- --dry [--date YYYY-MM-DD] [--days N] [--histories N]
 *       Real API, throwaway in-memory database (every migration, PGlite): shows what an import would do. Nothing is saved.
 *   npm run racing:pull -- --yes [--date YYYY-MM-DD] [--days N] [--histories N]
 *       Real API into the database in .env (SUPABASE_URL / SUPABASE_SECRET_KEY — production!). Imports are published
 *       (The Racing API's terms allow websites) and followers are alerted, exactly like the server's schedule.
 *
 * --date: the last day to pull (default: today on British racing's clock); --days: how many days back from it (default 1,
 * up to 31); --histories: afterwards, read earlier starts for up to N horses running around today (default 0).
 * --file <path>: instead, import a racing data file (e.g. the co-dev's collected Equibase files) — always as drafts.
 * Needs RACING_API_USERNAME / RACING_API_PASSWORD in .env (not for --file). Never prints the login.
 */
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const dry = flag("dry");
if (!dry && !flag("yes")) {
  console.error("Add --dry (in-memory database) or --yes (writes to the database in .env).");
  process.exit(2);
}
if (dry) {
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SECRET_KEY = "offline-check";
  process.env.NODE_ENV = "test";
  process.env.RACING_API_IN_TESTS = "1"; // the real API, with the in-memory database
  process.env.RACING_FEED_DEBUG = "1";
}
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env") });

async function main() {
  const { supabase } = require("../dist/lib/supabase");
  const { racingApiLogin } = require("../dist/lib/racingFeed/theRacingApi");
  const { pullDay, pullHistories, racingToday, shiftISO } = require("../dist/lib/racingFeed/pull");
  const { racingAlertsSettled } = require("../dist/lib/racingAlerts");
  const file = value("file", "");
  if (!file && !racingApiLogin()) {
    console.error("RACING_API_USERNAME / RACING_API_PASSWORD aren't set in .env.");
    process.exit(1);
  }
  const last = value("date", racingToday());
  const days = Math.min(Math.max(Number(value("days", "1")) || 1, 1), 31);
  const histories = Math.min(Math.max(Number(value("histories", "0")) || 0, 0), 500);
  let database;
  if (dry) {
    database = await require("../tests/support/pgrest.cjs").installDatabase(supabase);
  } else {
    console.log(`Writing to ${new URL(process.env.SUPABASE_URL).host}`);
  }
  const started = Date.now();
  if (file) {
    const { cardsFromFile, importCards } = require("../dist/lib/racingFeed/importCards");
    const parsed = cardsFromFile(JSON.parse(require("node:fs").readFileSync(file, "utf8")));
    if ("error" in parsed) throw new Error(parsed.error);
    const results = await importCards(null, parsed.cards, false);
    for (const r of results)
      console.log(`${r.ok ? "✓" : "✗"} ${r.track} ${r.date}: ${r.ok ? `${r.races} races, ${r.runners} runners, ${r.history} earlier starts, ${r.workouts} workouts · draft` : r.error}`);
  }
  for (let i = file ? -1 : days - 1; i >= 0; i--) {
    const date = shiftISO(last, -i);
    const day = await pullDay(date, null);
    const failed = day.results.filter((r) => !r.ok);
    console.log(
      `${date}: ${day.imported}/${day.cards} tracks, ${day.races} races, ${day.runners} runners, ${day.officialRaces} results` +
        (day.published ? ", published" : ", drafts") + (failed.length ? `, ${failed.length} failed` : ""),
    );
    for (const f of failed) console.log(`   ✗ ${f.track} ${f.date}: ${f.error}${f.detail ? ` (${f.detail})` : ""}`);
  }
  if (histories && !file) {
    const h = await pullHistories(histories);
    console.log(`Earlier starts: ${h.starts} for ${h.horses} horses (${h.due} were due)`);
  }
  await racingAlertsSettled();
  if (dry) {
    const count = async (sql) => Number((await database.db.query(sql)).rows[0].n);
    console.log({
      tracks: await count("select count(*) n from racing_tracks"),
      publishedDays: await count("select count(*) n from racing_days where status = 'published'"),
      races: await count("select count(*) n from racing_races"),
      officialRaces: await count("select count(*) n from racing_races where status = 'official'"),
      runners: await count("select count(*) n from racing_runners"),
      scratched: await count("select count(*) n from racing_runners where scratched"),
      horses: await count("select count(*) n from racing_horses"),
      people: await count("select count(*) n from racing_people"),
      earlierStarts: await count("select count(*) n from racing_horse_history"),
    });
    const sample = await database.db.query(
      "select t.code, t.name, t.country, r.race_number, r.post_time, r.name race, r.status, r.purse, r.currency, r.track_condition, r.conditions from racing_races r join racing_days d on d.id = r.day_id join racing_tracks t on t.id = d.track_id order by d.race_date desc, t.code, r.race_number limit 3",
    );
    console.log(sample.rows);
    await database.close();
  }
  console.log(`Done in ${Math.round((Date.now() - started) / 1000)} s.`);
}
main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
