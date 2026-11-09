# Account rollout

Production authentication uses Supabase Auth, not the local demo password. Passwords are handled by Supabase. Since 2026-11-09 roles and profiles live in the `accounts` table (see `docs/accounts-and-security.md`); sign-up details are copied there once. Self-described racing roles never assign permissions, and `app_metadata.stayblz_role` is no longer read.

New members can edit their own profile and read published racing records. The current legacy stable tables have no tenant ownership model, so shared inventory, messages, feed, dashboard, wagering and legacy mock racing APIs remain superadmin-only. No existing stable rows are migrated or deleted. The existing username `superadmin` remains an alias for the authorized, verified admin identity. A production demo-password fallback is deliberately disabled.

## Current local verification test

Verification testing uses the existing built-in Supabase email service, with no custom SMTP provider or sending domain. Keep email confirmation enabled and use only an authorized organization test address. No SMTP configuration is needed for that limited test. See `auth-email-testing.md` for local checks, rate limits, the opt-in helper, and the distinction between accepted email requests and observed delivery. The subsequent authorized code release does not change provider settings or remove sender restrictions.

## Later public rollout configuration

1. Configure custom SMTP in Supabase Authentication Email/SMTP. Verify a domain with your email provider and add its DNS records. Store its credentials in Supabase, never in this repository or chat.
2. Keep Confirm Email enabled. Signup checks provider settings and refuses to create a session when email verification is disabled or cannot be checked.
3. Set the provider Site URL to your production frontend origin. Add the exact `/auth/confirm` and `/auth/confirm?recovery=1` redirect URLs. The default confirmation template can stay enabled; the app also supports token-hash confirmation templates.
4. In the backend deployment, set `NODE_ENV=production`, `FRONTEND_URL` to the exact production frontend origin, and `AUTH_SITE_URL` to that origin. Existing server-only Supabase credentials remain on the server. `SUPERADMIN_EMAIL` is no longer used: sign-in is by email only.
5. Keep the Vercel `/api` rewrite pointed to the deployed backend. Production browser API calls use this same-origin proxy instead of cross-site third-party cookies.

## Preserve the admin

Admin roles are granted only in the Supabase SQL editor: `select public.set_platform_role('person@example.com', 'admin');` (or `'superadmin'`). The old `scripts/bootstrap-admin.cjs` and the shared `superadmin` username were removed on 2026-11-09.

The invite opens `/auth/confirm`, verifies email ownership, and asks the admin to set a strong password. Shared stable access is blocked until that setup is complete. The old public demo password is not copied to production. Test the admin login, restore, logout, and its stable workspace before calling a rollout complete.

## Session behavior

Access and rotating refresh credentials are HttpOnly, SameSite=Lax cookies with Secure enabled on production/Render. Access-cookie lifetime is capped at one hour; the refresh cookie expires after 30 days (provider policy may be shorter). Browser JS does not store production tokens. The provider verifies each authenticated request; it never uses browser-supplied profile roles. Logout clears the browser cookies and requests provider session revocation. Existing access JWTs on other devices may remain valid until provider expiry; instant cross-device JWT revocation is not claimed.

Confirm credentials are captured once before React mounts and stripped from the URL. Single-use confirmation is not retried automatically. Password reset changes the provider password using the verified session, clears local cookies, and returns to login. Signup, login, confirmation, email requests, password changes, and profile edits are rate limited; origin and JSON checks protect cookie-authenticated writes. App limits are process-local; Supabase provider limits remain active. Shared/distributed limits and CAPTCHA must be configured for a higher-volume launch.

## Validation and limits

Automated tests stub provider/database calls and cover verified/unverified users, cookie flags, permission injection, private-data denial, confirmation, refresh, profile persistence, form validation, URL cleanup, StrictMode, logo theme switching, and responsive layouts. These tests do not prove SMTP delivery, remote table/RLS setup, provider redirect configuration, real-device behavior, or production deployment.

The prepared public-racing migration is separate from user profile storage. Missing public data has no mock fallback. Public registration beyond authorized organization addresses needs an appropriate email provider. The current error-handling/design release preserves the existing verified-account authentication and admin identity; it does not complete public email delivery setup or the pending human recovery/login checks.
