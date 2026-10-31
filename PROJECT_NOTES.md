# Stayblz project notebook

## Starting point
Fresh planning baseline: 2026-10-31.
We will build step by step. Previous plans and design decisions are not carried forward.
Existing application source remains in place; this setup does not rebuild the application.

## Agreed decisions
- Begin with only essential setup files.
- Decide architecture, data, theme, and UI/UX as the relevant work begins.

## Verified implementation
2026-10-31: Audited the current mock backend without remote schema or data changes.
- Added async error forwarding and safe JSON error responses, bounded JSON bodies, and no-store/nosniff response headers.
- Tracking tolerates a missing linked inventory row.
- Demo sessions expire after one hour; login attempts and in-memory stores are bounded.
- Updated vulnerable transitive dependencies. Node >=22.12.0 is required.
- Validation: eight API regression tests passed with database access stubbed; TypeScript build and npm audit passed with zero reported vulnerabilities.
- User confirmed the current release remains a mock. Demo credentials, single-admin sessions, shared demo state, and unverified tenant isolation remain; this is not production authentication.
- Tests did not read or write the remote database.

## Lessons
Express 4 async handlers must forward rejected promises. Catch database failures without exposing internal details.

2026-11-01: Added `GET /api/public/racing-overview` for the redesigned landing.
- Reads only published, non-future records from `site_racing_records`, limited to 30 per section, with public-field projections and malformed-record exclusion. Never reads private tables or mock arrays.
- Prepared local-only migration `migrations/202611010001_site_racing_records.sql`: dedicated curated public content, draft default, RLS, no browser table grants, no seed records or legacy changes. NOT applied remotely. No public publishing UI is implemented yet.
- Missing schema/database failures return generic HTTP 503, never mock data. Existing authenticated racing endpoints remain unchanged and mock-backed.
- Backend build and 10 database-stubbed API tests passed. No remote database queries, migrations, writes, or production verification occurred.

## Next agreed step
2026-11-01: User explicitly authorized audit/fixes and production release. Public-API commit `bfe7f77` was pushed and verified through the live health commit marker. The initial release preserved current admin auth while SMTP was pending.
- Implemented Supabase confirmed-email auth, isolated provider clients, bounded provider requests, rotating HttpOnly cookies, CSRF origin/JSON checks, profile validation/editing, and limited auth actions. Provider outages return 503 without clearing otherwise valid refresh cookies. Development sessions are disabled on Render/production.
- New members can read only published racing records and their own profile. Shared legacy tables and mock workspace endpoints are superadmin-only until tenant membership is modeled. Server-managed metadata controls admin permission; profile role inputs cannot grant access.
- Prepared a read-only-first admin bootstrap script; an authorized invitation preserves the account, verifies email, and requires strong password setup without accepting/printing passwords or tokens. It has only been dry-run so far.
- User confirmed SMTP/redirect setup is ready. Next: deploy account code, apply the authorized admin invitation, and verify activation without deleting existing records. No personal email/password is recorded in this notebook. The public-racing migration remains unapplied.

Account release `ecb576d` was pushed and verified through live backend health and the Vercel proxy. The provider-project fingerprint matches the intended local project. Live anonymous checks confirmed 401 for private routes, 400 for malformed signup, and no credential cookies on rejected requests. Final local checks: 24 API tests/build passed; npm audit reported zero vulnerabilities.

The authorized admin invitation was sent successfully and the user confirmed inbox receipt. The admin role is assigned in trusted metadata; email verification/password setup remained pending at the last check. No password, verification link, personal email or token is recorded here. Bootstrap retries now request a setup email for an incomplete existing admin without deleting/resetting that identity.

See `docs/auth-release.md` and `docs/public-racing.md`. Verify owner activation after password setup. Public-racing schema/data remains a separate unapplied migration; no existing stable rows were changed or deleted.

## Maintenance
After meaningful work, update only the sections affected.
Record actual checks and their limits. Do not mark proposals as completed work.
Never include secrets, private data, or copied historical plans.
