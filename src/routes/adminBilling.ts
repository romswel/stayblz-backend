import { Router, type Request, type Response } from "express";
import { requireAuth, requireRole, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { BillingError, rpc, sendBillingError } from "../lib/billing/errors";
import { liveProviderConfigured, paymentProvider } from "../lib/billing/provider";
import { refundPayment } from "../lib/billing/engine";
import { runBillingSweep } from "../lib/billing/schedule";
import * as input from "../lib/billing/input";

/**
 * Billing administration (admin and up; changing fees, the paywall switch or the mode needs superadmin).
 * Admins see Stayblz's own sales in full and stable payments as amounts and fees only (who paid a stable and
 * for what stays with that stable). Admins can refund Stayblz's own sales; stables refund their own clients.
 * Every change is recorded in billing_events.
 */
const router = Router();
router.use(requireAuth, requireRole("admin"));

const me = (req: Request) => (req as AuthenticatedRequest).user;
const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      sendBillingError(res, error);
    }
  });
const superOnly = (req: Request) => {
  if (me(req).role !== "superadmin") throw new BillingError(403, "superadmin_only", "Only a superadmin can change billing settings.");
};
const audit = (req: Request, event: string, detail: Record<string, unknown> = {}, account: string | null = null) =>
  rpc(supabase, "billing_event", { p_actor: me(req).id, p_account: account, p_stable: null, p_invoice: null, p_payment: null, p_event: event, p_detail: detail });

router.get(
  "/summary",
  handle(async (_req, res) => {
    const [summary, { data: settings }] = await Promise.all([
      rpc(supabase, "billing_admin_summary", {}),
      supabase.from("billing_settings").select("*").eq("id", true).maybeSingle(),
    ]);
    res.json({
      summary,
      settings: settings && {
        mode: settings.mode,
        enforcePaywalls: settings.enforce_paywalls,
        fees: settings.fees,
        costs: settings.costs,
        payoutDelayDays: settings.payout_delay_days,
        bankSettleMinutes: settings.bank_settle_minutes,
        updatedAt: settings.updated_at,
      },
      provider: { name: paymentProvider().name, live: paymentProvider().live, liveAvailable: liveProviderConfigured() },
    });
  }),
);

router.put(
  "/settings",
  handle(async (req, res) => {
    superOnly(req);
    const b = req.body ?? {};
    if (b.mode === "live" && !liveProviderConfigured())
      throw new BillingError(409, "no_live_provider", "No live payment processor is connected yet, so billing stays in test mode.");
    const payoutDelay = b.payoutDelayDays ?? 2;
    const settle = b.bankSettleMinutes ?? 3;
    if (!Number.isInteger(payoutDelay) || payoutDelay < 0 || payoutDelay > 30) throw new BillingError(400, "invalid_input", "Payout delay is 0 to 30 days.");
    if (!Number.isInteger(settle) || settle < 0 || settle > 10080) throw new BillingError(400, "invalid_input", "Bank clearing time is 0 to 10,080 minutes.");
    const row = {
      enforce_paywalls: input.bool(b.enforcePaywalls, false),
      fees: input.rates(b.fees),
      costs: input.rates(b.costs),
      payout_delay_days: payoutDelay,
      bank_settle_minutes: settle,
      updated_at: new Date().toISOString(),
      updated_by: me(req).id,
    };
    const { error } = await supabase.from("billing_settings").update(row).eq("id", true);
    if (error) throw error;
    await audit(req, "settings.updated", { enforcePaywalls: row.enforce_paywalls, fees: row.fees });
    res.json({ ok: true });
  }),
);

router.post(
  "/run",
  handle(async (req, res) => {
    const report = await runBillingSweep();
    await audit(req, "schedule.run", report);
    res.json({ report });
  }),
);

/* ---------- Payments ---------- */

router.get(
  "/payments",
  handle(async (req, res) => {
    const status = typeof req.query.status === "string" && ["pending", "processing", "succeeded", "failed"].includes(req.query.status) ? req.query.status : null;
    const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
    res.json({ payments: await rpc(supabase, "billing_admin_payments", { p_status: status, p_limit: 100, p_before: before }) });
  }),
);

