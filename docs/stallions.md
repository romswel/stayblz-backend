# Stayblz Stallions

Boss's brief: "a stallion showcase feature where people can list their stallions and people can inquire about breeding
to their stallions", "something like BloodHorse or Stallion eSearch", "enter the horse information and use AI to enhance
the profile". Built 2026-11-22 (local, not released yet). Migration: `migrations/202611220001_stallions.sql`.

## What it does

| Who | Where | What |
| --- | --- | --- |
| Anyone (no login) | `/stallions` | Directory: search (name, farm, town, sire), filters (breed, region, fee range, private fees, bookings, method, sire, ancestor in pedigree, has video, has runners in our data, saved), sorts (most saved = default, newest, fee, runners in our data, newest to stud, name). Featured first. |
| Anyone | `/stallions/:id` | Stallion page: gallery (viewer always closes: Close button, Escape, tap outside, phone Back), fee + terms + booking fee, availability, methods, where he stands, pedigree chart (4 gens), owner's race record + his record in Stayblz data, **offspring in Stayblz racing data**, genetics, fertility, documents, share. |
| Anyone | `/stallions/compare?ids=` | Up to 3 side by side (tray kept in this browser). |
| Anyone | `/stallions/mating` | Mating check: one stallion (`?stallion=`) in full, or the mare against every stallion. |
| Signed in | Save, Ask about a breeding | Request → owner's Stayblz Chat (stallion card under the message) + tracked request. |
| Signed in | `/stallions/manage`, `/manage/new`, `/manage/:id` | Owner: list/edit (draft or publish), views per day (30 days), saves, requests, feature (Billing). |
| Signed in | `/stallions/requests` | Received (status New/Talking/Booked/Declined/Closed + private note) and Sent (breeder sees the status, never the note). |
| Signed in | `/stallions/mares` | Saved mares (pedigree 3 gens + genetics) for checks and requests. |
| Admin+ | Stallion page | Hide (with a reason the owner sees; owner can't republish) / unhide, remove. Audited `stallion.*` in `account_events`. |

## Data honesty rules (keep them)

- Owner-entered facts (fee, record, highlights, genetics, fertility) are labelled "From the owner" / "as the owner states".
- Offspring, crosses and the linked record are **computed** from `racing_horses` + published official results
  (`racing_runners`) + feed history (`racing_horse_history`), and only for horses on public racing pages
  (`racing_horse_public`), so draft/unlicensed data (scraped Equibase files) never shows up, not even as a count.
- Offspring are matched by sire name (`stallion_key()`: lower case, single spaces, no "(IRE)" suffix). Two different
  horses with the same name would be merged; rare, but don't present it as certain identity.
- No ratings, nick grades or value predictions. The mating check is arithmetic: Wright's coefficient over the names
  given (missing names count as unrelated, so it's a floor), shared ancestors with generation notation, and
  single-gene inheritance for genetic tests. Coverage today: GB/IRE/FR/HK (no US/Canada yet) — `DATA_COVERAGE` in
  `components/stallions/OffspringPanel.tsx` says so on the page; update it when US data arrives.
- Thoroughbreds: live cover only (registry rule) — enforced in the API and the form.

## Code map

Backend: `routes/stallionsPublic.ts` (`/api/public/stallions`, optionalAuth), `routes/stallions.ts` (`/api/stallions`,
signed in), `routes/stallionFiles.ts` (uploads + media; same storage as Marketplace files: R2 when `R2_*` is set,
else the private Supabase bucket `marketplace-media`, keys under `stallions/<owner>/`), `lib/stallionInput.ts`,
`lib/stallionPedigree.ts` + `lib/stallionGenetics.ts` (pure, `tests/stallion_pedigree.test.cjs`),
`lib/stallionMating.ts`, `lib/stallionWriter.ts`. SQL functions: `stallions_search`, `stallions_facets`,
`stallion_profile`, `stallions_mine`, `stallion_offspring`, `stallion_cross`, `stallion_cross_counts`,
`stallion_known_parents` (pedigree auto-fill), `stallion_racing_lookup`, `stallion_inquiry`, `stallion_requests`,
`stallion_seen`. Tests: `tests/stallions.test.cjs`.

Frontend: `pages/Stallions.tsx` (lazy; signed-out = public header) → `components/stallions/*`; reuses the Marketplace
`MediaManager`/`DocumentManager` with `STALLION_MEDIA`; chat card = `ListingMessageCard` with `listing.kind = "stallion"`.
Spec: `tests/stallions.spec.ts`.

## Billing

- Products `stallion_feature_7` ($9.99) and `stallion_feature_30` ($29.99), effect `stallion_feature` (prices are
  placeholders matching Marketplace featuring; change them in Admin → Billing).
- Plan `stallion_showcase` ($25/month, feature `stallions.list`) stays **draft**. Listing is open to everyone until a
  superadmin makes that plan active **and** turns paywalls on; then owners need the plan (staff always can).

## Setup still needed for production

1. ~~Apply `202611220001_stallions.sql`~~ (applied with the v0.23 release, 2026-11-22).
2. Optional "Write a draft for me": `ANTHROPIC_API_KEY` on Render (model `claude-haiku-5-5`, well under a cent
   per draft; override with `STALLION_AI_MODEL`, e.g. `claude-opus-5-5` at about 2 cents). There's no usable free AI:
   Gemini's free tier allows only about 20 requests a day on its better models and Google may use the text, and
   Chrome's on-device AI only runs on strong desktop computers, not on phones. Without the key the form shows an
   "Under work" line instead of the button.
   Drafts use only the form's facts + Stayblz data; the owner edits before saving. 10 drafts per person per hour.
3. Photos/videos go to Supabase Storage until Render has `R2_*` (videos up to 50 MB there).
4. Boss decides: featuring prices (`stallion_feature_7` $9.99, `stallion_feature_30` $29.99 — placeholders copied from
   Marketplace featuring; Billing admin → Offers) and whether the $25/month Stallion Showcase plan goes on sale
   (draft = listing is free).
5. When US data arrives: update `DATA_COVERAGE` (frontend OffspringPanel.tsx) and the directory's "Under work" line
   (`components/stallions/UnderWork.tsx`).

## Not done yet

US/Canada offspring (needs US data), booking contracts/deposits through Billing, stallion season auctions,
progeny sales data / yearling values, alerts when a saved stallion changes his fee, link previews (OG tags) for
shared pages (the SPA can't set them per page).
