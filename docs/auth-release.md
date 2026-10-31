# Account rollout

Production authentication uses Supabase Auth, not the local demo password. Normal signup stores only first name, last name, country, and self-described racing role in the provider's account metadata. Passwords are handled by Supabase. Self-described roles never assign permissions: the backend grants membership by default and trusts only server-managed `app_metadata.stayblz_role` for the superadmin.

New members can edit their own profile and read published racing records. The current legacy stable tables have no tenant ownership model, so shared inventory, messages, feed, dashboard, wagering and legacy mock racing APIs remain superadmin-only. No existing stable rows are migrated or deleted. The existing username `superadmin` remains an alias for the authorized, verified admin identity. A production demo-password fallback is deliberately disabled.

## Required provider configuration

1. Configure custom SMTP in Supabase Authentication Email/SMTP. Verify a domain with your email provider and add its DNS records. Store its credentials in Supabase, never in this repository or chat.
2. Keep Confirm Email enabled. Signup checks provider settings and refuses to create a session when email verification is disabled or cannot be checked.
3. Set the provider Site URL to your production frontend origin. Add the exact `/auth/confirm` and `/auth/confirm?recovery=1` redirect URLs. The default confirmation template can stay enabled; the app also supports token-hash confirmation templates.
4. In the backend deployment, set `NODE_ENV=production`, `FRONTEND_URL` to the exact production frontend origin, and `AUTH_SITE_URL` to that origin. Existing server-only Supabase credentials remain on the server. `SUPERADMIN_EMAIL` is an optional exact alias mapping.
5. Keep the Vercel `/api` rewrite pointed to the deployed backend. Production browser API calls use this same-origin proxy instead of cross-site third-party cookies.

## Preserve the admin

Run `node scripts/bootstrap-admin.cjs <authorized-email>` first. This is a read-only dry run. After SMTP and redirects are ready, `--apply` sends an invitation for a missing account or preserves an existing account and assigns the server-owned admin role. It never accepts a password on the command line, deletes accounts, auto-confirms email, or prints verification links/tokens.

The invite opens `/auth/confirm`, verifies email ownership, and asks the admin to set a strong password. Shared stable access is blocked until that setup is complete. The old public demo password is not copied to production. Test the admin login, restore, logout, and its stable workspace before calling a rollout complete.

## Session behavior

Access and rotating refresh credentials are HttpOnly, SameSite=Lax cookies with Secure enabled on production/Render. Access-cookie lifetime is capped at one hour; the refresh cookie expires after 30 days (provider policy may be shorter). Browser JS does not store production tokens. The provider verifies each authenticated request; it never uses browser-supplied profile roles. Logout clears the browser cookies and requests provider session revocation. Existing access JWTs on other devices may remain valid until provider expiry; instant cross-device JWT revocation is not claimed.

Confirm credentials are captured once before React mounts and stripped from the URL. Single-use confirmation is not retried automatically. Password reset changes the provider password using the verified session, clears local cookies, and returns to login. Signup, login, confirmation, email requests, password changes, and profile edits are rate limited; origin and JSON checks protect cookie-authenticated writes. App limits are process-local; Supabase provider limits remain active. Shared/distributed limits and CAPTCHA must be configured for a higher-volume launch.

## Validation and limits

Automated tests stub provider/database calls and cover verified/unverified users, cookie flags, permission injection, private-data denial, confirmation, refresh, profile persistence, form validation, URL cleanup, StrictMode, logo theme switching, and responsive layouts. These tests do not prove SMTP delivery, remote table/RLS setup, provider redirect configuration, real-device behavior, or production deployment.

The prepared public-racing migration is separate from user profile storage. Missing public data has no mock fallback. An unconfigured SMTP sender or missing admin invitation is a release blocker for switching the existing production admin to verified-account auth.
