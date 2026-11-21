import { Router, type NextFunction, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import type { StableRequest } from "../middleware/stable";
import { supabase } from "../lib/supabase";
import { BillingError, rpc, sendBillingError } from "../lib/billing/errors";
import { paymentProvider } from "../lib/billing/provider";
import { payInvoice, payout, refundPayment, type InvoiceJson } from "../lib/billing/engine";
import { billingPushSaved } from "../lib/billing/alerts";
import * as input from "../lib/billing/input";

/**
 * Stable billing ("Barn office"), mounted at /api/workspace/billing behind requireAuth + requireStable.
 * Owners and managers run it; other members can't see the stable's money. Setting up payments and paying out
 * are for the owner only. Stayblz takes its fee from each card/bank payment (Billing settings); cash and cheques
 * the stable records itself carry no fee.
 */
const router = Router();

const st = (req: Request) => (req as StableRequest).stable;
const me = (req: Request) => (req as StableRequest).user;
const perUser = (req: Request) => (req as Partial<StableRequest>).user?.id ?? null;
const takeLimit = authLimit("billing-stable-take", 30, 10 * 60_000, perUser);
const sendLimit = authLimit("billing-stable-send", 60, 10 * 60_000, perUser);

router.use((req, res, next) => {
  if (!["owner", "manager"].includes(st(req).role)) {
    res.status(403).json({ error: "Only this stable's owner and managers can see its billing.", code: "billing_staff_only" });
    return;
  }
  if (req.method !== "GET" && me(req).passwordSetupRequired) {
    res.status(403).json({ error: "Complete password setup before changing billing." });
    return;
  }
  next();
});
const ownerOnly = (req: Request, res: Response, next: NextFunction) => {
  if (st(req).role !== "owner") {
    res.status(403).json({ error: "Only the stable's owner can do this.", code: "owner_only" });
    return;
  }
  next();
};

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
/** Integer cents for quantity x unit price, rounded half away from zero (same as the SQL). */
const lineCents = (quantity: number, unit: number) => {
  const n = Math.round(quantity * 100) * unit;
  return Math.sign(n) * Math.floor((Math.abs(n) + 50) / 100);
};

/* ---------- Overview and setup ---------- */

router.get(
  "/overview",
  handle(async (req, res) => {
    const data = await rpc<Record<string, unknown>>(supabase, "billing_stable_overview", { p_stable: st(req).id });
    res.json({ ...data, role: st(req).role, stableName: await stableName(st(req).id) });
  }),
);

async function stableName(stableId: string) {
  const { data } = await supabase.from("member_stables").select("name").eq("id", stableId).maybeSingle();
  return (data?.name as string) ?? "";
}

router.get(
  "/setup",
  handle(async (req, res) => {
    const { data, error } = await supabase.from("billing_merchants").select("*").eq("stable_id", st(req).id).maybeSingle();
    if (error) throw error;
    const name = await stableName(st(req).id);
    const merchant = data ? (({ payout_ref: _hidden, ...rest }) => rest)(data as Record<string, unknown>) : null;
    res.json({ merchant, suggested: { legalName: name, statementName: name.slice(0, 22), invoicePrefix: input.prefixFrom(name) } });
  }),
);

router.put(
  "/setup",
  ownerOnly,
  handle(async (req, res) => {
    const b = req.body ?? {};
    const { data: current } = await supabase.from("billing_merchants").select("stable_id,payout,payout_ref").eq("stable_id", st(req).id).maybeSingle();
    if (!current && b.acceptTerms !== true)
      throw new BillingError(400, "terms_required", "Agree to the Stayblz payments terms to start taking payments.");
    const businessType = b.businessType === "company" ? "company" : b.businessType === "individual" ? "individual" : null;
    if (!businessType) throw new BillingError(400, "invalid_input", "Choose individual or company.");
    const prefix = input.text(b.invoicePrefix, 8, { required: true, label: "Invoice prefix" }).toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(prefix)) throw new BillingError(400, "invalid_input", "The invoice prefix is 2 to 8 letters or numbers.");
    const termsDays = b.termsDays ?? 15;
    if (typeof termsDays !== "number" || !Number.isInteger(termsDays) || termsDays < 0 || termsDays > 120)
      throw new BillingError(400, "invalid_input", "Payment terms are 0 to 120 days.");
    let payout = (current?.payout as Record<string, unknown>) ?? {};
    let payoutRef = (current?.payout_ref as string | null) ?? null;
    if (b.payoutToken !== undefined && b.payoutToken !== null && b.payoutToken !== "") {
      const bank = paymentProvider().describe(b.payoutToken, "bank");
      if (!bank) throw new BillingError(400, "invalid_method", "Use the Stayblz test bank for payouts while billing is in test mode.");
      payout = { bankName: bank.bankName, last4: bank.last4, holder: input.text(b.payoutHolder, 120, { label: "Account holder" }) };
      payoutRef = b.payoutToken;
    }
    const acceptCard = input.bool(b.acceptCard, true);
    const acceptBank = input.bool(b.acceptBank, true);
    if (!acceptCard && !acceptBank) throw new BillingError(400, "invalid_input", "Accept cards, bank transfers, or both.");
    const now = new Date().toISOString();
    const row = {
      stable_id: st(req).id,
      legal_name: input.text(b.legalName, 120, { required: true, label: "Business name" }),
      business_type: businessType,
      email: input.email(b.email),
      phone: input.text(b.phone, 40, { label: "Phone" }),
      statement_name: input.text(b.statementName, 22, { required: true, label: "Statement name" }),
      invoice_prefix: prefix,
      terms_days: termsDays,
      default_memo: input.text(b.defaultMemo, 1000, { label: "Invoice note" }),
      accept_card: acceptCard,
      accept_bank: acceptBank,
      payout,
      payout_ref: payoutRef,
      updated_at: now,
    };
    if (row.legal_name.length < 2) throw new BillingError(400, "invalid_input", "Enter the business name.");
    if (row.statement_name.length < 2) throw new BillingError(400, "invalid_input", "Enter a statement name.");
    const { error } = current
      ? await supabase.from("billing_merchants").update(row).eq("stable_id", st(req).id)
      : await supabase.from("billing_merchants").insert({ ...row, status: "active", terms_accepted_at: now, terms_accepted_by: me(req).id, test: !paymentProvider().live });
    if (error) throw error;
    await rpc(supabase, "billing_event", {
      p_actor: me(req).id,
      p_account: null,
      p_stable: st(req).id,
      p_invoice: null,
      p_payment: null,
      p_event: current ? "merchant.updated" : "merchant.created",
      p_detail: {},
    });
    res.json({ ok: true });
  }),
);

