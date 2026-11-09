import { Router, type Request, type Response } from "express";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import {
  MOCK_PASSWORD,
  MOCK_USERNAME,
  createSession,
  destroySession,
  getSessionUser,
  demoEnabled,
  mockUser,
  requireAuth,
  requireSession,
  suspendedMessage,
  type AuthenticatedRequest,
} from "../middleware/auth";
import {
  identity,
  profile,
  resolveEmail,
  clearSession,
  cookie,
  accessToken,
  providerUnavailable,
  tokenAal,
} from "../lib/identity";
import { accountStore } from "../lib/accounts";
import { startSession } from "../lib/session";
import accountSecurity from "./accountSecurity";
import { supabase } from "../lib/supabase";
import type { User } from "../types";
import { sendAuthEmailError, isUnknownRecipient } from "../lib/authEmailErrors";

const router = Router();
const emailValid = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const strongPassword = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 12 &&
  value.length <= 128 &&
  /[a-z]/.test(value) &&
  /[A-Z]/.test(value) &&
  /[0-9]/.test(value);
const shortName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length >= 1 &&
  value.trim().length <= 60 &&
  !/[\u0000-\u001f<>]/.test(value);
const countryValid = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z]{2}$/.test(value);
const roles = ["owner", "trainer", "jockey", "staff", "fan", "other"];
function profileInput(body: Record<string, unknown>) {
  if (
    !shortName(body.firstName) ||
    !shortName(body.lastName) ||
    !countryValid(body.country) ||
    typeof body.racingRole !== "string" ||
    !roles.includes(body.racingRole)
  )
    return null;
  return {
    first_name: body.firstName.trim(),
    last_name: body.lastName.trim(),
    country: body.country,
    racing_role: body.racingRole,
  };
}
const appOrigin = () =>
  (
    process.env.AUTH_SITE_URL ||
    process.env.FRONTEND_URL?.split(",")[0] ||
    (process.env.NODE_ENV === "production"
      ? "https://stayblz-frontend.vercel.app"
      : "http://localhost:5173")
  ).replace(/\/$/, "");
const confirmationUrl = () => `${appOrigin()}/auth/confirm`;
const genericMail = {
  ok: true,
  message:
    "If the address can receive this request, an email will arrive shortly.",
};

router.use((req, res, next) => {
  if (req.method !== "GET" && !req.is("application/json")) {
    res.status(415).json({ error: "Send account requests as JSON." });
    return;
  }
  next();
});

router.post(
  "/login",
  authLimit("login", 20, 60_000),
  asyncRoute(async (req, res) => {
    const { username, password } = req.body ?? {};
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      !username.trim() ||
      username.length > 254 ||
      password.length > 128
    ) {
      res.status(400).json({ error: "Enter your email and password." });
      return;
    }
    if (
      demoEnabled() &&
      username === MOCK_USERNAME &&
      password === MOCK_PASSWORD
    ) {
      res.json({ token: createSession(mockUser), user: mockUser });
      return;
    }
    try {
      const email = resolveEmail(username);
      if (!email) {
        res.status(401).json({ error: "Incorrect email or password." });
        return;
      }
      const { data, error } = await identity
        .client()
        .auth.signInWithPassword({ email, password });
      if (providerUnavailable(error)) {
        res
          .status(503)
          .json({ error: "Sign-in is unavailable. Try again shortly." });
        return;
      }
      if (
        error?.status === 429 ||
        ["over_email_send_rate_limit", "over_request_rate_limit"].includes(
          error?.code ?? "",
        )
      ) {
        sendAuthEmailError(
          res,
          error,
          "Sign-in is temporarily limited. Please try again later.",
        );
        return;
      }
      if (error?.code === "user_banned") {
        res
          .status(403)
          .json({ code: "account_suspended", error: suspendedMessage });
        return;
      }
      if (error || !data.session || !data.user?.email_confirmed_at) {
        if (error?.code === "email_not_confirmed") {
          res.status(403).json({
            code: "email_not_confirmed",
            error:
              "Verify your email before logging in. You can resend the confirmation email.",
          });
          return;
        }
        res
          .status(401)
          .json({ error: "Incorrect credentials or email not verified." });
        return;
      }
      const user = await startSession(res, data.user, data.session);
      if (!user) return;
      await accountStore.record("auth.signed_in", user.id, user.id, {
        mfaPending: !!user.mfaPending,
      });
      res.json({ user });
    } catch {
      res
        .status(503)
        .json({ error: "Sign-in is unavailable. Try again shortly." });
    }
  }),
);

