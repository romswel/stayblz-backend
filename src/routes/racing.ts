import { Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  entries,
  jockeyStandings,
  results,
  speedFigures,
  stakesSchedule,
  trainerStandings,
  virtualStable,
  workouts
} from '../data/racing';

const router = Router();
router.use(requireAuth);

router.get('/entries', (_req: Request, res: Response) => res.json({ entries }));
router.get('/results', (_req: Request, res: Response) => res.json({ results }));
router.get('/workouts', (_req: Request, res: Response) => res.json({ workouts }));
router.get('/speed-figures', (_req: Request, res: Response) => res.json({ speedFigures }));
router.get('/statistics', (_req: Request, res: Response) =>
  res.json({ jockeys: jockeyStandings, trainers: trainerStandings })
);
router.get('/stakes', (_req: Request, res: Response) => res.json({ stakes: stakesSchedule }));
router.get('/virtual-stable', (_req: Request, res: Response) => res.json({ stable: virtualStable }));

// Toggle a watch flag (in-memory; persists until server restart).
router.post('/virtual-stable/toggle', (req: Request, res: Response) => {
  const { name } = req.body ?? {};
  const item = virtualStable.find((w) => w.name === name);
  if (!item) return res.status(404).json({ error: 'Horse not found in stable list.' });
  item.watched = !item.watched;
  return res.json({ item });
});

export default router;
