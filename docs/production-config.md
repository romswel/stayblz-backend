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
| `PORT`, `RENDER`, `RENDER_GIT_COMMIT` | set by Render | — | |

Render service settings: Node 22.12 or newer; build `npm ci --include=dev && npm run build` (TypeScript is a
dev dependency, and npm skips those when `NODE_ENV=production`); start `npm start`; health check path `/api/health`.

## Website (Vercel → Project)

- Environment variables: none needed. `VITE_API_URL` is ignored by production builds; never add secrets to `VITE_*`.
- Build: framework Vite, build `npm run build`, output `dist`, Node 22.
- Domains: `stayblz-app.com` (primary) and `www.stayblz-app.com` → redirect to `stayblz-app.com` (308).
  `vercel.json` redirects the old `stayblz-frontend.vercel.app` address to `https://stayblz-app.com`.

## Supabase (Authentication)

- URL Configuration → Site URL `https://stayblz-app.com`; Redirect URLs `https://stayblz-app.com/auth/confirm`,
  `https://stayblz-app.com/auth/confirm?recovery=1`, `http://localhost:5173/auth/confirm`. Remove the old
  `stayblz-frontend.vercel.app` entries.
- Providers → Email: Confirm email on; Email OTP Length 6; Email OTP Expiration 3600.
- Emails → Templates: paste from `email-templates/` (see its README).
- Emails → SMTP: Resend (`smtp.resend.com`), sender `no-reply@stayblz-app.com`, name `Stayblz`.
- Rate Limits: keep the defaults or lower; the API adds its own per-address limits on codes and emails.

## Email domain (Resend + Bluehost DNS)

Records seen in public DNS on 2026-11-13: DKIM `resend._domainkey`, SPF and return-path MX on `send.`,
DMARC `p=none`. The Resend dashboard is the source of truth for "Verified". Once mail is flowing well,
move DMARC to `p=quarantine` and add a `rua=` report address. The bare domain has no MX record, so
mail sent to `@stayblz-app.com` addresses bounces; add one before using a support address.
