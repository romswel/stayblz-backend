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

## Next agreed step
2026-11-01: User authorized a production landing release. Added a public racing overview that reads only published, non-future records, projects reviewed fields, and returns a generic unavailable response instead of mock data. Added origin checks and a commit marker in health responses.
- Backend build and 10 stubbed API tests passed. Existing admin login and shared stable routes are unchanged in this release.
- `migrations/202611010001_site_racing_records.sql` is tracked for review only; it was not applied remotely and contains no seed rows or legacy changes.
- Verified-account auth/profile/signup code remains a separate local change until custom SMTP, provider redirects, and the admin invitation are ready.

Verify the deployed public endpoint and unchanged admin session. Activate verified accounts only after email delivery/admin setup works. No force push, schema application, or data deletion is authorized by this release alone.

## Maintenance
After meaningful work, update only the sections affected.
Record actual checks and their limits. Do not mark proposals as completed work.
Never include secrets, private data, or copied historical plans.
