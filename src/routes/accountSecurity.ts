import { Router, type Response } from "express";
import type { Session, User as ProviderUser } from "@supabase/supabase-js";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import {
  requireAuth,
  requireSession,
  type AuthenticatedRequest,
} from "../middleware/auth";
import {
  accessToken,
  clearSession,
  identity,
  persistentSession,
  profile,
  tokenAal,
  verifiedTotp,
} from "../lib/identity";
import {
  accountStore,
  AccountError,
  fromApiRole,
  roleRank,
} from "../lib/accounts";
import { startSession } from "../lib/session";
import { supabase } from "../lib/supabase";

/** Mounted inside /api/auth: "View as" and 2-step login. */
const router = Router();
const devOnly = (res: Response) =>
  res.status(409).json({ error: "Development profiles cannot use this setting." });

/** Staff can view the site as a lower role. The server never allows a higher one. */
router.post(
  "/view-as",
  authLimit("view-as", 30, 60_000),
  requireAuth,
  asyncRoute(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const role = fromApiRole(req.body?.role);
    if (!request.account || !request.providerUser) return void devOnly(res);
    if (!role || roleRank(role) > roleRank(request.account.platform_role)) {
      res.status(403).json({ error: "Your account cannot use that view." });
      return;
    }
    try {
      const account = await accountStore.setActingRole(request.user.id, role);
      res.json({
        user: profile(request.providerUser, account, tokenAal(accessToken(req))),
      });
    } catch (error) {
      res
        .status(
          error instanceof AccountError && error.code === "not_allowed" ? 403 : 503,
        )
        .json({ error: "The view could not be changed. Try again." });
    }
  }),
);

/* ---------------- 2-step login (authenticator app codes) ---------------- */

const sixDigits = (value: unknown): value is string =>
  typeof value === "string" && /^\d{6}$/.test(value);
const mfaUnavailable = (res: Response) =>
  res
    .status(503)
    .json({ error: "2-step login is unavailable right now. Try again shortly." });
const wrongCode = (res: Response) =>
  res.status(400).json({
    code: "mfa_invalid",
    error: "That code did not match. Check your app and try again.",
  });

router.get("/mfa", requireSession, (req, res) => {
  const request = req as AuthenticatedRequest;
  const factors = request.providerUser ? verifiedTotp(request.providerUser) : [];
  res.json({
    enabled: factors.length > 0,
    verified: tokenAal(accessToken(req)) === "aal2",
    factors: factors.map((factor) => ({
      id: factor.id,
      createdAt: factor.created_at,
    })),
  });
});

/** Starts set-up: returns a QR code for an authenticator app. Not active until verified. */
router.post(
  "/mfa/enroll",
  authLimit("mfa-enroll", 5, 15 * 60_000),
  requireAuth,
  asyncRoute(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const provider = request.providerUser;
    const token = accessToken(req);
    if (!provider || !token) return void devOnly(res);
    if (verifiedTotp(provider).length > 0) {
      res.status(409).json({ error: "2-step login is already on for this account." });
      return;
    }
    try {
      // Clear abandoned set-up attempts so a fresh QR code can be issued.
      for (const factor of provider.factors ?? [])
        if (factor.status !== "verified") {
          const removed = await supabase.auth.admin.mfa.deleteFactor({
            id: factor.id,
            userId: provider.id,
          });
          if (removed.error) throw removed.error;
        }
      const result = await identity.gotrue("/factors", token, "POST", {
        factor_type: "totp",
        friendly_name: `Stayblz ${new Date().toISOString().slice(0, 19)}`,
        issuer: "Stayblz",
      });
      const totp = result.data.totp as
        | { qr_code?: string; secret?: string }
        | undefined;
      if (
        !result.ok ||
        typeof result.data.id !== "string" ||
        typeof totp?.qr_code !== "string" ||
        !totp.qr_code.startsWith("data:image/svg+xml") ||
        typeof totp.secret !== "string"
      )
        return void mfaUnavailable(res);
      res.status(201).json({
        factorId: result.data.id,
        qrCode: totp.qr_code,
        secret: totp.secret,
      });
    } catch {
      mfaUnavailable(res);
    }
  }),
);

