import { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { User } from '../types';

/**
 * Development-only session store.
 * Replace with real auth (DB-backed users, hashed passwords, JWT/sessions)
 * before any production use.
 */
const sessions = new Map<string, User>();

export const MOCK_USERNAME = 'superadmin';
export const MOCK_PASSWORD = 'staybliz123';

export const mockUser: User = {
  id: 'u1',
  username: MOCK_USERNAME,
  displayName: 'Super Admin',
  role: 'superadmin'
};

export function createSession(user: User): string {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, user);
  return token;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function getSessionUser(token: string | undefined): User | undefined {
  if (!token) return undefined;
  return sessions.get(token);
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
