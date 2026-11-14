import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 file storage (S3-compatible), shared with Suprah: same Cloudflare account, same
 * buckets and keys (senior dev decision, 2026-11-15). Settings: R2_* in .env (see docs/r2-storage.md).
 *
 * Suprah's own files (car photos, call recordings, screenshots) live in the same buckets, so:
 *  - Every key Stayblz touches is forced under the fixed folder `stayblz/`. It is a constant on
 *    purpose: no setting can point Stayblz at Suprah's folders.
 *  - Callers pass keys relative to that folder ("horses/<owner>/<horse>/<uuid>.jpg"); store those
 *    in the database. Only plain names are accepted, so "..", "/x" or "a//b" can never escape it.
 *  - Uploads never overwrite an existing file (If-None-Match), and there is no list, copy or
 *    bucket-level operation here at all.
 *
 * "private" = files the API streams (or signs short links for) after its own permission check.
 * "public"  = files anyone can open by URL (R2_PUBLIC_URL). Only put truly public files there.
 */
export const R2_ROOT = "stayblz";
export type R2Bucket = "public" | "private";

export type StorageErrorCode =
  | "not_configured"
  | "bad_key"
  | "not_found"
  | "exists"
  | "access_denied"
  | "no_such_bucket"
  | "no_public_url"
  | "too_large"
  | "unavailable";

export class StorageError extends Error {
  constructor(public code: StorageErrorCode, message?: string) {
    super(message ?? code);
    this.name = "StorageError";
  }
}

type Settings = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  buckets: Partial<Record<R2Bucket, string>>;
  publicUrl: string | null;
  problems: string[];
};

const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
// Each part of a key: letters, digits, "_", "." and "-", never starting with "." (so no "." or "..").
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MAX_KEY_LENGTH = 900; // R2/S3 allow 1024 bytes; leave room for the root folder.
/** get() reads the whole file into memory; anything bigger must be streamed with open() (Render free tier has 512 MB). */
export const MAX_GET_BYTES = 25 * 1024 * 1024;

/** Read the R2_* settings. Never returns or logs the secret anywhere except to the S3 client. */
function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const value = (name: string) => (env[name] ?? "").trim();
  const problems: string[] = [];
  const accessKeyId = value("R2_ACCESS_KEY_ID");
  const secretAccessKey = value("R2_SECRET_ACCESS_KEY");
  if (!accessKeyId) problems.push("R2_ACCESS_KEY_ID is missing");
  if (!secretAccessKey) problems.push("R2_SECRET_ACCESS_KEY is missing");

  // The account endpoint only: https://<account-id>.r2.cloudflarestorage.com (no bucket in the path).
  let endpoint = value("R2_ENDPOINT").replace(/\/+$/, "");
  if (!endpoint) problems.push("R2_ENDPOINT is missing");
  else {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || !url.hostname.endsWith(".r2.cloudflarestorage.com") || url.pathname !== "/")
        throw new Error("not an R2 endpoint");
      endpoint = url.origin;
    } catch {
      problems.push("R2_ENDPOINT must look like https://<account-id>.r2.cloudflarestorage.com");
      endpoint = "";
    }
  }

  const buckets: Settings["buckets"] = {};
  for (const [bucket, name] of [["private", "R2_BUCKET_PRIVATE"], ["public", "R2_BUCKET_PUBLIC"]] as const) {
    const bucketName = value(name);
    if (!bucketName) problems.push(`${name} is missing`);
    else if (!BUCKET_NAME.test(bucketName)) problems.push(`${name} is not a valid bucket name`);
    else buckets[bucket] = bucketName;
  }

  let publicUrl: string | null = value("R2_PUBLIC_URL").replace(/\/+$/, "") || null;
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (url.protocol !== "https:" || url.search || url.hash) throw new Error("bad");
    } catch {
      problems.push("R2_PUBLIC_URL must be an https address");
      publicUrl = null;
    }
  } else problems.push("R2_PUBLIC_URL is missing (only needed for public files)");

  return { accessKeyId, secretAccessKey, endpoint, buckets, publicUrl, problems };
}

const credentialsReady = (s: Settings) => !!(s.accessKeyId && s.secretAccessKey && s.endpoint);

let cached: { fingerprint: string; client: S3Client } | null = null;
let testClient: Pick<S3Client, "send"> | null = null;

function client(settings: Settings): S3Client {
  const fingerprint = `${settings.endpoint}|${settings.accessKeyId}|${settings.secretAccessKey}`;
  if (cached?.fingerprint !== fingerprint) {
    cached?.client.destroy();
    cached = {
      fingerprint,
      client: new S3Client({
        region: "auto",
        endpoint: settings.endpoint,
        credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
        // R2 does not support the newer default checksums; same settings as Suprah.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
      }),
    };
  }
  return cached.client;
}

