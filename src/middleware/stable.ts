import type { NextFunction, Request, Response } from "express";
import { supabase } from "../lib/supabase";
import type { AuthenticatedRequest } from "./auth";
export interface StableRequest extends AuthenticatedRequest {
  stable: {
    id: string;
    role: "owner" | "manager" | "member";
    displayName: string;
  };
}
export const isUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export async function requireStable(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const user = (req as AuthenticatedRequest).user;
  if (user.passwordSetupRequired) {
    res
      .status(403)
      .json({ error: "Set your account password before opening a stable." });
    return;
  }
  const id = req.get("X-Stayblz-Stable");
  if (!isUuid(id)) {
    res
      .status(403)
      .json({
        error: "Choose a stable you belong to.",
        code: "stable_required",
      });
    return;
  }
  try {
    const { data, error } = await supabase
      .from("stable_memberships")
      .select("role,display_name")
      .eq("stable_id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data || !["owner", "manager", "member"].includes(data.role)) {
      res
        .status(403)
        .json({
          error: "You do not have access to this stable.",
          code: "stable_access_denied",
        });
      return;
    }
    (req as StableRequest).stable = {
      id,
      role: data.role,
      displayName: user.displayName,
    };
    next();
  } catch {
    res
      .status(503)
      .json({
        error: "Stable services are unavailable. Please try again later.",
      });
  }
}
export function requireStableManager(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!["owner", "manager"].includes((req as StableRequest).stable.role)) {
    res
      .status(403)
      .json({
        error: "Only this stable’s owner or managers can make this change.",
      });
    return;
  }
  next();
}
