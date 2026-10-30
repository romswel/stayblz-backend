import { Request, Response, Router } from 'express';
import { horses } from '../data/mock';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// GET /api/horses — tracked horses with status + training info.
router.get('/', (_req: Request, res: Response) => {
  res.json({ horses });
});

// GET /api/horses/:id
router.get('/:id', (req: Request, res: Response) => {
  const horse = horses.find((h) => h.id === req.params.id);
  if (!horse) return res.status(404).json({ error: 'Horse not found.' });
  return res.json({ horse });
});

export default router;
