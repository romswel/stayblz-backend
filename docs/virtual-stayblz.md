# Virtual Stayblz

Horses someone tracks **without owning them**, such as rivals, prospects and sale candidates, together with their own records about each horse. There are two kinds of list:

| List | Who sees it | API | Row key |
|---|---|---|---|
| Personal (My racing → Virtual Stayblz) | Only the account | `/api/my-racing/virtual` (`requireAuth`) | `virtual_horses.user_id` |
| Stable (Stable workspace → Virtual Stayblz) | Every member of the stable | `/api/workspace/virtual` (`requireAuth` + `requireStable`, `X-Stayblz-Stable` header) | `virtual_horses.stable_id` |

Both lists use the same router, `virtualRouter(mode)` in `src/routes/virtualStayblz.ts`. Every query goes through `scoped()`, which adds the `user_id` or `stable_id` filter, so one list can't read or change another. The table's check constraint requires exactly one of the two to be set.

## Tables (migration `202611200001_virtual_stayblz.sql`)

- **`virtual_horses`**
  - `source` is `community` (an `owner_horses` row), `racing` (a `racing_horses` row) or `manual`.
  - Links are `on delete set null`. When a horse is added, its name, pedigree, trainer, owner name and location are copied, so the entry stays readable if the source goes away. Linked horses keep the copied details; only `notes` can be edited. Manual horses can be edited in full.
  - A partial unique index allows each linked horse once per list. A duplicate add returns 409 `already_added`.
- **`virtual_horse_entries`**
  - `kind` is `workout`, `race`, `sale` or `note`, each with its own fields (see `virtualEntryInput` in `src/lib/virtualInput.ts`).
  - Fields that don't belong to the kind are cleared.
  - Sale `result` is `entered`, `sold`, `rna`, `withdrawn` or `private`; `amount_cents` holds the price or earnings.
- **`virtual_horse_entry_counts`**: a view with counts per kind and the last entry date, used for the list.
- **`community_public_horses(...)`**: returns, as jsonb, the community horses every signed-in member can see. That means the horse's visibility is `members`, or it is `inherit` and the owner's default is members. The owner must be active, and the viewer's own horses are excluded. It backs `GET /api/community/public-horses` (the Public horses tab), which takes the filters `q` (name contains), `breed` (exact, any case), `sex`, `status`, `foaledFrom`/`foaledTo` (years) and `raced=1` (has at least one race record). Invalid filters return 400.
- **`community_public_horse_breeds(viewer)`**: the breeds among those horses (up to 40, most common first), served by `GET /api/community/public-horses/breeds` for the breed filter.

RLS is on for all of these, browser roles have no grants, and everything goes through the service role.

## Rules

- **Live data is never copied.** `GET /:id` reads it per request:
  - Community horses go through `loadCommunityHorse(viewer, id)` (`src/lib/communityHorses.ts`), the same check as the profile page. A teammate who can't see a followers-only horse gets only the copied details plus the team's entries.
  - Racing horses use the public `racing_horse` RPC.
  - When nothing live is available, `liveUnavailable: true` is returned.
- **Adding a community horse** requires the adder to be able to see it now, and you can't add your own horse.
- **Stable permissions:**
  - Any member can add horses and log entries.
  - A horse can be edited or removed by whoever added it, or by the stable's owner or a manager.
  - An entry can be edited or removed by its author, or by the stable's owner or a manager.
- **Owners aren't notified** when someone tracks their horse.
- **Limits:** 300 horses per list and 2,000 entries per horse, checked in the route.

## Race data: Racing horses, linked horses, alerts (migration `202611240001_virtual_racing_horses.sql`)

**United States and Canada only.** Every FormFav read is limited to US/Canada: meetings, races, the index, runner search and runner stats (`isNorthAmerica`), and jockey/trainer/track stats (only people and tracks in the US/Canada index). Only US/Canada horses can be tracked: race-data horses come from the index, and `source: "racing"` needs a US/USA/CA/CAN horse (400 `not_north_america`). Horses tracked before this rule stay. The frontend's "+ Add horse" dialog searches US and Canada race data instead of the racing feed.

