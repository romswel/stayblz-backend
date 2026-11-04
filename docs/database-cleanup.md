# Database cleanup review

Read-only review on 2026-11-05. The configured provider fingerprint matched the live backend. PostgREST metadata and HEAD-only counts confirmed 20 API-visible public tables. No customer records were fetched, and no schema or data was changed. This inventory does not cover private schemas, external consumers, or SQL-only dependencies.

## Keep the current tables

Keep `site_racing_records`, `member_stables`, `stable_memberships`, `stable_invitations`, `member_horses`, `member_posts`, `member_conversations`, `member_messages`, `member_watchlist`, `racing_notes`, `racing_preferences`, `personal_conversations`, `personal_messages`, and `personal_invitations`. All 14 support the current app, even when empty.

## Old tables to review for retirement

| Table | Current backend dependency | Condition before removal |
| --- | --- | --- |
| `connection_test` | `src/app.ts`: `/api/db-health` | Change the health check to use a retained table and verify deployment. |
| `feed_posts` | `src/routes/feed.ts`: admin legacy feed | Retire the legacy route and preserve any needed feed history. |
| `horse_inventory` | `src/routes/inventory.ts`: admin legacy inventory | Retire the route and preserve or explicitly discard old horse records. |
| `horse_tracking` | `src/routes/horses.ts`: admin legacy tracking | Retire the route and review linked horse records. |
| `conversations` | `src/routes/messages.ts`: admin legacy conversations | Review together with `chat_messages`; preserve any needed conversation history. |
| `chat_messages` | `src/routes/messages.ts`: admin legacy history | Retire the route and preserve or explicitly discard old messages. |

All six contain rows. Their age or names alone do not establish that the data can be discarded. The current customer frontend uses the new tables; the old backend routes remain mounted under `/api/admin/legacy/*`.

Before dropping anything: export a backup, check database foreign keys/views/functions/triggers and other consumers, remove and deploy old code dependencies, then obtain approval for the exact tables and data to delete. Use a reviewed transaction with explicit table names and no `CASCADE`. Only app API credentials are configured locally; a database migration connection or the owner's SQL Editor is needed for reviewed SQL. No destructive SQL has been prepared or executed in this pass.