/* ---------- Clients ---------- */

const CLIENT_COLUMNS = "id,stable_id,name,email,phone,company,notes,archived,created_at,updated_at";
const clientOut = (c: Record<string, unknown>) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  phone: c.phone,
  company: c.company,
  notes: c.notes,
  archived: c.archived,
  createdAt: c.created_at,
});
function clientInput(b: Record<string, unknown>) {
  return {
    name: input.text(b.name, 120, { required: true, label: "Name" }),
    email: input.email(b.email),
    phone: input.text(b.phone, 40, { label: "Phone" }),
    company: input.text(b.company, 120, { label: "Company" }),
    notes: input.text(b.notes, 1000, { label: "Notes" }),
  };
}
async function ownClient(stableId: string, clientId: string) {
  const { data } = await supabase.from("billing_clients").select(CLIENT_COLUMNS).eq("id", clientId).eq("stable_id", stableId).maybeSingle();
  if (!data) throw new BillingError(404, "client_not_found", "That client wasn't found.");
  return data as Record<string, unknown>;
}

router.get(
  "/clients",
  handle(async (req, res) => {
    let q = supabase.from("billing_clients").select(CLIENT_COLUMNS).eq("stable_id", st(req).id);
    if (req.query.archived !== "1") q = q.eq("archived", false);
    const { data, error } = await q.order("name").limit(1000);
    if (error) throw error;
    const { data: open } = await supabase.from("billing_invoices").select("client_id,total_cents,amount_paid_cents,due_on").eq("stable_id", st(req).id).eq("status", "open");
    const owed = new Map<string, { owed: number; overdue: number }>();
    const today = new Date().toISOString().slice(0, 10);
    for (const inv of open ?? []) {
      const o = owed.get(inv.client_id) ?? { owed: 0, overdue: 0 };
      o.owed += inv.total_cents - inv.amount_paid_cents;
      if (inv.due_on && inv.due_on < today) o.overdue += inv.total_cents - inv.amount_paid_cents;
      owed.set(inv.client_id, o);
    }
    res.json({ clients: (data ?? []).map((c) => ({ ...clientOut(c), ...(owed.get(c.id as string) ?? { owed: 0, overdue: 0 }) })) });
  }),
);

