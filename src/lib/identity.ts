import {
  createClient,
  type User as ProviderUser,
  type Session,
} from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { supabase } from "./supabase";
import type { User } from "../types";
import { effectiveRole, toApiRole, type AccountRow } from "./accounts";

export const identity = {
  client: () =>
    createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_SECRET_KEY!,
      {
        global: {
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: init?.signal ?? AbortSignal.timeout(15000),
            }),
        },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    ),
  user: (token: string) => supabase.auth.getUser(token),
  /** Calls the provider's user-scoped auth API (2-step login) with the caller's own token. */
  async gotrue(
    path: string,
    token: string,
    method: "GET" | "POST" | "DELETE",
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1${path}`, {
      method,
      headers: {
        apikey:
          process.env.SUPABASE_PUBLISHABLE_KEY ||
          process.env.SUPABASE_SECRET_KEY!,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { ok: response.ok, status: response.status, data };
  },
};
export function providerUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const failure = error as { status?: number; name?: string };
  return (
    failure.status === 0 ||
    (typeof failure.status === "number" && failure.status >= 500) ||
    ["AuthRetryableFetchError", "TimeoutError", "AbortError"].includes(
      failure.name ?? "",
    )
  );
}

export function tokenAal(token: string | undefined): "aal1" | "aal2" {
  // Only read after the provider verified this token.
  try {
    const claims = JSON.parse(
      Buffer.from(token?.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return claims?.aal === "aal2" ? "aal2" : "aal1";
  } catch {
    return "aal1";
  }
}

export const verifiedTotp = (user: ProviderUser) =>
  (user.factors ?? []).filter(
    (factor) => factor.factor_type === "totp" && factor.status === "verified",
  );

/** The browser-facing account. Roles and profile come from `accounts`, never from the token. */
export function profile(
  user: ProviderUser,
  account: AccountRow,
  aal: "aal1" | "aal2" = "aal1",
): User {
  const role = toApiRole(effectiveRole(account));
  const platformRole = toApiRole(account.platform_role);
  const mfaEnabled = verifiedTotp(user).length > 0;
  return {
    id: user.id,
    username: user.email ?? account.email,
    displayName:
      `${account.first_name} ${account.last_name}`.trim() ||
      (platformRole === "superadmin"
        ? "Super Admin"
        : platformRole === "admin"
          ? "Admin"
          : "Member"),
    role,
    platformRole,
    actingRole: role === platformRole ? null : (role as "admin" | "member"),
    accountStatus: account.status,
    email: user.email,
    emailVerified: !!user.email_confirmed_at,
    passwordSetupRequired:
      user.app_metadata?.stayblz_require_password_setup === true,
    mfa: { enabled: mfaEnabled, verified: aal === "aal2" },
    mfaPending: mfaEnabled && aal !== "aal2",
    profile: {
      firstName: account.first_name,
      lastName: account.last_name,
      country: account.country,
      racingRole: account.racing_role,
      communityRoles: account.community_roles ?? [],
      organisation: account.organisation ?? "",
      city: account.city ?? "",
      bio: account.bio ?? "",
    },
    preferences: {
      marketingOptIn: !!account.marketing_opt_in,
      // Never marked as read: count posts from a week before the account was made.
      updatesSeenAt:
        account.updates_seen_at ??
        new Date(Date.parse(account.created_at || "2026-11-01T00:00:00Z") - 7 * 864e5).toISOString(),
      updatesPopup: account.updates_popup !== false,
    },
  };
}

const baseCookie = () => ({
  httpOnly: true,
  secure:
    process.env.NODE_ENV === "production" || process.env.RENDER === "true",
  sameSite: "lax" as const,
});
export function cookie(req: Request, name: string): string | undefined {
  const value = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="))
    ?.slice(name.length + 1);
  if (!value || value.length > 16384) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
export function accessToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header
    ? header.startsWith("Bearer ") && header.length < 16391
      ? header.slice(7)
      : undefined
    : cookie(req, "stayblz_access");
}
/**
 * "Keep me signed in" (persistent, default): cookies survive closing the browser and the
 * refresh cookie lasts 30 days from the last visit. Otherwise both are browser-session
 * cookies, and a marker keeps renewals session-only too.
 */
export function sessionCookies(res: Response, session: Session, persistent = true) {
  res.cookie("stayblz_access", session.access_token, {
    ...baseCookie(),
    path: "/api",
    ...(persistent
      ? { maxAge: Math.min(session.expires_in || 3600, 3600) * 1000 }
      : {}),
  });
  res.cookie("stayblz_refresh", session.refresh_token, {
    ...baseCookie(),
    path: "/api/auth",
    ...(persistent ? { maxAge: 30 * 24 * 60 * 60 * 1000 } : {}),
  });
  if (persistent)
    res.clearCookie("stayblz_session_only", { ...baseCookie(), path: "/api/auth" });
  else
    res.cookie("stayblz_session_only", "1", { ...baseCookie(), path: "/api/auth" });
}
export const persistentSession = (req: Request) =>
  cookie(req, "stayblz_session_only") !== "1";
export function clearSession(res: Response) {
  res.clearCookie("stayblz_access", { ...baseCookie(), path: "/api" });
  res.clearCookie("stayblz_refresh", { ...baseCookie(), path: "/api/auth" });
  res.clearCookie("stayblz_session_only", { ...baseCookie(), path: "/api/auth" });
}

/** Sign-in is by email only. There is no shared admin username. */
export function resolveEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
    ? email
    : null;
}
