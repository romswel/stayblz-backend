// Web Push keys for "alerts when Stayblz is closed" (see src/lib/push.ts).
//   npm run push:keys              → prints a new key pair to paste into Render → Environment (keep it secret)
//   npm run push:keys -- --write   → adds a new pair to this folder's .env if it has none (prints nothing secret)
// Changing the keys later means every device has to turn alerts on again, so create them once per environment.
const fs = require("node:fs");
const path = require("node:path");
const webpush = require("web-push");

const keys = webpush.generateVAPIDKeys();
const lines = [
  `PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`,
  "PUSH_CONTACT=mailto:support@stayblz-app.com",
];

if (process.argv.includes("--write")) {
  const file = path.join(__dirname, "..", ".env");
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (/^PUSH_VAPID_PRIVATE_KEY=.+/m.test(current)) {
    console.log(".env already has push keys; nothing changed.");
  } else {
    fs.writeFileSync(file, current.replace(/\s*$/, "\n") + "\n# Web Push (alerts when Stayblz is closed)\n" + lines.join("\n") + "\n");
    console.log("Added push keys to .env (values not shown).");
  }
} else {
  console.log("Add these to the backend's environment (Render → Environment). Keep the private key secret:\n");
  console.log(lines.join("\n"));
}
