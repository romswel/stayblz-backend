import express, { Request, Response, ErrorRequestHandler } from 'express';
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

export const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const allowedOrigins = (process.env.FRONTEND_URL ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim());

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json({ limit: '32kb' }));

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
        error: 'Database connection failed'
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

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status = error?.type === 'entity.too.large' ? 413 : error?.type === 'entity.parse.failed' ? 400 : 500;
  res.status(status).json({ error: status === 413 ? 'Request body is too large.' : status === 400 ? 'Invalid JSON body.' : 'Something went wrong. Please try again.' });
};
app.use(errorHandler);
