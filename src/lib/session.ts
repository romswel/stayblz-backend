import type { Response } from "express";
import type { Session, User as ProviderUser } from "@supabase/supabase-js";
import { accountStore } from "./accounts";
import { clearSession, profile, sessionCookies, tokenAal } from "./identity";
import { supabase } from "./supabase";
import { suspendedMessage } from "../middleware/auth";
import type { User } from "../types";

/**
 * Issues session cookies only for an active account and returns its browser profile.
 * Suspended accounts get no session: the new provider session is revoked at once.
 * Returns null after it has already sent an error response.
 */
export async function startSession(
  res: Response,
  user: ProviderUser,
  session: Session,
): Promise<User | null> {
  let account;
  try {
    account = await accountStore.load(user.id);
  } catch {
    res.status(503).json({ error: "Sign-in is unavailable. Try again shortly." });
    return null;
  }
  if (account.status !== "active") {
    await supabase.auth.admin
      .signOut(session.access_token, "global")
      .catch(() => undefined);
    clearSession(res);
    res.status(403).json({ code: "account_suspended", error: suspendedMessage });
    return null;
  }
  sessionCookies(res, session);
  return profile(user, account, tokenAal(session.access_token));
}
