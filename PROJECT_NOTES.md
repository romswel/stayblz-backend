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
Release this mock-stage bug-fix pass, then choose the next feature with the user.

## Maintenance
After meaningful work, update only the sections affected.
Record actual checks and their limits. Do not mark proposals as completed work.
Never include secrets, private data, or copied historical plans.
