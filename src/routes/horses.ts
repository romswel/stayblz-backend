import { asyncRoute } from '../middleware/asyncRoute';
import { Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = Router();

router.use(requireAuth);

const fields = `
  id,
  trainer,
  jockey,
  status,
  condition,
  form,
  last_workout,
  next_race,
  location,
  horse_inventory (
    horse_name,
    breed,
    age,
    coat_color,
    mane_color,
    blaze,
    saddlecloth,
    silks_color
  )
`;

function formatHorse(row: any) {
  const horse = row.horse_inventory;
  if (!horse) return null;

  return {
    id: row.id,
    name: horse.horse_name,
    breed: horse.breed,
    age: horse.age,
    coatColor: horse.coat_color,
    maneColor: horse.mane_color,
    blaze: horse.blaze,
    saddlecloth: horse.saddlecloth,
    silksColor: horse.silks_color,
    trainer: row.trainer,
    jockey: row.jockey,
    status: row.status,
    condition: row.condition,
    form: row.form,
    lastWorkout: row.last_workout,
    nextRace: row.next_race,
    location: row.location
  };
}

router.get('/', asyncRoute(async (_req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('horse_tracking')
    .select(fields);

  if (error) {
    return res.status(500).json({
      error: 'Failed to load tracked horses.'
    });
  }

  return res.json({
    horses: (data ?? []).map(formatHorse).filter(Boolean)
  });
}));

router.get('/:id', asyncRoute(async (req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('horse_tracking')
    .select(fields)
    .eq('id', String(req.params.id))
    .maybeSingle();

  if (error) {
    return res.status(500).json({
      error: 'Failed to load horse.'
    });
  }

  if (!data || !data.horse_inventory) {
    return res.status(404).json({
      error: 'Horse not found.'
    });
  }

  return res.json({
    horse: formatHorse(data)
  });
}));

export default router;