/** The bucket name and S3 client for a request, or a not_configured error. */
function target(bucket: R2Bucket) {
  const settings = readSettings();
  const name = settings.buckets[bucket];
  if (!credentialsReady(settings) || !name) throw new StorageError("not_configured", `R2 ${bucket} storage is not set up.`);
  return { settings, name, s3: (testClient ?? client(settings)) as Pick<S3Client, "send"> };
}

/**
 * Turns a key relative to the Stayblz folder into the full R2 key, or throws bad_key.
 * "horses/abc/1.jpg" → "stayblz/horses/abc/1.jpg".
 */
export function r2Key(key: unknown): string {
  if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH)
    throw new StorageError("bad_key", "A file key must be a short relative path.");
  const parts = key.split("/");
  if (parts.length > 12 || !parts.every((part) => SEGMENT.test(part)))
    throw new StorageError("bad_key", "A file key may only use letters, numbers, '.', '_' and '-' between slashes.");
  return `${R2_ROOT}/${key}`;
}

/** A fresh, unguessable key inside a folder: newKey("horses/<owner>", "jpg") → "horses/<owner>/<uuid>.jpg". */
export function newKey(folder: string, extension?: string): string {
  const ext = extension ? `.${extension.replace(/^\./, "").toLowerCase()}` : "";
  const key = `${folder.replace(/^\/+|\/+$/g, "")}/${randomUUID()}${ext}`;
  r2Key(key); // throws bad_key for an unsafe folder or extension
  return key;
}

/** Translate an S3/R2 failure into a StorageError without leaking request details. */
function failure(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  const name = e?.name ?? e?.Code ?? "";
  if (status === 404 && name === "NoSuchBucket") return new StorageError("no_such_bucket");
  if (status === 404 || name === "NoSuchKey" || name === "NotFound") return new StorageError("not_found");
  if (status === 412 || name === "PreconditionFailed") return new StorageError("exists");
  if (status === 401 || status === 403 || /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch/.test(name))
    return new StorageError("access_denied");
  return new StorageError("unavailable");
}

// Plain ASCII only: the name ends up in a Content-Disposition header, where other characters can break it.
const safeDownloadName = (name: string) =>
  name
    .replace(/[^\x20-\x7e]+/g, "_")
    .replace(/["\\/<>:|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "file";

export type PutOptions = {
  /** e.g. "public, max-age=31536000, immutable" for public photos that never change. */
  cacheControl?: string;
};

export const r2Storage = {
  /** True when keys, endpoint and that bucket's name are set (it does not contact R2). */
  isConfigured(bucket: R2Bucket = "private"): boolean {
    const settings = readSettings();
    return credentialsReady(settings) && !!settings.buckets[bucket];
  },

  /** Store a file. Never overwrites: an existing key fails with code "exists". */
  async put(bucket: R2Bucket, key: string, body: Buffer, contentType: string, options: PutOptions = {}): Promise<void> {
    const Key = r2Key(key);
    const { name, s3 } = target(bucket);
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: name,
          Key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
          IfNoneMatch: "*",
          ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
        }),
      );
    } catch (error) {
      throw failure(error);
    }
  },

  /** Read a whole file into memory (photos, documents up to MAX_GET_BYTES). Use open() for large files. */
  async get(bucket: R2Bucket, key: string): Promise<{ body: Buffer; contentType: string }> {
    const Key = r2Key(key);
    const { name, s3 } = target(bucket);
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: name, Key }));
      if (!res.Body) throw new StorageError("not_found");
      if ((res.ContentLength ?? 0) > MAX_GET_BYTES) {
        (res.Body as Partial<Readable>).destroy?.();
        throw new StorageError("too_large", "That file is too big to load at once; stream it with open().");
      }
      return {
        body: Buffer.from(await res.Body.transformToByteArray()),
        contentType: res.ContentType || "application/octet-stream",
      };
    } catch (error) {
      throw failure(error);
    }
  },

  /** Stream a file (videos, big downloads): pipe `stream` to the response. */
  async open(bucket: R2Bucket, key: string): Promise<{ stream: Readable; contentType: string; size: number | null }> {
    const Key = r2Key(key);
    const { name, s3 } = target(bucket);
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: name, Key }));
      if (!res.Body) throw new StorageError("not_found");
      return {
        stream: res.Body as Readable,
        contentType: res.ContentType || "application/octet-stream",
        size: typeof res.ContentLength === "number" ? res.ContentLength : null,
      };
    } catch (error) {
      throw failure(error);
    }
  },

  /** Delete Stayblz files. Every key is checked before anything is deleted; missing files are fine. */
  async remove(bucket: R2Bucket, keys: string[]): Promise<void> {
    const list = [...new Set(keys.filter(Boolean).map(r2Key))];
    if (!list.length) return;
    const { name, s3 } = target(bucket);
    try {
      for (let i = 0; i < list.length; i += 8)
        await Promise.all(list.slice(i, i + 8).map((Key) => s3.send(new DeleteObjectCommand({ Bucket: name, Key }))));
    } catch (error) {
      throw failure(error);
    }
  },

  /** The permanent web address of a file in the public bucket. */
  publicUrl(key: string): string {
    const full = r2Key(key);
    const { publicUrl } = readSettings();
    if (!publicUrl) throw new StorageError("no_public_url", "R2_PUBLIC_URL is not set.");
    return `${publicUrl}/${full}`;
  },

  /**
   * A short-lived link to a private file (60 s to 1 h, default 5 min). Only hand it out after the
   * route's own permission check. The link points at *.r2.cloudflarestorage.com, so the frontend's
   * Content-Security-Policy must allow that host before pages can show it.
   */
  async signedUrl(key: string, options: { seconds?: number; downloadName?: string } = {}): Promise<string> {
    const Key = r2Key(key);
    const { settings, name } = target("private");
    const expiresIn = Math.min(3600, Math.max(60, Math.round(options.seconds ?? 300)));
    const command = new GetObjectCommand({
      Bucket: name,
      Key,
      ...(options.downloadName
        ? { ResponseContentDisposition: `attachment; filename="${safeDownloadName(options.downloadName)}"` }
        : {}),
    });
    return getSignedUrl(client(settings), command, { expiresIn });
  },

  /** What is set up, for the admin status page. No keys, secrets or endpoint. */
  status() {
    const settings = readSettings();
    const ready = credentialsReady(settings);
    return {
      folder: `${R2_ROOT}/`,
      private: { configured: ready && !!settings.buckets.private, bucket: settings.buckets.private ?? null },
      public: {
        configured: ready && !!settings.buckets.public,
        bucket: settings.buckets.public ?? null,
        publicUrl: !!settings.publicUrl,
      },
      problems: settings.problems,
    };
  },

  /**
   * Checks the connection. Always: asks R2 for a file that doesn't exist. R2 answers "no such file"
   * only when the keys and the bucket are right, and nothing is read or changed. (A HEAD request
   * can't be used: it says "not found" for a wrong bucket name too.) With write: also saves, reads back and deletes one
   * tiny text file under stayblz/_checks/ in each bucket, and opens the public one by its URL.
   */
  async check(options: { write?: boolean } = {}) {
    const results: Record<R2Bucket, BucketCheck> = {
      private: await checkBucket("private", !!options.write),
      public: await checkBucket("public", !!options.write),
    };
    return { folder: `${R2_ROOT}/`, ok: results.private.ok && results.public.ok, ...results };
  },
};