router.post(
  "/signup",
  authLimit("signup", 5, 60 * 60_000),
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const details = profileInput(body);
    if (
      !details ||
      !emailValid(body.email) ||
      !strongPassword(body.password) ||
      body.password !== body.confirmPassword
    ) {
      res.status(400).json({
        error:
          "Enter your name, country, racing role, valid email, and matching passwords of 12–128 characters with uppercase, lowercase, and a number.",
      });
      return;
    }
    if (
      body.role !== undefined ||
      body.app_metadata !== undefined ||
      body.user_metadata !== undefined
    ) {
      res.status(400).json({
        error: "Account permissions cannot be supplied during sign-up.",
      });
      return;
    }
    try {
      // Never silently create auto-confirmed accounts if provider settings drift.
      const settings = await fetch(
        `${process.env.SUPABASE_URL}/auth/v1/settings`,
        {
          headers: {
            apikey:
              process.env.SUPABASE_PUBLISHABLE_KEY ||
              process.env.SUPABASE_SECRET_KEY!,
          },
          signal: AbortSignal.timeout(8000),
        },
      );
      const config = (await settings.json()) as {
        mailer_autoconfirm?: boolean;
      };
      if (!settings.ok || config.mailer_autoconfirm !== false) {
        res
          .status(503)
          .json({ error: "Verified registration is not available right now." });
        return;
      }
      const { error } = await identity.client().auth.signUp({
        email: body.email.trim().toLowerCase(),
        password: body.password,
        options: { data: details, emailRedirectTo: confirmationUrl() },
      });
      if (
        error &&
        !["user_already_exists", "email_exists"].includes(error.code ?? "")
      ) {
        sendAuthEmailError(
          res,
          error,
          "Registration could not be completed. Please try again later.",
        );
        return;
      }
      res.status(202).json({
        ok: true,
        requiresVerification: true,
        message:
          "Check your email for a confirmation link. Verify it before logging in.",
      });
    } catch (error) {
      sendAuthEmailError(
        res,
        error,
        "Registration is unavailable. Please try again later.",
      );
    }
  }),
);

router.post(
  "/resend",
  authLimit("email", 3, 15 * 60_000),
  asyncRoute(async (req, res) => {
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    if (!emailValid(email)) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }
    try {
      const { error } = await identity.client().auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: confirmationUrl() },
      });
      if (error && !isUnknownRecipient(error)) {
        sendAuthEmailError(
          res,
          error,
          "The confirmation email could not be requested. Please try again later.",
        );
        return;
      }
    } catch (error) {
      sendAuthEmailError(
        res,
        error,
        "The confirmation email service is unavailable. Please try again later.",
      );
      return;
    }
    res.status(202).json(genericMail);
  }),
);

router.post(
  "/forgot-password",
  authLimit("email", 3, 15 * 60_000),
  asyncRoute(async (req, res) => {
    const email =
      typeof req.body?.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    if (!emailValid(email)) {
      res.status(400).json({ error: "Enter a valid email address." });
      return;
    }
    try {
      const { error } = await identity
        .client()
        .auth.resetPasswordForEmail(email, {
          redirectTo: confirmationUrl(),
        });
      if (error && !isUnknownRecipient(error)) {
        sendAuthEmailError(
          res,
          error,
          "The password reset email could not be requested. Please try again later.",
        );
        return;
      }
    } catch (error) {
      sendAuthEmailError(
        res,
        error,
        "The password reset email service is unavailable. Please try again later.",
      );
      return;
    }
    res.status(202).json(genericMail);
  }),
);

router.post(
  "/confirm",
  authLimit("confirm", 10, 10 * 60_000),
  asyncRoute(async (req, res) => {
    const {
      tokenHash,
      type,
      accessToken: providedAccess,
      refreshToken,
    } = req.body ?? {};
    const client = identity.client();
    try {
      let result;
      if (
        typeof tokenHash === "string" &&
        tokenHash.length >= 16 &&
        tokenHash.length <= 512 &&
        ["email", "signup", "invite", "recovery"].includes(type)
      ) {
        result = await client.auth.verifyOtp({ token_hash: tokenHash, type });
      } else if (
        typeof providedAccess === "string" &&
        providedAccess.length < 16384 &&
        typeof refreshToken === "string" &&
        refreshToken.length < 2048
      ) {
        result = await client.auth.setSession({
          access_token: providedAccess,
          refresh_token: refreshToken,
        });
      } else {
        res.status(400).json({
          error: "The confirmation link is incomplete. Request a new email.",
        });
        return;
      }
      if (providerUnavailable(result.error)) {
        res.status(503).json({
          error: "Email confirmation is unavailable. Try again shortly.",
        });
        return;
      }
      if (
        result.error?.status === 429 ||
        ["over_email_send_rate_limit", "over_request_rate_limit"].includes(
          result.error?.code ?? "",
        )
      ) {
        sendAuthEmailError(
          res,
          result.error,
          "Confirmation is temporarily limited. Please try again later.",
        );
        return;
      }
      if (
        result.error ||
        !result.data.session ||
        !result.data.user?.email_confirmed_at
      ) {
        res.status(400).json({
          error:
            "The confirmation link has expired or was already used. Request a new email.",
        });
        return;
      }
      const user = await startSession(
        res,
        result.data.user,
        result.data.session,
      );
      if (user) res.json({ user });
    } catch {
      res.status(503).json({
        error: "Email confirmation is unavailable. Try again shortly.",
      });
    }
  }),
);