// Stayblz's own sales only (subscriptions, purchases). The SQL refuses stable payments here.
router.post(
  "/payments/:id/refund",
  handle(async (req, res) => {
    if (!input.isUuid(req.params.id)) throw new BillingError(404, "payment_not_found", "That payment wasn't found.");
    const b = req.body ?? {};
    const amount = b.amountCents === undefined || b.amountCents === null ? null : input.cents(b.amountCents, { min: 1 });
    res.json(
      await refundPayment({
        paymentId: req.params.id,
        stableId: null,
        amountCents: amount,
        reason: typeof b.reason === "string" ? b.reason : "requested_by_customer",
        note: input.text(b.note, 300, { label: "Note" }),
        key: input.key(b.key),
        actorId: me(req).id,
      }),
    );
  }),
);

/* ---------- Subscriptions ---------- */

router.get(
  "/subscriptions",
  handle(async (req, res) => {
    const status = typeof req.query.status === "string" && ["incomplete", "trialing", "active", "past_due", "canceled"].includes(req.query.status) ? req.query.status : null;
    res.json({ subscriptions: await rpc(supabase, "billing_admin_subscriptions", { p_status: status, p_limit: 200 }) });
  }),
);

router.post(
  "/subscriptions/:id/cancel",
  handle(async (req, res) => {
    if (!input.isUuid(req.params.id)) throw new BillingError(404, "subscription_not_found", "That plan wasn't found.");
    const now = input.bool(req.body?.now, false);
    res.json(await rpc(supabase, "billing_sub_cancel", { p_sub: req.params.id, p_account: null, p_now: now, p_actor: me(req).id, p_reason: "admin" }));
  }),
);

// Test mode: jump to the end of the period, then run billing, to try renewals and failed-payment retries.
router.post(
  "/subscriptions/:id/advance",
  handle(async (req, res) => {
    if (!input.isUuid(req.params.id)) throw new BillingError(404, "subscription_not_found", "That plan wasn't found.");
    await rpc(supabase, "billing_test_advance", { p_sub: req.params.id, p_actor: me(req).id });
    const report = await runBillingSweep();
    res.json({ report, subscription: await rpc(supabase, "billing_sub_one", { p_sub: req.params.id }) });
  }),
);

/* ---------- Plans and products ---------- */

const catalogOut = (c: Record<string, unknown>) => ({
  id: c.id,
  kind: c.kind,
  family: c.family,
  name: c.name,
  description: c.description,
  amount: c.amount_cents,
  interval: c.interval,
  trialDays: c.trial_days,
  features: c.features,
  effect: c.effect,
  effectDays: c.effect_days,
  status: c.status,
  sort: c.sort,
  updatedAt: c.updated_at,
});

router.get(
  "/catalog",
  handle(async (_req, res) => {
    const { data, error } = await supabase.from("billing_catalog").select("*").order("sort");
    if (error) throw error;
    res.json({ catalog: (data ?? []).map(catalogOut) });
  }),
);

function catalogInput(b: Record<string, unknown>, existing: Record<string, unknown> | null) {
  const kind = existing ? (existing.kind as string) : b.kind === "product" ? "product" : b.kind === "plan" ? "plan" : null;
  if (!kind) throw new BillingError(400, "invalid_input", "Choose a plan or a product.");
  const status = ["draft", "active", "retired"].includes(b.status as string) ? (b.status as string) : ((existing?.status as string) ?? "draft");
  const row: Record<string, unknown> = {
    name: input.text(b.name, 80, { required: true, label: "Name" }),
    description: input.text(b.description, 600, { label: "Description" }),
    amount_cents: input.cents(b.amount, { min: 50, max: 10_000_000, label: "Price" }),
    status,
    sort: Number.isInteger(b.sort) ? Math.max(0, Math.min(10000, b.sort as number)) : ((existing?.sort as number) ?? 100),
    updated_at: new Date().toISOString(),
  };
  if (kind === "plan") {
    const interval = existing ? existing.interval : b.interval === "year" ? "year" : b.interval === "month" ? "month" : null;
    if (!interval) throw new BillingError(400, "invalid_input", "Choose monthly or yearly.");
    const trial = b.trialDays ?? 0;
    if (!Number.isInteger(trial) || (trial as number) < 0 || (trial as number) > 90) throw new BillingError(400, "invalid_input", "A free trial is 0 to 90 days.");
    row.trial_days = trial;
    if (!existing) row.interval = interval;
  }
  if (!existing) {
    const idValue = String(b.id ?? "");
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(idValue)) throw new BillingError(400, "invalid_input", "The id is 2 to 40 lowercase letters, numbers or _.");
    const family = String(b.family ?? "");
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(family)) throw new BillingError(400, "invalid_input", "The family is lowercase letters, numbers or _.");
    const features = Array.isArray(b.features) ? (b.features as unknown[]).filter((f): f is string => typeof f === "string" && /^[a-z][a-z0-9_.]{2,39}$/.test(f)).slice(0, 10) : [];
    Object.assign(row, { id: idValue, kind, family, features });
    if (kind === "product") {
      if (b.effect !== "marketplace_feature" && b.effect !== "stallion_feature") throw new BillingError(400, "invalid_input", "Choose what the product does.");
      const days = b.effectDays;
      if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365) throw new BillingError(400, "invalid_input", "Choose 1 to 365 days.");
      Object.assign(row, { effect: b.effect, effect_days: days });
    }
  }
  return row;
}

