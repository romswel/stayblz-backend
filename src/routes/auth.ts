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
  persistentSession,
  providerUnavailable,
  tokenAal,
} from "../lib/identity";
import { accountStore, AccountError } from "../lib/accounts";
import { profileInput, TERMS_VERSION } from "../lib/profileInput";
import { startSession } from "../lib/session";
import accountSecurity from "./accountSecurity";
import { supabase } from "../lib/supabase";
import type { User } from "../types";
import { sendAuthEmailError, isUnknownRecipient } from "../lib/authEmailErrors";
import { siteOrigin } from "../lib/site";

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
const confirmationUrl = () => `${siteOrigin()}/auth/confirm`;
/** The address a request is about, for per-address limits; null when there isn't one. */
const bodyEmail = (req: Request) =>
  typeof req.body?.email === "string" && req.body.email.length <= 254
    ? req.body.email.trim().toLowerCase()
    : null;
// A 6-digit code has a million values, so guesses are capped per address as well as per network
// address: someone spreading guesses over many connections still gets only a few per code.
const codeAttempts = authLimit("code", 5, 15 * 60_000, (req) =>
  typeof req.body?.code === "string" ? bodyEmail(req) : null,
);
// Stops one inbox from being flooded with codes requested from many places.
const emailsToAddress = authLimit("email-to", 3, 15 * 60_000, bodyEmail);
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
    // "Keep me signed in" is on unless the person turns it off.
    const remember = req.body?.remember !== false;
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
              "Confirm your email before logging in. Enter the 6-digit code from your sign-up email, or send a new one.",
          });
          return;
        }
        res
          .status(401)
          .json({ error: "Incorrect credentials or email not verified." });
        return;
      }
      const user = await startSession(res, data.user, data.session, remember);
      if (!user) return;
      await accountStore.record("auth.signed_in", user.id, user.id, {
        mfaPending: !!user.mfaPending,
        remember,
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
          "Enter your name, country, role in racing, valid email, and matching passwords of 12–128 characters with uppercase, lowercase, and a number.",
      });
      return;
    }
    if (
      body.acceptTerms !== true ||
      body.ageConfirmed !== true ||
      body.termsVersion !== TERMS_VERSION
    ) {
      res.status(400).json({
        code: "terms_required",
        error:
          "Confirm you are 18 or older and accept the Terms of Use and Privacy Notice to create an account.",
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
        options: {
          data: {
            ...details,
            terms_version: TERMS_VERSION,
            terms_accepted_at: new Date().toISOString(),
            age_confirmed: true,
            marketing_opt_in: body.marketingOptIn === true,
          },
          emailRedirectTo: confirmationUrl(),
        },
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
          "We emailed you a 6-digit code. Enter it here to confirm your email.",
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
  emailsToAddress,
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
  emailsToAddress,
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
  codeAttempts,
  asyncRoute(async (req, res) => {
    const {
      tokenHash,
      type,
      accessToken: providedAccess,
      refreshToken,
      email,
      code,
    } = req.body ?? {};
    const client = identity.client();
    try {
      let result;
      if (
        emailValid(email) &&
        typeof code === "string" &&
        /^\d{6}$/.test(code) &&
        ["signup", "recovery"].includes(type)
      ) {
        // The 6-digit code from the email, typed on the "Check your email" screen.
        result = await client.auth.verifyOtp({
          email: email.trim().toLowerCase(),
          token: code,
          type: type === "recovery" ? "recovery" : "email",
        });
        if (result.error && type === "signup" && !providerUnavailable(result.error))
          result = await client.auth.verifyOtp({
            email: email.trim().toLowerCase(),
            token: code,
            type: "signup",
          });
      } else if (
        typeof tokenHash === "string" &&
        tokenHash.length >= 16 &&
        tokenHash.length <= 512 &&
        ["email", "signup", "invite", "recovery", "email_change"].includes(type)
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
        res.status(400).json(
          typeof code === "string"
            ? {
                code: "code_invalid",
                error:
                  "That code is wrong or has expired. Check the latest email or request a new one.",
              }
            : {
                error:
                  "The confirmation link has expired or was already used. Request a new email.",
              },
        );
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
      const user = await startSession(
        res,
        data.user,
        data.session,
        persistentSession(req),
      );
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
    } catch (error) {
      if (error instanceof AccountError && error.code === "not_allowed") {
        res.status(403).json({
          code: "profile_locked",
          error: "This profile can't be edited here.",
        });
        return;
      }
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
      // Only these known reasons are passed on; provider text is never shown.
      const failure = (await response.json().catch(() => ({}))) as {
        error_code?: unknown;
        code?: unknown;
      };
      const reason = [failure.error_code, failure.code].find(
        (value): value is string => typeof value === "string",
      );
      res.status(400).json(
        reason === "same_password"
          ? {
              code: "same_password",
              error: "Choose a password that is different from your current one.",
            }
          : reason === "weak_password"
            ? {
                code: "weak_password",
                error: "That password is too easy to guess. Choose a different one.",
              }
            : {
                error:
                  "The password could not be changed. Start the reset again to get a new code.",
              },
      );
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

/** Settings that only affect the signed-in person. */
router.patch(
  "/preferences",
  authLimit("preferences", 30, 60_000),
  requireAuth,
  asyncRoute(async (req, res) => {
    const { marketingOptIn, updatesSeen, updatesPopup } = req.body ?? {};
    const request = req as AuthenticatedRequest;
    if (
      (marketingOptIn !== undefined && typeof marketingOptIn !== "boolean") ||
      (updatesPopup !== undefined && typeof updatesPopup !== "boolean") ||
      (updatesSeen !== undefined && updatesSeen !== true)
    ) {
      res.status(400).json({ error: "Those settings could not be saved." });
      return;
    }
    if (!request.providerUser) {
      res.status(409).json({ error: "Development profiles cannot save settings." });
      return;
    }
    try {
      const account = await accountStore.updatePreferences(request.user.id, {
        marketingOptIn,
        updatesSeen,
        updatesPopup,
      });
      res.json({
        user: profile(request.providerUser, account, tokenAal(accessToken(req))),
      });
    } catch {
      res.status(503).json({ error: "Settings could not be saved. Try again later." });
    }
  }),
);

/**
 * "This wasn't me" from a sign-up email. Using the email's one-time token proves the
 * person controls that inbox; the unconfirmed sign-up made with their address is then
 * removed so nobody else can use it. Only brand-new customer sign-ups qualify.
 */
router.post(
  "/not-me",
  authLimit("confirm", 10, 10 * 60_000),
  asyncRoute(async (req, res) => {
    const { tokenHash } = req.body ?? {};
    if (typeof tokenHash !== "string" || tokenHash.length < 16 || tokenHash.length > 512) {
      res.status(400).json({ error: "This link is incomplete. Open the latest email again." });
      return;
    }
    try {
      const result = await identity
        .client()
        .auth.verifyOtp({ token_hash: tokenHash, type: "email" });
      if (providerUnavailable(result.error)) {
        res.status(503).json({ error: "This is unavailable right now. Try again shortly." });
        return;
      }
      const user = result.data?.user;
      if (result.error || !user) {
        res.status(400).json({
          code: "link_used",
          error:
            "This link has expired or was already used. If someone is using your email, reset the password with “Forgot password” or contact Stayblz.",
        });
        return;
      }
      const account = await accountStore.load(user.id).catch(() => null);
      const ageDays = (Date.now() - Date.parse(user.created_at)) / 86_400_000;
      if (!account || account.platform_role !== "customer" || !(ageDays < 14)) {
        if (result.data.session)
          await supabase.auth.admin
            .signOut(result.data.session.access_token, "global")
            .catch(() => undefined);
        res.status(409).json({
          error:
            "This account can't be removed automatically. Reset its password with “Forgot password”, or contact Stayblz.",
        });
        return;
      }
      await accountStore.record("account.disowned", user.id, null, {
        createdAt: user.created_at,
      });
      const removed = await supabase.auth.admin.deleteUser(user.id);
      if (removed.error) {
        res.status(503).json({ error: "The sign-up could not be removed. Try again shortly." });
        return;
      }
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: "This is unavailable right now. Try again shortly." });
    }
  }),
);

/** Signs out this device; `{ everywhere: true }` signs out every device. */
router.post(
  "/logout",
  asyncRoute(async (req, res) => {
    const token = accessToken(req);
    const everywhere = req.body?.everywhere === true;
    clearSession(res);
    let signedOutId: string | undefined;
    if (token) {
      const demo = !!getSessionUser(token);
      // Look the person up before their sessions are revoked, for the activity log.
      if (everywhere && !demo)
        signedOutId = (await identity.user(token).catch(() => null))?.data?.user?.id;
      destroySession(token);
      if (!demo)
        try {
          const result = await supabase.auth.admin.signOut(
            token,
            everywhere ? "global" : "local",
          );
          if (result.error) throw result.error;
        } catch {
          res.status(503).json({
            error:
              "Signed out here. Server session revocation could not be confirmed.",
          });
          return;
        }
    }
    if (signedOutId)
      await accountStore.record("auth.signed_out_everywhere", signedOutId, signedOutId);
    res.json({ ok: true });
  }),
);

export default router;
