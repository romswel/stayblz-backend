# Racing data feed — what's connected, rules, and how it works

Written 2026-11-19, updated the same day when the login turned out to be The Racing API's. For the Stayblz devs (and Claude).

## Where we are

- **The login the boss gave ("Equibase API") is a The Racing API login** (https://api.theracingapi.com, HTTP Basic,
  vendor names `RACING_API_USERNAME` / `RACING_API_PASSWORD`; in `stayblz-backend/.env`, never commit or print them).
  Checked 2026-11-19: accepted, **Pro plan** (Pro racecards, results, horse results, sire/dam/damsire searches), but
  **no North America add-on** (`/v1/north-america/*` → 401 "North American racing add-on required"). The add-on was
  £49.99/month and the vendor's FAQ says regional add-ons are "currently unavailable to new subscribers".
  Coverage seen: Great Britain, Ireland, France, Hong Kong (≈6–7 tracks and 50 races a day in November).
- **Nothing connects to Equibase itself.** Equibase has no public API; a feed would come with its own contract, address
  and format. Nobody has shown us one.
- **The Racing API is wired in (2026-11-19):** `lib/racingFeed/theRacingApi.ts` (client + converters),
  `lib/racingFeed/pull.ts` (pull a day, earlier starts, background jobs, the schedule), Publishing → **Data feed**
  (connection status, North America yes/no, Pull now, progress), `npm run racing:pull` (command line, `--dry` = real API
  into an in-memory database). Its cards publish (its terms allow "applications, websites"); followers get alerts.
- **Following + alerts** (`202611190004_racing_follows.sql`): horse, family (sire, dam, same-dam siblings, foals),
  jockey/trainer/owner. Alerts for entries, scratches/non-runners, official results and workouts, one per person per
  runner, never for old history.
- **Importer** (`202611190005_racing_feed.sql`): one card format (`lib/racingFeed/card.ts`) → SQL `racing_feed_import`
  (atomic per track-day). Horses, people, tracks and races carry the provider's id (`source` + `source_ref`), so
  re-imports update in place; a track never takes another track's code (KEMP → KEMP2); a results-only update never wipes
  what the racecard said; a non-runner without its number scratches the runner already on the card.
  Earlier starts → `racing_horse_history` (date, track, race name, type, distance, surface, field size, finish, odds,
  rider). Automatic imports pass no actor.
- **The co-dev's collected Equibase files** (backend commit bbc71b4, `data/horse-racing/`, 14 MB, one day, 9 US tracks,
  made with the Apify actor "jungle_synthesizer/equibase-us-horse-racing-scraper", i.e. scraped from equibase.com):
  `lib/racingFeed/apifyEquibase.ts` reads them; `npm run racing:check -- <file>` dry-runs them. They import as **drafts**
  and can't be published until the owner lists `equibase` in `RACING_FEED_LICENSED`. The user asked to keep the files
  (2026-11-19).

## What gets kept, what never does

Kept: race facts (track, date, post time in the track's own clock, race name, kind, class/pattern, distance, going,
purse), runners (number, draw, horse, jockey, trainer, owner, weight, headgear), results (finishing order, starting
price as odds-to-1, prize money, winning time), tote dividends, non-runners, pedigree (sire, dam, dam's sire,
breeder, foaling year), each horse's earlier starts.

Never kept: provider ratings (RPR, Topspeed, "performance"/"speed" ratings, Equibase speed figures), race comments,
spotlights, tips, verdicts, bookmaker odds, silks images, links back to the source. They belong to other companies.

## How the pulls run

- **Schedule** (`startRacingSchedule`, started in `index.ts` when the login is set; `RACING_FEED_AUTO=off` stops it):
  every 20 minutes while the server is awake — today (cards, changes, results), the 120 horses most due for earlier
  starts; tomorrow every 3 hours; yesterday once a day. Render's free plan sleeps, so pulls happen when the site is used.
  For guaranteed updates, keep the backend awake or move to a paid instance.
- **Pull now** (`POST /api/admin/racing/feed/pull {date, days ≤31, histories ≤300}`, admin+, audited `racing.feed_pull`):
  one job at a time in the background; `GET /api/admin/racing/feed` shows progress and the last jobs (memory only).
- **Command line:** `npm run racing:pull -- --dry --date 2026-11-19 --days 2 --histories 40` (offline database) or
  `-- --yes …` (writes to the database in `.env`, i.e. production).
- Limits: ≤4 requests a second (the plan allows 5), retries on 429/5xx, 60 s timeout per call.

## Rules

- **No scraping equibase.com.** Its Terms of Use ban robots/scrapers and limit reuse to personal, non-commercial use.
  Collected Equibase data stays a draft unless the owner confirms a licence (`RACING_FEED_LICENSED`).
- **The Racing API's terms:** data is "for use in the creation of applications, websites, and data analysis"; resale of
  the data without permission is forbidden; not for betting operators. Showing it on Stayblz is fine; selling the raw
  data (downloads, exports, an API) is not without the vendor's permission. Check with them before charging for pages
  that are mostly their data.
- **No copied photos.** Use photos owners upload, or photos a contract explicitly licenses.
- Independent identity still holds for brand, wording, product names and page design (CLAUDE.md rule 1). A data
  credit ("Data: The Racing API") is shown on race cards.

## Next

1. Add `RACING_API_USERNAME` / `RACING_API_PASSWORD` on Render so the schedule runs in production.
2. US/Canada: The Racing API's North America add-on (if the vendor still sells it) or a real Equibase data contract.
   The Equibase adapter would be `lib/racingFeed/equibase.ts` → the same cards → `importCards`.
3. Link `owner_horses` and Marketplace listings to racing records (auto-fill pedigree + live race record).
4. Paid full horse profile / family report once billing exists — mindful of the resale clause above.
