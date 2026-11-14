# Cloudflare R2 storage (shared with Suprah)

Stayblz can store files in Cloudflare R2, using **Suprah's R2 account, buckets and keys**
(senior dev decision, connected 2026-11-15). Nothing in Stayblz uses it yet: chat files and
community/horse photos still go to Supabase Storage (`lib/chatStorage.ts`, `lib/communityStorage.ts`).

## Where things are

| Part | File |
| --- | --- |
| Service (all R2 access) | `src/lib/r2Storage.ts` |
| Controller (admin status/check) | `src/routes/storage.ts`, mounted at `/api/admin/storage` |
| Settings | `R2_*` in `.env` (documented in `.env.example`) |
| Tests (fake R2, no network) | `tests/r2.test.cjs` |
| Live check | `npm run r2:check` (read-only) / `npm run r2:check -- --write` |

## Protecting Suprah's files

Suprah keeps car photos, call recordings and screenshots in the same buckets. The service enforces this:

- Every key is forced under the fixed folder **`stayblz/`** (`R2_ROOT`, a constant, not a setting).
  Callers pass keys *relative* to it (`horses/<owner>/<horse>/<uuid>.jpg`). Store those relative keys in the database.
- Each part of a key may only use letters, digits, `_`, `.` and `-`, and may not start with `.`.
  So `..`, `/x`, `a//b`, `%2e` and the like are rejected (`StorageError("bad_key")`).
- Uploads never overwrite (`If-None-Match: *`). `remove()` checks every key before deleting any.
- The service has no list, copy or bucket-level operations.
- Checked 2026-11-15: Suprah's jobs only list their own folders (`screenshots/`, `idle-recordings/`);
  nothing in Suprah uses `stayblz/`, and Suprah's FTP bucket isn't used here.

Please keep it this way: don't create a second `S3Client` elsewhere, and don't add list or bucket operations.

## Using it in a route

```ts
import { newKey, r2Storage, StorageError } from "../lib/r2Storage";

// Upload (after your own permission check; read the body with express.raw like community.ts does)
const key = newKey(`horses/${ownerId}/${horseId}`, "jpg");   // "horses/<owner>/<horse>/<uuid>.jpg"
await r2Storage.put("private", key, body, "image/jpeg");
// ...save `key` in your table; on DB failure: await r2Storage.remove("private", [key])

// Serve (again after the permission check)
const { body, contentType } = await r2Storage.get("private", key);    // small files
const { stream } = await r2Storage.open("private", key);              // big files: stream.pipe(res)

// Delete
await r2Storage.remove("private", [key]);
```

Failures are `StorageError` with `code`: `not_configured`, `bad_key`, `not_found`, `exists`,
`access_denied`, `no_such_bucket`, `no_public_url`, `unavailable`. Messages never contain keys or URLs.

- **private** bucket: the API streams the file after its own check. Use this for anything with privacy
  rules (horse photos have members/followers/only-me settings).
- **public** bucket + `r2Storage.publicUrl(key)`: anyone with the link can open it. Only for files that are
  meant to be public. **Not usable yet** (see below).
- `r2Storage.signedUrl(key, { seconds, downloadName })`: a 1–60 minute link to a private file that points
  at `*.r2.cloudflarestorage.com`.

**Moving an existing feature:** `r2Files("private")` has the same `upload/download/remove` shape as
`communityStorage`/`chatStorage`. But existing rows point at files already in Supabase Storage.
Before switching, copy those files to R2 (same relative path) or read from R2 first and fall back to Supabase.

## Known gaps

- **Public links are off.** The `R2_PUBLIC_URL` in Suprah's local `.env` (an r2.dev address) no longer
  exists on the internet (DNS `ENOTFOUND`, 2026-11-15), so Stayblz's `R2_PUBLIC_URL` is empty. Suprah's live
  server may use a different address. Find out from whoever runs Suprah's hosting or Cloudflare.
- **Frontend Content-Security-Policy:** `stayblz-frontend/vercel.json` only allows images and media from
  `'self'`. Files served through `/api/...` work as they are. Public links or signed links need their host
  added to `img-src`/`media-src` first.
- **Render isn't set up yet:** production has no `R2_*` settings. Request size limits and Render free-tier
  memory still apply: stream big files with `open()`. Don't load them with `get()`.
- **Same keys as Suprah:** a leak of Stayblz's server settings exposes Suprah's files too. The safer end
  state is below.

## Production (Render), when a release is approved

1. Render → stayblz-backend → Environment: add `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`,
   `R2_BUCKET_PRIVATE`, `R2_BUCKET_PUBLIC` (and `R2_PUBLIC_URL` once known). Copy them from Suprah's settings.
   Never paste them into chat, notes or git.
2. After the deploy, sign in as an admin and open `https://stayblz-app.com/api/admin/storage/check`
   (read-only), or POST to it for the write test. Every bucket should show `"ok": true`.

## Later: Stayblz's own buckets (recommended before heavy use)

Needs someone with access to Suprah's Cloudflare account (about 10 minutes, no code changes):

1. R2 → Create bucket `stayblz-private`, and `stayblz-public` if public files are wanted.
2. For `stayblz-public`: Settings → Custom domain, for example `media.stayblz-app.com` (better than r2.dev, which
   is rate-limited and meant for testing).
3. R2 → Manage API tokens → Create token: **Object Read & Write**, limited to those two buckets only.
4. Put the new token's keys and bucket names in Stayblz's `.env` and Render, then run `npm run r2:check -- --write`.
   Copy any files already under `stayblz/` across first, for example with `rclone`.
