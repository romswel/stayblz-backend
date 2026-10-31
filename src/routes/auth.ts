import { Request, Response, Router } from 'express';
import {
  MOCK_PASSWORD,
  MOCK_USERNAME,
  createSession,
  destroySession,
  getSessionUser,
  mockUser
} from '../middleware/auth';

const router = Router();
const attempts = new Map<string, { count: number; expiresAt: number }>();

// POST /api/auth/login — mock credentials for development only.
router.post('/login', (req: Request, res: Response) => {
  const now = Date.now();
  for (const [key, attempt] of attempts) {
    if (attempt.expiresAt <= now) attempts.delete(key);
  }
  const key = req.ip ?? 'unknown';
  const attempt = attempts.get(key) ?? { count: 0, expiresAt: now + 60_000 };
  if (attempt.count >= 20) {
    res.setHeader('Retry-After', Math.max(1, Math.ceil((attempt.expiresAt - now) / 1000)));
    return res.status(429).json({ error: 'Too many sign-in attempts. Try again shortly.' });
  }
  if (attempts.size >= 1000 && !attempts.has(key)) {
    return res.status(429).json({ error: 'Sign-in is busy. Try again shortly.' });
  }
  attempt.count++;
  attempts.set(key, attempt);
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Enter a username and password.' });
  }
  if (username !== MOCK_USERNAME || password !== MOCK_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const token = createSession(mockUser);
  return res.json({ token, user: mockUser });
});

// POST /api/auth/logout
router.post('/logout', (req: Request, res: Response) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  destroySession(token);
  res.json({ ok: true });
});

// GET /api/auth/me — restore a session on page reload.
router.get('/me', (req: Request, res: Response) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  return res.json({ user });
});

export default router;
