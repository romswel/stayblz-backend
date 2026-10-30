import { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { User } from '../types';

interface FeedPost {
  id: string;
  author: string;
  role: string;
  body: string;
  createdAt: string;
}

// In-memory seed — replace with a database table for production.
const posts: FeedPost[] = [
  {
    id: 'p1',
    author: 'Miguel Ortega',
    role: 'trainer',
    body: 'Silver Comet came out of Saturday\u2019s win in great order. Light week, then we build toward the Sep 20 allowance.',
    createdAt: '2026-09-15T07:20:00Z'
  },
  {
    id: 'p2',
    author: 'Anna Reyes',
    role: 'trainer',
    body: 'Entries confirmed for Metro Downs R3 \u2014 Night Parade drew post 1. Blinkers stay on.',
    createdAt: '2026-09-15T11:45:00Z'
  },
  {
    id: 'p3',
    author: 'Erik Vet Services',
    role: 'veterinary',
    body: 'Iron Duke re-scan looks clean. Cleared for walker + light trot this week; re-evaluate Friday.',
    createdAt: '2026-09-16T06:05:00Z'
  },
  {
    id: 'p4',
    author: 'R. Villanueva',
    role: 'jockey',
    body: 'Breezed Bravado Star over the hill course \u2014 he\u2019s pulling like a train. Ready for 1600m.',
    createdAt: '2026-09-16T08:30:00Z'
  }
];

const router = Router();
router.use(requireAuth);

// GET /api/feed — newest first.
router.get('/', (_req: Request, res: Response) => {
  const sorted = [...posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ posts: sorted });
});

// POST /api/feed — create a post as the signed-in user.
router.post('/', (req: Request, res: Response) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) return res.status(400).json({ error: 'Write something before posting.' });
  if (body.length > 500) return res.status(400).json({ error: 'Posts are limited to 500 characters.' });

  const user = (req as Request & { user: User }).user;
  const post: FeedPost = {
    id: crypto.randomBytes(8).toString('hex'),
    author: user.displayName,
    role: user.role,
    body,
    createdAt: new Date().toISOString()
  };
  posts.push(post);
  return res.status(201).json({ post });
});

export default router;
