import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { supabase } from "../lib/supabase";
import { BillingError, rpc, sendBillingError } from "../lib/billing/errors";
import { paymentProvider } from "../lib/billing/provider";
import { payInvoice, purchase, savedMethod, subscribe, subscriptionJson } from "../lib/billing/engine";
import * as input from "../lib/billing/input";

/**
 * Your Billing (signed in): plans, cards and bank accounts, invoices and receipts, bills from stables, autopay.
 * Everything is for the signed-in account only; a stable's bills reach you when they're addressed to your
 * account's email. While billing is in test mode only Stayblz test cards/banks work and nothing real is charged.
 */
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.method !== "GET" && (req as AuthenticatedRequest).user.passwordSetupRequired) {
    res.status(403).json({ error: "Complete password setup before changing billing." });
    return;
  }
  next();
});

const me = (req: Request) => (req as AuthenticatedRequest).user;
const perUser = (req: Request) => (req as Partial<AuthenticatedRequest>).user?.id ?? null;
// Card-testing guard: adding cards and paying are limited per person.
const methodLimit = authLimit("billing-method", 10, 60 * 60_000, perUser);
const payLimit = authLimit("billing-pay", 30, 10 * 60_000, perUser);
const MAX_METHODS = 10;

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      sendBillingError(res, error);
    }
  });

const id = (req: Request) => {
  if (!input.isUuid(req.params.id)) throw new BillingError(404, "not_found", "Not found.");
  return req.params.id;
};

router.get(
  "/overview",
  handle(async (req, res) => {
    const data = await rpc(supabase, "billing_overview", { p_account: me(req).id, p_email: me(req).email ?? "" });
    res.json({ ...(data as object), provider: { name: paymentProvider().name, live: paymentProvider().live } });
  }),
);

router.put(
  "/profile",
  handle(async (req, res) => {
    const b = req.body ?? {};
    const country = input.text(b.country, 2).toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) throw new BillingError(400, "invalid_input", "Choose a country.");
    const row = {
      account_id: me(req).id,
      name: input.text(b.name, 120, { label: "Name" }),
      email: input.email(b.email),
      line1: input.text(b.line1, 120, { label: "Address" }),
      line2: input.text(b.line2, 120, { label: "Address line 2" }),
      city: input.text(b.city, 80, { label: "City" }),
      region: input.text(b.region, 80, { label: "State or region" }),
      postal: input.text(b.postal, 20, { label: "ZIP or postcode" }),
      country,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("billing_profiles").upsert(row, { onConflict: "account_id" });
    if (error) throw error;
    res.json({ ok: true });
  }),
);

/* ---------- Cards and bank accounts ---------- */

router.post(
  "/methods",
  methodLimit,
  handle(async (req, res) => {
    const b = req.body ?? {};
    const type = b.type === "bank" ? "bank" : b.type === "card" ? "card" : null;
    if (!type) throw new BillingError(400, "invalid_input", "Choose a card or a bank account.");
    const provider = paymentProvider();
    const details = provider.describe(b.token, type);
    if (!details)
      throw new BillingError(400, "invalid_method", "Use one of the Stayblz test cards or banks. Real cards can't be used while billing is in test mode.");
    const expiry = type === "card" ? input.cardExpiry(b.expMonth, b.expYear) : null;
    const refused = await provider.verify(b.token, type);
    if (refused) throw new BillingError(402, refused.code, refused.message);
    const { data: existing, error: countError } = await supabase.from("billing_methods").select("id").eq("account_id", me(req).id).eq("status", "active");
    if (countError) throw countError;
    if ((existing ?? []).length >= MAX_METHODS) throw new BillingError(400, "too_many_methods", `You can save up to ${MAX_METHODS} cards and bank accounts. Remove one first.`);
    const { data: created, error } = await supabase
      .from("billing_methods")
      .insert({
        account_id: me(req).id,
        type,
        provider: provider.name,
        provider_ref: b.token,
        brand: details.brand,
        last4: details.last4,
        exp_month: expiry?.expMonth ?? null,
        exp_year: expiry?.expYear ?? null,
        bank_name: details.bankName,
        holder_name: input.text(b.holderName, 120, { label: "Name on the card" }),
        test: !provider.live,
      })
      .select("id")
      .single();
    if (error || !created) throw error ?? new Error("insert failed");
    await setDefaultIfNeeded(me(req).id, created.id, b.makeDefault === true || !(existing ?? []).length);
    res.status(201).json({ method: { id: created.id, ...details, expMonth: expiry?.expMonth ?? null, expYear: expiry?.expYear ?? null } });
  }),
);

