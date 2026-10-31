import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { User } from '../types';
import type { User as ProviderUser } from '@supabase/supabase-js';
import { accessToken, identity, profile, providerUnavailable } from '../lib/identity';

/**
 * Explicitly enabled local/test sessions only. Production uses verified Supabase
 * identities and HttpOnly cookies; this store is disabled on Render/production.
 */
const sessions = new Map<string, { user: User; expiresAt: number }>();
const SESSION_TTL_MS = 60 * 60 * 1000;
export interface AuthenticatedRequest extends Request {user: User;providerUser?:ProviderUser;}

export const MOCK_USERNAME = 'superadmin';
export const MOCK_PASSWORD =
  process.env.NODE_ENV === 'test'
    ? 'unit-test-only-password'
    : (process.env.DEMO_ADMIN_PASSWORD ?? '');
export const demoEnabled = () =>
  process.env.NODE_ENV !== 'production' &&
  process.env.RENDER !== 'true' &&
  process.env.ENABLE_PUBLIC_DEMO === 'true' &&
  !!MOCK_PASSWORD;

export const mockUser: User = {
  id: 'u1',
  username: MOCK_USERNAME,
  displayName: 'Super Admin',
  role: 'superadmin',
};

export function createSession(user: User): string {
  for (const [token, session] of sessions) {
    if (session.expiresAt <= Date.now()) sessions.delete(token);
  }
  if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function getSessionUser(token: string | undefined): User | undefined {
  if (!token || !demoEnabled()) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return session.user;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = accessToken(req);
  const user = getSessionUser(token);
  if (user) {
    (req as Request & { user: User }).user = user;
    next();
    return;
  }
  if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  try {
    const { data, error } = await identity.user(token);
    if(providerUnavailable(error)){res.status(503).json({error:'Account verification is unavailable. Try again shortly.'});return;}
    if (error || !data.user || !data.user.email_confirmed_at) {
      res
        .status(401)
        .json({ error: 'Sign in with a verified account to continue.' });
      return;
    }
    (req as Request & { user: User }).user = profile(data.user);
    (req as AuthenticatedRequest).providerUser=data.user;
    next();
  } catch {
    res
      .status(503)
      .json({
        error: 'Account verification is unavailable. Try again shortly.',
      });
  }
}

export function requireWorkspaceAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const user = (req as Request & { user?: User }).user;
  if (user?.passwordSetupRequired) {
    res
      .status(403)
      .json({
        error: 'Set your account password before opening the stable workspace.',
      });
    return;
  }
  if (user?.role !== 'superadmin') {
    res
      .status(403)
      .json({ error: 'This stable workspace requires admin access.' });
    return;
  }
  next();
}
