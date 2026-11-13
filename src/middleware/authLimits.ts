import type { Request, Response, NextFunction } from 'express';
const attempts = new Map<string, { count: number; expires: number }>();

/**
 * Fixed-window limit, per client IP by default. `max` may be a function so tests and env can tune it.
 * `keyOf` limits by something else instead (such as the email address a request is about);
 * when it returns null the request isn't counted.
 */
export function authLimit(
  action: string,
  max: number | (() => number),
  windowMs: number,
  keyOf?: (req: Request) => string | null,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const limit = typeof max === 'function' ? max() : max;
    const subject = keyOf ? keyOf(req) : (req.ip ?? 'unknown');
    if (!Number.isFinite(limit) || limit <= 0 || subject === null) {
      next();
      return;
    }
    const now = Date.now();
    for (const [key, bucket] of attempts)
      if (bucket.expires <= now) attempts.delete(key);
    const key = `${action}:${subject}`;
    const bucket = attempts.get(key) ?? { count: 0, expires: now + windowMs };
    if (bucket.count >= limit || (!attempts.has(key) && attempts.size >= 10000)) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.expires - now) / 1000),
      );
      res.setHeader('Retry-After', retryAfterSeconds);
      res
        .status(429)
        .json({
          code: 'auth_rate_limited',
          retryAfterSeconds,
          error: 'Too many attempts. Please try again later.',
        });
      return;
    }
    bucket.count++;
    attempts.set(key, bucket);
    next();
  };
}

/**
 * Whole-API ceiling per IP (default 1200 requests/minute). Behind the Vercel proxy many
 * visitors can share one address, so this is a flood guard, not a per-person limit.
 * Set API_RATE_LIMIT_PER_MINUTE to tune it, or 0 to switch it off. Off in automated tests.
 */
export const apiLimit = authLimit(
  'api',
  () => {
    const configured = process.env.API_RATE_LIMIT_PER_MINUTE;
    if (configured !== undefined) return Number(configured);
    return process.env.NODE_ENV === 'test' ? 0 : 1200;
  },
  60_000,
);