async function setDefaultIfNeeded(accountId: string, methodId: string, force: boolean) {
  const { data: profile } = await supabase.from("billing_profiles").select("account_id,default_method_id").eq("account_id", accountId).maybeSingle();
  if (!profile) {
    const { error } = await supabase.from("billing_profiles").insert({ account_id: accountId, default_method_id: methodId });
    if (error) throw error;
    return;
  }
  let current = profile.default_method_id as string | null;
  if (current) {
    const { data: still } = await supabase.from("billing_methods").select("id").eq("id", current).eq("status", "active").maybeSingle();
    if (!still) current = null;
  }
  if (force || !current) {
    const { error } = await supabase.from("billing_profiles").update({ default_method_id: methodId, updated_at: new Date().toISOString() }).eq("account_id", accountId);
    if (error) throw error;
  }
}

router.post(
  "/methods/:id/default",
  handle(async (req, res) => {
    await savedMethod(me(req).id, id(req));
    await setDefaultIfNeeded(me(req).id, id(req), true);
    res.json({ ok: true });
  }),
);

router.post(
  "/methods/:id/remove",
  handle(async (req, res) => {
    const account = me(req).id;
    const method = await savedMethod(account, id(req));
    const { data: others } = await supabase.from("billing_methods").select("id,created_at").eq("account_id", account).eq("status", "active").order("created_at", { ascending: false });
    const replacement = (others ?? []).find((m) => m.id !== method.id)?.id ?? null;
    const { data: subs } = await supabase.from("billing_subscriptions").select("id,status,method_id").eq("account_id", account).eq("method_id", method.id);
    const live = (subs ?? []).filter((s) => ["trialing", "active", "past_due"].includes(s.status));
    if (live.length && !replacement)
      throw new BillingError(409, "method_in_use", "This card pays for a plan. Add another card first, or cancel the plan.");
    const now = new Date().toISOString();
    const { error } = await supabase.from("billing_methods").update({ status: "removed", removed_at: now }).eq("id", method.id).eq("account_id", account);
    if (error) throw error;
    for (const s of live) await supabase.from("billing_subscriptions").update({ method_id: replacement, updated_at: now }).eq("id", s.id);
    await supabase.from("billing_autopay").delete().eq("account_id", account).eq("method_id", method.id);
    const { data: profile } = await supabase.from("billing_profiles").select("default_method_id").eq("account_id", account).maybeSingle();
    if (profile?.default_method_id === method.id)
      await supabase.from("billing_profiles").update({ default_method_id: replacement, updated_at: now }).eq("account_id", account);
    res.json({ ok: true, movedTo: live.length ? replacement : null });
  }),
);

/* ---------- Plans ---------- */

router.post(
  "/subscriptions",
  payLimit,
  handle(async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.planId !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(b.planId)) throw new BillingError(400, "invalid_input", "Choose a plan.");
    if (!input.isUuid(b.methodId)) throw new BillingError(400, "invalid_input", "Choose a card or bank account.");
    const coupon = input.text(b.coupon, 24, { label: "Code" }) || null;
    const result = await subscribe({ accountId: me(req).id, planId: b.planId, methodId: b.methodId, coupon, key: input.key(b.key) });
    if (result.payment?.status === "failed")
      return res.status(402).json({ code: result.payment.failureCode ?? "card_declined", error: result.payment.failureMessage ?? "The payment didn't go through.", ...result });
    res.status(201).json(result);
  }),
);

router.post(
  "/subscriptions/:id/cancel",
  handle(async (req, res) => {
    res.json(await rpc(supabase, "billing_sub_cancel", { p_sub: id(req), p_account: me(req).id, p_now: false, p_actor: me(req).id, p_reason: "requested" }));
  }),
);

router.post(
  "/subscriptions/:id/resume",
  handle(async (req, res) => {
    res.json(await rpc(supabase, "billing_sub_resume", { p_sub: id(req), p_account: me(req).id, p_actor: me(req).id }));
  }),
);

router.post(
  "/subscriptions/:id/change",
  handle(async (req, res) => {
    const b = req.body ?? {};
    const plan = typeof b.planId === "string" && /^[a-z][a-z0-9_]{1,39}$/.test(b.planId) ? b.planId : null;
    const method = input.isUuid(b.methodId) ? b.methodId : null;
    if (!plan && !method) throw new BillingError(400, "invalid_input", "Choose a plan or a card.");
    res.json(await rpc(supabase, "billing_sub_change", { p_sub: id(req), p_account: me(req).id, p_plan: plan, p_method: method, p_actor: me(req).id }));
  }),
);

