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

## Release order

Apply the migration first, then deploy the backend, then the frontend. The backend's Virtual Stayblz routes and `/api/community/public-horses` return 503 until the migration exists. All other routes are unaffected.

Tests: `tests/virtual_stayblz.test.cjs` (PGlite with every migration).
