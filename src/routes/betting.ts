import { Request, Response, Router } from 'express';
import crypto from 'crypto';
import { requireAuth, requireWorkspaceAdmin } from '../middleware/auth';
import { entries } from '../data/racing';

/**
 * Mock wagering module — demo credits only, no real money.
 * Markets are derived from the entries data; wallet, transactions,
 * and bets live in memory. Replace with real accounts, a payments
 * provider, and licensed wagering infrastructure for production.
 */

interface Runner { pp: number; horse: string; ml: string; silksColor: string; decimal: number; }
interface Market {
  id: string;
  league: string;
  track: string;
  raceNo: number;
  date: string;
  postTime: string;
  distance: string;
  surface: string;
  runners: Runner[];
}

interface Txn { id: string; type: 'deposit' | 'bet'; amount: number; note: string; at: string; }
interface Bet {
  id: string;
  marketId: string;
  raceLabel: string;
  horse: string;
  ml: string;
  stake: number;
  potential: number;
  status: 'Open';
  placedAt: string;
}

function mlToDecimal(ml: string): number {
  const [a, b] = ml.split('-').map(Number);
  if (!a || !b) return 2;
  return Number((a / b + 1).toFixed(2));
}

const LEAGUES: Record<string, string> = {
  'Naga Turf Club': 'Provincial Cup Series',
  'Metro Downs': 'Metro Champions League'
};

const markets: Market[] = entries.flatMap((t) =>
  t.races.map((r) => ({
    id: `${t.track.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-r${r.raceNo}`,
    league: LEAGUES[t.track] ?? 'Open Meeting',
    track: t.track,
    raceNo: r.raceNo,
    date: t.date,
    postTime: r.postTime,
    distance: r.distance,
    surface: r.surface,
    runners: r.entries.map((e) => ({
      pp: e.pp,
      horse: e.horse,
      ml: e.ml,
      silksColor: e.silksColor,
      decimal: mlToDecimal(e.ml)
    }))
  }))
);

const wallet = { balance: 1000 };
const transactions: Txn[] = [
  { id: 't0', type: 'deposit', amount: 1000, note: 'Welcome demo credits', at: '2026-09-16T00:00:00Z' }
];
const bets: Bet[] = [];

const router = Router();
router.use(requireAuth, requireWorkspaceAdmin);

// GET /api/betting/markets — upcoming league races with odds.
router.get('/markets', (_req: Request, res: Response) => {
  res.json({ markets });
});

// GET /api/betting/wallet — balance + recent transactions.
router.get('/wallet', (_req: Request, res: Response) => {
  res.json({
    balance: Number(wallet.balance.toFixed(2)),
    transactions: [...transactions].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12)
  });
});

// POST /api/betting/wallet/deposit — mock top-up of demo credits.
router.post('/wallet/deposit', (req: Request, res: Response) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Enter an amount above zero.' });
  }
  if (amount > 10000) {
    return res.status(400).json({ error: 'Demo deposits are capped at 10,000 credits.' });
  }
  wallet.balance += amount;
  transactions.push({
    id: crypto.randomBytes(6).toString('hex'),
    type: 'deposit',
    amount,
    note: 'Demo credit top-up',
    at: new Date().toISOString()
  });
  return res.status(201).json({ balance: Number(wallet.balance.toFixed(2)) });
});

// GET /api/betting/bets — the user's bet history.
router.get('/bets', (_req: Request, res: Response) => {
  res.json({ bets: [...bets].sort((a, b) => b.placedAt.localeCompare(a.placedAt)) });
});

// POST /api/betting/bets — place a win bet with demo credits.
router.post('/bets', (req: Request, res: Response) => {
  const { marketId, horse } = req.body ?? {};
  const stake = Number(req.body?.stake);

  const market = markets.find((m) => m.id === marketId);
  if (!market) return res.status(404).json({ error: 'Race not found.' });
  const runner = market.runners.find((r) => r.horse === horse);
  if (!runner) return res.status(404).json({ error: 'Horse not found in this race.' });
  if (!Number.isFinite(stake) || stake < 1) {
    return res.status(400).json({ error: 'Minimum stake is 1 credit.' });
  }
  if (stake > wallet.balance) {
    return res.status(400).json({ error: 'Not enough credits — top up your wallet first.' });
  }

  wallet.balance -= stake;
  const bet: Bet = {
    id: crypto.randomBytes(6).toString('hex'),
    marketId: market.id,
    raceLabel: `${market.track} · R${market.raceNo} · ${market.distance}`,
    horse: runner.horse,
    ml: runner.ml,
    stake,
    potential: Number((stake * runner.decimal).toFixed(2)),
    status: 'Open',
    placedAt: new Date().toISOString()
  };
  bets.push(bet);
  transactions.push({
    id: crypto.randomBytes(6).toString('hex'),
    type: 'bet',
    amount: -stake,
    note: `Win bet — ${runner.horse} (${runner.ml})`,
    at: bet.placedAt
  });
  return res.status(201).json({ bet, balance: Number(wallet.balance.toFixed(2)) });
});

export default router;