// Pay a plan's open invoice now (after a failed renewal, or a first payment that didn't go through).
router.post(
  "/subscriptions/:id/pay",
  payLimit,
  handle(async (req, res) => {
    const b = req.body ?? {};
    if (!input.isUuid(b.methodId)) throw new BillingError(400, "invalid_input", "Choose a card or bank account.");
    const { data: own } = await supabase.from("billing_subscriptions").select("id,account_id").eq("id", id(req)).eq("account_id", me(req).id).maybeSingle();
    if (!own) throw new BillingError(404, "subscription_not_found", "That plan wasn't found.");
    const sub = await subscriptionJson(id(req));
    const open = (sub as { openInvoice?: { id: string } | null } | null)?.openInvoice;
    if (!open) throw new BillingError(409, "nothing_due", "Nothing is due on this plan.");
    const method = await savedMethod(me(req).id, b.methodId);
    const result = await payInvoice({
      invoiceId: open.id,
      payerId: me(req).id,
      actorId: me(req).id,
      channel: method.type === "bank" ? "bank" : "card",
      method: { kind: "saved", methodId: method.id },
      key: input.key(b.key),
    });
    if (result.payment.status !== "failed")
      await rpc(supabase, "billing_sub_change", { p_sub: id(req), p_account: me(req).id, p_plan: null, p_method: method.id, p_actor: me(req).id }).catch(() => undefined);
    const subscription = await subscriptionJson(id(req));
    if (result.payment.status === "failed")
      return res.status(402).json({ code: result.payment.failureCode, error: result.payment.failureMessage ?? "The payment didn't go through.", payment: result.payment, subscription });
    res.json({ payment: result.payment, subscription });
  }),
);

router.post(
  "/coupons/check",
  handle(async (req, res) => {
    const b = req.body ?? {};
    const code = input.text(b.code, 24, { required: true, label: "Code" }).toUpperCase();
    const { data: c } = await supabase.from("billing_coupons").select("*").eq("code", code).maybeSingle();
    const { data: plan } = typeof b.planId === "string" ? await supabase.from("billing_catalog").select("id,amount_cents,status,kind").eq("id", b.planId).maybeSingle() : { data: null };
    const { data: used } = c ? await supabase.from("billing_coupon_redemptions").select("code").eq("code", code).eq("account_id", me(req).id).maybeSingle() : { data: null };
    const valid =
      !!c &&
      !!plan &&
      plan.kind === "plan" &&
      plan.status === "active" &&
      c.active &&
      (!c.expires_at || new Date(c.expires_at) > new Date()) &&
      (c.max_redemptions === null || c.redeemed < c.max_redemptions) &&
      (!c.applies_to?.length || c.applies_to.includes(plan.id)) &&
      !used;
    if (!valid) throw new BillingError(400, "coupon_invalid", "That code isn't valid, has expired, or was already used on your account.");
    const discount = c.percent_off ? Math.round((plan.amount_cents * c.percent_off) / 100) : Math.min(c.amount_off_cents, plan.amount_cents);
    res.json({
      code,
      percentOff: c.percent_off,
      amountOff: c.amount_off_cents,
      duration: c.duration,
      durationMonths: c.duration_months,
      discount,
      firstTotal: plan.amount_cents - discount,
    });
  }),
);

/* ---------- One-time purchases ---------- */

router.post(
  "/purchases",
  payLimit,
  handle(async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.productId !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(b.productId)) throw new BillingError(400, "invalid_input", "Choose what to buy.");
    if (!input.isUuid(b.methodId)) throw new BillingError(400, "invalid_input", "Choose a card or bank account.");
    if (!input.isUuid(b.listingId)) throw new BillingError(400, "invalid_target", "Choose the listing to feature.");
    const result = await purchase({ accountId: me(req).id, productId: b.productId, target: { listingId: b.listingId }, methodId: b.methodId, key: input.key(b.key) });
    if (result.payment.status === "failed")
      return res.status(402).json({ code: result.payment.failureCode, error: result.payment.failureMessage ?? "The payment didn't go through.", ...result });
    res.status(201).json(result);
  }),
);

/* ---------- Invoices and receipts ---------- */

router.get(
  "/invoices",
  handle(async (req, res) => {
    const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
    res.json({ invoices: await rpc(supabase, "billing_invoices_for", { p_account: me(req).id, p_email: me(req).email ?? "", p_limit: 30, p_before: before }) });
  }),
);

router.get(
  "/invoices/:id",
  handle(async (req, res) => {
    const invoice = await rpc(supabase, "billing_payer_invoice", { p_invoice: id(req), p_account: me(req).id, p_email: me(req).email ?? "" });
    if (!invoice) throw new BillingError(404, "invoice_not_found", "That bill wasn't found.");
    res.json({ invoice });
  }),
);

