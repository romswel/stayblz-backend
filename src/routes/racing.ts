import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { kinds, publicRecord, type Kind } from './publicRacing';
import { supabase } from '../lib/supabase';
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
    const { data, error } = await supabase
      .from('site_racing_records')
      .select('id,payload')
      .eq('kind', kind)
      .eq('publication_status', 'published')
      .lte('published_at', new Date().toISOString())
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + 50);
    if (error) {
      res
        .status(503)
        .json({
          error: 'Racing records are unavailable. Please try again later.',
        });
      return;
    }
    const source = data ?? [];
    res.json({
      records: source
        .slice(0, 50)
        .map((row) => publicRecord(row, kind))
        .filter(Boolean),
      nextOffset: source.length > 50 ? offset + 50 : null,
    });
  }),
);
export default router;
