import express, { Request, Response } from 'express';
import cors from 'cors';
import authRoutes from './routes/auth';
import messageRoutes from './routes/messages';
import inventoryRoutes from './routes/inventory';
import horseRoutes from './routes/horses';
import dashboardRoutes from './routes/dashboard';
import racingRoutes from './routes/racing';
import feedRoutes from './routes/feed';
import bettingRoutes from './routes/betting';
import { supabase } from './lib/supabase';

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

const allowedOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim());

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'stayblz-api', time: new Date().toISOString() });
});

app.get('/api/db-health', async (_req: Request, res: Response) => {
  try {
    const { error } = await supabase
      .from('connection_test')
      .select('id')
      .limit(1);

    if (error) {
      return res.status(500).json({
        ok: false,
        error: error.message
      });
    }

    return res.json({ ok: true, database: 'connected' });
  } catch {
    return res.status(500).json({
      ok: false,
      error: 'Database connection failed'
    });
  }
});

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/racing', racingRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/betting', bettingRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/horses', horseRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stayblz API running on port ${PORT}`);
});