type BucketCheck = {
  ok: boolean;
  configured: boolean;
  connected: boolean;
  wrote?: boolean;
  readBack?: boolean;
  deleted?: boolean;
  publicUrl?: boolean;
  error?: StorageErrorCode;
};

async function checkBucket(bucket: R2Bucket, write: boolean): Promise<BucketCheck> {
  if (!r2Storage.isConfigured(bucket)) return { ok: false, configured: false, connected: false, error: "not_configured" };
  const result: BucketCheck = { ok: false, configured: true, connected: false };
  const probe = `_checks/${randomUUID()}.txt`;
  try {
    const { name, s3 } = target(bucket);
    try {
      const found = await s3.send(new GetObjectCommand({ Bucket: name, Key: r2Key(probe) }));
      (found.Body as Partial<Readable> | undefined)?.destroy?.(); // a random new key can't exist; don't read it
    } catch (error) {
      if (failure(error).code !== "not_found") throw error;
    }
    result.connected = true;
    if (!write) return { ...result, ok: true };

    const text = `Stayblz storage check ${new Date().toISOString()}`;
    await r2Storage.put(bucket, probe, Buffer.from(text), "text/plain; charset=utf-8");
    result.wrote = true;
    try {
      result.readBack = (await r2Storage.get(bucket, probe)).body.toString() === text;
      if (bucket === "public" && readSettings().publicUrl) {
        const res = await fetch(r2Storage.publicUrl(probe), { signal: AbortSignal.timeout(10_000) }).catch(() => null);
        result.publicUrl = !!res?.ok && (await res.text()) === text;
      }
    } finally {
      await r2Storage.remove(bucket, [probe]);
      result.deleted = true;
    }
    result.ok = !!result.readBack && result.publicUrl !== false;
    return result;
  } catch (error) {
    return { ...result, ok: false, error: failure(error).code };
  }
}

/** Same shape as chatStorage/communityStorage, so a feature can move to R2 by swapping one object. */
export function r2Files(bucket: R2Bucket) {
  return {
    upload: (key: string, body: Buffer, contentType: string) => r2Storage.put(bucket, key, body, contentType),
    download: async (key: string) => (await r2Storage.get(bucket, key)).body,
    remove: (keys: string[]) => r2Storage.remove(bucket, keys),
  };
}

/** Tests only: route every request to a fake (null restores the real client). */
export function setR2ClientForTests(fake: Pick<S3Client, "send"> | null): void {
  testClient = fake;
}
