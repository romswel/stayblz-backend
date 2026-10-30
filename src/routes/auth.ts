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

// POST /api/auth/login — mock credentials for development only.
router.post('/login', (req: Request, res: Response) => {
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
