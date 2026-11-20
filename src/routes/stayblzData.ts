import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncRoute } from '../middleware/asyncRoute';
import { getHorse, getRace, listHorses, listRaces, meta, type ListQuery } from '../lib/stayblzData';

/** Stayblz Data (Explore → Stayblz Data): the Equibase race day kept in data/horse-racing. Signed in only. */
const router = Router();
router.use(requireAuth);

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** Reads ?offset, ?limit, ?track and ?q; null when any of them is malformed. */
function listQuery(req: Request): ListQuery | null {
  const { offset: rawOffset, limit: rawLimit, track: rawTrack, q: rawQ } = req.query;
  for (const v of [rawOffset, rawLimit, rawTrack, rawQ]) if (v !== undefined && typeof v !== 'string') return null;
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return null;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
  const track = typeof rawTrack === 'string' && rawTrack ? rawTrack.toUpperCase() : undefined;
  if (track && !/^[A-Z0-9]{1,6}$/.test(track)) return null;
  const q = typeof rawQ === 'string' ? rawQ.trim().slice(0, 60) : '';
  return { offset, limit, track, q: q || undefined };
}

/** Runs a read against the data file; a missing or unreadable file is a 503, not a crash. */
function serve(res: Response, read: () => unknown) {
  let body: unknown;
  try {
    body = read();
  } catch {
    res.status(503).json({ error: 'Stayblz data is unavailable.' });
    return;
  }
  if (body === null) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  res.json(body);
}

router.get('/meta', asyncRoute(async (_req, res) => serve(res, meta)));

router.get(
  '/races',
  asyncRoute(async (req, res) => {
    const query = listQuery(req);
    if (!query) return void res.status(400).json({ error: 'Invalid races request.' });
    serve(res, () => listRaces(query));
  }),
);

router.get(
  '/horses',
  asyncRoute(async (req, res) => {
    const query = listQuery(req);
    if (!query) return void res.status(400).json({ error: 'Invalid horses request.' });
    serve(res, () => listHorses(query));
  }),
);

router.get('/races/:id', asyncRoute(async (req, res) => serve(res, () => getRace(String(req.params.id)))));
router.get('/horses/:refno', asyncRoute(async (req, res) => serve(res, () => getHorse(String(req.params.refno)))));

export default router;