/** Checks a 6-digit code: finishes set-up, or completes sign-in when 2-step login is on. */
router.post(
  "/mfa/verify",
  authLimit("mfa-verify", 10, 10 * 60_000),
  requireSession,
  asyncRoute(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const provider = request.providerUser;
    const token = accessToken(req);
    const { code, factorId } = req.body ?? {};
    if (!provider || !token) return void devOnly(res);
    if (!sixDigits(code)) {
      res.status(400).json({ error: "Enter the 6-digit code from your authenticator app." });
      return;
    }
    const factor =
      typeof factorId === "string"
        ? (provider.factors ?? []).find(
            (item) => item.id === factorId && item.factor_type === "totp",
          )
        : verifiedTotp(provider)[0];
    // While a code is outstanding, only an already-active factor can complete sign-in.
    if (!factor || (request.user.mfaPending && factor.status !== "verified")) {
      res.status(400).json({ error: "Start 2-step login set-up again." });
      return;
    }
    const outcome = await checkCode(token, factor.id, code);
    if (outcome.kind === "unavailable") return void mfaUnavailable(res);
    if (outcome.kind === "wrong") {
      await accountStore.record("auth.mfa_failed", provider.id, provider.id);
      return void wrongCode(res);
    }
    // The verify response may not list the factor as verified yet; read it fresh.
    let fresh: ProviderUser = outcome.user;
    try {
      const reread = await supabase.auth.admin.getUserById(provider.id);
      if (!reread.error && reread.data.user) fresh = reread.data.user;
    } catch {
      /* keep the verify response */
    }
    const user = await startSession(res, fresh, outcome.session, persistentSession(req));
    if (!user) return;
    await accountStore.record(
      factor.status === "verified" ? "auth.mfa_passed" : "auth.mfa_enabled",
      provider.id,
      provider.id,
    );
    res.json({ user });
  }),
);

/** Turning 2-step login off needs a fresh code, so a stolen session alone cannot do it. */
router.post(
  "/mfa/disable",
  authLimit("mfa-verify", 10, 10 * 60_000),
  requireAuth,
  asyncRoute(async (req, res) => {
    const request = req as AuthenticatedRequest;
    const provider = request.providerUser;
    const token = accessToken(req);
    if (!provider || !token) return void devOnly(res);
    if (!sixDigits(req.body?.code)) {
      res.status(400).json({ error: "Enter the 6-digit code from your authenticator app." });
      return;
    }
    const factor = verifiedTotp(provider)[0];
    if (!factor) {
      res.status(409).json({ error: "2-step login is already off." });
      return;
    }
    const outcome = await checkCode(token, factor.id, req.body.code);
    if (outcome.kind === "unavailable") return void mfaUnavailable(res);
    if (outcome.kind === "wrong") {
      await accountStore.record("auth.mfa_failed", provider.id, provider.id);
      return void wrongCode(res);
    }
    const removed = await identity.gotrue(
      `/factors/${encodeURIComponent(factor.id)}`,
      outcome.session.access_token,
      "DELETE",
    );
    if (!removed.ok) return void mfaUnavailable(res);
    await accountStore.record("auth.mfa_disabled", provider.id, provider.id);
    // End every session so none keeps its 2-step status; sign in again with the password.
    await supabase.auth.admin
      .signOut(outcome.session.access_token, "global")
      .catch(() => undefined);
    clearSession(res);
    res.json({ ok: true, signedOut: true });
  }),
);

async function checkCode(
  token: string,
  factorId: string,
  code: string,
): Promise<
  | { kind: "ok"; session: Session; user: ProviderUser }
  | { kind: "wrong" }
  | { kind: "unavailable" }
> {
  try {
    const path = `/factors/${encodeURIComponent(factorId)}`;
    const challenge = await identity.gotrue(`${path}/challenge`, token, "POST", {});
    if (challenge.status >= 500) return { kind: "unavailable" };
    if (!challenge.ok || typeof challenge.data.id !== "string")
      return { kind: "wrong" };
    const verified = await identity.gotrue(`${path}/verify`, token, "POST", {
      challenge_id: challenge.data.id,
      code,
    });
    if (verified.status >= 500) return { kind: "unavailable" };
    const session = verified.data as unknown as Session;
    if (
      !verified.ok ||
      typeof session.access_token !== "string" ||
      typeof session.refresh_token !== "string" ||
      !session.user
    )
      return { kind: "wrong" };
    return { kind: "ok", session, user: session.user };
  } catch {
    return { kind: "unavailable" };
  }
}

export default router;
