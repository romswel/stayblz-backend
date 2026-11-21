import type { Response } from "express";

/** A billing problem with a status and plain words for the person. */
export class BillingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Codes raised by the SQL functions in 202611210002_billing.sql → status + words. */
const KNOWN: Record<string, [number, string]> = {
  invoice_not_found: [404, "That bill wasn't found."],
  invoice_not_payable: [409, "This bill can't be paid: it's already paid or was cancelled."],
  invoice_not_draft: [409, "Only draft invoices can be changed. This one has already been sent."],
  invoice_not_voidable: [409, "Only unpaid invoices can be cancelled."],
  payment_in_progress: [409, "A payment for this bill is already in progress. Wait for it to finish before trying again."],
  invalid_amount: [400, "Check the amount: it can't be more than what's due."],
  invalid_channel: [400, "That way of paying isn't available for this bill."],
  method_not_accepted: [400, "This bill doesn't accept that payment method."],
  amount_too_small: [400, "Card and bank payments must be at least $0.50."],
  idempotency_conflict: [409, "This request was already used for something else. Refresh and try again."],
  invalid_key: [400, "Refresh the page and try again."],
  plan_unavailable: [404, "That plan isn't available."],
  product_unavailable: [404, "That item isn't available."],
  already_subscribed: [409, "You already have this plan."],
  method_not_found: [404, "Choose a saved card or bank account."],
  coupon_invalid: [400, "That code isn't valid, has expired, or was already used on your account."],
  unknown_account: [404, "Account not found."],
  invalid_target: [400, "Choose what this purchase is for."],
  listing_not_found: [404, "That listing wasn't found."],
  not_your_listing: [403, "You can only feature your own listings."],
  payment_not_found: [404, "That payment wasn't found."],
  not_refundable: [409, "Nothing is left to refund on this payment."],
  refund_too_large: [400, "A refund can't be more than what's left of the payment."],
  invalid_reason: [400, "Choose a reason for the refund."],
  refund_not_found: [404, "That refund wasn't found."],
  payments_not_set_up: [409, "Set up payments for this stable first (Billing → Settings)."],
  no_payout_account: [409, "Add a payout bank account in Billing → Settings first."],
  payout_too_small: [400, "Payouts start at $1.00."],
  insufficient_balance: [409, "That's more than the balance available to pay out."],
  payout_not_found: [404, "That payout wasn't found."],
  client_not_found: [404, "Choose one of this stable's clients."],
  horse_not_found: [404, "Choose one of this stable's horses."],
  invalid_owners: [400, "Check the owners: each needs a share between 0.01% and 100%."],
  shares_over: [400, "Owner shares can't add up to more than 100%."],
  invalid_lines: [400, "Check the invoice lines: each needs a type, a description, a quantity and a price."],
  empty_invoice: [400, "Add at least one line before sending."],
  negative_total: [400, "The total can't be below zero. Remove a credit or add charges."],
  no_payment_methods: [400, "Allow card or bank payments for this invoice."],
  has_payments: [409, "This invoice has payments. Refund them before cancelling it."],
  too_many_lines: [400, "An invoice can hold up to 200 lines."],
  subscription_not_found: [404, "That plan wasn't found."],
  not_resumable: [409, "This plan isn't set to end, so there's nothing to undo."],
  test_mode_only: [409, "That's only available while billing is in test mode."],
};

export function billingErrorFrom(error: unknown): BillingError {
  if (error instanceof BillingError) return error;
  const message = String((error as { message?: unknown })?.message ?? "");
  for (const [code, [status, words]] of Object.entries(KNOWN)) {
    if (message.includes(code)) return new BillingError(status, code, words);
  }
  const pg = (error as { code?: string })?.code;
  if (pg === "23505" && /billing_subscriptions_live/.test(message))
    return new BillingError(409, "already_subscribed", KNOWN.already_subscribed[1]);
  if (pg === "23505" && /billing_payments_in_flight/.test(message))
    return new BillingError(409, "payment_in_progress", KNOWN.payment_in_progress[1]);
  if (pg === "23505" && /billing_clients_email/.test(message))
    return new BillingError(409, "client_exists", "A client with this email already exists.");
  if (["PGRST202", "PGRST205", "42P01", "42883"].includes(pg ?? "") && /billing/.test(message))
    return new BillingError(503, "setup_database", "Billing isn't set up on the database yet: run migration 202611210002_billing.sql.");
  console.error(`[billing] unexpected error: ${pg ?? "?"} ${message.slice(0, 300)}`);
  return new BillingError(503, "billing_unavailable", "Billing is temporarily unavailable. Please try again.");
}

export function sendBillingError(res: Response, error: unknown) {
  const e = billingErrorFrom(error);
  return res.status(e.status).json({ error: e.message, code: e.code });
}

/** Runs a Supabase RPC and throws a BillingError on failure. */
export async function rpc<T = unknown>(
  client: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> },
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw billingErrorFrom(error);
  return data as T;
}
