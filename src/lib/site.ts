/**
 * Where the Stayblz website lives. Set FRONTEND_URL (and optionally AUTH_SITE_URL) on the server;
 * the defaults below only apply when they are missing.
 */
export const PRODUCTION_SITE = "https://stayblz-app.com";
const LOCAL_SITE = "http://localhost:5173";

export const isProduction = () =>
  process.env.NODE_ENV === "production" || process.env.RENDER === "true";

// Browsers send origins without a trailing slash, so "https://site.com/" must still match.
const clean = (origin: string) => origin.trim().replace(/\/+$/, "");

/** Exact browser origins allowed to call the API with cookies (FRONTEND_URL, comma-separated). */
export function frontendOrigins(): string[] {
  const configured = (process.env.FRONTEND_URL ?? "")
    .split(",")
    .map(clean)
    .filter(Boolean);
  return configured.length ? configured : [isProduction() ? PRODUCTION_SITE : LOCAL_SITE];
}

/** The site that email redirects point to: AUTH_SITE_URL, else the first frontend origin. */
export function siteOrigin(): string {
  return clean(process.env.AUTH_SITE_URL ?? "") || frontendOrigins()[0];
}
