import { Router, type Request, type Response } from "express";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { supabase } from "../lib/supabase";
import { BillingError, rpc, sendBillingError } from "../lib/billing/errors";
import { payInvoice, savedMethod, type InvoiceJson } from "../lib/billing/engine";
import * as input from "../lib/billing/input";

/**
 * Pay links: /api/pay/:token. A stable shares the link with a client (by text, chat or email of their own);
 * the client can pay without a Stayblz account. Signed in, they can also use a saved card. The token is 64
 * random hex characters; a new link (or cancelling the invoice) makes the old one stop working.
 *
 * Card-testing guard: few attempts per address and per link.
 */
const router = Router();
router.use(optionalAuth);

const viewLimit = authLimit("billing-link-view", 120, 10 * 60_000);
// 12 tries per address per 10 minutes (BILLING_LINK_PAY_LIMIT changes it, e.g. for tests).
const payLimitIp = authLimit("billing-link-pay", () => Number(process.env.BILLING_LINK_PAY_LIMIT ?? 12), 10 * 60_000);
const payLimitLink = authLimit("billing-link-pay-token", 8, 10 * 60_000, (req) => (typeof req.params.token === "string" ? req.params.token.slice(0, 64) : null));

const token = (req: Request) => {
  const t = String(req.params.token ?? "");
  if (!/^[0-9a-f]{64}$/.test(t)) throw new BillingError(404, "link_not_found", "This pay link isn't valid or is no longer active.");
  return t;
};
const signedIn = (req: Request) => (req as Partial<AuthenticatedRequest>).user ?? null;

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req, res) => {
    res.setHeader("X-Robots-Tag", "noindex");
    try {
      await fn(req, res);
    } catch (error) {
      sendBillingError(res, error);
    }
  });

router.get(
  "/:token",
  viewLimit,
  handle(async (req, res) => {
    const invoice = await rpc<InvoiceJson | null>(supabase, "billing_by_token", { p_token: token(req) });
    if (!invoice) throw new BillingError(404, "link_not_found", "This pay link isn't valid or is no longer active.");
    res.json({ invoice, signedIn: !!signedIn(req) });
  }),
);

router.post(
  "/:token/pay",
  payLimitIp,
  payLimitLink,
  handle(async (req, res) => {
    const invoice = await rpc<InvoiceJson | null>(supabase, "billing_by_token", { p_token: token(req) });
    if (!invoice) throw new BillingError(404, "link_not_found", "This pay link isn't valid or is no longer active.");
    const b = req.body ?? {};
    const user = signedIn(req);
    let channel: "card" | "bank";
    let method: { kind: "saved"; methodId: string } | { kind: "token"; token: string; type: "card" | "bank" };
    if (b.methodId) {
      if (!user) throw new BillingError(401, "sign_in", "Sign in to use a saved card.");
      if (!input.isUuid(b.methodId)) throw new BillingError(400, "invalid_input", "Choose a card or bank account.");
      const saved = await savedMethod(user.id, b.methodId);
      channel = saved.type === "bank" ? "bank" : "card";
      method = { kind: "saved", methodId: saved.id };
    } else {
      const type = b.type === "bank" ? "bank" : "card";
      if (typeof b.token !== "string") throw new BillingError(400, "invalid_method", "Enter a card or bank account.");
      channel = type;
      method = { kind: "token", token: b.token, type };
    }
    const result = await payInvoice({ invoiceId: invoice.id, payerId: user?.id ?? null, actorId: user?.id ?? null, channel, method, key: input.key(b.key) });
    // Signed in and paying it: the bill is now also listed in your own Billing page.
    if (user && result.payment.status !== "failed")
      await supabase.from("billing_invoices").update({ account_id: user.id }).eq("id", invoice.id).is("account_id", null);
    const fresh = await rpc<InvoiceJson | null>(supabase, "billing_by_token", { p_token: token(req) });
    const body = { payment: result.payment, invoice: fresh, paid: result.paid };
    if (result.payment.status === "failed")
      return res.status(402).json({ code: result.payment.failureCode, error: result.payment.failureMessage ?? "The payment didn't go through.", ...body });
    res.json(body);
  }),
);

export default router;
