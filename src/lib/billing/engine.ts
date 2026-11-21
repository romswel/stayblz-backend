import { supabase } from "../supabase";
import { paymentProvider } from "./provider";
import { BillingError, rpc } from "./errors";
import { billingAlert, money, stableStaff } from "./alerts";

/**
 * Stayblz Billing engine: the steps between the API and the payment processor.
 *
 *   start (SQL: lock the bill, record a pending payment with its idempotency key)
 *     → processor (charge with the payment's id as the processor's idempotency key)
 *     → finish (SQL: apply the result to the bill, the ledger, the subscription)
 *
 * If the server stops between processor and finish, the payment stays "pending" and `reconcile()` asks the
 * processor again with the same key (same answer, never a second charge). Only one payment per bill can be
 * in flight (database index), so two clicks, two tabs or a retry can't pay twice.
 */

export type Channel = "card" | "bank" | "keyed" | "reader" | "offline";

export interface PaymentJson {
  id: string;
  invoiceId: string;
  stableId: string | null;
  channel: Channel;
  method: { type?: string; brand?: string; last4?: string; bankName?: string };
  amount: number;
  fee: number;
  net: number;
  refunded: number;
  status: "pending" | "processing" | "succeeded" | "failed";
  failureCode: string | null;
  failureMessage: string | null;
  auto: boolean;
  createdAt: string;
}
export interface InvoiceJson {
  id: string;
  number: string | null;
  issuer: "stayblz" | "stable";
  kind: "subscription" | "purchase" | "stable";
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  stableId: string | null;
  stableName: string | null;
  accountId: string | null;
  subscriptionId: string | null;
  catalogId: string | null;
  billTo: { name?: string; email?: string };
  total: number;
  paid: number;
  due: number;
  dueOn: string | null;
  [key: string]: unknown;
}
export interface PayResult {
  payment: PaymentJson;
  invoice: InvoiceJson;
  paid: boolean;
  replayed?: boolean;
}

/** How the person pays. */
export type PayMethod =
  | { kind: "saved"; methodId: string }
  | { kind: "token"; token: string; type: "card" | "bank" }
  | { kind: "offline"; offlineKind: "cash" | "check" | "bank_transfer" | "other"; reference: string; amountCents: number };

interface Resolved {
  methodId: string | null;
  token: string | null;
  type: "card" | "bank" | null;
  expMonth: number | null;
  expYear: number | null;
  snapshot: Record<string, unknown>;
}

async function settings() {
  const { data } = await supabase.from("billing_settings").select("mode,bank_settle_minutes,payout_delay_days,enforce_paywalls").eq("id", true).maybeSingle();
  return {
    mode: (data?.mode as string) ?? "test",
    bankSettleMinutes: Number(data?.bank_settle_minutes ?? 3),
    enforcePaywalls: data?.enforce_paywalls === true,
  };
}

