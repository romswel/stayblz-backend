import { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';
import { User } from '../types';

const router = Router();

router.use(requireAuth);

function formatPost(row: any) {
  return {
    id: row.id,
    author: row.author,
    role: row.role,
    body: row.body,
    createdAt: row.created_at
  };
}

router.get('/', async (_req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('feed_posts')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return res.status(500).json({
      error: 'Failed to load posts.'
    });
  }

  return res.json({
    posts: (data ?? []).map(formatPost)
  });
});

router.post('/', async (req: Request, res: Response) => {
  const body =
    typeof req.body?.body === 'string'
      ? req.body.body.trim()
      : '';

  if (!body) {
    return res.status(400).json({
      error: 'Write something before posting.'
    });
  }

  if (body.length > 500) {
    return res.status(400).json({
      error: 'Posts are limited to 500 characters.'
    });
  }

  const user = (req as Request & { user: User }).user;

  const { data, error } = await supabase
    .from('feed_posts')
    .insert({
      id: crypto.randomBytes(8).toString('hex'),
      author: user.displayName,
      role: user.role,
      body
    })
    .select()
    .single();

  if (error) {
    return res.status(500).json({
      error: 'Failed to create post.'
    });
  }

  return res.status(201).json({
    post: formatPost(data)
  });
});

export default router;