Race data is FormFav's US/Canada race cards, through the A–Z index (`src/lib/formFavIndex.ts`, today−29 … +2, refreshed every 30 min while the server is awake). The UI never names FormFav in a tab, only in the credit line.

- **Racing horses tab:** `GET /racing-horses?offset&limit&q&codes&countries&tracking=1`.
  - Horses from the index, most followed first, then A–Z. Each carries `followers` and `trackingId` (this list's horse, or null).
  - `tracking=1` keeps only this list's horses, plus `noRecentRuns` ones that have no runs in the window right now.
  - Shares the per-person 60/min FormFav limit (`formFavAllowed` in `src/lib/formFav.ts`).
- **Added from Racing horses:** `POST / {source:'formfav', formfavName, formfavCode}`.
  - The horse shows in that tab (Tracking only) and in `GET /`, which carries `race` (index numbers: starts, wins, places, last start, next entry, trainer; null outside the window) and `racingLimit`. The app puts these horses in their own "Racing horses" section of My tracked horses, under the list's own horses.
  - It has its own 300-horse allowance.
  - Details can't be edited, and it can't be unlinked, only removed.
- **Linking a hand-typed horse:** `POST /:id/formfav {name, code}` (409 `already_linked` / `already_added`). Unlink with `POST /:id/formfav/remove`.
- **Owned horses:** `POST /api/community/horses/:id/formfav` links one, and each race-data horse can be claimed by one owner only (`formfav_key` globally unique, 409 `formfav_claimed`). Also `…/formfav/remove` and `…/formfav/alerts {on}`.
- **Matching:** a race-data horse is known by name + code only. `formfav_key` = `<code>|<folded name>` is written by the API (`idx.horseKey`), and everything matches on it.
- **While linked:**
  - Trainer, sire, dam, sex, foaled year and breed come from race data. `src/lib/formFavSync.ts` takes them from the index, the race card of a new entry (one cached call) and runner search. Routes keep these columns as stored.
  - Every final result becomes a log row with `formfav_ref` (one per race start). A hand-written race row of the same day and track gets the ref instead of a duplicate. Those rows take notes only (owned records: notes and earnings) and can't be removed until the horse is unlinked.
  - Unlinking (`formfav_unlink`) keeps all values and clears the refs.
- **Alerts:** `syncFormFav()` runs after every index refresh (`startFormFavSync` in `src/index.ts`).
  - **Events:** entered (first sighting, `formfav_entry_seen`), jockey/driver or trainer change (`race_change`, names compared ignoring dots and case), scratched / race abandoned (from yesterday on), result (final, last 2 days).
  - **Who:** `formfav_notify` sends to list owners, every stable member and linked-horse owners. Each person gets one alert per event, minus mutes (`virtual_horse_mutes`, `POST /:id/alerts {on}`), the owner's `formfav_alerts`, `racing_preferences` (`race_change` follows the entries switch) and events from before the link.
  - Push goes through `groupedPushes` / `pushSaved` (`src/lib/racingAlerts.ts`).
- **Follower counts:** distinct people, from the view `virtual_horse_followers` (personal-list owner, or every active member of the stable).
  - `formfav_follower_counts()` feeds Racing horses (cached 60 s).
  - `community_public_horses_v2` orders Public horses by it. Its cursor is `{f, name, id}`, and each record has `followers`.
  - The old `community_public_horses` stays for the backend that is live during the release; drop it later.

## Release order

Apply the migration first, then deploy the backend, then the frontend. The backend's Virtual Stayblz routes and `/api/community/public-horses` return 503 until the migration exists. All other routes are unaffected. `202611240001_virtual_racing_horses.sql` must be applied before the backend that uses it: owned-horse reads select the new columns.

Tests: `tests/virtual_stayblz.test.cjs` and `tests/formfav_sync.test.cjs` (PGlite with every migration, fake FormFav).
