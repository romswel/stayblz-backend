// Must be first: fills process.env from .env (local) or Render's Secret File before the app loads.
import './lib/loadEnv';
import { app } from './app';
import { startRacingSchedule } from './lib/racingFeed/pull';

const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
app.listen(port, '0.0.0.0', () => {
  console.log(`Stayblz API running on port ${port}`);
  // Racing data from The Racing API while the server is awake (needs RACING_API_USERNAME/PASSWORD).
  if (startRacingSchedule()) console.log('Racing data schedule on (The Racing API).');
});
