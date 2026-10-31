# Public racing overview

`GET /api/public/racing-overview` reads only published, non-future records from `site_racing_records`, with a limit of 30 records per section. It never imports the existing mock racing arrays or reads private inventory, tracking, messages, or feed tables. It returns only allowlisted public fields, not raw JSON payloads.

The SQL in `migrations/202611010001_site_racing_records.sql` is a local draft. It has not been applied to a remote database. It contains no seed/sample records and changes no existing tables. Review and explicit authorization are required before remote application. Content entry/publishing UI is outside this landing-design pass.

After database setup, authorized server/admin tooling can store your own records. Drafts and future publications are excluded. Each payload requires a `name` and the fields below:

| kind | Required payload fields in addition to name |
| --- | --- |
| racecards | track, time, race, surface, distance, runners |
| results | track, time, race |
| workouts | track, time, distance |
| horses | starts, wins, figure |
| jockeys, trainers | starts, wins |
| stakes | track, date (ISO date) |
| notes | category, summary, body |

Optional fields are explicitly listed in `src/routes/publicRacing.ts`. Numeric fields must be finite and nonnegative; required malformed records are omitted. Names/metadata are bounded to 500 characters and note bodies to 5000. Numeric rankings and track menus are derived from these records in the client. An empty database returns empty arrays. A missing table or database error returns HTTP 503 with a generic message; no mock fallback is used.

Existing authenticated racing routes remain mock-stage routes and are not used as a public data source. Their replacement and production auth are separate work.
