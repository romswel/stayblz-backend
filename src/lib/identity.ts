import {
  createClient,
  type User as ProviderUser,
  type Session,
} from "@supabase/supabase-js";
import type { Request, Response } from "express";
import { supabase } from "./supabase";
import type { User } from "../types";

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

export function profile(user: ProviderUser): User {
  const info = user.user_metadata ?? {};
  const firstName =
    typeof info.first_name === "string" ? info.first_name.slice(0, 60) : "";
  const lastName =
    typeof info.last_name === "string" ? info.last_name.slice(0, 60) : "";
  const admin = user.app_metadata?.stayblz_role === "superadmin";
  return {
    id: user.id,
    username: admin ? "superadmin" : (user.email ?? ""),
    displayName:
      `${firstName} ${lastName}`.trim() || (admin ? "Super Admin" : "Member"),
    role: admin ? "superadmin" : "member",
    email: user.email,
    emailVerified: !!user.email_confirmed_at,
    passwordSetupRequired:
      user.app_metadata?.stayblz_require_password_setup === true,
    profile: {
      firstName,
      lastName,
      country:
        typeof info.country === "string" ? info.country.slice(0, 80) : "",
      racingRole:
        typeof info.racing_role === "string"
          ? info.racing_role.slice(0, 40)
          : "",
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
export function sessionCookies(res: Response, session: Session) {
  res.cookie("stayblz_access", session.access_token, {
    ...baseCookie(),
    path: "/api",
    maxAge: Math.min(session.expires_in || 3600, 3600) * 1000,
  });
  res.cookie("stayblz_refresh", session.refresh_token, {
    ...baseCookie(),
    path: "/api/auth",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}
export function clearSession(res: Response) {
  res.clearCookie("stayblz_access", { ...baseCookie(), path: "/api" });
  res.clearCookie("stayblz_refresh", { ...baseCookie(), path: "/api/auth" });
}

let adminAlias: { email: string; expires: number } | null = null;
export class AdminSetupRequiredError extends Error {
  constructor() {
    super(
      "Finish your admin email invitation and set a password before logging in.",
    );
  }
}
export async function resolveEmail(value: string): Promise<string | null> {
  if (value.includes("@")) return value.toLowerCase();
  if (value.toLowerCase() !== "superadmin") return null;
  if (process.env.SUPERADMIN_EMAIL)
    return process.env.SUPERADMIN_EMAIL.trim().toLowerCase();
  if (adminAlias && adminAlias.expires > Date.now()) return adminAlias.email;
  let pendingAdmin = false;
  // Compatibility for the existing admin username. Only a server-assigned role qualifies.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw error;
    if (
      data.users.some(
        (user) =>
          user.app_metadata?.stayblz_role === "superadmin" &&
          !user.email_confirmed_at &&
          user.email,
      )
    )
      pendingAdmin = true;
    const admin = data.users.find(
      (user) =>
        user.app_metadata?.stayblz_role === "superadmin" &&
        user.email_confirmed_at &&
        user.email,
    );
    if (admin?.email) {
      adminAlias = { email: admin.email, expires: Date.now() + 60_000 };
      return admin.email;
    }
    if (data.users.length < 100) break;
  }
  if (pendingAdmin) throw new AdminSetupRequiredError();
  return null;
}