router.post(
  "/clients",
  handle(async (req, res) => {
    const row = clientInput(req.body ?? {});
    const { data, error } = await supabase.from("billing_clients").insert({ ...row, stable_id: st(req).id, created_by: me(req).id }).select(CLIENT_COLUMNS).single();
    if (error) throw error;
    res.status(201).json({ client: clientOut(data) });
  }),
);

router.get(
  "/clients/:id",
  handle(async (req, res) => {
    // The customer's page: who they are, their horses and shares, every invoice, totals, and charges waiting to be billed.
    const client = await ownClient(st(req).id, id(req));
    const [{ data: shares }, invoices, { data: charges }] = await Promise.all([
      supabase.from("billing_horse_owners").select("horse_id,share_bps").eq("client_id", client.id as string).eq("stable_id", st(req).id),
      rpc<InvoiceJson[]>(supabase, "billing_stable_invoices", { p_stable: st(req).id, p_status: null, p_client: client.id, p_limit: 200, p_before: null }),
      supabase.from("billing_charges").select(CHARGE_COLUMNS).eq("stable_id", st(req).id).eq("client_id", client.id as string).eq("status", "unbilled"),
    ]);
    const horses = await horseNames(st(req).id);
    const today = new Date().toISOString().slice(0, 10);
    const issued = invoices.filter((i) => i.status !== "draft" && i.status !== "void");
    const open = invoices.filter((i) => i.status === "open");
    res.json({
      client: clientOut(client),
      horses: (shares ?? []).map((s) => ({ horseId: s.horse_id, name: horses.get(s.horse_id) ?? "Horse", shareBps: s.share_bps })),
      invoices,
      charges: (charges ?? []).map(chargeOut),
      totals: {
        billed: issued.reduce((n, i) => n + i.total, 0),
        paid: issued.reduce((n, i) => n + i.paid - Number(i.refunded ?? 0), 0),
        owed: open.reduce((n, i) => n + i.due, 0),
        overdue: open.filter((i) => i.dueOn && i.dueOn < today).reduce((n, i) => n + i.due, 0),
        lastPaidAt: issued.map((i) => (i.paidAt as string | null) ?? "").sort().pop() || null,
      },
    });
  }),
);

router.patch(
  "/clients/:id",
  handle(async (req, res) => {
    await ownClient(st(req).id, id(req));
    const row = clientInput(req.body ?? {});
    const { data, error } = await supabase.from("billing_clients").update({ ...row, updated_at: new Date().toISOString() }).eq("id", id(req)).eq("stable_id", st(req).id).select(CLIENT_COLUMNS).single();
    if (error) throw error;
    res.json({ client: clientOut(data) });
  }),
);

router.post(
  "/clients/:id/archive",
  handle(async (req, res) => {
    await ownClient(st(req).id, id(req));
    const archived = input.bool(req.body?.archived, true);
    const { error } = await supabase.from("billing_clients").update({ archived, updated_at: new Date().toISOString() }).eq("id", id(req)).eq("stable_id", st(req).id);
    if (error) throw error;
    res.json({ ok: true });
  }),
);

/* ---------- Horses and who pays for them ---------- */

async function horseNames(stableId: string) {
  const { data } = await supabase.from("member_horses").select("id,inventory").eq("stable_id", stableId).limit(2000);
  return new Map((data ?? []).map((h) => [h.id as string, String((h.inventory as { horseName?: string })?.horseName ?? "Horse")]));
}

