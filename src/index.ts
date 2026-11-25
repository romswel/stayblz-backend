// Must be first: fills process.env from .env (local) or Render's Secret File before the app loads.
import './lib/loadEnv';
import { app } from './app';
import { startRacingSchedule } from './lib/racingFeed/pull';
import { startBillingSchedule } from './lib/billing/schedule';
import { startFormFavIndex } from './lib/formFavIndex';
import { startFormFavSync } from './lib/formFavSync';
import { startChatSchedule } from './lib/chatSchedule';

const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
app.listen(port, '0.0.0.0', () => {
  console.log(`Stayblz API running on port ${port}`);
  // Racing data from The Racing API while the server is awake (needs RACING_API_USERNAME/PASSWORD).
  if (startRacingSchedule()) console.log('Racing data schedule on (The Racing API).');
  // Renewals, retries, bank clearing and autopay (Stayblz Billing), every minute while awake.
  if (startBillingSchedule()) console.log('Billing schedule on.');
  // Stayblz Data's A–Z horses / jockeys / trainers from FormFav (needs FORMFAV_API_KEY), every 30 min while awake.
  if (startFormFavIndex()) {
    console.log('FormFav index schedule on.');
    // After each refresh: linked horses' details, race logs and alerts (Virtual Stayblz / owned horses).
    startFormFavSync();
  }
  // Scheduled updates in Stayblz Chat (Philippine times), checked every minute while awake.
  if (startChatSchedule()) console.log('Chat schedule on.');
});