router.post(
  "/catalog",
  handle(async (req, res) => {
    const row = catalogInput(req.body ?? {}, null);
    const { data: clash } = await supabase.from("billing_catalog").select("id").eq("id", row.id as string).maybeSingle();
    if (clash) throw new BillingError(409, "exists", "Something with this id already exists.");
    const { data, error } = await supabase.from("billing_catalog").insert(row).select("*").single();
    if (error) throw error;
    await audit(req, "catalog.created", { id: row.id, amount: row.amount_cents, status: row.status });
    res.status(201).json({ item: catalogOut(data) });
  }),
);

// Price changes apply to new subscribers; people already subscribed keep the price they signed up at.
router.patch(
  "/catalog/:id",
  handle(async (req, res) => {
    const { data: existing } = await supabase.from("billing_catalog").select("*").eq("id", req.params.id).maybeSingle();
    if (!existing) throw new BillingError(404, "not_found", "That plan or product wasn't found.");
    const row = catalogInput(req.body ?? {}, existing);
    const { data, error } = await supabase.from("billing_catalog").update(row).eq("id", req.params.id).select("*").single();
    if (error) throw error;
    await audit(req, "catalog.updated", { id: req.params.id, amount: row.amount_cents, status: row.status, before: { amount: existing.amount_cents, status: existing.status } });
    res.json({ item: catalogOut(data) });
  }),
);

/* ---------- Coupons ---------- */

const couponOut = (c: Record<string, unknown>) => ({
  code: c.code,
  percentOff: c.percent_off,
  amountOff: c.amount_off_cents,
  duration: c.duration,
  durationMonths: c.duration_months,
  appliesTo: c.applies_to,
  maxRedemptions: c.max_redemptions,
  redeemed: c.redeemed,
  expiresAt: c.expires_at,
  active: c.active,
  note: c.note,
  createdAt: c.created_at,
});

router.get(
  "/coupons",
  handle(async (_req, res) => {
    const { data, error } = await supabase.from("billing_coupons").select("*").order("created_at", { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ coupons: (data ?? []).map(couponOut) });
  }),
);

router.post(
  "/coupons",
  handle(async (req, res) => {
    const b = req.body ?? {};
    const code = input.text(b.code, 24, { required: true, label: "Code" }).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{2,23}$/.test(code)) throw new BillingError(400, "invalid_input", "Codes are 3 to 24 letters, numbers, - or _.");
    const percent = b.percentOff === undefined || b.percentOff === null || b.percentOff === "" ? null : b.percentOff;
    const amountOff = b.amountOffCents === undefined || b.amountOffCents === null || b.amountOffCents === "" ? null : b.amountOffCents;
    if ((percent === null) === (amountOff === null)) throw new BillingError(400, "invalid_input", "Give a percentage off or an amount off (one of them).");
    if (percent !== null && (!Number.isInteger(percent) || percent < 1 || percent > 100)) throw new BillingError(400, "invalid_input", "Percentage off is 1 to 100.");
    if (amountOff !== null) input.cents(amountOff, { min: 1, max: 1_000_000, label: "Amount off" });
    const duration = ["once", "repeating", "forever"].includes(b.duration) ? b.duration : "once";
    const months = duration === "repeating" ? b.durationMonths : null;
    if (duration === "repeating" && (!Number.isInteger(months) || months < 1 || months > 36)) throw new BillingError(400, "invalid_input", "Choose 1 to 36 months.");
    const max = b.maxRedemptions === undefined || b.maxRedemptions === null || b.maxRedemptions === "" ? null : b.maxRedemptions;
    if (max !== null && (!Number.isInteger(max) || max < 1)) throw new BillingError(400, "invalid_input", "Uses must be a whole number.");
    const expires = b.expiresOn ? input.date(b.expiresOn, { label: "Expiry" }) : null;
    const appliesTo = Array.isArray(b.appliesTo) ? (b.appliesTo as unknown[]).filter((x): x is string => typeof x === "string" && /^[a-z][a-z0-9_]{1,39}$/.test(x)).slice(0, 20) : [];
    const { data: clash } = await supabase.from("billing_coupons").select("code").eq("code", code).maybeSingle();
    if (clash) throw new BillingError(409, "exists", "That code already exists.");
    const { data, error } = await supabase
      .from("billing_coupons")
      .insert({
        code,
        percent_off: percent,
        amount_off_cents: amountOff,
        duration,
        duration_months: months,
        applies_to: appliesTo,
        max_redemptions: max,
        expires_at: expires ? `${expires}T23:59:59Z` : null,
        note: input.text(b.note, 200, { label: "Note" }),
        created_by: me(req).id,
      })
      .select("*")
      .single();
    if (error) throw error;
    await audit(req, "coupon.created", { code, percent, amountOff, duration });
    res.status(201).json({ coupon: couponOut(data) });
  }),
);

