# Racing accounts and optional workspaces

Stayblz now uses one verified account for the racing overview, follows, private notes, alert preferences, personal messages and profile. None of these require stable membership. Platform superadmin and stable owner/manager/member permissions remain separate.

The main frontend navigation starts with racing, then personal account tools. `/my-racing` contains Following, Race notebook and Alert preferences. `/messages` is personal messaging. `/workspace`, `/stables`, `/inventory`, `/tracker` and `/team-messages` form the optional stable operations area.

## API boundaries

- `/api/messages`: participant-only personal conversations, without a stable header. New conversations initially belong only to the creator. The creator can issue recipient-email-bound invitations. Acceptance checks the verified email, expiry, unused state and conversation ownership inside a transaction. Invitations grant access to existing conversation history; the UI explains this before sharing. Only the creator manages/revokes invitations. There is no public account lookup or unsolicited direct-message endpoint.
- `/api/team-messages`: existing stable conversations, requiring current stable membership and conversation participation. No old stable conversation is relabelled or moved into the personal inbox.
- `/api/my-racing/notes`: own-account list/create/update/delete, with server-supplied user identity. Notes are private, plain text, and independent of published racing news or team feed posts. The list currently returns the latest 100 notes; deletion is explicit and permanent.
- `/api/my-racing/preferences`: saved boolean preferences, with `deliveryAvailable: false`. Saving choices does not subscribe a user to a functioning alert transport or send email.
- `/api/my-racing/summary`: account-scoped counts of follows, notes and personal conversations.
- `/api/watchlist`: account-scoped follows for horses, jockeys or trainers, selected by `?kind=`. Published records supply names and details. Each category includes at most 500 current public records plus the user's saved follows. An unpublished saved record is labelled as lacking current public details.

Personal messaging preserves the same retry-safe message IDs and timestamp-plus-ID history cursors as team messaging. Senders and conversation participants come from server-verified identity. Platform admins cannot read an unrelated personal conversation through the customer API. Lists return the most recent 100 conversations. Live message delivery, notifications, unread counts and read receipts are not implemented.

## Activation and validation

The user applied the reviewed activation bundle on 2026-11-03, and the matching backend/frontend application release is live. The bundle contains the published-record migration, member-workspace migration, then `migrations/202611030002_personal_racing.sql` after checking which migrations already exist on the intended target. No migration is automatically applied by the application. No legacy records are moved or deleted; the new watchlist category column defaults existing follows to horses. The personal tables have RLS and no browser/public grants. Only service-role functions can accept invitations or send messages.

Local SQL/API coverage executes the real migrations in isolated PostgreSQL and checks account isolation, invitation email binding/replay/expiry/revocation, personal messaging without a stable, participant-only reads/sends, private notes/preferences, jockey/trainer follows and denied browser database access. Browser tests mock APIs and check racing-first navigation, optional-workspace outages, notes, preferences, messages, invitations, themes and screen widths. These checks do not establish hosted PostgREST/provider/proxy or real-device behavior.

No Equibase feed, replay source, automatic alert delivery, paid racing products or checkout has been connected by these UI/account changes.
