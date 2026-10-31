import { Request, Response, Router } from 'express';
import { requireAuth, requireWorkspaceAdmin } from '../middleware/auth';
import { kinds, publicRecord, type Kind } from './publicRacing';
import { supabase } from '../lib/supabase';
import { asyncRoute } from '../middleware/asyncRoute';
import {
  entries,
  jockeyStandings,
  results,
  speedFigures,
  stakesSchedule,
  trainerStandings,
  virtualStable,
  workouts,
} from '../data/racing';

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
router.use(requireWorkspaceAdmin);

router.get('/entries', (_req: Request, res: Response) => res.json({ entries }));
router.get('/results', (_req: Request, res: Response) => res.json({ results }));
router.get('/workouts', (_req: Request, res: Response) =>
  res.json({ workouts }),
);
router.get('/speed-figures', (_req: Request, res: Response) =>
  res.json({ speedFigures }),
);
router.get('/statistics', (_req: Request, res: Response) =>
  res.json({ jockeys: jockeyStandings, trainers: trainerStandings }),
);
router.get('/stakes', (_req: Request, res: Response) =>
  res.json({ stakes: stakesSchedule }),
);
router.get('/virtual-stable', (_req: Request, res: Response) =>
  res.json({ stable: virtualStable }),
);

// Toggle a watch flag (in-memory; persists until server restart).
router.post('/virtual-stable/toggle', (req: Request, res: Response) => {
  const { name } = req.body ?? {};
  const item = virtualStable.find((w) => w.name === name);
  if (!item)
    return res.status(404).json({ error: 'Horse not found in stable list.' });
  item.watched = !item.watched;
  return res.json({ item });
});

export default router;