router.get(
  "/horses",
  handle(async (req, res) => {
    const [names, { data: owners }, { data: clients }] = await Promise.all([
      horseNames(st(req).id),
      supabase.from("billing_horse_owners").select("horse_id,client_id,share_bps").eq("stable_id", st(req).id),
      supabase.from("billing_clients").select("id,name,archived").eq("stable_id", st(req).id),
    ]);
    const clientName = new Map((clients ?? []).map((c) => [c.id as string, c.name as string]));
    const horses = [...names.entries()]
      .map(([horseId, name]) => {
        const list = (owners ?? []).filter((o) => o.horse_id === horseId).map((o) => ({ clientId: o.client_id, name: clientName.get(o.client_id) ?? "Client", shareBps: o.share_bps }));
        return { id: horseId, name, owners: list, billedBps: list.reduce((n, o) => n + o.shareBps, 0) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ horses });
  }),
);

router.put(
  "/horses/:id/owners",
  handle(async (req, res) => {
    const owners = req.body?.owners;
    if (!Array.isArray(owners) || owners.length > 20) throw new BillingError(400, "invalid_owners", "Check the owners: up to 20 per horse.");
    const clean = owners.map((o: Record<string, unknown>) => {
      if (!input.isUuid(o?.clientId)) throw new BillingError(400, "invalid_owners", "Choose a client for each owner.");
      return { clientId: o.clientId, shareBps: input.bps(o.shareBps, { min: 1, max: 10_000, label: "Share" }) };
    });
    if (new Set(clean.map((o) => o.clientId)).size !== clean.length) throw new BillingError(400, "invalid_owners", "Each client can be listed once per horse.");
    res.json(await rpc(supabase, "billing_set_owners", { p_stable: st(req).id, p_horse: id(req), p_owners: clean }));
  }),
);

/* ---------- Charges (work waiting to be billed) ---------- */

const CHARGE_COLUMNS = "id,stable_id,horse_id,horse_name,client_id,category,description,quantity,unit_cents,amount_cents,service_on,status,billed_at,created_at";
const chargeOut = (c: Record<string, unknown>) => ({
  id: c.id,
  horseId: c.horse_id,
  horseName: c.horse_name,
  clientId: c.client_id,
  category: c.category,
  description: c.description,
  quantity: Number(c.quantity),
  unit: Number(c.unit_cents),
  amount: Number(c.amount_cents),
  serviceOn: c.service_on,
  status: c.status,
  billedAt: c.billed_at,
});
async function chargeInput(stableId: string, b: Record<string, unknown>) {
  const l = input.line({ ...b, shareBps: null, chargeId: null });
  const horseId = l.horseId;
  const clientId = b.clientId ? (input.isUuid(b.clientId) ? b.clientId : null) : null;
  if (b.clientId && !clientId) throw new BillingError(404, "client_not_found", "Choose one of this stable's clients.");
  if (!horseId && !clientId) throw new BillingError(400, "invalid_input", "Choose the horse (billed to its owners) or the client to bill.");
  let horseName = "";
  if (horseId) {
    const names = await horseNames(stableId);
    if (!names.has(horseId)) throw new BillingError(404, "horse_not_found", "Choose one of this stable's horses.");
    horseName = names.get(horseId)!;
  }
  if (clientId) await ownClient(stableId, clientId);
  const serviceOn = input.date(b.serviceOn, { required: true, label: "Date" })!;
  return {
    horse_id: horseId,
    horse_name: horseName.slice(0, 120),
    client_id: clientId,
    category: l.category,
    description: l.description,
    quantity: l.quantity,
    unit_cents: l.unitCents,
    amount_cents: lineCents(l.quantity, l.unitCents),
    service_on: serviceOn,
  };
}
async function unbilledCharge(stableId: string, chargeId: string) {
  const { data } = await supabase.from("billing_charges").select(CHARGE_COLUMNS).eq("id", chargeId).eq("stable_id", stableId).maybeSingle();
  if (!data) throw new BillingError(404, "not_found", "That charge wasn't found.");
  if (data.status !== "unbilled") throw new BillingError(409, "charge_billed", "This charge is already on an invoice. Change it there, or cancel that invoice first.");
  return data;
}

router.get(
  "/charges",
  handle(async (req, res) => {
    let q = supabase.from("billing_charges").select(CHARGE_COLUMNS).eq("stable_id", st(req).id);
    const status = req.query.status === "billed" ? "billed" : req.query.status === "all" ? null : "unbilled";
    if (status) q = q.eq("status", status);
    const { data, error } = await q.order("service_on", { ascending: false }).limit(500);
    if (error) throw error;
    res.json({ charges: (data ?? []).map(chargeOut) });
  }),
);

router.post(
  "/charges",
  handle(async (req, res) => {
    const row = await chargeInput(st(req).id, req.body ?? {});
    const { data, error } = await supabase.from("billing_charges").insert({ ...row, stable_id: st(req).id, created_by: me(req).id }).select(CHARGE_COLUMNS).single();
    if (error) throw error;
    res.status(201).json({ charge: chargeOut(data) });
  }),
);

router.patch(
  "/charges/:id",
  handle(async (req, res) => {
    await unbilledCharge(st(req).id, id(req));
    const row = await chargeInput(st(req).id, req.body ?? {});
    const { data, error } = await supabase.from("billing_charges").update({ ...row, updated_at: new Date().toISOString() }).eq("id", id(req)).eq("stable_id", st(req).id).eq("status", "unbilled").select(CHARGE_COLUMNS).single();
    if (error || !data) throw error ?? new BillingError(409, "charge_billed", "This charge is already on an invoice.");
    res.json({ charge: chargeOut(data) });
  }),
);

router.post(
  "/charges/:id/remove",
  handle(async (req, res) => {
    await unbilledCharge(st(req).id, id(req));
    const { error } = await supabase.from("billing_charges").delete().eq("id", id(req)).eq("stable_id", st(req).id).eq("status", "unbilled");
    if (error) throw error;
    res.json({ ok: true });
  }),
);

// Turn unbilled charges into one draft invoice per client (split by owner shares).
router.post(
  "/bill-owners",
  handle(async (req, res) => {
    const b = req.body ?? {};
    const through = input.date(b.through, { label: "Bill through" });
    const horses = Array.isArray(b.horseIds) ? b.horseIds.filter(input.isUuid).slice(0, 500) : [];
    res.json(await rpc(supabase, "billing_bill_owners", { p_stable: st(req).id, p_actor: me(req).id, p_through: through, p_horses: horses }));
  }),
);

/* ---------- Invoices ---------- */

function invoiceBody(b: Record<string, unknown>) {
  if (!input.isUuid(b.clientId)) throw new BillingError(400, "client_not_found", "Choose who the invoice is for.");
  const taxRate = b.taxRateBps === undefined || b.taxRateBps === null ? 0 : input.bps(b.taxRateBps, { min: 0, max: 2500, label: "Tax rate" });
  return {
    p_client: b.clientId,
    p_lines: input.lines(b.lines),
    p_memo: input.text(b.memo, 1000, { label: "Note" }),
    p_due_on: input.date(b.dueOn, { label: "Due date" }),
    p_tax_bps: taxRate,
    p_allow_card: input.bool(b.allowCard, true),
    p_allow_bank: input.bool(b.allowBank, true),
  };
}

router.get(
  "/invoices",
  handle(async (req, res) => {
    const status = typeof req.query.status === "string" && ["draft", "open", "paid", "void", "uncollectible", "overdue"].includes(req.query.status) ? req.query.status : null;
    const client = input.isUuid(req.query.clientId) ? req.query.clientId : null;
    const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : null;
    res.json({ invoices: await rpc(supabase, "billing_stable_invoices", { p_stable: st(req).id, p_status: status, p_client: client, p_limit: 100, p_before: before }) });
  }),
);

router.post(
  "/invoices",
  handle(async (req, res) => {
    const body = invoiceBody(req.body ?? {});
    const invoice = await rpc(supabase, "billing_invoice_save", { p_stable: st(req).id, p_actor: me(req).id, p_invoice: null, ...body });
    res.status(201).json({ invoice });
  }),
);

router.get(
  "/invoices/:id",
  handle(async (req, res) => {
    const invoice = await rpc(supabase, "billing_stable_invoice", { p_stable: st(req).id, p_invoice: id(req) });
    if (!invoice) throw new BillingError(404, "invoice_not_found", "That invoice wasn't found.");
    res.json({ invoice });
  }),
);

router.put(
  "/invoices/:id",
  handle(async (req, res) => {
    const body = invoiceBody(req.body ?? {});
    const invoice = await rpc(supabase, "billing_invoice_save", { p_stable: st(req).id, p_actor: me(req).id, p_invoice: id(req), ...body });
    res.json({ invoice });
  }),
);

router.post(
  "/invoices/:id/send",
  sendLimit,
  handle(async (req, res) => {
    const result = await rpc<{ invoice: InvoiceJson; notify: unknown }>(supabase, "billing_invoice_send", { p_stable: st(req).id, p_invoice: id(req), p_actor: me(req).id });
    billingPushSaved(result.notify as never);
    res.json({ invoice: result.invoice });
  }),
);

router.post(
  "/invoices/:id/void",
  handle(async (req, res) => {
    res.json(await rpc(supabase, "billing_invoice_void", { p_stable: st(req).id, p_invoice: id(req), p_actor: me(req).id }));
  }),
);

// New pay link (the old one stops working).
router.post(
  "/invoices/:id/link",
  handle(async (req, res) => {
    const token = randomBytes(32).toString("hex");
    const { data, error } = await supabase.from("billing_invoices").update({ pay_token: token, updated_at: new Date().toISOString() }).eq("id", id(req)).eq("stable_id", st(req).id).eq("status", "open").select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new BillingError(409, "invoice_not_payable", "Only unpaid invoices have a pay link.");
    res.json({ payToken: token });
  }),
);

// Take a payment for an invoice: a card typed in (phone), the card reader, or money received outside Stayblz.
router.post(
  "/invoices/:id/payments",
  takeLimit,
  handle(async (req, res) => {
    const b = req.body ?? {};
    const invoice = await rpc<InvoiceJson | null>(supabase, "billing_stable_invoice", { p_stable: st(req).id, p_invoice: id(req) });
    if (!invoice) throw new BillingError(404, "invoice_not_found", "That invoice wasn't found.");
    const channel = b.channel;
    if (!["keyed", "reader", "offline"].includes(channel)) throw new BillingError(400, "invalid_channel", "Choose how the payment was taken.");
    let method;
    if (channel === "offline") {
      const kind = ["cash", "check", "bank_transfer", "other"].includes(b.offlineKind) ? b.offlineKind : null;
      if (!kind) throw new BillingError(400, "invalid_channel", "Choose cash, cheque, bank transfer or other.");
      method = { kind: "offline" as const, offlineKind: kind, reference: input.text(b.reference, 80, { label: "Reference" }), amountCents: input.cents(b.amountCents, { min: 1, max: 100_000_000 }) };
    } else {
      if (typeof b.token !== "string") throw new BillingError(400, "invalid_method", "Enter the card.");
      method = { kind: "token" as const, token: b.token, type: "card" as const };
    }
    const result = await payInvoice({ invoiceId: invoice.id, payerId: invoice.accountId, actorId: me(req).id, channel, method, key: input.key(b.key) });
    if (result.payment.status === "failed")
      return res.status(402).json({ code: result.payment.failureCode, error: result.payment.failureMessage ?? "The payment didn't go through.", ...result });
    res.json(result);
  }),
);

router.post(
  "/payments/:id/refund",
  takeLimit,
  handle(async (req, res) => {
    const b = req.body ?? {};
    const amount = b.amountCents === undefined || b.amountCents === null ? null : input.cents(b.amountCents, { min: 1 });
    res.json(
      await refundPayment({
        paymentId: id(req),
        stableId: st(req).id,
        amountCents: amount,
        reason: typeof b.reason === "string" ? b.reason : "requested_by_customer",
        note: input.text(b.note, 300, { label: "Note" }),
        key: input.key(b.key),
        actorId: me(req).id,
      }),
    );
  }),
);

/* ---------- Payments, payouts, export ---------- */

router.get(
  "/payments",
  handle(async (req, res) => {
    const from = input.date(req.query.from, { label: "From" });
    const to = input.date(req.query.to, { label: "To" });
    res.json({ payments: await rpc(supabase, "billing_stable_payments", { p_stable: st(req).id, p_limit: 200, p_from: from, p_to: to }) });
  }),
);

router.get(
  "/payouts",
  handle(async (req, res) => {
    const { data, error } = await supabase.from("billing_payouts").select("*").eq("stable_id", st(req).id).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    const balance = await rpc(supabase, "billing_balance", { p_stable: st(req).id });
    res.json({
      balance,
      payouts: (data ?? []).map((p) => ({ id: p.id, amount: p.amount_cents, status: p.status, destination: p.destination, arrivesOn: p.arrives_on, failureMessage: p.failure_message, createdAt: p.created_at, test: p.test })),
    });
  }),
);

router.post(
  "/payouts",
  ownerOnly,
  handle(async (req, res) => {
    const b = req.body ?? {};
    const amount = b.amountCents === undefined || b.amountCents === null ? null : input.cents(b.amountCents, { min: 100 });
    res.json(await payout({ stableId: st(req).id, amountCents: amount, key: input.key(b.key), actorId: me(req).id }));
  }),
);

// For an accountant or QuickBooks: payments (default) or invoices, as CSV.
router.get(
  "/export.csv",
  handle(async (req, res) => {
    const from = input.date(req.query.from, { label: "From" });
    const to = input.date(req.query.to, { label: "To" });
    let head: string[];
    let rows: unknown[][];
    if (req.query.kind === "invoices") {
      const list = await rpc<InvoiceJson[]>(supabase, "billing_stable_invoices", { p_stable: st(req).id, p_status: null, p_client: null, p_limit: 200, p_before: null });
      head = ["Invoice", "Status", "Client", "Client email", "Issued", "Due", "Total", "Paid", "Refunded", "Balance"];
      rows = list
        .filter((i) => i.status !== "draft")
        .filter((i) => (!from || String(i.issuedAt ?? "").slice(0, 10) >= from) && (!to || String(i.issuedAt ?? "").slice(0, 10) <= to))
        .map((i) => [i.number, i.status, i.billTo?.name, i.billTo?.email, String(i.issuedAt ?? "").slice(0, 10), i.dueOn, input.dollars(i.total), input.dollars(i.paid), input.dollars(Number(i.refunded ?? 0)), input.dollars(Math.max(0, i.total - i.paid))]);
    } else {
      const list = await rpc<{ createdAt: string; invoiceNumber: string; client: string; clientEmail: string; channel: string; method: { brand?: string; last4?: string; bankName?: string }; offlineKind: string | null; reference: string; amount: number; fee: number; net: number; refunded: number; status: string; test: boolean }[]>(
        supabase,
        "billing_stable_payments",
        { p_stable: st(req).id, p_limit: 5000, p_from: from, p_to: to },
      );
      head = ["Date", "Invoice", "Client", "Client email", "Paid by", "Reference", "Amount", "Stayblz fee", "Net", "Refunded", "Status", "Test"];
      rows = list.map((p) => [
        p.createdAt.slice(0, 10),
        p.invoiceNumber,
        p.client,
        p.clientEmail,
        p.channel === "offline" ? (p.offlineKind ?? "offline") : `${p.channel}${p.method.last4 ? ` ${p.method.brand || p.method.bankName || ""} •${p.method.last4}` : ""}`,
        p.reference,
        input.dollars(p.amount),
        input.dollars(p.fee),
        input.dollars(p.net),
        input.dollars(p.refunded),
        p.status,
        p.test ? "yes" : "no",
      ]);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="stayblz-${req.query.kind === "invoices" ? "invoices" : "payments"}.csv"`);
    res.send([head.join(","), ...rows.map((r) => r.map(input.csvCell).join(","))].join("\r\n") + "\r\n");
  }),
);

export default router;
