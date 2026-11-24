import { supabase } from "./supabase";
import { linkView } from "./formFavLink";

/**
 * Community horse shapes and visibility checks, shared by /api/community and Virtual Stayblz.
 * Who may see a horse: its owner always; otherwise the horse's own setting, or the owner's
 * inventory setting when the horse says 'inherit' (members, followers only, or private).
 */

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

export const HORSE_COLUMNS =
  "id,owner_id,name,breed,sex,foaled_year,color,sire,dam,status,trainer,location,description,visibility,cover_image_id,created_at,updated_at,formfav_name,formfav_code,formfav_key,formfav_runner_id,formfav_linked_at,formfav_synced_at,formfav_alerts";

export type Stats = { starts: number; wins: number; places: number; shows: number; earnings_cents: number; last_race: string | null };
const noStats: Stats = { starts: 0, wins: 0, places: 0, shows: 0, earnings_cents: 0, last_race: null };

export function horseView(h: any, stats: Stats | undefined, opts: { mine: boolean; showEarnings: boolean; imageCount?: number }) {
  const s = stats ?? noStats;
  return {
    id: h.id,
    ownerId: h.owner_id,
    name: h.name,
    breed: h.breed,
    sex: h.sex,
    foaledYear: h.foaled_year,
    color: h.color,
    sire: h.sire,
    dam: h.dam,
    status: h.status,
    trainer: h.trainer,
    location: h.location,
    description: h.description,
    // Only the owner needs to know the privacy setting.
    visibility: opts.mine ? h.visibility : undefined,
    coverImageId: h.cover_image_id,
    imageCount: opts.imageCount,
    stats: {
      starts: num(s.starts),
      wins: num(s.wins),
      places: num(s.places),
      shows: num(s.shows),
      earningsCents: opts.showEarnings || opts.mine ? num(s.earnings_cents) : null,
      lastRace: s.last_race,
    },
    mine: opts.mine,
    // Race data the owner linked (lib/formFavLink.ts); only the owner sees their alerts setting.
    raceData: linkView(h) && { ...linkView(h)!, alertsOn: opts.mine ? h.formfav_alerts !== false : undefined },
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  };
}

export function recordView(r: any, showEarnings: boolean) {
  return {
    id: r.id,
    raceDate: r.race_date,
    track: r.track,
    raceName: r.race_name,
    distance: r.distance,
    surface: r.surface,
    finish: r.finish,
    fieldSize: r.field_size,
    earningsCents: showEarnings ? num(r.earnings_cents) : null,
    notes: r.notes,
    fromRaceData: !!r.formfav_ref,
  };
}

export const IMAGE_COLUMNS = "id,kind,width,height,caption,position,duration_seconds,poster_path";
export const imageView = (i: any) => ({
  id: i.id,
  kind: i.kind === "video" ? "video" : "photo",
  width: i.width,
  height: i.height,
  caption: i.caption ?? "",
  position: i.position,
  durationSeconds: i.kind === "video" ? (i.duration_seconds ?? null) : null,
  hasPoster: !!i.poster_path,
});

/* ============================== Visibility helpers ============================== */

export type OwnerContext = { level: "members" | "followers" | "private"; showEarnings: boolean; follows: boolean; headline: string };

export async function ownerContext(viewer: string, owner: string): Promise<OwnerContext> {
  const [profile, follow] = await Promise.all([
    supabase.from("community_profiles").select("inventory_visibility,show_earnings,headline").eq("user_id", owner).maybeSingle(),
    viewer === owner
      ? Promise.resolve({ data: null, error: null })
      : supabase.from("community_follows").select("follower_id").eq("follower_id", viewer).eq("followee_id", owner).maybeSingle(),
  ]);
  if (profile.error || follow.error) throw profile.error ?? follow.error;
  return {
    level: (profile.data?.inventory_visibility as OwnerContext["level"]) ?? "members",
    showEarnings: profile.data?.show_earnings ?? true,
    follows: !!follow.data,
    headline: profile.data?.headline ?? "",
  };
}

export function canSeeHorse(viewer: string, horse: { owner_id: string; visibility: string }, ctx: OwnerContext) {
  if (viewer === horse.owner_id) return true;
  const level = horse.visibility === "inherit" ? ctx.level : horse.visibility;
  return level === "members" || (level === "followers" && ctx.follows);
}

export async function loadStats(ids: string[]) {
  const map = new Map<string, Stats>();
  if (!ids.length) return map;
  const { data, error } = await supabase.from("owner_horse_stats").select("*").in("horse_id", ids);
  if (error) throw error;
  for (const row of data ?? []) map.set(row.horse_id, row as Stats);
  return map;
}

export async function accountActive(id: string) {
  const { data, error } = await supabase.from("accounts").select("id,status").eq("id", id).maybeSingle();
  if (error) throw error;
  return !!data && data.status === "active";
}


/**
 * A community horse with photos, race records and owner, exactly as `viewer` may see it.
 * Returns null when it doesn't exist, the owner isn't active, or the viewer can't see it. Throws on database errors.
 */
export async function loadCommunityHorse(viewer: string, id: string) {
  const { data: horse, error } = await supabase.from("owner_horses").select(HORSE_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw error;
  if (!horse || !(await accountActive(horse.owner_id))) return null;
  const ctx = await ownerContext(viewer, horse.owner_id);
  if (!canSeeHorse(viewer, horse, ctx)) return null;
  const mine = viewer === horse.owner_id;
  const showEarnings = mine || ctx.showEarnings;
  const [stats, images, records, owner] = await Promise.all([
    loadStats([horse.id]),
    supabase.from("owner_horse_images").select(IMAGE_COLUMNS).eq("horse_id", horse.id).order("position").order("created_at"),
    supabase
      .from("owner_horse_records")
      .select("id,race_date,track,race_name,distance,surface,finish,field_size,earnings_cents,notes,formfav_ref")
      .eq("horse_id", horse.id)
      .order("race_date", { ascending: false })
      .limit(500),
    supabase.from("accounts").select("id,first_name,last_name").eq("id", horse.owner_id).maybeSingle(),
  ]);
  const failed = images.error ?? records.error ?? owner.error;
  if (failed) throw failed;
  return {
    ...horseView(horse, stats.get(horse.id), { mine, showEarnings, imageCount: images.data?.length ?? 0 }),
    images: (images.data ?? []).map(imageView),
    records: (records.data ?? []).map((r) => recordView(r, showEarnings)),
    owner: {
      id: horse.owner_id,
      name: `${owner.data?.first_name ?? ""} ${owner.data?.last_name ?? ""}`.trim() || "Stayblz member",
      headline: ctx.headline,
      isFollowing: ctx.follows,
      me: mine,
    },
  };
}
