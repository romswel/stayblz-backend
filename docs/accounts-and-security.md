# Accounts and security

Written 2026-11-09. This is the current model; older docs that mention `app_metadata.stayblz_role`,
`SUPERADMIN_EMAIL` or the `superadmin` username are out of date.

## Account model

| Layer | What it is | Who changes it |
| --- | --- | --- |
| Sign-in identity | `auth.users` (Supabase Auth): email, password, 2-step factors | The person; Supabase |
| Account | `public.accounts`: one row per identity, created automatically (trigger + `ensure_account()` fallback) | Backend through checked functions only |
| Platform role | `accounts.platform_role`: `customer` / `admin` / `superadmin` | **SQL editor only**: `public.set_platform_role(email, role)` |
| View as | `accounts.acting_role`: staff may use the site as a lower role | The person, via Profile |
| Status | `accounts.status`: `active` / `suspended` / `closed` | Superadmin via Administration (not other superadmins, not self) |
| Stable role | `stable_memberships.role`: `owner` / `manager` / `member` per stable | Stable owners/managers |
| Activity | `public.account_events`: append-only log (sign-ins, 2-step, role/status/view changes) | Backend inserts; nobody can edit or delete |

The API keeps reporting the customer role as `member` (`user.role`) for older clients; `user.platformRole`
is the real role and `user.role` is the role in use after "View as".

What each role can do today:

- **Customer**: racing pages, My Racing, personal messages, create/join stables.
- **Admin**: everything a customer can, plus Administration → stable directory. (Racing data publishing goes here next.)
- **Superadmin**: everything an admin can, plus Accounts (suspend/restore) and Account activity.
- No platform role opens private stable records or conversations. That needs real membership.

### Building future features on accounts

Every customer-owned table (subscriptions, carts, orders, entitlements, saved horses…) should:

1. Reference the owner as `account_id uuid not null references public.accounts(id)`. Stable-owned data uses
   `stable_id` + a membership check instead.
2. `enable row level security`, grant nothing to `anon`/`authenticated`, and grant `service_role` only what the
   backend needs (default privileges already deny browser roles; migration `202611090002` turns RLS on for new tables).
3. Do multi-step or permission-sensitive writes in a `security definer` function with `set search_path = ''`
   that re-checks the actor, and grant `execute` only to `service_role`.
4. Record money, role and access changes in `account_events` (or a similar append-only table).
5. Treat an account with `status <> 'active'` as unable to buy, post or message. The API already blocks it on every request.

## Security controls in place

**Accounts and sessions**
- Email-only sign-in; the shared `superadmin` username was removed (a known username helps attackers).
- Passwords: 12–128 chars with upper, lower and a number. Supabase hashes them; we never see them.
- Sessions in HttpOnly, Secure, SameSite=Lax cookies; access token ≤ 1 h, refresh token scoped to `/api/auth`.
- Every request re-reads the account row, so a suspension or role change applies immediately.
- Suspension also bans the identity at Supabase, so no new session can start.
- Optional 2-step login (TOTP authenticator apps). When it's on, a password-only session can only enter the
  code or sign out. Turning it off requires a fresh code and signs out every session.
- `REQUIRE_STAFF_MFA=true` (Render env) makes 2-step login mandatory before admins open Administration.
  It's **off** for now by the user's choice (2026-11-09).

**Database**
- RLS on every table; the browser has no table or function grants at all. Everything goes through the API.
- The server key can read accounts but cannot write `platform_role`, `status` or insert accounts directly,
  and cannot call `set_platform_role`. A leaked server key still can't mint admins in our tables.
- `account_events` rejects UPDATE, DELETE and TRUNCATE, even from the database owner.

**API**
- Per-IP rate limits: whole API 1200/min (`API_RATE_LIMIT_PER_MINUTE`), tighter on login, sign-up, email, 2-step.
- Origin check on all writes (CSRF), JSON-only auth requests, 32 KB body limit, generic error messages.
- Headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, strict CSP for JSON, HSTS in production.
- Mock/demo endpoints (`/api/betting`, `/api/dashboard`, mock `/api/racing/*`) and legacy admin routes were removed.

**Website (Vercel)**
- Content-Security-Policy: scripts only from our own origin plus one hashed inline theme script; no
  framing; no plugins. `tests/security-headers.spec.ts` fails if the inline script changes without its hash.
- HSTS, `X-Frame-Options: DENY`, COOP, Permissions-Policy (camera, mic, location, payment off).

## Recommended Supabase dashboard settings (manual — not checked by us)

Do these in the Supabase dashboard. They protect accounts beyond our code:

1. **Owner account**: turn on 2-step login for your own Supabase (and GitHub, Vercel, Render) logins. Whoever
   controls these controls Stayblz.
2. **Auth → Providers → Email**: keep "Confirm email" on (our sign-up already refuses to run if it's off).
   Set minimum password length to 12.
3. **Auth → Rate limits**: keep the defaults or lower.
4. **Auth → Attack protection**: enable CAPTCHA (hCaptcha/Turnstile) once the frontend supports it; enable
   leaked-password protection if your plan offers it.
5. **Auth → Multi-factor**: TOTP enabled (it is by default).
6. **Project settings → API keys**: if the secret key was ever pasted anywhere outside Render/.env, rotate it.
7. **Database → Backups**: the free tier keeps limited backups. Export important data before big changes.

## Known limits (honest list)

- Rate limits live in the server's memory: they reset when Render restarts, and they are per server instance.
- Behind the Vercel proxy, the API may see Vercel's address instead of the visitor's, so per-IP limits can be
  shared between visitors. Fixing it needs a trusted proxy header; not done yet.
- No CAPTCHA yet on sign-up/login.
- No "sign out other devices" button or session list yet.
- Superadmin can't be suspended from the website by design; use the SQL editor if ever needed.
- The superadmin profile (name, country, racing role) is locked in the website; the API refuses edits
  (`profile_locked`). To change it, update `public.accounts` in the SQL editor. Password and 2-step login stay changeable.
- The Render free tier sleeps; the first request can be slow or return 503. That isn't an attack or a bug.
