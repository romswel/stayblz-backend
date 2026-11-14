# Cloudflare R2 storage (shared with Suprah)

Stayblz stores files in Cloudflare R2, using **Suprah's R2 account, buckets and keys**
(senior dev decision, connected 2026-11-15). These use it, through `lib/mediaStore.ts`:

| Feature | Store | R2 key (private bucket) | Supabase fallback bucket |
| --- | --- | --- | --- |
| Horse photos | `communityStorage` | `stayblz/community/horses/<owner>/<horse>/<id>` | `community-media` |
| Feed post photos | `communityStorage` | `stayblz/community/posts/<author>/<id>` | `community-media` |
| Profile pictures | `communityStorage` | `stayblz/community/avatars/<account>/<version>` | `community-media` |
| Stayblz Chat attachments | `chatStorage` | `stayblz/chat/{personal,team}/<chat>/<id>` | `chat-files` |

**R2 when set up, Supabase otherwise (`mediaStore`).** Uploads go to R2 when the `R2_*` settings exist.
Otherwise, or when R2 fails, they go to the Supabase bucket exactly as before. Reads try R2 first,
then Supabase, so files saved before R2 was switched on keep working. Nothing needs copying, and the
`path` stored in the database is the same either way, so SQL checks on paths (chat) are untouched.
Deletes go to both places. **While Render has no `R2_*` settings, production behaves exactly as before.**

## Where things are

| Part | File |
| --- | --- |
| Service (all R2 access) | `src/lib/r2Storage.ts` |
| R2-or-Supabase store for features | `src/lib/mediaStore.ts` (used by `lib/communityStorage.ts`, `lib/chatStorage.ts`) |
| Controller (admin status/check) | `src/routes/storage.ts`, mounted at `/api/admin/storage` |
| Profile pictures | `src/routes/avatars.ts` at `/api/avatars`, table `account_avatars` (`202611150002_avatars.sql`) |
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

**A new feature with files:** create a store once, for example
`export const docStorage = mediaStore("documents", supabaseFiles("documents"))`, then call
`docStorage.upload(path, body, type)` / `.download(path)` / `.remove(paths)` after your own permission check.
Keep the stored `path` relative, without a leading `stayblz/`. Use `r2Storage` directly only for R2-only
files (no Supabase copy), such as big videos streamed with `open()`.

**Profile pictures** (`/api/avatars`, signed in only): `GET /lookup?ids=a,b` returns `{ avatars: { id: version } }`
(at most 100 ids; suspended accounts left out), `GET /:id/:version` streams the picture, and `POST /me` (raw
JPG, PNG or WebP, up to 2 MB) or `POST /me/remove` change your own. The frontend batches lookups
(`components/account/avatars.ts`) and shows initials when there's no picture (`AvatarFace`).

## Known gaps

- **Public links are off.** The `R2_PUBLIC_URL` in Suprah's local `.env` (an r2.dev address) no longer
  exists on the internet (DNS `ENOTFOUND`, 2026-11-15), so Stayblz's `R2_PUBLIC_URL` is empty. Suprah's live
  server may use a different address. Find out from whoever runs Suprah's hosting or Cloudflare.
- **Frontend Content-Security-Policy:** `stayblz-frontend/vercel.json` only allows images and media from
  `'self'`. Files served through `/api/...` work as they are. Public links or signed links need their host
  added to `img-src`/`media-src` first.
- **Render isn't set up yet:** production has no `R2_*` settings, so live files still go to Supabase
  (nothing breaks; R2 starts with the next upload once the settings are added). Request size limits and
  Render free-tier memory still apply: stream big files with `open()`. Don't load them with `get()`.
- **Local development uses the production database.** With R2 set up locally, photos you upload from
  your computer go to R2, and the live site only finds them once Render has the R2 settings too.
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