router.post(
  "/coupons/:code/active",
  handle(async (req, res) => {
    const active = input.bool(req.body?.active, false);
    const { data, error } = await supabase.from("billing_coupons").update({ active }).eq("code", String(req.params.code).toUpperCase()).select("*").maybeSingle();
    if (error) throw error;
    if (!data) throw new BillingError(404, "not_found", "That code wasn't found.");
    await audit(req, active ? "coupon.activated" : "coupon.deactivated", { code: data.code });
    res.json({ coupon: couponOut(data) });
  }),
);

/* ---------- Free access (grants) ---------- */

router.get(
  "/grants",
  handle(async (_req, res) => {
    const { data, error } = await supabase.from("billing_grants").select("*").order("created_at", { ascending: false }).limit(300);
    if (error) throw error;
    const ids = [...new Set((data ?? []).map((g) => g.account_id as string))];
    const { data: accounts } = ids.length ? await supabase.from("accounts").select("id,email,first_name,last_name").in("id", ids) : { data: [] };
    const byId = new Map((accounts ?? []).map((a) => [a.id as string, a]));
    res.json({
      grants: (data ?? []).map((g) => {
        const a = byId.get(g.account_id as string);
        return {
          id: g.id,
          account: a ? { id: a.id, email: a.email, name: `${a.first_name} ${a.last_name}`.trim() } : { id: g.account_id, email: "", name: "" },
          feature: g.feature,
          reason: g.reason,
          endsAt: g.ends_at,
          revokedAt: g.revoked_at,
          createdAt: g.created_at,
        };
      }),
    });
  }),
);

router.post(
  "/grants",
  handle(async (req, res) => {
    const b = req.body ?? {};
    const email = input.email(b.email, { required: true });
    const feature = typeof b.feature === "string" && /^[a-z][a-z0-9_.]{2,39}$/.test(b.feature) ? b.feature : null;
    if (!feature) throw new BillingError(400, "invalid_input", "Choose what to give access to.");
    const { data: account } = await supabase.from("accounts").select("id,status").eq("email", email).maybeSingle();
    if (!account) throw new BillingError(404, "not_found", "No Stayblz account uses that email.");
    const ends = b.endsOn ? input.date(b.endsOn, { label: "End date" }) : null;
    const { data, error } = await supabase
      .from("billing_grants")
      .insert({ account_id: account.id, feature, reason: input.text(b.reason, 200, { label: "Reason" }), ends_at: ends ? `${ends}T23:59:59Z` : null, granted_by: me(req).id })
      .select("id")
      .single();
    if (error) throw error;
    await audit(req, "grant.created", { feature, endsOn: ends }, account.id);
    res.status(201).json({ id: data.id });
  }),
);

router.post(
  "/grants/:id/revoke",
  handle(async (req, res) => {
    if (!input.isUuid(req.params.id)) throw new BillingError(404, "not_found", "Not found.");
    const { data, error } = await supabase.from("billing_grants").update({ revoked_at: new Date().toISOString() }).eq("id", req.params.id).is("revoked_at", null).select("id,account_id,feature").maybeSingle();
    if (error) throw error;
    if (!data) throw new BillingError(404, "not_found", "That grant wasn't found or was already ended.");
    await audit(req, "grant.revoked", { feature: data.feature }, data.account_id);
    res.json({ ok: true });
  }),
);

router.get(
  "/events",
  handle(async (_req, res) => {
    const { data, error } = await supabase.from("billing_events").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    res.json({
      events: (data ?? []).map((e) => ({ id: e.id, event: e.event, actorId: e.actor_id, accountId: e.account_id, stableId: e.stable_id, invoiceId: e.invoice_id, detail: e.detail, createdAt: e.created_at })),
    });
  }),
);

export default router;
