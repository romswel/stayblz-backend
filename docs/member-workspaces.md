# Member workspaces

The workspace is now optional alongside personal racing accounts. Personal messaging uses `/api/messages`; the stable conversations described here use `/api/team-messages`. See `racing-accounts.md` for that boundary and the additional migration. No stable or legacy message history was moved into personal accounts.

Implemented locally, not deployed or applied to the hosted database.

Platform permissions and stable membership are independent. A verified regular account can create up to ten owned stables. Owners and managers maintain horse inventory and tracking and invite ordinary members. Only owners assign manager roles. All current members can view stable horses, read/write the stable feed, and create private conversations with current teammates. Conversation participants alone can read/send its messages. Platform superadmin status does not bypass these checks.

`GET /api/workspaces` lists only the verified account's memberships. Stable requests to inventory, horses, feed, messages and workspace/team routes supply `X-Stayblz-Stable`. The backend rechecks that header against the verified identity on every request; neither the selected browser stable nor profile racing role is authority. Mutations take authorship, stable identity and role from the server. Removing a membership blocks subsequent stable requests. Owners cannot be removed or promoted through member-role endpoints.

Invitations contain a random 256-bit token; only its SHA-256 digest is stored. Acceptance requires the verified recipient email, unexpired unused invitation and a currently authorized inviter. Invites expire in seven days and can be revoked. Existing memberships are never silently elevated through invitation replay. The UI generates a private shareable link; it does not send email. The fragment is consumed in memory and stripped from the browser URL. Signed-out visitors sign in separately and return to the invitation tab.

Messages use database transactions to validate participation and save the message and preview together. Client-generated request IDs make retries idempotent per conversation and sender. History uses a timestamp-plus-ID cursor, so equal timestamps do not skip messages. No realtime delivery, read receipts, unread counts or notifications are implemented. The list currently loads up to 100 conversations; the feed shows the latest 100 posts. The frontend labels manual message refresh.

`/api/watchlist` is personal to the verified user, independent of any stable. Setting a watched flag is idempotent and persists in PostgreSQL. Available horses come from published records (up to 500 plus the user's saved entries), never the shared mock watchlist. Removed/unpublished public details are not returned as current data. No notifications are promised.

## Database activation

After explicit authorization for the target database, inspect its migration state and apply, in order:

1. `migrations/202611010001_site_racing_records.sql`, only if that table has not already been provisioned.
2. `migrations/202611030001_member_workspaces.sql`.

These migrations run in transactions and are intentionally not automatically replayed on app startup. They create separate tables and functions, enable RLS and revoke browser/public grants. Only the backend service role can access them. No existing stable or horse rows are assigned to a customer, modified or deleted. Creation and acceptance transactions are callable only by the service role. Existing identities and trusted superadmin metadata are preserved.

The workspace migration also requests a PostgREST schema-cache reload so the new functions can be discovered; this follows the [PostgREST RPC documentation](https://docs.postgrest.org/en/stable/references/api/functions.html#calling-with-post).

Release backend before the matching frontend after migration validation. Missing membership storage returns an unavailable state; the app must never fall back to shared data. Verify custom header forwarding through the actual Vercel proxy and perform live isolation smoke checks with two authorized test accounts before describing this as live. No automatic test emails or remote account mutations are part of this implementation.

Old unmapped inventory, tracker, feed and message APIs remain restricted to superadmins under `/api/admin/legacy/{inventory,horses,feed,messages}`. Legacy mock racing/dashboard/wagering routes remain superadmin-only and are not used by the member frontend. A deliberate, reviewed ownership mapping would be required to migrate old records. `/api/admin/stables` returns only a platform directory, not private conversations.

## Evidence

`tests/workspaces.test.cjs` executes both migrations in an isolated PGlite PostgreSQL engine and runs the actual Express routes through a test-only query adapter. It covers stable ownership, forged IDs, platform-admin isolation, stable roles, invitation email/expiry/replay/revocation, removed members, server-owned authorship, participant checks, message retries/history cursors, user-specific watches, denied direct browser table/function access and fail-closed outages. This is local SQL/API evidence, not hosted PostgREST or provider verification. Browser tests use mocked APIs.
