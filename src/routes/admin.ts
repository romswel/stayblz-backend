import { Router } from "express";
import {
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { isUuid } from "../middleware/stable";
import { supabase } from "../lib/supabase";
import { AccountError, accountStore, toApiRole } from "../lib/accounts";

const router = Router();
router.use(requireAuth);

// Admins and superadmins: directory metadata only. Private conversations still
// require participation; no platform role bypasses them.
router.get(
  "/stables",
  requireRole("admin"),
  asyncRoute(async (_req, res) => {
    const { data, error } = await supabase
      .from("member_stables")
      .select("id,name,created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error)
      return res
        .status(503)
        .json({ error: "The stable directory is unavailable." });
    res.json({ stables: data ?? [] });
  }),
);

// Superadmin only from here on.
router.get(
  "/accounts",
  requireRole("superadmin"),
  asyncRoute(async (_req, res) => {
    const { data, error } = await supabase
      .from("accounts")
      .select(
        "id,email,first_name,last_name,platform_role,status,status_reason,created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error)
      return res.status(503).json({ error: "Accounts are unavailable." });
    // 2-step status lives with the sign-in provider. Unknown is shown as unknown.
    let mfa: Map<string, boolean> | null = null;
    try {
      const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (!listed.error)
        mfa = new Map(
          listed.data.users.map((user) => [
            user.id,
            (user.factors ?? []).some(
              (factor) => factor.factor_type === "totp" && factor.status === "verified",
            ),
          ]),
        );
    } catch {
      mfa = null;
    }
    res.json({
      accounts: (data ?? []).map((row) => ({
        id: row.id,
        email: row.email,
        name: `${row.first_name} ${row.last_name}`.trim(),
        role: toApiRole(row.platform_role),
        status: row.status,
        statusReason: row.status_reason,
        createdAt: row.created_at,
        mfaEnabled: mfa ? (mfa.get(row.id) ?? false) : null,
      })),
    });
  }),
);

router.post(
  "/accounts/:id/status",
  authLimit("admin-status", 30, 60_000),
  requireRole("superadmin"),
  asyncRoute(async (req, res) => {
    const actor = (req as AuthenticatedRequest).user;
    const subject = String(req.params.id);
    const { status, reason } = req.body ?? {};
    if (
      !isUuid(subject) ||
      !["active", "suspended"].includes(status) ||
      (reason !== undefined && (typeof reason !== "string" || reason.length > 300))
    ) {
      res.status(400).json({ error: "Choose active or suspended, with a short reason." });
      return;
    }
    let account;
    try {
      account = await accountStore.setStatus(actor.id, subject, status, reason ?? "");
    } catch (error) {
      const code = error instanceof AccountError ? error.code : "unavailable";
      res
        .status(code === "not_allowed" ? 403 : code === "unknown_account" ? 404 : 503)
        .json({
          error:
            code === "not_allowed"
              ? "Superadmin accounts and your own account cannot be changed here."
              : code === "unknown_account"
                ? "That account was not found."
                : "The account could not be updated. Try again.",
        });
      return;
    }
    // Also lock or unlock sign-in at the provider so no new session can start.
    let signInLocked: boolean | null = null;
    try {
      const result = await supabase.auth.admin.updateUserById(subject, {
        ban_duration: status === "suspended" ? "876000h" : "none",
      });
      signInLocked = result.error ? null : status === "suspended";
    } catch {
      signInLocked = null;
    }
    res.json({
      account: { id: account.id, status: account.status, statusReason: account.status_reason },
      providerUpdated: signInLocked !== null,
    });
  }),
);

router.get(
  "/events",
  requireRole("superadmin"),
  asyncRoute(async (_req, res) => {
    const { data, error } = await supabase
      .from("account_events")
      .select("id,account_id,actor_id,event,detail,created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error)
      return res.status(503).json({ error: "Account activity is unavailable." });
    res.json({
      events: (data ?? []).map((row) => ({
        id: String(row.id),
        accountId: row.account_id,
        actorId: row.actor_id,
        event: row.event,
        detail: row.detail,
        createdAt: row.created_at,
      })),
    });
  }),
);

export default router;
