import { asyncRoute } from '../middleware/asyncRoute';
import { Request, Response, Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { supabase } from '../lib/supabase';

const router = Router();

router.use(requireAuth);

function formatHorse(row: any) {
  return {
    id: row.id,
    saddlecloth: row.saddlecloth,
    silksColor: row.silks_color,
    coatColor: row.coat_color,
    maneColor: row.mane_color,
    blaze: row.blaze,
    horseName: row.horse_name,
    breed: row.breed,
    age: row.age,
    sex: row.sex,
    status: row.status,
    stable: row.stable,
    valueUsd: Number(row.value_usd),
    acquiredAt: row.acquired_at
  };
}

router.get('/', asyncRoute(async (_req: Request, res: Response) => {
  const { data, error } = await supabase
    .from('horse_inventory')
    .select('*')
    .order('saddlecloth', { ascending: true });

  if (error) {
    return res.status(500).json({
      error: 'Failed to load inventory.'
    });
  }

  return res.json({
    items: (data ?? []).map(formatHorse)
  });
}));

router.get('/:id', asyncRoute(async (req: Request, res: Response) => {
  const id = String(req.params.id);

  const { data, error } = await supabase
    .from('horse_inventory')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    return res.status(500).json({
      error: 'Failed to load horse.'
    });
  }

  if (!data) {
    return res.status(404).json({
      error: 'Record not found.'
    });
  }

  return res.json({
    item: formatHorse(data)
  });
}));

export default router;
