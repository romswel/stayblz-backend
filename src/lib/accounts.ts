import { supabase } from "./supabase";

/** Database role names. The API reports `customer` as `member` for older clients. */
export type PlatformRole = "customer" | "admin" | "superadmin";
export type ApiRole = "member" | "admin" | "superadmin";

export interface AccountRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  country: string;
  racing_role: string;
  platform_role: PlatformRole;
  acting_role: "customer" | "admin" | null;
  status: "active" | "suspended" | "closed";
  status_reason: string;
  community_roles: string[];
  organisation: string;
  city: string;
  bio: string;
  terms_version: string;
  terms_accepted_at: string | null;
  marketing_opt_in: boolean;
  updates_seen_at: string | null;
  updates_popup: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProfileDetails {
  first_name: string;
  last_name: string;
  country: string;
  racing_role: string;
  community_roles: string[];
  organisation: string;
  city: string;
  bio: string;
}

const rank: Record<string, number> = {
  customer: 0,
  member: 0,
  admin: 1,
  superadmin: 2,
};
export const roleRank = (role: string | undefined) => rank[role ?? ""] ?? -1;
export const toApiRole = (role: PlatformRole): ApiRole =>
  role === "customer" ? "member" : role;
export const fromApiRole = (role: unknown): PlatformRole | null =>
  role === "member" || role === "customer"
    ? "customer"
    : role === "admin" || role === "superadmin"
      ? role
      : null;

/** The role a request acts with: the chosen view, never above the real role. */
export function effectiveRole(account: AccountRow): PlatformRole {
  return account.acting_role &&
    roleRank(account.acting_role) < roleRank(account.platform_role)
    ? account.acting_role
    : account.platform_role;
}

export class AccountError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function call(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const known = [
      "unknown_account",
      "not_allowed",
      "invalid_status",
    ].find((code) => String(error.message ?? "").includes(code));
    throw new AccountError(known ?? "unavailable");
  }
  if (!data || typeof data !== "object") throw new AccountError("unavailable");
  return data as AccountRow;
}

/** Overridable in tests. Every write goes through a checked database function. */
export const accountStore = {
  load: (userId: string) => call("ensure_account", { p_user: userId }),
  updateProfile: (userId: string, details: ProfileDetails) =>
    call("update_account_profile", {
      p_user: userId,
      p_first: details.first_name,
      p_last: details.last_name,
      p_country: details.country,
      p_racing_role: details.racing_role,
      p_community_roles: details.community_roles,
      p_organisation: details.organisation,
      p_city: details.city,
      p_bio: details.bio,
    }),
  /** Undefined leaves a setting unchanged. */
  updatePreferences: (
    userId: string,
    prefs: { marketingOptIn?: boolean; updatesSeen?: boolean; updatesPopup?: boolean },
  ) =>
    call("update_account_preferences", {
      p_user: userId,
      p_marketing: prefs.marketingOptIn ?? null,
      p_updates_seen: prefs.updatesSeen ?? null,
      p_updates_popup: prefs.updatesPopup ?? null,
    }),
  setActingRole: (userId: string, role: PlatformRole) =>
    call("set_account_acting_role", { p_user: userId, p_role: role }),
  setStatus: (
    actorId: string,
    subjectId: string,
    status: "active" | "suspended",
    reason: string,
  ) =>
    call("set_account_status", {
      p_actor: actorId,
      p_subject: subjectId,
      p_status: status,
      p_reason: reason,
    }),
  /** Best effort: a failed audit write is logged but never blocks the user. */
  async record(
    event: string,
    accountId: string | null,
    actorId: string | null,
    detail: Record<string, unknown> = {},
  ) {
    try {
      const { error } = await supabase.from("account_events").insert({
        account_id: accountId,
        actor_id: actorId,
        event,
        detail,
      });
      if (error) throw error;
    } catch {
      console.error(`account event not recorded: ${event}`);
    }
  },
};
