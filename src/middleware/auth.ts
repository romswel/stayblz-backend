import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { User } from '../types';
import type { User as ProviderUser } from '@supabase/supabase-js';
import { accessToken, identity, profile, providerUnavailable, tokenAal } from '../lib/identity';
import { accountStore, roleRank, type AccountRow, type ApiRole } from '../lib/accounts';

/**
 * Explicitly enabled local/test sessions only. Production uses verified Supabase
 * identities and HttpOnly cookies; this store is disabled on Render/production.
 */
const sessions = new Map<string, { user: User; expiresAt: number }>();
const SESSION_TTL_MS = 60 * 60 * 1000;
export interface AuthenticatedRequest extends Request {
  user: User;
  providerUser?: ProviderUser;
  account?: AccountRow;
}

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

export const suspendedMessage =
  'This account is suspended. Contact Stayblz support if you think this is a mistake.';

/**
 * Verifies the provider session, then loads the account row on every request so a
 * suspension or role change applies immediately, not when the token expires.
 */
function authenticate(allowMfaPending: boolean) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = accessToken(req);
    const demo = getSessionUser(token);
    if (demo) {
      (req as AuthenticatedRequest).user = demo;
      next();
      return;
    }
    if (!token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    try {
      const { data, error } = await identity.user(token);
      if (providerUnavailable(error)) {
        res.status(503).json({ error: 'Account verification is unavailable. Try again shortly.' });
        return;
      }
      if (error || !data.user || !data.user.email_confirmed_at) {
        res.status(401).json({ error: 'Sign in with a verified account to continue.' });
        return;
      }
      const account = await accountStore.load(data.user.id);
      if (account.status !== 'active') {
        res.status(403).json({ code: 'account_suspended', error: suspendedMessage });
        return;
      }
      const user = profile(data.user, account, tokenAal(token));
      if (user.mfaPending && !allowMfaPending) {
        res.status(403).json({ code: 'mfa_required', error: 'Enter your 2-step login code to continue.' });
        return;
      }
      const request = req as AuthenticatedRequest;
      request.user = user;
      request.providerUser = data.user;
      request.account = account;
      next();
    } catch {
      res.status(503).json({ error: 'Account verification is unavailable. Try again shortly.' });
    }
  };
}

/** A fully signed-in account (2-step login passed when it is turned on). */
export const requireAuth = authenticate(false);
/** Signed in with a password; the 2-step code may still be outstanding. */
export const requireSession = authenticate(true);

/**
 * Platform staff check. Uses the role the person is currently acting with, so
 * "View as: Customer" really does remove admin access until switched back.
 * Set REQUIRE_STAFF_MFA=true to make 2-step login mandatory for staff.
 */
export function requireRole(minimum: Exclude<ApiRole, 'member'>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as Partial<AuthenticatedRequest>).user;
    if (user?.passwordSetupRequired) {
      res.status(403).json({ error: 'Set your account password before opening administration.' });
      return;
    }
    if (!user || roleRank(user.role) < roleRank(minimum)) {
      res.status(403).json({
        error: minimum === 'superadmin' ? 'This page requires superadmin access.' : 'This page requires admin access.',
      });
      return;
    }
    if (process.env.REQUIRE_STAFF_MFA === 'true' && user.id !== 'u1' && !user.mfa?.verified) {
      res.status(403).json({
        code: 'mfa_setup_required',
        error: 'Turn on 2-step login on your Profile page before opening administration.',
      });
      return;
    }
    next();
  };
}
