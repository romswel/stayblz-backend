# Production configuration

Where each Stayblz setting lives, and what it should be. Values are placeholders; real keys live only
in the hosting dashboards and local `.env` files (never in git, notes or chat).

Website: **https://stayblz-app.com** (Vercel). API: `https://stayblz-backend.onrender.com`, reached by the
browser only through the same-origin proxy `https://stayblz-app.com/api/*` (`vercel.json`).

## API environment (Render → Environment)

| Variable | Production | Local `.env` | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | `production` | `development` | Render also sets `RENDER=true`; the app treats either as production (Secure cookies, HSTS, demo login off). |
| `FRONTEND_URL` | `https://stayblz-app.com` | `http://localhost:5173` | Exact origins, comma-separated. Only these may send sign-in and other write requests. |
| `AUTH_SITE_URL` | `https://stayblz-app.com` | `http://localhost:5173` | Where email redirects point. Defaults to the first `FRONTEND_URL`. |
| `SUPABASE_URL` | production project URL | a **development** project URL | Local `.env` currently points at production; see "Risks". |
| `SUPABASE_SECRET_KEY` | secret key | secret key | Server only. |
| `SUPABASE_PUBLISHABLE_KEY` | publishable key | optional | Used for user-facing auth calls instead of the secret key. |
| `REQUIRE_STAFF_MFA` | `true` once staff have 2-step login | `false` | |
| `API_RATE_LIMIT_PER_MINUTE` | unset (1200) | unset | |
| `ENABLE_PUBLIC_DEMO`, `DEMO_ADMIN_PASSWORD` | **unset** | unset | Ignored on Render anyway. |
| `DATABASE_URL` | **unset** | release tooling only | Not read by the API. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET_PRIVATE`, `R2_BUCKET_PUBLIC` | Suprah's values (not yet on Render) | copied from `suprah-backend/.env` | Cloudflare R2, shared with Suprah; Stayblz only uses keys under `stayblz/`. Unset = R2 off. See `r2-storage.md`. |
| `R2_PUBLIC_URL` | unset until Suprah's live public address is known | empty | Suprah's local r2.dev value no longer resolves (2026-11-15). Only public-bucket links need it. |
| `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY`, `PUSH_CONTACT` | **on Render since 2026-11-18** (a device got a push that day) — never change them casually | `npm run push:keys -- --write` adds a pair to `.env` | Web Push ("alerts when Stayblz is closed", `lib/push.ts`). Unset = push off; settings say so and alerts still work while Stayblz is open. Changing keys later means every device turns alerts on again. Contact defaults to `mailto:support@stayblz-app.com`. |
| `RACING_API_USERNAME`, `RACING_API_PASSWORD` | **add on Render** (the login the boss gave; it is The Racing API's, not Equibase's) | in local `.env` since 2026-11-19 | Turns on The Racing API: automatic pulls every 20 min while awake + Publishing → Data feed → Pull now (`lib/racingFeed/pull.ts`). Pro plan; no North America add-on. Never print or commit. |
| `RACING_API_REGIONS` | unset (every region on the plan) | unset | Optional comma list of provider regions to import (e.g. `gb,ire,fr,hk`). |
| `RACING_FEED_AUTO` | unset | unset | `off` stops the automatic pulls (manual pulls still work). |
| `RACING_FEED_LICENSED` | **unset** until the boss confirms a licence for the collected Equibase data | unset | Which *other* sources may be published: comma list (e.g. `equibase`) or `yes` for all (`lib/racingFeed/licence.ts`). The Racing API is allowed by its terms and needs nothing here. Unset = collected Equibase files import as drafts and every publish of them is refused. See `racing-data-feed.md`. |
| `PORT`, `RENDER`, `RENDER_GIT_COMMIT` | set by Render | — | |

Render service settings: Node 22.12 or newer; build `npm ci --include=dev && npm run build` (TypeScript is a
dev dependency, and npm skips those when `NODE_ENV=production`); start `npm start`; health check path `/api/health`.

## Website (Vercel → Project)

- Environment variables: none needed. `VITE_API_URL` is ignored by production builds; never add secrets to `VITE_*`.
- Build: framework Vite, build `npm run build`, output `dist`, Node 22.
- Domains: `stayblz-app.com` (primary) and `www.stayblz-app.com` → redirect to `stayblz-app.com` (308).
  `vercel.json` redirects the old `stayblz-frontend.vercel.app` address to `https://stayblz-app.com`.
- **`www` certificate (checked 2026-11-19: broken).** `www.stayblz-app.com` (CNAME → Vercel) is served the
  certificate for `stayblz-app.com` only, so every browser shows "Your connection is not private" on the `www`
  address, and because the main site sends HSTS with `includeSubDomains` there is no "proceed anyway". Fix in
  Vercel → Project → Settings → Domains → `www.stayblz-app.com`: if it says Invalid Configuration, set the DNS record
  it shows at Bluehost (CNAME `www` → the value Vercel gives); then use Refresh / re-issue, or remove `www` and add it
  again as "Redirect to stayblz-app.com". Check: `openssl s_client -connect www.stayblz-app.com:443 -servername
  www.stayblz-app.com` must list `DNS:www.stayblz-app.com` in Subject Alternative Name. Keep `includeSubDomains`.

## Supabase (Authentication)

- URL Configuration → Site URL `https://stayblz-app.com`; Redirect URLs `https://stayblz-app.com/auth/confirm`,
  `https://stayblz-app.com/auth/confirm?recovery=1`, `http://localhost:5173/auth/confirm`. Remove the old
  `stayblz-frontend.vercel.app` entries.
- Providers → Email: Confirm email on; Email OTP Expiration 3600 (the emailed links last that long).
- Emails → Templates: paste from `email-templates/` (see its README). Since 2026-11-19 every email is **link-only**
  (no 6-digit codes): paste the new templates before releasing that change.
- Emails → SMTP: Resend (`smtp.resend.com`), sender `no-reply@stayblz-app.com`, name `Stayblz`.
- Rate Limits: keep the defaults or lower; the API adds its own per-address limit on emails.

## Email domain (Resend + Bluehost DNS)

Records seen in public DNS on 2026-11-13: DKIM `resend._domainkey`, SPF and return-path MX on `send.`,
DMARC `p=none`. The Resend dashboard is the source of truth for "Verified". Once mail is flowing well,
move DMARC to `p=quarantine` and add a `rua=` report address. The bare domain has no MX record, so
mail sent to `@stayblz-app.com` addresses bounces; add one before using a support address.
