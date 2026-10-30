import { Request, Response, Router } from 'express';
import { conversations, horses, inventory } from '../data/mock';
import { requireAuth } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// GET /api/dashboard — aggregated overview for the landing page.
router.get('/', (_req: Request, res: Response) => {
  const raceReady = horses.filter((h) => h.status === 'Race ready' || h.status === 'Entered').length;
  const inWork = horses.filter((h) => h.status === 'In training').length;
  const recovering = horses.filter((h) => h.status === 'Recovering').length;
  const unread = conversations.reduce((sum, c) => sum + c.unread, 0);

  const engagements = horses
    .filter((h) => h.nextRace !== null)
    .map((h) => ({
      id: h.id,
      saddlecloth: h.saddlecloth,
      silksColor: h.silksColor,
      coatColor: h.coatColor,
      maneColor: h.maneColor,
      blaze: h.blaze,
      name: h.name,
      jockey: h.jockey,
      nextRace: h.nextRace as string
    }))
    .sort((a, b) => a.nextRace.localeCompare(b.nextRace));

  const recentMessages = conversations
    .map(({ messages, ...preview }) => preview)
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    .slice(0, 3);

  // Mock leaderboard — replace with real race-results aggregation later.
  const leaderboard = {
    yesterdayTop: [
      { rank: 1, name: 'Silver Comet', earningsUsd: 114000, meeting: 'Naga Turf Club', race: 'Race 3' },
      { rank: 2, name: 'Night Parade', earningsUsd: 111000, meeting: 'Naga Turf Club', race: 'Race 7' },
      { rank: 3, name: 'Bravado Star', earningsUsd: 98500, meeting: 'Naga Turf Club', race: 'Race 6' }
    ],
    leading: [
      { rank: 1, name: 'Golden Tempo', earningsUsd: 4750000 },
      { rank: 2, name: 'Renegade', earningsUsd: 2435000 },
      { rank: 3, name: 'Silver Comet', earningsUsd: 2247400 },
      { rank: 4, name: 'Napoleon Solo', earningsUsd: 1691520 },
      { rank: 5, name: 'Counting Stars', earningsUsd: 1502000 },
      { rank: 6, name: 'Night Parade', earningsUsd: 1446250 },
      { rank: 7, name: 'Commandment', earningsUsd: 1403020 },
      { rank: 8, name: 'Magnitude', earningsUsd: 1374500 },
      { rank: 9, name: 'In Our Time', earningsUsd: 1301213 },
      { rank: 10, name: 'Knightsbridge', earningsUsd: 1233610 }
    ],
    season: 2026
  };

  res.json({
    stats: {
      horses: inventory.length,
      raceReady,
      inWork,
      recovering,
      unread
    },
    engagements,
    recentMessages,
    leaderboard
  });
});

export default router;
