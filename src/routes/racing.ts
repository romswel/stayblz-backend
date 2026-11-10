import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { kinds, racingSection, type Kind } from './publicRacing';
import { asyncRoute } from '../middleware/asyncRoute';

const router = Router();
router.use(requireAuth);
router.get(
  '/published/:kind',
  asyncRoute(async (req, res) => {
    const kind = String(req.params.kind) as Kind;
    const rawOffset = req.query.offset;
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    if (
      !kinds.includes(kind) ||
      typeof rawOffset === 'object' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 100000
    ) {
      res.status(400).json({ error: 'Invalid records request.' });
      return;
    }
    let source: unknown[];
    try {
      source = await racingSection(kind, offset, 51);
    } catch {
      res.status(503).json({
        error: 'Racing records are unavailable. Please try again later.',
      });
      return;
    }
    res.json({
      records: source.slice(0, 50),
      nextOffset: source.length > 50 ? offset + 50 : null,
    });
  }),
);
export default router;
