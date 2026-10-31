import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { User } from '../types';

/**
 * Development-only session store.
 * Replace with real auth (DB-backed users, hashed passwords, JWT/sessions)
 * before any production use.
 */
const sessions = new Map<string, { user: User; expiresAt: number }>();
const SESSION_TTL_MS = 60 * 60 * 1000;

export const MOCK_USERNAME = 'superadmin';
export const MOCK_PASSWORD = 'staybliz123';

export const mockUser: User = {
  id: 'u1',
  username: MOCK_USERNAME,
  displayName: 'Super Admin',
  role: 'superadmin'
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
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return undefined;
  }
  return session.user;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  const user = getSessionUser(token);
  if (!user) {
    res.status(401).json({ error: 'Sign in to continue.' });
    return;
  }
  (req as Request & { user: User }).user = user;
  next();
}
