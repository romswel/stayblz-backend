import { createHash } from "node:crypto";
import { supabase } from "./supabase";
import { formFavKey } from "./formFav";
import * as idx from "./formFavIndex";

/**
 * Linking a Stayblz horse to a race-data horse (FormFav, through the A–Z index in lib/formFavIndex.ts): Virtual
 * Stayblz horses (added from the Racing horses tab, or typed in by hand and linked) and owned horses.
 * Migration 202611240001_virtual_racing_horses.sql; the sync that keeps linked horses up to date and sends their
 * alerts is lib/formFavSync.ts.
 *
 * A race-data horse is known by its name and code only (FormFav has no id for it in meeting results), keyed as
 * idx.horseKey(name, code) — the same key everywhere (formfav_key columns, follower counts, alerts).
 */

export class LinkError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Database columns race data keeps up to date (and the API locks) while a horse is linked. */
export const LOCKED_COLUMNS = ["trainer", "sire", "dam", "sex", "foaled_year", "breed"] as const;

const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
/** A person's name for comparing (FormFav writes "J. Acosta" one day and "J Acosta" the next). */
export const personKey = (name: string | null | undefined) => (name ? fold(name.replace(/\./g, " ")) : "");

/** The same UUID for the same text every time (SHA-1, version 5 layout): one per race start or event. */
export function refFor(text: string) {
  const b = createHash("sha1").update(`stayblz-formfav:${text}`).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** One race start of one horse. */
export const startBase = (s: idx.Start, name: string) => `${s.code}|${s.date}|${s.slug}|${s.raceNumber ?? 0}|${fold(name)}`;

export const breedFor = (code: string) => (code === "harness" ? "Standardbred" : "Thoroughbred");

const SEXES: Record<string, string> = {
  c: "colt",
  colt: "colt",
  f: "filly",
  filly: "filly",
  m: "mare",
  mare: "mare",
  g: "gelding",
  gelding: "gelding",
  h: "stallion",
  horse: "stallion",
  stallion: "stallion",
  r: "ridgling",
  rig: "ridgling",
  ridgling: "ridgling",
};
/** FormFav's "Filly" / "G" / "Horse" → Stayblz's sexes, or null when it's something else. */
export const sexFrom = (v: unknown) => (typeof v === "string" ? (SEXES[v.trim().toLowerCase()] ?? null) : null);

/** North American racing ages roll over on 1 January, so the foaling year is the race's year minus the age. */
export function foaledFrom(age: unknown, raceDate: string) {
  if (typeof age !== "number" || !Number.isInteger(age) || age < 1 || age > 30) return null;
  const year = Number(raceDate.slice(0, 4)) - age;
  return year >= 1980 && year <= new Date().getUTCFullYear() ? year : null;
}

/** "1308m" → "6½f (1,308 m)"; anything else as it is. */
export function distanceLabel(d: string | null | undefined) {
  if (!d) return "";
  const m = /^(\d{3,5})\s*m$/i.exec(d.trim());
  if (!m) return d.trim().slice(0, 40);
  const metres = Number(m[1]);
  const halves = Math.round((metres / 201.168) * 2);
  const furlongs = `${Math.floor(halves / 2) || ""}${halves % 2 ? "½" : ""}` || "0";
  return `${furlongs}f (${metres.toLocaleString("en-US")} m)`;
}

/**
 * What a member picked ({name, code}) as the index knows it. Only horses that raced or were entered in the US/Canada
 * window can be picked; the stored name is FormFav's own spelling.
 */
export function resolveRacingHorse(body: { name?: unknown; code?: unknown }) {
  const code = body.code;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!(idx.INDEX_CODES as readonly unknown[]).includes(code) || !name || name.length > 100)
    throw new LinkError(400, "Choose a racing horse.");
  if (!formFavKey()) throw new LinkError(503, "Race data isn't available right now.");
  idx.ensureIndex();
  if (idx.indexStatus().building) throw new LinkError(503, "Race data is still loading. Try again in a minute.");
  const horse = idx.getHorse(name, code as idx.IndexCode);
  if (!horse) throw new LinkError(404, "That horse isn't in the last 30 days of US and Canada race data.");
  return { name: horse.name, code: code as idx.IndexCode, key: idx.horseKey(horse.name, code as string), horse };
}

/** The link columns for a newly linked horse. */
export function linkColumns(target: { name: string; code: string; key: string }) {
  return {
    formfav_name: target.name.slice(0, 100),
    formfav_code: target.code,
    formfav_key: target.key.slice(0, 120),
    formfav_linked_at: new Date().toISOString(),
    formfav_synced_at: null,
  };
}

/** The link as the API shows it (null when not linked). */
export const linkView = (h: any) =>
  h?.formfav_key
    ? {
        name: h.formfav_name as string,
        code: h.formfav_code as string,
        runnerId: h.formfav_runner_id === null || h.formfav_runner_id === undefined ? null : Number(h.formfav_runner_id),
        linkedAt: h.formfav_linked_at as string,
        syncedAt: (h.formfav_synced_at as string | null) ?? null,
      }
    : null;

/** Live race data for a linked horse: the index summary and its runs in the window (null when it has none now). */
export function liveRaceData(link: { name: string; code: string }) {
  idx.ensureIndex();
  const status = idx.indexStatus();
  const horse = idx.getHorse(link.name, link.code as idx.IndexCode);
  return { building: status.building, coverage: status.coverage, updatedAt: status.updatedAt, horse };
}

// ── follower counts ─────────────────────────────────────────────────────────────────────────────────────────────────
let counts: { until: number; map: Map<string, number> } | null = null;
/** Distinct people tracking each race-data horse (only horses someone tracks), cached for a minute. */
export async function followerCounts() {
  if (counts && Date.now() < counts.until) return counts.map;
  const { data, error } = await supabase.rpc("formfav_follower_counts", {});
  if (error) throw error;
  const map = new Map<string, number>();
  for (const row of Array.isArray(data) ? data : []) if (typeof row?.key === "string") map.set(row.key, Number(row.followers) || 0);
  counts = { until: Date.now() + 60_000, map };
  return map;
}
/** After a horse is added, removed, linked or unlinked. */
export function bustFollowerCounts() {
  counts = null;
}
