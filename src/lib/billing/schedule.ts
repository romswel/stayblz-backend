import { supabase } from "../supabase";
import { paymentProvider } from "./provider";
import { rpc } from "./errors";
import { payInvoice, type PayResult } from "./engine";
import { billingAlert, money, stableStaff } from "./alerts";

/**
 * The billing schedule (every minute while the server is awake, and once when it starts):
 *   1. reconcile  payments left "pending" by a crash: ask the processor again with the same key
 *   2. settle     bank transfers whose clearing time has come
 *   3. cycle      renewals: end what was cancelled, open the next period's invoice, trial reminders
 *   4. collect    charge invoices due for automatic payment (renewals, client autopay), retry failures
 *
 * Render's free plan sleeps; on waking the schedule catches up (everything is "due at or before now").
 * Each step claims its rows with a lease in SQL, so two runs at once never handle the same payment.
 */
type Claimed = { id: string; channel?: string; amount?: number; method?: { ref?: string; type?: string }; auto?: boolean; providerRef?: string; invoiceId: string };

const report = () => ({ reconciled: 0, settled: 0, renewalsOpened: 0, ended: 0, collected: 0, failed: 0, errors: 0 });
export type SweepReport = ReturnType<typeof report>;

async function afterFailure(invoiceId: string, code: string | null, auto: boolean) {
  if (!auto) return;
  const r = await rpc<{ skipped?: boolean; final?: boolean; invoice?: { accountId: string | null; kind: string; number: string; total: number; stableName: string | null; id: string; subscriptionId: string | null }; nextAttemptAt?: string | null }>(
    supabase,
    "billing_collect_failed",
    { p_invoice: invoiceId, p_code: code ?? "declined" },
  );
  if (r.skipped || !r.invoice?.accountId) return;
  const inv = r.invoice;
  const when = r.nextAttemptAt ? new Date(r.nextAttemptAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;
  if (inv.kind === "subscription") {
    billingAlert(
      [inv.accountId!],
      r.final ? "Your plan has ended" : "Payment didn't go through",
      r.final
        ? `We couldn't charge ${money(inv.total)} after several tries, so the plan was cancelled. You can subscribe again any time.`
        : `We couldn't charge ${money(inv.total)} for your plan. We'll try again on ${when}. Update your card to keep access.`,
      "/billing",
      inv.id,
    );
  } else {
    billingAlert(
      [inv.accountId!],
      "Autopay didn't go through",
      r.final
        ? `${inv.number} from ${inv.stableName ?? "your stable"} is still due. Pay it from Billing.`
        : `${inv.number} from ${inv.stableName ?? "your stable"}: we'll try again on ${when}.`,
      `/billing/invoices/${inv.id}`,
      inv.id,
    );
  }
}

async function bankFailed(result: PayResult) {
  if (result.payment.status !== "failed" || result.payment.channel !== "bank") return;
  const inv = result.invoice;
  if (inv.accountId && !result.payment.auto)
    billingAlert([inv.accountId], "Bank payment didn't clear", `${money(result.payment.amount)} for ${inv.number}: ${result.payment.failureMessage ?? "the bank returned it"}.`, inv.issuer === "stable" ? `/billing/invoices/${inv.id}` : "/billing", inv.id);
  if (inv.issuer === "stable" && inv.stableId) {
    const staff = await stableStaff(inv.stableId);
    billingAlert(staff, "A bank payment was returned", `${inv.billTo?.name || "A client"}'s ${money(result.payment.amount)} for ${inv.number} didn't clear. The invoice is due again.`, `/workspace/billing/invoices/${inv.id}?stable=${inv.stableId}`, inv.id);
  }
}

async function reconcile(out: SweepReport) {
  const stale = await rpc<Claimed[]>(supabase, "billing_stale_claim", { p_limit: 20 });
  for (const p of stale) {
    try {
      const method = (p.method ?? {}) as { ref?: string; type?: string; expMonth?: number; expYear?: number };
      const outcome = await paymentProvider().charge({
        token: method.ref ?? "",
        type: method.type === "bank" ? "bank" : "card",
        amountCents: p.amount ?? 0,
        idempotencyKey: p.id,
      });
      const result = await rpc<PayResult>(supabase, "billing_pay_finish", {
        p_payment: p.id,
        p_status: outcome.status,
        p_ref: outcome.providerRef,
        p_code: outcome.status === "failed" ? outcome.failureCode : null,
        p_message: outcome.status === "failed" ? outcome.failureMessage : null,
        p_settles_at: outcome.status === "processing" ? new Date(Date.now() + 3 * 60_000).toISOString() : null,
      });
      out.reconciled++;
      if (result.payment.status === "failed") await afterFailure(p.invoiceId, result.payment.failureCode, !!p.auto);
    } catch {
      out.errors++;
    }
  }
}

async function settle(out: SweepReport) {
  const due = await rpc<Claimed[]>(supabase, "billing_settle_claim", { p_limit: 20 });
  for (const p of due) {
    try {
      const outcome = await paymentProvider().retrieve(p.providerRef ?? "");
      if (outcome.status === "processing") continue;
      const result = await rpc<PayResult>(supabase, "billing_pay_finish", {
        p_payment: p.id,
        p_status: outcome.status,
        p_ref: outcome.providerRef,
        p_code: outcome.status === "failed" ? outcome.failureCode : null,
        p_message: outcome.status === "failed" ? outcome.failureMessage : null,
        p_settles_at: null,
      });
      out.settled++;
      if (result.payment.status === "failed") {
        await bankFailed(result);
        await afterFailure(p.invoiceId, result.payment.failureCode, !!p.auto);
      } else if (result.payment.status === "succeeded" && result.invoice.issuer === "stable" && result.invoice.stableId) {
        const staff = await stableStaff(result.invoice.stableId);
        billingAlert(staff, result.paid ? "Invoice paid" : "Payment received", `${result.invoice.billTo?.name || "A client"}'s bank payment of ${money(result.payment.amount)} for ${result.invoice.number} cleared`, `/workspace/billing/invoices/${result.invoice.id}?stable=${result.invoice.stableId}`, result.invoice.id);
      }
    } catch {
      out.errors++;
    }
  }
}

async function cycle(out: SweepReport) {
  const r = await rpc<{ created: unknown[]; ended: unknown[]; trialsEnding: { accountId: string; trialEnd: string; amount: number }[] }>(supabase, "billing_cycle", { p_limit: 100 });
  out.renewalsOpened += r.created.length;
  out.ended += r.ended.length;
  for (const t of r.trialsEnding)
    billingAlert(
      [t.accountId],
      "Your free trial ends soon",
      `It ends on ${new Date(t.trialEnd).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}. Then ${money(t.amount)} is charged unless you cancel.`,
      "/billing",
      null,
    );
}

async function collect(out: SweepReport) {
  const due = await rpc<{ invoiceId: string; accountId: string | null; attempts: number; method: { id: string; type: "card" | "bank" } | null }[]>(
    supabase,
    "billing_collect_claim",
    { p_limit: 20 },
  );
  for (const item of due) {
    try {
      if (!item.method || !item.accountId) {
        await afterFailure(item.invoiceId, "no_payment_method", true);
        out.failed++;
        continue;
      }
      const result = await payInvoice({
        invoiceId: item.invoiceId,
        payerId: item.accountId,
        actorId: null,
        channel: item.method.type === "bank" ? "bank" : "card",
        method: { kind: "saved", methodId: item.method.id },
        key: `auto-${item.invoiceId}-${item.attempts}`,
        auto: true,
      });
      if (result.payment.status === "failed") {
        await afterFailure(item.invoiceId, result.payment.failureCode, true);
        out.failed++;
      } else out.collected++;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // Somebody is paying it right now, or the card was removed: count it as a failed try (not for "in progress").
      if (code === "method_not_found") {
        await afterFailure(item.invoiceId, "no_payment_method", true).catch(() => undefined);
        out.failed++;
      } else out.errors++;
    }
  }
}

let running: Promise<SweepReport> | null = null;
/** One full pass. Concurrent calls share the pass already running. */
export function runBillingSweep(): Promise<SweepReport> {
  if (running) return running;
  running = (async () => {
    const out = report();
    for (const step of [reconcile, settle, cycle, collect]) {
      try {
        await step(out);
      } catch (error) {
        out.errors++;
        console.error(`[billing] ${step.name} failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      }
    }
    return out;
  })().finally(() => {
    running = null;
  });
  return running;
}

let timer: NodeJS.Timeout | null = null;
export function startBillingSchedule(everyMs = 60_000) {
  if (timer || process.env.BILLING_SCHEDULE === "off") return false;
  const tick = () => void runBillingSweep().catch(() => undefined);
  setTimeout(tick, 5_000).unref();
  timer = setInterval(tick, everyMs);
  timer.unref();
  return true;
}
