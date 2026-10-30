import { Request, Response, Router } from 'express';
import { inventory } from '../data/mock';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// GET /api/inventory — all inventory records.
router.get('/', (_req: Request, res: Response) => {
  res.json({ items: inventory });
});

// GET /api/inventory/:id
router.get('/:id', (req: Request, res: Response) => {
  const item = inventory.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Record not found.' });
  return res.json({ item });
});

export default router;