router.post(
  "/refresh",
  authLimit("refresh", 60, 60_000),
  asyncRoute(async (req, res) => {
    const refreshToken = cookie(req, "stayblz_refresh");
    if (!refreshToken) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    try {
      const { data, error } = await identity
        .client()
        .auth.refreshSession({ refresh_token: refreshToken });
      if (providerUnavailable(error)) {
        res.status(503).json({
          error: "Session renewal is unavailable. Try again shortly.",
        });
        return;
      }
      if (error || !data.session || !data.user?.email_confirmed_at) {
        clearSession(res);
        res
          .status(401)
          .json({ error: "Your session expired. Please log in again." });
        return;
      }
      const user = await startSession(res, data.user, data.session);
      if (user) res.json({ user });
    } catch {
      res
        .status(503)
        .json({ error: "Session renewal is unavailable. Try again shortly." });
    }
  }),
);

router.get("/me", requireSession, (req: Request, res: Response) =>
  res.json({ user: (req as Request & { user: User }).user }),
);

router.patch(
  "/profile",
  authLimit("profile", 15, 60_000),
  requireAuth,
  asyncRoute(async (req, res) => {
    const details = profileInput(req.body ?? {});
    if (!details) {
      res
        .status(400)
        .json({ error: "Check your name, country, and racing role." });
      return;
    }
    const user = (req as Request & { user: User }).user;
    if (user.id === "u1") {
      res.status(409).json({ error: "Development profiles are read-only." });
      return;
    }
    const provider = (req as AuthenticatedRequest).providerUser;
    // The superadmin identity is fixed so a shared or stolen login cannot rename it.
    // Checked against the real role, so "View as: Customer" does not unlock it.
    if ((req as AuthenticatedRequest).account?.platform_role === "superadmin") {
      res.status(403).json({
        code: "profile_locked",
        error: "The superadmin profile is locked and cannot be edited here.",
      });
      return;
    }
    try {
      if (!provider) throw new Error("no provider identity");
      const account = await accountStore.updateProfile(user.id, details);
      res.json({
        user: profile(provider, account, tokenAal(accessToken(req))),
      });
    } catch {
      res
        .status(503)
        .json({ error: "Profile could not be saved. Try again later." });
    }
  }),
);

router.post(
  "/password",
  authLimit("password", 5, 15 * 60_000),
  requireAuth,
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    if (
      !strongPassword(body.password) ||
      body.password !== body.confirmPassword
    ) {
      res.status(400).json({
        error:
          "Use matching passwords of 12–128 characters with uppercase, lowercase, and a number.",
      });
      return;
    }
    // Provider validates the current session. It also invalidates refresh tokens on password change.
    const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      headers: {
        apikey:
          process.env.SUPABASE_PUBLISHABLE_KEY ||
          process.env.SUPABASE_SECRET_KEY!,
        Authorization: `Bearer ${accessToken(req)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: body.password }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      res.status(400).json({
        error: "The password could not be changed. Request a new reset email.",
      });
      return;
    }
    const user = (req as Request & { user: User }).user;
    if (user.passwordSetupRequired) {
      const result = await supabase.auth.admin.updateUserById(user.id, {
        app_metadata: {
          ...(req as AuthenticatedRequest).providerUser?.app_metadata,
          stayblz_require_password_setup: false,
        },
      });
      if (result.error) {
        res.status(503).json({
          error:
            "Password saved, but account setup could not be completed. Please log in again and retry.",
        });
        return;
      }
    }
    await accountStore.record("auth.password_changed", user.id, user.id);
    clearSession(res);
    res.json({ ok: true });
  }),
);

router.use(accountSecurity);

router.post(
  "/logout",
  asyncRoute(async (req, res) => {
    const token = accessToken(req);
    clearSession(res);
    if (token) {
      const demo = !!getSessionUser(token);
      destroySession(token);
      if (!demo)
        try {
          const result = await supabase.auth.admin.signOut(token, "global");
          if (result.error) throw result.error;
        } catch {
          res.status(503).json({
            error:
              "Signed out here. Server session revocation could not be confirmed.",
          });
          return;
        }
    }
    res.json({ ok: true });
  }),
);

export default router;
