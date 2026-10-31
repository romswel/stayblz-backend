import type { Request, Response, NextFunction } from 'express';
const attempts = new Map<string, { count: number; expires: number }>();
export function authLimit(action: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    for (const [key, bucket] of attempts)
      if (bucket.expires <= now) attempts.delete(key);
    const key = `${action}:${req.ip ?? 'unknown'}`;
    const bucket = attempts.get(key) ?? { count: 0, expires: now + windowMs };
    if (bucket.count >= max || (!attempts.has(key) && attempts.size >= 10000)) {
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
