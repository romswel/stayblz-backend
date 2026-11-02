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
2026-11-03: User authorized complete review and production publication directly on main, without a new branch. Reviewed all modified/untracked identity, login, bootstrap, test-helper, regression-test, and notebook changes. The release includes pending-admin setup feedback, correct invitation retry handling for invited accounts, and neutral Test Account labels in the opt-in helper. It performs no automatic invitations, password resets, account/permission edits, or schema changes.
- Release checks: all 31 API tests including TypeScript build, helper syntax checks, diff checks, and npm audit (zero reported vulnerabilities) passed. Changed-file credential-pattern scan found no embedded credentials. Preserve the verified admin identity and require its actual password for login; no authentication bypass. Verify the live health commit marker after pushing. Public-racing storage configuration and email sending restrictions remain separate from this release.

2026-11-02: Owner reported successful admin password save. A read-only provider check independently confirmed email verification, password-setup flag cleared, preserved trusted superadmin role, and the default admin username alias matching that identity. Actual password login remains to be exercised by the owner; no password/session token was requested or used for this check.

2026-11-02: Investigated reported superadmin wrong-password error. Read-only provider lookup found the existing trusted admin unconfirmed, password setup required, and no prior sign-in. The username alias skipped unconfirmed admins and produced a misleading credential error. Added a safe admin_setup_required 403 for that specific alias state; no session or email disclosure, role injection, or confirmation bypass. Added regression coverage; all 31 API tests/build and diff checks passed.
- Requested one fresh real invitation for the existing incomplete admin, with the production callback; the provider accepted it. A subsequent read-only lookup observed email confirmation and retained admin role, while password setup was still pending. The owner must save a password through the actual emailed link; no password is accepted in chat, guessed, or set by this investigation. Actual password login is not yet verified. Updated bootstrap retries to resend an invitation for invited/unconfirmed accounts rather than a signup email. Code remains local/uncommitted; no deployment or schema changes.

2026-11-02: With explicit user authorization, renamed only the existing first signup-test account's profile to Test Account. Verified the provider matches production before the update, refused an unexpected admin identity or edited profile, merged existing user metadata, and verified unchanged email/confirmation/server metadata afterward. The superadmin account was untouched; no password, permission, schema, or provider-setting changes. The optional test helper now uses Test Account for future separate test registrations; node syntax and diff checks passed. Helper code remains local/uncommitted.

2026-11-01: User authorized review and production push from the original repositories without backups/worktrees. Reviewed every changed/untracked file and preserved safe classification for thrown signup/resend/recovery provider errors. Release validation: 30 API tests including TypeScript build, diff checks, and npm audit (zero vulnerabilities) passed. Credential-pattern scan found no embedded credentials in release files. No schema/provider configuration changes, account resets, or additional test emails are part of this release. Verify the live health commit marker after pushing. The built-in sender still limits public signup/recovery; completed live recovery and verified password login/logout remain unverified.

2026-11-01: Removed the obsolete .release/backend Git worktree after verifying it was clean, had no unique commits, and was already an ancestor of main. All local auth/email changes remain in the original stayblz-backend repository. Fetch confirmed main matches origin/main; no pull/merge was needed. No backend behavior changes, commits, pushes, or deployments in this cleanup.

2026-11-01: Local-only email verification follow-up. The latest user instruction supersedes the earlier SMTP-ready assumption: use the existing Supabase built-in sender for authorized organization testing; no provider configuration, schema, or deployment changes.
- Signup, resend, and recovery now report safe recipient restrictions and provider rate limits; failed email requests no longer return false success. Unknown-account responses remain generic. Local throttles return matching Retry-After header/body values; unverified login has a clear confirmation-required code.
- Added an opt-in isolated loopback integration helper that keeps its test password in memory, stops for existing accounts, waits for actual owner confirmation, and never generates verification tokens or auto-confirms users.
- Validation: all 29 API tests and TypeScript build passed. Provider responses are stubbed in automated tests. Real authorized signup returned 202; unverified login returned 403 and private access 401. The owner subsequently completed the emailed link; a read-only provider lookup confirmed verified email and no superadmin role. One real recovery request returned 429 over_email_send_rate_limit; no retries. Live password login/logout and completed recovery remain unverified. The temporary test password was discarded when its process closed; no admin password/profile changes or verification bypass occurred. No commits or pushes in this pass. See docs/auth-email-testing.md.

After meaningful work, update only the sections affected.
Record actual checks and their limits. Do not mark proposals as completed work.
Never include secrets, private data, or copied historical plans.
