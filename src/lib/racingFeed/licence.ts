/**
 * Which racing data sources may be shown publicly (docs/racing-data-feed.md). Hand-entered cards ('' source) always
 * may. The Racing API's terms allow its data "for use in the creation of applications, websites, and data analysis",
 * so its cards publish. Anything else — the co-dev's collected Equibase files, a future Equibase feed — stays a draft
 * until the owner lists it in RACING_FEED_LICENSED (comma-separated sources, or "yes" for every source).
 */
const ALLOWED_BY_TERMS = ["theracingapi"];

export function sourceLicensed(source: string | null | undefined) {
  if (!source) return true;
  const setting = (process.env.RACING_FEED_LICENSED ?? "").trim().toLowerCase();
  if (setting === "yes") return true;
  return ALLOWED_BY_TERMS.includes(source) || setting.split(",").map((s) => s.trim()).includes(source);
}

export const licences = () => ({ equibase: sourceLicensed("equibase"), theracingapi: sourceLicensed("theracingapi") });