router.post(
  "/invoices/:id/pay",
  payLimit,
  handle(async (req, res) => {
    const b = req.body ?? {};
    const invoice = await rpc<{ id: string; status: string } | null>(supabase, "billing_payer_invoice", { p_invoice: id(req), p_account: me(req).id, p_email: me(req).email ?? "" });
    if (!invoice) throw new BillingError(404, "invoice_not_found", "That bill wasn't found.");
    if (!input.isUuid(b.methodId)) throw new BillingError(400, "invalid_input", "Choose a card or bank account.");
    const method = await savedMethod(me(req).id, b.methodId);
    const result = await payInvoice({
      invoiceId: invoice.id,
      payerId: me(req).id,
      actorId: me(req).id,
      channel: method.type === "bank" ? "bank" : "card",
      method: { kind: "saved", methodId: method.id },
      key: input.key(b.key),
    });
    // Paying it yourself also claims the bill for your account (so it shows here even if your email changes).
    await supabase.from("billing_invoices").update({ account_id: me(req).id }).eq("id", invoice.id).is("account_id", null);
    if (result.payment.status === "failed")
      return res.status(402).json({ code: result.payment.failureCode, error: result.payment.failureMessage ?? "The payment didn't go through.", ...result });
    res.json(result);
  }),
);

router.get(
  "/payments",
  handle(async (req, res) => {
    res.json({ payments: await rpc(supabase, "billing_payments_for", { p_account: me(req).id, p_limit: 100 }) });
  }),
);

router.get(
  "/payments.csv",
  handle(async (req, res) => {
    const rows = await rpc<{ createdAt: string; invoiceNumber: string; stableName: string | null; kind: string; channel: string; method: { brand?: string; last4?: string; bankName?: string }; amount: number; refunded: number; status: string; test: boolean }[]>(
      supabase,
      "billing_payments_for",
      { p_account: me(req).id, p_limit: 500 },
    );
    const head = ["Date", "Invoice", "Paid to", "For", "Method", "Amount", "Refunded", "Status", "Test"];
    const body = rows.map((p) =>
      [
        p.createdAt.slice(0, 10),
        p.invoiceNumber,
        p.stableName ?? "Stayblz",
        p.kind,
        p.method.last4 ? `${p.method.brand || p.method.bankName || p.channel} •${p.method.last4}` : p.channel,
        input.dollars(p.amount),
        input.dollars(p.refunded),
        p.status,
        p.test ? "yes" : "no",
      ].map(input.csvCell).join(","),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="stayblz-payments.csv"');
    res.send([head.join(","), ...body].join("\r\n") + "\r\n");
  }),
);

/* ---------- Autopay for a stable's bills ---------- */

router.put(
  "/autopay",
  handle(async (req, res) => {
    const b = req.body ?? {};
    if (!input.isUuid(b.stableId) || !input.isUuid(b.methodId)) throw new BillingError(400, "invalid_input", "Choose a stable and a card or bank account.");
    await savedMethod(me(req).id, b.methodId);
    const overview = await rpc<{ billers: { stableId: string }[] }>(supabase, "billing_overview", { p_account: me(req).id, p_email: me(req).email ?? "" });
    if (!overview.billers.some((x) => x.stableId === b.stableId)) throw new BillingError(404, "not_found", "Autopay can be set up for stables that have sent you a bill.");
    const { error } = await supabase.from("billing_autopay").upsert({ account_id: me(req).id, stable_id: b.stableId, method_id: b.methodId, created_at: new Date().toISOString() }, { onConflict: "account_id,stable_id" });
    if (error) throw error;
    // Bills from this stable that are already open start paying themselves on their due date.
    const now = new Date().toISOString();
    const { data: open } = await supabase.from("billing_invoices").select("id,due_on,account_id,auto_collect").eq("stable_id", b.stableId).eq("status", "open").eq("account_id", me(req).id);
    for (const inv of open ?? [])
      if (!inv.auto_collect)
        await supabase
          .from("billing_invoices")
          .update({ auto_collect: true, attempts: 0, next_attempt_at: inv.due_on && `${inv.due_on}T00:00:00Z` > now ? `${inv.due_on}T00:00:00Z` : now })
          .eq("id", inv.id);
    res.json({ ok: true });
  }),
);

router.post(
  "/autopay/remove",
  handle(async (req, res) => {
    const b = req.body ?? {};
    if (!input.isUuid(b.stableId)) throw new BillingError(400, "invalid_input", "Choose a stable.");
    await supabase.from("billing_autopay").delete().eq("account_id", me(req).id).eq("stable_id", b.stableId);
    await supabase.from("billing_invoices").update({ auto_collect: false, next_attempt_at: null }).eq("stable_id", b.stableId).eq("account_id", me(req).id).eq("status", "open");
    res.json({ ok: true });
  }),
);

export default router;
