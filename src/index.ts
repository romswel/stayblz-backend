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

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'stayblz-api', time: new Date().toISOString() });
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

app.listen(PORT, () => {
  console.log(`Stayblz API running on http://localhost:${PORT}`);
});
