import type { ProfileDetails } from "./accounts";

/** Keys match public.stayblz_community_roles(). They describe people; they never grant access. */
export const COMMUNITY_ROLES = [
  "owner", "syndicate", "breeder", "bloodstock",
  "trainer", "assistant_trainer", "jockey", "apprentice", "exercise_rider", "jockey_agent",
  "staff", "farrier", "vet", "equine_therapist",
  "official", "track_staff",
  "handicapper", "media",
  "fan", "newcomer",
  "other",
] as const;

/** Bump when the Terms or Privacy Notice change in a way people must accept again. */
export const TERMS_VERSION = "2026-11-10";

const unsafe = /[\u0000-\u0008\u000b-\u001f\u007f<>]/;
const text = (value: unknown, min: number, max: number, multiline = false) =>
  typeof value === "string" &&
  value.trim().length >= min &&
  value.trim().length <= max &&
  !unsafe.test(value) &&
  (multiline || !/\n/.test(value));
const optional = (value: unknown, max: number, multiline = false) =>
  value === undefined || value === null || text(value, 0, max, multiline);

/**
 * Validates the profile part of sign-up and profile edits. Returns null when anything is
 * invalid. Never accepts permission fields; those are rejected separately.
 */
export function profileInput(body: Record<string, unknown>): ProfileDetails | null {
  const roles = body.communityRoles ?? [];
  if (
    !text(body.firstName, 1, 60) ||
    !text(body.lastName, 1, 60) ||
    typeof body.country !== "string" ||
    !/^[A-Z]{2}$/.test(body.country) ||
    typeof body.racingRole !== "string" ||
    !(COMMUNITY_ROLES as readonly string[]).includes(body.racingRole) ||
    !Array.isArray(roles) ||
    roles.length > 3 ||
    new Set(roles).size !== roles.length ||
    roles.some(
      (role) =>
        typeof role !== "string" ||
        !(COMMUNITY_ROLES as readonly string[]).includes(role) ||
        role === body.racingRole,
    ) ||
    !optional(body.organisation, 100) ||
    !optional(body.city, 80) ||
    !optional(body.bio, 280, true)
  )
    return null;
  const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return {
    first_name: clean(body.firstName),
    last_name: clean(body.lastName),
    country: body.country,
    racing_role: body.racingRole,
    community_roles: roles as string[],
    organisation: clean(body.organisation),
    city: clean(body.city),
    bio: clean(body.bio).replace(/\n{3,}/g, "\n\n"),
  };
}
