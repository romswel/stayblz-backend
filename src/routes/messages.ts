import { Request, Response, Router } from 'express';
import { conversations } from '../data/mock';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// GET /api/messages — conversation list with previews.
router.get('/', (_req: Request, res: Response) => {
  const list = conversations.map(({ messages, ...preview }) => preview);
  res.json({ conversations: list });
});

// GET /api/messages/:id — full conversation thread.
router.get('/:id', (req: Request, res: Response) => {
  const conversation = conversations.find((c) => c.id === req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  return res.json({ conversation });
});

export default router;