/** A saved card/bank that belongs to the payer and is still active. */
export async function savedMethod(accountId: string, methodId: string) {
  const { data, error } = await supabase
    .from("billing_methods")
    .select("id,account_id,type,provider_ref,brand,last4,exp_month,exp_year,bank_name,holder_name,status")
    .eq("id", methodId)
    .eq("account_id", accountId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new BillingError(503, "billing_unavailable", "Billing is temporarily unavailable. Please try again.");
  if (!data) throw new BillingError(404, "method_not_found", "Choose a saved card or bank account.");
  return data as {
    id: string;
    type: "card" | "bank";
    provider_ref: string;
    brand: string;
    last4: string;
    exp_month: number | null;
    exp_year: number | null;
    bank_name: string;
    holder_name: string;
  };
}

async function resolve(payerId: string | null, channel: Channel, method: PayMethod): Promise<Resolved> {
  if (method.kind === "offline") {
    if (channel !== "offline") throw new BillingError(400, "invalid_channel", "That way of paying isn't available for this bill.");
    return { methodId: null, token: null, type: null, expMonth: null, expYear: null, snapshot: {} };
  }
  if (channel === "offline") throw new BillingError(400, "invalid_channel", "That way of paying isn't available for this bill.");
  const wantType = channel === "bank" ? "bank" : "card";
  if (method.kind === "saved") {
    if (!payerId) throw new BillingError(401, "sign_in", "Sign in to use a saved card.");
    const m = await savedMethod(payerId, method.methodId);
    if (m.type !== wantType) throw new BillingError(400, "invalid_channel", "That card or bank account can't be used this way.");
    return {
      methodId: m.id,
      token: m.provider_ref,
      type: m.type,
      expMonth: m.exp_month,
      expYear: m.exp_year,
      snapshot: { type: m.type, brand: m.brand, last4: m.last4, bankName: m.bank_name, holder: m.holder_name, ref: m.provider_ref },
    };
  }
  if (method.type !== wantType) throw new BillingError(400, "invalid_channel", "That card or bank account can't be used this way.");
  const details = paymentProvider().describe(method.token, method.type);
  if (!details)
    throw new BillingError(400, "invalid_method", "Use one of the Stayblz test cards or banks. Real cards can't be used while billing is in test mode.");
  return {
    methodId: null,
    token: method.token,
    type: method.type,
    expMonth: null,
    expYear: null,
    snapshot: { type: details.type, brand: details.brand, last4: details.last4, bankName: details.bankName, ref: method.token },
  };
}

/** Records the processor's answer. */
async function finish(paymentId: string, outcome: Awaited<ReturnType<ReturnType<typeof paymentProvider>["charge"]>>) {
  const s = await settings();
  return rpc<PayResult>(supabase, "billing_pay_finish", {
    p_payment: paymentId,
    p_status: outcome.status,
    p_ref: outcome.providerRef,
    p_code: outcome.status === "failed" ? outcome.failureCode : null,
    p_message: outcome.status === "failed" ? outcome.failureMessage : null,
    p_settles_at: outcome.status === "processing" ? new Date(Date.now() + s.bankSettleMinutes * 60_000).toISOString() : null,
  });
}

/** Alerts after a payment ends well (fire and forget). */
async function announcePaid(result: PayResult) {
  const { invoice, payment } = result;
  if (payment.status !== "succeeded") return;
  if (invoice.issuer === "stable" && invoice.stableId) {
    const staff = await stableStaff(invoice.stableId);
    const who = invoice.billTo?.name || "A client";
    billingAlert(
      staff,
      result.paid ? "Invoice paid" : "Payment received",
      `${who} paid ${money(payment.amount)} on ${invoice.number}${payment.channel === "offline" ? " (recorded)" : ""}`,
      `/workspace/billing/invoices/${invoice.id}?stable=${invoice.stableId}`,
      invoice.id,
    );
    if (payment.auto && invoice.accountId)
      billingAlert(
        [invoice.accountId],
        "Autopay paid a bill",
        `${money(payment.amount)} to ${invoice.stableName ?? "your stable"} for ${invoice.number}`,
        `/billing/invoices/${invoice.id}`,
        invoice.id,
      );
  }
}

/**
 * Pays an invoice. `key` = the browser's idempotency key for this attempt (or the schedule's for automatic
 * collection). Same key again = the same payment back, never a second charge.
 */
export async function payInvoice(opts: {
  invoiceId: string;
  payerId: string | null;
  actorId: string | null;
  channel: Channel;
  method: PayMethod;
  key: string;
  auto?: boolean;
}): Promise<PayResult> {
  const resolved = await resolve(opts.payerId, opts.channel, opts.method);
  const start = await rpc<PayResult & { charge?: { amount: number } }>(supabase, "billing_pay_start", {
    p_invoice: opts.invoiceId,
    p_payer: opts.payerId,
    p_channel: opts.channel,
    p_method_id: resolved.methodId,
    p_method: resolved.snapshot,
    p_amount: opts.method.kind === "offline" ? opts.method.amountCents : null,
    p_key: opts.key,
    p_actor: opts.actorId,
    p_auto: opts.auto ?? false,
    p_offline_kind: opts.method.kind === "offline" ? opts.method.offlineKind : null,
    p_reference: opts.method.kind === "offline" ? opts.method.reference : null,
  });
  if (opts.channel === "offline") {
    void announcePaid(start).catch(() => undefined);
    return start;
  }
  // The same attempt again: report how it ended, or (still pending) finish it with the same key.
  if (start.replayed && start.payment.status !== "pending") return start;
  // A retried attempt is always finished with the card/bank it started with (never one chosen later),
  // so the processor sees the same request under the same key.
  let charge = { token: resolved.token!, type: resolved.type!, expMonth: resolved.expMonth, expYear: resolved.expYear };
  if (start.replayed) {
    const { data: original } = await supabase.from("billing_payments").select("method").eq("id", start.payment.id).maybeSingle();
    const m = (original?.method ?? {}) as { ref?: string; type?: string };
    if (!m.ref) throw new BillingError(409, "payment_in_progress", "A payment for this bill is already in progress. Wait for it to finish before trying again.");
    charge = { token: m.ref, type: m.type === "bank" ? "bank" : "card", expMonth: null, expYear: null };
  }
  let outcome;
  try {
    outcome = await paymentProvider().charge({
      token: charge.token,
      type: charge.type,
      amountCents: start.payment.amount,
      idempotencyKey: start.payment.id,
      expMonth: charge.expMonth,
      expYear: charge.expYear,
    });
  } catch {
    throw new BillingError(
      503,
      "payment_unconfirmed",
      "We couldn't confirm this payment yet. We'll check again in a minute; please don't pay again in the meantime.",
    );
  }
  const result = await finish(start.payment.id, outcome);
  void announcePaid(result).catch(() => undefined);
  return result;
}

/** Subscribe: create the subscription, then pay its first invoice (unless it starts with a free trial). */
export async function subscribe(opts: { accountId: string; planId: string; methodId: string; coupon: string | null; key: string }) {
  const method = await savedMethod(opts.accountId, opts.methodId);
  const made = await rpc<{ subscription: Record<string, unknown>; invoice: InvoiceJson | null }>(supabase, "billing_subscribe", {
    p_account: opts.accountId,
    p_plan: opts.planId,
    p_method: opts.methodId,
    p_coupon: opts.coupon,
    p_actor: opts.accountId,
  });
  let payment: PaymentJson | null = null;
  if (made.invoice && made.invoice.status === "open") {
    const paid = await payInvoice({
      invoiceId: made.invoice.id,
      payerId: opts.accountId,
      actorId: opts.accountId,
      channel: method.type === "bank" ? "bank" : "card",
      method: { kind: "saved", methodId: opts.methodId },
      key: opts.key,
    });
    payment = paid.payment;
  }
  const subscription = await subscriptionJson(String(made.subscription.id));
  return { subscription, payment };
}

export async function subscriptionJson(id: string) {
  const { data } = await supabase.rpc("billing_sub_one", { p_sub: id });
  return data as Record<string, unknown> | null;
}

/** A one-time purchase: creates (or reuses) the invoice, then pays it. */
export async function purchase(opts: { accountId: string; productId: string; target: Record<string, string>; methodId: string; key: string }) {
  const method = await savedMethod(opts.accountId, opts.methodId);
  const made = await rpc<{ invoice: InvoiceJson }>(supabase, "billing_purchase", {
    p_account: opts.accountId,
    p_product: opts.productId,
    p_target: opts.target,
    p_actor: opts.accountId,
  });
  return payInvoice({
    invoiceId: made.invoice.id,
    payerId: opts.accountId,
    actorId: opts.accountId,
    channel: method.type === "bank" ? "bank" : "card",
    method: { kind: "saved", methodId: opts.methodId },
    key: opts.key,
  });
}

/** Refund all (amountCents null) or part of a payment. stableId null = Stayblz refunding its own sale. */
export async function refundPayment(opts: {
  paymentId: string;
  stableId: string | null;
  amountCents: number | null;
  reason: string;
  note: string;
  key: string;
  actorId: string;
}) {
  const start = await rpc<{ refund: { id: string; status: string; amount_cents: number }; replayed: boolean; offline?: boolean; paymentRef?: string | null }>(
    supabase,
    "billing_refund_start",
    {
      p_payment: opts.paymentId,
      p_stable: opts.stableId,
      p_amount: opts.amountCents,
      p_reason: opts.reason,
      p_note: opts.note,
      p_key: opts.key,
      p_actor: opts.actorId,
    },
  );
  if (start.replayed && start.refund.status !== "pending") return { refund: start.refund };
  let ok = true;
  let ref: string | null = null;
  let message: string | null = null;
  if (!start.offline) {
    try {
      const r = await paymentProvider().refund({ paymentRef: start.paymentRef ?? "", amountCents: start.refund.amount_cents, idempotencyKey: start.refund.id });
      ok = r.ok;
      ref = r.providerRef;
      message = r.message ?? null;
    } catch {
      throw new BillingError(503, "refund_unconfirmed", "We couldn't confirm the refund yet. Try again in a minute; it won't be sent twice.");
    }
  }
  const done = await rpc<{ refund: { status: string; amount_cents: number }; invoice?: InvoiceJson; payment?: PaymentJson }>(
    supabase,
    "billing_refund_finish",
    { p_refund: start.refund.id, p_ok: ok, p_ref: ref, p_message: message },
  );
  if (done.refund.status === "succeeded" && done.invoice?.accountId && !start.offline)
    billingAlert(
      [done.invoice.accountId],
      "Refund on its way",
      `${money(done.refund.amount_cents)} back to your ${done.payment?.method?.type === "bank" ? "bank account" : "card"} for ${done.invoice.number}`,
      `/billing/invoices/${done.invoice.id}`,
      done.invoice.id,
    );
  return done;
}

/** Pays out (all of) a stable's available balance to its payout bank account. */
export async function payout(opts: { stableId: string; amountCents: number | null; key: string; actorId: string }) {
  const start = await rpc<{ payout: { id: string; status: string; amount_cents: number }; replayed: boolean; destinationRef?: string }>(
    supabase,
    "billing_payout_start",
    { p_stable: opts.stableId, p_amount: opts.amountCents, p_key: opts.key, p_actor: opts.actorId },
  );
  if (start.replayed && start.payout.status !== "pending") return { payout: start.payout };
  let result;
  try {
    result = await paymentProvider().payout({ destinationToken: start.destinationRef ?? "", amountCents: start.payout.amount_cents, idempotencyKey: start.payout.id });
  } catch {
    throw new BillingError(503, "payout_unconfirmed", "We couldn't confirm the payout yet. Try again in a minute; it won't be sent twice.");
  }
  const done = await rpc<{ payout: { status: string; amount_cents: number; arrives_on: string | null } }>(supabase, "billing_payout_finish", {
    p_payout: start.payout.id,
    p_ok: result.ok,
    p_ref: result.providerRef,
    p_message: result.ok ? null : result.message,
    p_arrives: result.ok ? result.arrivesOn : null,
  });
  if (done.payout.status === "paid") {
    const staff = await stableStaff(opts.stableId);
    billingAlert(
      staff,
      "Payout sent",
      `${money(done.payout.amount_cents)} is on its way to your bank${done.payout.arrives_on ? `, arriving about ${done.payout.arrives_on}` : ""}`,
      `/workspace/billing/payouts?stable=${opts.stableId}`,
      null,
    );
  }
  return done;
}

/** Can this person use a paid feature? Staff can always (to check it); paywalls off = everyone. */
export async function featureAccess(user: { id: string; role: string }, feature: string) {
  try {
    const s = await settings();
    if (!s.enforcePaywalls) return { allowed: true, reason: "open" as const, enforced: false };
    if (user.role === "admin" || user.role === "superadmin") return { allowed: true, reason: "staff" as const, enforced: true };
    const { data, error } = await supabase.rpc("billing_features", { p_account: user.id });
    if (error) throw error;
    const has = Array.isArray(data) && (data as string[]).includes(feature);
    return { allowed: has, reason: has ? ("subscribed" as const) : ("required" as const), enforced: true };
  } catch {
    // Billing unreachable: don't lock paying people out of what they bought (the paywall is off by default anyway).
    return { allowed: true, reason: "unavailable" as const, enforced: false };
  }
}
