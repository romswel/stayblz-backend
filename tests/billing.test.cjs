// Stayblz Billing: subscriptions, payments, invoices, stable billing, refunds, payouts, autopay, admin.
// Real SQL (PGlite with every migration) through the real API; the Stayblz test processor; nothing external.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { installDatabase } = require("./support/pgrest.cjs");
process.env.SUPABASE_URL = "http://127.0.0.1:1";
process.env.SUPABASE_SECRET_KEY = "test-only";
process.env.NODE_ENV = "test";
// Every test pays from 127.0.0.1; the per-address card-testing guard is checked on its own below.
process.env.BILLING_LINK_PAY_LIMIT = "10000";
const { app } = require("../dist/app");
const auth = require("../dist/middleware/auth");
const { supabase } = require("../dist/lib/supabase");
const { runBillingSweep } = require("../dist/lib/billing/schedule");
const { billingAlertsSettled } = require("../dist/lib/billing/alerts");
const provider = require("../dist/lib/billing/provider");

const ann = "a1111111-1111-4111-8111-111111111111", // subscriber
  ben = "b2222222-2222-4222-8222-222222222222", // stable owner (trainer)
  cat = "c3333333-3333-4333-8333-333333333333", // stable manager
  dan = "d4444444-4444-4444-8444-444444444444", // stable member (groom)
  eve = "e5555555-5555-4555-8555-555555555555", // client (horse owner) with an account
  fay = "f6666666-6666-4666-8666-666666666666", // admin
  gus = "a7777777-7777-4777-8777-777777777777", // superadmin
  hal = "a8888888-8888-4888-8888-888888888888"; // another subscriber
const people = {
  [ann]: ["Ann", "Archer", "member"],
  [ben]: ["Ben", "Bishop", "member"],
  [cat]: ["Cat", "Carter", "member"],
  [dan]: ["Dan", "Diaz", "member"],
  [eve]: ["Eve", "Evans", "member"],
  [fay]: ["Fay", "Fox", "admin"],
  [gus]: ["Gus", "Grant", "superadmin"],
  [hal]: ["Hal", "Hunt", "member"],
};
const tokens = new Map();
let db, database, server, origin, stable, horses;

before(async () => {
  database = await installDatabase(supabase);
  db = database.db;
  for (const [id, [first, last, role]] of Object.entries(people)) {
    const email = first.toLowerCase() + "@example.test";
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, email]);
    await db.query("update accounts set email=$2, first_name=$3, last_name=$4 where id=$1", [id, email, first, last]);
    tokens.set(id, auth.createSession({ id, username: email, displayName: `${first} ${last}`, role, email }));
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  const created = await call(ben, "/api/workspaces", { body: { name: "Bishop Racing" } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  stable = created.data.stable.id;
  await db.query("insert into stable_memberships(stable_id,user_id,display_name,role) values($1,$2,'Cat Carter','manager'),($1,$3,'Dan Diaz','member')", [stable, cat, dan]);
  horses = {};
  for (const name of ["Golden Gate", "Night Owl", "Solo Run"]) {
    const { rows } = await db.query("insert into member_horses(stable_id,inventory,tracking,created_by) values($1,$2,'{}',$3) returning id", [stable, { horseName: name }, ben]);
    horses[name] = rows[0].id;
  }
  // Quick clocks for tests: bank transfers clear at once, card money is available for payout at once.
  await db.query("update billing_settings set bank_settle_minutes = 0, payout_delay_days = 0");
});
after(async () => {
  provider.setPaymentProviderForTests(null);
  for (const token of tokens.values()) auth.destroySession(token);
  await new Promise((resolve) => server.close(resolve));
  await database.close();
});

async function call(user, path, { body, method, team } = {}) {
  const response = await fetch(origin + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      ...(user ? { Authorization: "Bearer " + tokens.get(user) } : {}),
      "Content-Type": "application/json",
      ...(team ? { "X-Stayblz-Stable": team } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const textBody = await response.text();
  let data = null;
  try {
    data = JSON.parse(textBody);
  } catch {
    data = textBody;
  }
  return { status: response.status, data, headers: response.headers };
}
const key = () => randomUUID().replace(/-/g, "");
const sb = (user, path, opts = {}) => call(user, "/api/workspace/billing" + path, { ...opts, team: stable });
async function addCard(user, token = "tok_visa", extra = {}) {
  const r = await call(user, "/api/billing/methods", { body: { type: "card", token, holderName: "Test Person", expMonth: 12, expYear: 2034, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.method.id;
}
async function addBank(user, token = "btok_ok") {
  const r = await call(user, "/api/billing/methods", { body: { type: "bank", token, holderName: "Test Person" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.method.id;
}
const count = async (sql, args = []) => (await db.query(sql, args)).rows[0].n;
async function setupStable() {
  const existing = await db.query("select 1 from billing_merchants where stable_id=$1", [stable]);
  if (existing.rows.length) return;
  const r = await sb(ben, "/setup", {
    method: "PUT",
    body: { legalName: "Bishop Racing LLC", businessType: "company", email: "office@bishop.test", statementName: "BISHOP RACING", invoicePrefix: "BR", termsDays: 15, acceptTerms: true, payoutToken: "btok_ok", payoutHolder: "Bishop Racing LLC" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
async function client(name, email = "") {
  const r = await sb(ben, "/clients", { body: { name, email } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.client.id;
}
async function sentInvoice(clientId, lines, extra = {}) {
  const draft = await sb(ben, "/invoices", { body: { clientId, lines, ...extra } });
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const sent = await sb(ben, `/invoices/${draft.data.invoice.id}/send`, { body: {} });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  return sent.data.invoice;
}

/* ====================================================================================================== */

test("fee maths: percentages round half up, fixed parts and caps apply, offline is free", async () => {
  const rate = async (rates, channel, amount) => (await db.query("select public.billing_rate($1,$2,$3)::int as v", [rates, channel, amount])).rows[0].v;
  const fees = { card: { bps: 299, fixed: 0, cap: 0 }, bank: { bps: 100, fixed: 0, cap: 0 }, keyed: { bps: 350, fixed: 30, cap: 0 }, reader: { bps: 80, fixed: 0, cap: 500 } };
  assert.equal(await rate(fees, "card", 10000), 299); // 2.99% of $100.00
  assert.equal(await rate(fees, "card", 50), 1); // 1.495c rounds to 1
  assert.equal(await rate(fees, "card", 51), 2); // 1.5249c rounds to 2 (half up)
  assert.equal(await rate(fees, "bank", 12345678), 123457); // 1% no cap
  assert.equal(await rate(fees, "keyed", 1000), 65); // 3.5% + 30c
  assert.equal(await rate(fees, "reader", 10000000), 500); // capped at $5
  assert.equal(await rate(fees, "offline", 10000), 0);
  assert.equal(await rate(fees, "card", 0), 0);
  assert.equal(await rate({ card: { bps: 0, fixed: 500, cap: 0 } }, "card", 100), 100, "a fee is never more than the payment");
  const line = async (q, u, s) => (await db.query("select public.billing_line_amount($1,$2,$3)::bigint as v", [q, u, s])).rows[0].v;
  assert.equal(Number(await line(30, 9550, null)), 286500);
  assert.equal(Number(await line(0.15, 10, null)), 2, "0.15 x 10c = 1.5c rounds to 2 (exact decimals, no float error)");
  assert.equal(Number(await line(1, -101, 5000)), -51, "credits round away from zero");
});

test("cards: only Stayblz test tokens are accepted; real card numbers never are", async () => {
  for (const token of ["4242424242424242", "tok_unknown", "", 42]) {
    const r = await call(ann, "/api/billing/methods", { body: { type: "card", token, expMonth: 12, expYear: 2034 } });
    assert.equal(r.status, 400, `token ${token}`);
  }
  const declined = await call(ann, "/api/billing/methods", { body: { type: "card", token: "tok_declined", expMonth: 12, expYear: 2034 } });
  assert.equal(declined.status, 402);
  assert.equal(declined.data.code, "card_declined");
  const expired = await call(ann, "/api/billing/methods", { body: { type: "card", token: "tok_visa", expMonth: 1, expYear: 2020 } });
  assert.equal(expired.status, 400);
  const ok = await call(ann, "/api/billing/methods", { body: { type: "card", token: "tok_visa", holderName: "Ann Archer", expMonth: 12, expYear: 2034 } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.method.brand, "visa");
  assert.equal(ok.data.method.last4, "4242", "the last 4 come from the token on the server, not from the browser");
  const overview = await call(ann, "/api/billing/overview");
  assert.equal(overview.status, 200);
  assert.equal(overview.data.settings.mode, "test");
  assert.equal(overview.data.profile.defaultMethodId, ok.data.method.id, "the first card becomes the default");
  assert.ok(!JSON.stringify(overview.data).includes("tok_visa"), "processor tokens are never sent back to the browser");
  assert.ok(overview.data.catalog.some((c) => c.id === "tv_monthly" && c.amount === 1200), "the $12/month TV pass is offered");
  assert.ok(!overview.data.catalog.some((c) => c.status === "draft" || c.id === "tv_yearly"), "drafts aren't offered");
  // Removing it: allowed while nothing depends on it.
  const removed = await call(ann, `/api/billing/methods/${ok.data.method.id}/remove`, { body: {} });
  assert.equal(removed.status, 200);
  assert.equal((await call(ann, "/api/billing/overview")).data.methods.length, 0);
});

test("subscribe to the TV pass: first invoice paid, access granted, ledger and receipt; a retry never charges twice", async () => {
  const card = await addCard(ann);
  const k = key();
  const sub = await call(ann, "/api/billing/subscriptions", { body: { planId: "tv_monthly", methodId: card, key: k } });
  assert.equal(sub.status, 201, JSON.stringify(sub.data));
  assert.equal(sub.data.subscription.status, "active");
  assert.equal(sub.data.payment.status, "succeeded");
  assert.equal(sub.data.payment.amount, 1200);
  assert.equal(sub.data.payment.fee, 0, "Stayblz's own sales carry no stable fee");
  const end = new Date(sub.data.subscription.currentPeriodEnd);
  assert.ok(end.getTime() - Date.now() > 27 * 86400e3, "a month of access");
  const overview = (await call(ann, "/api/billing/overview")).data;
  assert.deepEqual(overview.features, ["tv.watch"]);
  // The same request again (double click / retry): no second subscription and no second charge.
  const again = await call(ann, "/api/billing/subscriptions", { body: { planId: "tv_monthly", methodId: card, key: k } });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, "already_subscribed");
  assert.equal(await count("select count(*)::int n from billing_payments where account_id=$1", [ann]), 1);
  assert.equal(await count("select coalesce(sum(amount_cents),0)::int n from billing_ledger where holder='platform' and entry='sale'"), 1200);
  // Receipts list and the invoice itself.
  const list = await call(ann, "/api/billing/invoices");
  assert.equal(list.data.invoices.length, 1);
  const inv = list.data.invoices[0];
  assert.match(inv.number, /^SBZ-\d{4}-\d{6}$/);
  assert.equal(inv.status, "paid");
  const one = await call(ann, `/api/billing/invoices/${inv.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.data.invoice.payments.length, 1);
  assert.equal(one.data.invoice.lines[0].category, "subscription");
  // Paying a paid invoice is refused.
  const payAgain = await call(ann, `/api/billing/invoices/${inv.id}/pay`, { body: { methodId: card, key: key() } });
  assert.equal(payAgain.status, 409);
  // Somebody else can't see it.
  assert.equal((await call(hal, `/api/billing/invoices/${inv.id}`)).status, 404);
  // CSV of receipts.
  const csv = await call(ann, "/api/billing/payments.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.data, /^Date,Invoice,Paid to/);
  assert.match(csv.data, /12\.00/);
});

test("a declined first payment leaves the plan unfinished; trying again with another card replaces it", async () => {
  const bad = await addCard(hal, "tok_fail_later");
  const first = await call(hal, "/api/billing/subscriptions", { body: { planId: "tv_monthly", methodId: bad, key: key() } });
  assert.equal(first.status, 402);
  assert.equal(first.data.code, "card_declined");
  assert.equal(first.data.subscription.status, "incomplete");
  assert.deepEqual((await call(hal, "/api/billing/overview")).data.features, [], "no access without payment");
  const good = await addCard(hal, "tok_mastercard");
  const second = await call(hal, "/api/billing/subscriptions", { body: { planId: "tv_monthly", methodId: good, key: key() } });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(second.data.subscription.status, "active");
  const subs = (await db.query("select status,cancel_reason from billing_subscriptions where account_id=$1 order by created_at", [hal])).rows;
  assert.deepEqual(subs.map((s) => s.status), ["canceled", "active"]);
  assert.equal(subs[0].cancel_reason, "replaced");
  assert.equal(await count("select count(*)::int n from billing_invoices where account_id=$1 and status='void'", [hal]), 1, "the unpaid first invoice is cancelled");
  assert.equal(await count("select count(*)::int n from billing_payments where account_id=$1 and status='succeeded'", [hal]), 1);
});

test("renewals: the period renews on its anchor date; a failing card goes past due, is retried, then the plan ends", async () => {
  const sub = (await db.query("select id from billing_subscriptions where account_id=$1 and status='active'", [hal])).rows[0];
  // Swap the card for one that fails from now on.
  const failing = await addCard(hal, "tok_fail_later");
  assert.equal((await call(hal, `/api/billing/subscriptions/${sub.id}/change`, { body: { methodId: failing } })).status, 200);
  const adv = await call(fay, `/api/admin/billing/subscriptions/${sub.id}/advance`, { body: {} });
  assert.equal(adv.status, 200, JSON.stringify(adv.data));
  assert.equal(adv.data.report.renewalsOpened, 1);
  assert.equal(adv.data.subscription.status, "past_due");
  await billingAlertsSettled();
  assert.ok(await count("select count(*)::int n from chat_alerts where user_id=$1 and kind='billing' and chat_title like 'Payment didn%'", [hal]) >= 1, "the subscriber hears about it");
  assert.deepEqual((await call(hal, "/api/billing/overview")).data.features, ["tv.watch"], "access continues while we retry");
  // Running billing again before the retry date changes nothing.
  await runBillingSweep();
  assert.equal(await count("select count(*)::int n from billing_payments where account_id=$1 and status='failed' and auto", [hal]), 1);
  // Three more failed tries (the clock jumps to each retry date).
  for (let i = 0; i < 3; i++) {
    await db.query("update billing_invoices set next_attempt_at = now() where subscription_id=$1 and status='open'", [sub.id]);
    await runBillingSweep();
  }
  const ended = (await db.query("select status,cancel_reason from billing_subscriptions where id=$1", [sub.id])).rows[0];
  assert.equal(ended.status, "canceled");
  assert.equal(ended.cancel_reason, "payment_failed");
  assert.equal(await count("select count(*)::int n from billing_invoices where subscription_id=$1 and status='uncollectible'", [sub.id]), 1);
  assert.equal(await count("select count(*)::int n from billing_payments where account_id=$1 and status='failed' and auto", [hal]), 4, "exactly four tries");
  assert.deepEqual((await call(hal, "/api/billing/overview")).data.features, []);
  // Further runs don't try again.
  await runBillingSweep();
  assert.equal(await count("select count(*)::int n from billing_payments where account_id=$1 and auto", [hal]), 4);
});

test("past due: paying now with a good card brings the plan back and keeps that card for renewals", async () => {
  const card = await addCard(eve, "tok_visa");
  const s = await call(eve, "/api/billing/subscriptions", { body: { planId: "tv_monthly", methodId: card, key: key() } });
  assert.equal(s.status, 201);
  const failing = await addCard(eve, "tok_fail_later");
  await call(eve, `/api/billing/subscriptions/${s.data.subscription.id}/change`, { body: { methodId: failing } });
  await call(fay, `/api/admin/billing/subscriptions/${s.data.subscription.id}/advance`, { body: {} });
  assert.equal((await db.query("select status from billing_subscriptions where id=$1", [s.data.subscription.id])).rows[0].status, "past_due");
  const pay = await call(eve, `/api/billing/subscriptions/${s.data.subscription.id}/pay`, { body: { methodId: card, key: key() } });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  assert.equal(pay.data.subscription.status, "active");
  assert.equal(pay.data.subscription.methodId, card);
  assert.ok(new Date(pay.data.subscription.currentPeriodEnd) > new Date(Date.now() + 27 * 86400e3), "the next period was paid");
  assert.equal((await call(eve, `/api/billing/subscriptions/${s.data.subscription.id}/pay`, { body: { methodId: card, key: key() } })).status, 409, "nothing more is due");
});

test("cancel at the end of the period keeps access until then; undo works; at the end it stops without a charge", async () => {
  const sub = (await db.query("select id from billing_subscriptions where account_id=$1 and status='active'", [ann])).rows[0];
  const cancel = await call(ann, `/api/billing/subscriptions/${sub.id}/cancel`, { body: {} });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.subscription.cancelAtPeriodEnd, true);
  assert.equal(cancel.data.subscription.status, "active");
  assert.deepEqual((await call(ann, "/api/billing/overview")).data.features, ["tv.watch"]);
  const resume = await call(ann, `/api/billing/subscriptions/${sub.id}/resume`, { body: {} });
  assert.equal(resume.status, 200);
  assert.equal(resume.data.subscription.cancelAtPeriodEnd, false);
  assert.equal((await call(ann, `/api/billing/subscriptions/${sub.id}/resume`, { body: {} })).status, 409, "nothing to undo");
  await call(ann, `/api/billing/subscriptions/${sub.id}/cancel`, { body: {} });
  const paymentsBefore = await count("select count(*)::int n from billing_payments where account_id=$1", [ann]);
  await call(fay, `/api/admin/billing/subscriptions/${sub.id}/advance`, { body: {} });
  const row = (await db.query("select status,cancel_reason from billing_subscriptions where id=$1", [sub.id])).rows[0];
  assert.equal(row.status, "canceled");
  assert.equal(row.cancel_reason, "requested");
  assert.equal(await count("select count(*)::int n from billing_payments where account_id=$1", [ann]), paymentsBefore, "no charge at the end");
  assert.deepEqual((await call(ann, "/api/billing/overview")).data.features, []);
  // Someone else can't cancel your plan.
  const other = (await db.query("select id from billing_subscriptions where account_id=$1 and status='active'", [eve])).rows[0];
  assert.equal((await call(ann, `/api/billing/subscriptions/${other.id}/cancel`, { body: {} })).status, 404);
});

test("coupons: 50% off the first invoice only, once per account; admins create and switch them off", async () => {
  assert.equal((await call(ann, "/api/admin/billing/coupons", { body: { code: "HALF", percentOff: 50 } })).status, 403, "customers can't make codes");
  const made = await call(fay, "/api/admin/billing/coupons", { body: { code: "half-off", percentOff: 50, duration: "once", appliesTo: ["tv_monthly"] } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.coupon.code, "HALF-OFF");
  const check = await call(ann, "/api/billing/coupons/check", { body: { code: "half-off", planId: "tv_monthly" } });
  assert.equal(check.status, 200);
  assert.equal(check.data.firstTotal, 600);
  const card = (await db.query("select id from billing_methods where account_id=$1 and status='active' limit 1", [ann])).rows[0].id;
  const s = await call(ann, "/api/billing/subscriptions", { body: { planId: "tv_monthly", methodId: card, coupon: "half-off", key: key() } });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal(s.data.payment.amount, 600);
  await call(fay, `/api/admin/billing/subscriptions/${s.data.subscription.id}/advance`, { body: {} });
  const renewal = (await db.query("select total_cents,discount_cents from billing_invoices where subscription_id=$1 order by created_at desc limit 1", [s.data.subscription.id])).rows[0];
  assert.equal(Number(renewal.total_cents), 1200, "the renewal is full price");
  assert.equal(Number(renewal.discount_cents), 0);
  assert.equal((await call(ann, "/api/billing/coupons/check", { body: { code: "HALF-OFF", planId: "tv_monthly" } })).status, 400, "used once per account");
  assert.equal((await call(fay, "/api/admin/billing/coupons/HALF-OFF/active", { body: { active: false } })).status, 200);
  assert.equal((await call(hal, "/api/billing/coupons/check", { body: { code: "HALF-OFF", planId: "tv_monthly" } })).status, 400, "switched off");
});

test("switching monthly to yearly happens at renewal, at the yearly price, with no proration", async () => {
  assert.equal((await call(fay, "/api/admin/billing/catalog/tv_yearly", { method: "PATCH", body: { name: "STAYBLZ TV Pass (yearly)", amount: 12000, status: "active" } })).status, 200);
  const sub = (await db.query("select id from billing_subscriptions where account_id=$1 and status='active'", [ann])).rows[0];
  const change = await call(ann, `/api/billing/subscriptions/${sub.id}/change`, { body: { planId: "tv_yearly" } });
  assert.equal(change.status, 200, JSON.stringify(change.data));
  assert.equal(change.data.subscription.pendingPlanId, "tv_yearly");
  assert.equal((await call(ann, `/api/billing/subscriptions/${sub.id}/change`, { body: { planId: "stallion_showcase" } })).status, 404, "another family (and a draft) can't be switched to");
  await call(fay, `/api/admin/billing/subscriptions/${sub.id}/advance`, { body: {} });
  const row = (await db.query("select plan_id,amount_cents,interval,current_period_end,pending_plan_id from billing_subscriptions where id=$1", [sub.id])).rows[0];
  assert.equal(row.plan_id, "tv_yearly");
  assert.equal(row.amount_cents, 12000);
  assert.equal(row.interval, "year");
  assert.equal(row.pending_plan_id, null);
  assert.ok(new Date(row.current_period_end) > new Date(Date.now() + 360 * 86400e3));
  await call(fay, "/api/admin/billing/catalog/tv_yearly", { method: "PATCH", body: { name: "STAYBLZ TV Pass (yearly)", amount: 12000, status: "draft" } });
});

test("price changes reach new subscribers only; free trials happen once", async () => {
  await call(fay, "/api/admin/billing/catalog/tv_monthly", { method: "PATCH", body: { name: "STAYBLZ TV Pass", amount: 1500, status: "active", trialDays: 7 } });
  const locked = (await db.query("select amount_cents from billing_subscriptions where account_id=$1 and status='active'", [eve])).rows[0];
  assert.equal(locked.amount_cents, 1200, "people already subscribed keep their price");
  // Dan has never subscribed: gets a 7-day trial, no charge yet.
  assert.deepEqual((await call(dan, "/api/billing/overview")).data.trialUsed, [], "the page may promise a trial");
  const card = await addCard(dan);
  const t = await call(dan, "/api/billing/subscriptions", { body: { planId: "tv_monthly", methodId: card, key: key() } });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  assert.equal(t.data.subscription.status, "trialing");
  assert.equal(t.data.payment, null);
  assert.deepEqual((await call(dan, "/api/billing/overview")).data.features, ["tv.watch"]);
  await runBillingSweep();
  // At the trial's end the first charge (new price) happens.
  await call(fay, `/api/admin/billing/subscriptions/${t.data.subscription.id}/advance`, { body: {} });
  const after = (await db.query("select status from billing_subscriptions where id=$1", [t.data.subscription.id])).rows[0];
  assert.equal(after.status, "active");
  assert.equal(await count("select coalesce(sum(amount_cents),0)::int n from billing_payments where account_id=$1 and status='succeeded'", [dan]), 1500);
  // Cancel now and subscribe again: no second trial.
  await call(fay, `/api/admin/billing/subscriptions/${t.data.subscription.id}/cancel`, { body: { now: true } });
  const again = await call(dan, "/api/billing/subscriptions", { body: { planId: "tv_monthly", methodId: card, key: key() } });
  assert.equal(again.status, 201);
  assert.equal(again.data.subscription.status, "active");
  assert.equal(again.data.payment.amount, 1500);
  assert.deepEqual((await call(dan, "/api/billing/overview")).data.trialUsed, ["tv"], "the page no longer promises a trial");
  await call(fay, "/api/admin/billing/catalog/tv_monthly", { method: "PATCH", body: { name: "STAYBLZ TV Pass", amount: 1200, status: "active", trialDays: 0 } });
});

test("STAYBLZ TV: open while paywalls are off; with them on only pass holders, grants and staff can watch", async () => {
  process.env.TV_ON_AIR = "true";
  process.env.TV_STREAM_URL = "https://stream.example.test/live.m3u8";
  try {
    assert.equal((await call(hal, "/api/tv/playback")).status, 200, "paywalls off: everyone");
    assert.equal((await call(fay, "/api/admin/billing/settings", { method: "PUT", body: { enforcePaywalls: true } })).status, 403, "admins can't flip it");
    const settings = (await call(gus, "/api/admin/billing/summary")).data.settings;
    const on = await call(gus, "/api/admin/billing/settings", { method: "PUT", body: { ...settings, enforcePaywalls: true } });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    const blocked = await call(hal, "/api/tv/playback");
    assert.equal(blocked.status, 402);
    assert.equal(blocked.data.code, "subscription_required");
    const status = await call(hal, "/api/tv/status");
    assert.equal(status.data.access.allowed, false);
    assert.equal((await call(eve, "/api/tv/playback")).status, 200, "a pass holder watches");
    assert.equal((await call(fay, "/api/tv/playback")).status, 200, "staff can always check it");
    // A free-access grant.
    const grant = await call(fay, "/api/admin/billing/grants", { body: { email: "hal@example.test", feature: "tv.watch", reason: "Press pass" } });
    assert.equal(grant.status, 201, JSON.stringify(grant.data));
    assert.equal((await call(hal, "/api/tv/playback")).status, 200);
    assert.equal((await call(fay, `/api/admin/billing/grants/${grant.data.id}/revoke`, { body: {} })).status, 200);
    assert.equal((await call(hal, "/api/tv/playback")).status, 402);
    await call(gus, "/api/admin/billing/settings", { method: "PUT", body: { ...settings, enforcePaywalls: false } });
  } finally {
    delete process.env.TV_ON_AIR;
    delete process.env.TV_STREAM_URL;
  }
});

/* ---------- Stable billing ---------- */

test("stable billing is for the owner and managers only; setup and payouts are the owner's", async () => {
  assert.equal((await sb(dan, "/overview")).status, 403, "a member (groom) can't see the stable's money");
  assert.equal((await call(eve, "/api/workspace/billing/overview", { team: stable })).status, 403, "outsiders are refused");
  assert.equal((await call(eve, "/api/workspace/billing/overview")).status, 403, "the stable header is required");
  assert.equal((await sb(cat, "/overview")).status, 200, "a manager can");
  assert.equal((await sb(cat, "/setup", { method: "PUT", body: { legalName: "X", businessType: "company", statementName: "X", invoicePrefix: "XX", acceptTerms: true } })).status, 403);
  // Not set up yet: invoices can be drafted but not sent.
  const c = await client("Early Client");
  const d = await sb(ben, "/invoices", { body: { clientId: c, lines: [{ category: "board", description: "Board", quantity: 1, unitCents: 1000 }] } });
  assert.equal(d.status, 201);
  const notReady = await sb(ben, `/invoices/${d.data.invoice.id}/send`, { body: {} });
  assert.equal(notReady.status, 409);
  assert.equal(notReady.data.code, "payments_not_set_up");
  assert.equal((await sb(ben, `/invoices/${d.data.invoice.id}/void`, { body: {} })).data.deleted, true);
  assert.equal((await sb(ben, "/setup", { method: "PUT", body: { legalName: "Bishop Racing LLC", businessType: "company", statementName: "BISHOP", invoicePrefix: "BR" } })).status, 400, "the terms must be accepted");
  await setupStable();
  const setup = await sb(ben, "/setup");
  assert.equal(setup.data.merchant.invoice_prefix, "BR");
  assert.equal(setup.data.merchant.payout.last4, "6789");
  assert.ok(!("payout_ref" in setup.data.merchant), "the payout token stays on the server");
  assert.equal((await sb(cat, "/payouts", { body: { key: key() } })).status, 403, "only the owner pays out");
});

test("Bill owners: charges are split by owner shares to the cent, one draft per owner; horses without owners wait", async () => {
  await setupStable();
  const eveClient = await client("Eve Evans", "eve@example.test");
  const joe = await client("Joe Jones", "joe@nowhere.test");
  const kim = await client("Kim Kale");
  // Golden Gate: Eve 50%, Joe 30%, Kim 20%. Night Owl: Eve 100%. Solo Run: nobody yet.
  const shares = await sb(ben, `/horses/${horses["Golden Gate"]}/owners`, {
    method: "PUT",
    body: { owners: [{ clientId: eveClient, shareBps: 5000 }, { clientId: joe, shareBps: 3000 }, { clientId: kim, shareBps: 2000 }] },
  });
  assert.equal(shares.status, 200, JSON.stringify(shares.data));
  assert.equal((await sb(ben, `/horses/${horses["Night Owl"]}/owners`, { method: "PUT", body: { owners: [{ clientId: eveClient, shareBps: 6000 }, { clientId: joe, shareBps: 5000 }] } })).status, 400, "over 100% is refused");
  await sb(ben, `/horses/${horses["Night Owl"]}/owners`, { method: "PUT", body: { owners: [{ clientId: eveClient, shareBps: 10000 }] } });
  const list = await sb(ben, "/horses");
  assert.equal(list.data.horses.find((h) => h.id === horses["Golden Gate"]).billedBps, 10000);

  const charge = (body) => sb(cat, "/charges", { body: { serviceOn: "2026-11-01", ...body } });
  assert.equal((await charge({ horseId: horses["Golden Gate"], category: "training", description: "Day rate, November", quantity: 30, unitCents: 9550 })).status, 201);
  assert.equal((await charge({ horseId: horses["Golden Gate"], category: "vet", description: "Vet check", quantity: 1, unitCents: 10001 })).status, 201);
  assert.equal((await charge({ horseId: horses["Night Owl"], category: "farrier", description: "Shoeing", quantity: 1, unitCents: 18000 })).status, 201);
  assert.equal((await charge({ horseId: horses["Solo Run"], category: "board", description: "Board", quantity: 30, unitCents: 4000 })).status, 201);
  assert.equal((await charge({ clientId: joe, category: "transport", description: "Van to Keeneland", quantity: 1, unitCents: 25000 })).status, 201);
  assert.equal((await charge({ category: "other", description: "Nobody", quantity: 1, unitCents: 100 })).status, 400, "a charge needs a horse or a client");
  assert.equal((await charge({ horseId: horses["Golden Gate"], category: "credit", description: "Bad credit", quantity: 1, unitCents: 500 })).status, 400, "credits are negative");
  assert.equal((await charge({ horseId: horses["Golden Gate"], category: "vet", description: "Too many decimals", quantity: 1.005, unitCents: 100 })).status, 400);

  const run = await sb(ben, "/bill-owners", { body: { through: "2026-11-30" } });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.invoices.length, 3, "Eve, Joe and Kim");
  assert.equal(run.data.skipped.length, 1);
  assert.equal(run.data.skipped[0].horseName, "Solo Run");
  assert.equal(run.data.skipped[0].reason, "no_owners");
  const by = Object.fromEntries(run.data.invoices.map((i) => [i.billTo.name, i]));
  // Day rate 30 x $95.50 = $2,865.00 → 1,432.50 / 859.50 / 573.00. Vet $100.01 → 50.01 / 30.00 / 20.00.
  assert.equal(by["Eve Evans"].total, 143250 + 5001 + 18000);
  assert.equal(by["Joe Jones"].total, 85950 + 3000 + 25000);
  assert.equal(by["Kim Kale"].total, 57300 + 2000);
  assert.equal(by["Eve Evans"].status, "draft");
  const unbilled = await sb(ben, "/charges");
  assert.equal(unbilled.data.charges.length, 1, "only Solo Run's board waits");
  assert.equal((await sb(ben, "/bill-owners", { body: { through: "2026-11-30" } })).data.invoices.length, 0, "nothing is billed twice");
  // A billed charge can't be edited or removed.
  const billed = (await sb(ben, "/charges?status=billed")).data.charges[0];
  assert.equal((await sb(ben, `/charges/${billed.id}/remove`, { body: {} })).status, 409);
  // Deleting Kim's draft frees only Kim's share... the charges stay billed for Eve and Joe.
  assert.equal((await sb(ben, `/invoices/${by["Kim Kale"].id}/void`, { body: {} })).data.deleted, true);
  assert.equal((await sb(ben, "/charges")).data.charges.length, 1, "the split charges are still on Eve's and Joe's invoices");
  // Kim's draft again: delete Eve's and Joe's too → the Golden Gate charges become unbilled.
  for (const name of ["Eve Evans", "Joe Jones"]) await sb(ben, `/invoices/${by[name].id}/void`, { body: {} });
  assert.equal((await sb(ben, "/charges")).data.charges.length, 5, "all charges are free to bill again");
  // Bill again for the next tests.
  const rerun = await sb(ben, "/bill-owners", { body: { through: "2026-11-30" } });
  assert.equal(rerun.data.invoices.length, 3);
});

test("send, pay by link as a guest, Stayblz fee, balance, alerts; the client with an account sees the bill", async () => {
  const drafts = (await sb(ben, "/invoices?status=draft")).data.invoices;
  const eveDraft = drafts.find((i) => i.billTo.name === "Eve Evans");
  const joeDraft = drafts.find((i) => i.billTo.name === "Joe Jones");
  const sent = await sb(cat, `/invoices/${eveDraft.id}/send`, { body: {} });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.match(sent.data.invoice.number, /^BR-\d{4}$/);
  assert.equal(sent.data.invoice.status, "open");
  assert.match(sent.data.invoice.payToken, /^[0-9a-f]{64}$/);
  const joeSent = await sb(ben, `/invoices/${joeDraft.id}/send`, { body: {} });
  assert.notEqual(joeSent.data.invoice.number, sent.data.invoice.number, "numbers never repeat");
  assert.equal((await sb(ben, `/invoices/${eveDraft.id}`, { method: "PUT", body: { clientId: eveDraft.clientId, lines: [{ category: "other", description: "x", quantity: 1, unitCents: 1 }] } })).status, 409, "a sent invoice can't be edited");
  await billingAlertsSettled();
  assert.equal(await count("select count(*)::int n from chat_alerts where user_id=$1 and kind='billing' and chat_title='New bill from Bishop Racing'", [eve]), 1);
  // Eve sees it in her Billing page (her account's email matches).
  const eveView = await call(eve, "/api/billing/overview");
  assert.ok(eveView.data.bills.some((b) => b.id === eveDraft.id));
  assert.equal((await call(hal, `/api/billing/invoices/${eveDraft.id}`)).status, 404);

  // Joe has no account: he pays from the link.
  const link = joeSent.data.invoice.payToken;
  const view = await call(null, `/api/pay/${link}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.invoice.total, 113950);
  assert.equal(view.data.invoice.from.name, "Bishop Racing LLC");
  assert.ok(!("accountId" in view.data.invoice) && !("payToken" in view.data.invoice));
  assert.equal(view.headers.get("x-robots-tag"), "noindex");
  assert.equal((await call(null, `/api/pay/${"0".repeat(64)}`)).status, 404);
  assert.equal((await call(null, "/api/pay/not-a-token")).status, 404);
  const declined = await call(null, `/api/pay/${link}/pay`, { body: { type: "card", token: "tok_insufficient", key: key() } });
  assert.equal(declined.status, 402);
  assert.equal(declined.data.code, "insufficient_funds");
  assert.equal(declined.data.invoice.status, "open");
  assert.equal((await call(null, `/api/pay/${link}/pay`, { body: { type: "card", token: "4242424242424242", key: key() } })).status, 400, "no real card numbers");
  assert.equal((await call(null, `/api/pay/${link}/pay`, { body: { methodId: randomUUID(), key: key() } })).status, 401, "saved cards need sign-in");
  const paid = await call(null, `/api/pay/${link}/pay`, { body: { type: "card", token: "tok_amex", key: key() } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(paid.data.paid, true);
  assert.equal(paid.data.invoice.status, "paid");
  assert.equal(paid.data.payment.fee, Math.floor((113950 * 299 + 5000) / 10000), "2.99% Stayblz fee");
  assert.equal((await call(null, `/api/pay/${link}/pay`, { body: { type: "card", token: "tok_visa", key: key() } })).status, 409, "can't pay twice");
  await billingAlertsSettled();
  assert.ok(await count("select count(*)::int n from chat_alerts where user_id=$1 and kind='billing' and chat_title='Invoice paid'", [ben]) >= 1, "the owner hears about it");
  assert.ok(await count("select count(*)::int n from chat_alerts where user_id=$1 and kind='billing' and chat_title='Invoice paid'", [cat]) >= 1, "managers too");
  assert.equal(await count("select count(*)::int n from chat_alerts where user_id=$1 and kind='billing'", [dan]), 0, "members don't");
  const overview = await sb(ben, "/overview");
  assert.equal(overview.data.balance.gross, 113950);
  assert.equal(overview.data.balance.fees, paid.data.payment.fee);
  assert.equal(overview.data.balance.available, 113950 - paid.data.payment.fee, "payout delay is 0 in these tests");
  assert.equal(await count("select coalesce(sum(amount_cents),0)::int n from billing_ledger where holder='platform' and entry='fee_income'"), paid.data.payment.fee);
});

test("one payment at a time per bill: two payments at once can't both go through", async () => {
  const kim = (await sb(ben, "/invoices?status=draft")).data.invoices.find((i) => i.billTo.name === "Kim Kale");
  const sent = await sb(ben, `/invoices/${kim.id}/send`, { body: {} });
  const link = sent.data.invoice.payToken;
  const [a, b] = await Promise.all([
    call(null, `/api/pay/${link}/pay`, { body: { type: "card", token: "tok_visa", key: key() } }),
    call(null, `/api/pay/${link}/pay`, { body: { type: "card", token: "tok_mastercard", key: key() } }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([a.data, b.data]));
  assert.equal(await count("select count(*)::int n from billing_payments where invoice_id=$1 and status='succeeded'", [kim.id]), 1);
  // Same key twice = the same payment.
  const c = await client("Replay Client");
  const inv = await sentInvoice(c, [{ category: "board", description: "Board", quantity: 1, unitCents: 5000 }]);
  const k = key();
  const first = await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "card", token: "tok_visa", key: k } });
  assert.equal(first.status, 200);
  const replay = await sb(ben, `/invoices/${inv.id}/payments`, { body: { channel: "keyed", token: "tok_visa", key: k } });
  assert.notEqual(replay.status, 500);
  assert.equal(await count("select count(*)::int n from billing_payments where invoice_id=$1", [inv.id]), 1);
});

test("crash between the processor and finish: the payment is finished once, by asking again with the same key", async () => {
  const c = await client("Crash Client");
  const inv = await sentInvoice(c, [{ category: "vet", description: "Vet", quantity: 1, unitCents: 7777 }]);
  const real = provider.paymentProvider();
  let charges = 0;
  provider.setPaymentProviderForTests({
    ...real,
    async charge(input) {
      charges++;
      throw new Error("network down");
    },
  });
  const r = await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "card", token: "tok_visa", key: key() } });
  assert.equal(r.status, 503);
  assert.equal(r.data.code, "payment_unconfirmed");
  provider.setPaymentProviderForTests({
    ...real,
    async charge(input) {
      charges++;
      return real.charge(input);
    },
  });
  // Another try is refused while the first is unresolved (no double charge).
  assert.equal((await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "card", token: "tok_visa", key: key() } })).status, 409);
  await db.query("update billing_payments set created_at = now() - interval '5 minutes' where invoice_id=$1", [inv.id]);
  const report = await runBillingSweep();
  assert.equal(report.reconciled, 1);
  provider.setPaymentProviderForTests(null);
  assert.equal(charges, 2, "asked twice with the same key: the processor treats it as one charge");
  const row = (await db.query("select status from billing_invoices where id=$1", [inv.id])).rows[0];
  assert.equal(row.status, "paid");
  assert.equal(await count("select count(*)::int n from billing_payments where invoice_id=$1", [inv.id]), 1);
  assert.equal(await count("select count(*)::int n from billing_ledger where invoice_id=$1 and entry='payment'", [inv.id]), 1);
});

test("a retried attempt finishes with the card it started with, not one picked afterwards", async () => {
  const c = await client("Switch Client");
  const inv = await sentInvoice(c, [{ category: "vet", description: "Vet", quantity: 1, unitCents: 4321 }]);
  const real = provider.paymentProvider();
  provider.setPaymentProviderForTests({ ...real, async charge() { throw new Error("network down"); } });
  const k = key();
  assert.equal((await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "card", token: "tok_declined", key: k } })).status, 503);
  provider.setPaymentProviderForTests(null);
  // Same attempt (same key), but now with a good card: it must end as the original card's decline.
  const retry = await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "card", token: "tok_visa", key: k } });
  assert.equal(retry.status, 402, JSON.stringify(retry.data));
  assert.equal(retry.data.code, "card_declined");
  assert.equal((await db.query("select status from billing_invoices where id=$1", [inv.id])).rows[0].status, "open");
  assert.equal(await count("select count(*)::int n from billing_payments where invoice_id=$1", [inv.id]), 1);
  // A new attempt with the good card then pays.
  assert.equal((await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "card", token: "tok_visa", key: key() } })).status, 200);
});

test("bank transfers: processing until they clear; a returned transfer makes the bill due again", async () => {
  const bank = await addBank(eve, "btok_ok");
  const bills = (await call(eve, "/api/billing/overview")).data.bills;
  const bill = bills[0];
  const pay = await call(eve, `/api/billing/invoices/${bill.id}/pay`, { body: { methodId: bank, key: key() } });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  assert.equal(pay.data.payment.status, "processing");
  assert.equal(pay.data.payment.fee, Math.floor((bill.due * 100 + 5000) / 10000), "1% bank fee");
  assert.equal(pay.data.invoice.status, "open");
  assert.equal((await call(eve, `/api/billing/invoices/${bill.id}/pay`, { body: { methodId: bank, key: key() } })).status, 409, "no second payment while one is clearing");
  const report = await runBillingSweep();
  assert.equal(report.settled, 1);
  assert.equal((await db.query("select status from billing_invoices where id=$1", [bill.id])).rows[0].status, "paid");
  // A bank account without enough money: accepted, then returned.
  const c = await client("Bounce Client");
  const inv = await sentInvoice(c, [{ category: "board", description: "Board", quantity: 1, unitCents: 20000 }]);
  const p = await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "bank", token: "btok_insufficient", key: key() } });
  assert.equal(p.data.payment.status, "processing");
  await runBillingSweep();
  const back = (await db.query("select i.status, p.status as pay, p.failure_code from billing_invoices i join billing_payments p on p.invoice_id=i.id where i.id=$1", [inv.id])).rows[0];
  assert.equal(back.status, "open");
  assert.equal(back.pay, "failed");
  assert.equal(back.failure_code, "insufficient_funds");
  assert.equal(await count("select count(*)::int n from billing_ledger where invoice_id=$1", [inv.id]), 0, "nothing reached the balance");
  await billingAlertsSettled();
  assert.ok(await count("select count(*)::int n from chat_alerts where user_id=$1 and chat_title='A bank payment was returned'", [ben]) >= 1);
  // A closed account fails at once.
  const closed = await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "bank", token: "btok_closed", key: key() } });
  assert.equal(closed.status, 402);
  assert.equal(closed.data.code, "account_closed");
});

test("taking payments: cash and cheques (part payments, no fee), a card over the phone (3.5%), the card reader (2.5%)", async () => {
  const c = await client("Counter Client");
  const inv = await sentInvoice(c, [{ category: "training", description: "Training", quantity: 10, unitCents: 10000 }]);
  const take = (body) => sb(cat, `/invoices/${inv.id}/payments`, { body: { key: key(), ...body } });
  assert.equal((await take({ channel: "offline", offlineKind: "check", amountCents: 200000 })).status, 400, "more than what's due");
  const check = await take({ channel: "offline", offlineKind: "check", reference: "Cheque 1042", amountCents: 40000 });
  assert.equal(check.status, 200, JSON.stringify(check.data));
  assert.equal(check.data.payment.fee, 0);
  assert.equal(check.data.invoice.status, "open");
  assert.equal(check.data.invoice.due, 60000);
  assert.equal((await take({ channel: "keyed", token: "tok_visa", amountCents: 100 })).data.payment.amount, 60000, "card payments always pay the full balance");
  const fresh = (await sb(ben, `/invoices/${inv.id}`)).data.invoice;
  assert.equal(fresh.status, "paid");
  const keyed = fresh.payments.find((p) => p.channel === "keyed");
  assert.equal(keyed.fee, 2100, "3.50% of $600");
  // The reader on another bill.
  const inv2 = await sentInvoice(c, [{ category: "jockey", description: "Jockey fee", quantity: 1, unitCents: 10000 }]);
  const reader = await sb(ben, `/invoices/${inv2.id}/payments`, { body: { channel: "reader", token: "tok_visa", key: key() } });
  assert.equal(reader.status, 200);
  assert.equal(reader.data.payment.fee, 250, "2.50% in person");
  assert.equal((await sb(ben, `/invoices/${inv2.id}/payments`, { body: { channel: "card", token: "tok_visa", key: key() } })).status, 400, "the stable can't pick the online channel");
  // Stayblz's own invoices can't take cash.
  const own = (await db.query("select id from billing_invoices where issuer='stayblz' limit 1")).rows[0];
  assert.equal((await sb(ben, `/invoices/${own.id}/payments`, { body: { channel: "offline", offlineKind: "cash", amountCents: 100, key: key() } })).status, 404);
});

test("refunds: part then the rest, never more; the Stayblz fee isn't returned; admins refund only Stayblz's own sales", async () => {
  const c = await client("Refund Client");
  const inv = await sentInvoice(c, [{ category: "sale", description: "Deposit", quantity: 1, unitCents: 100000 }]);
  const paid = await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "card", token: "tok_visa", key: key() } });
  const payment = paid.data.payment;
  const before = (await sb(ben, "/overview")).data.balance.available;
  assert.equal((await sb(dan, `/payments/${payment.id}/refund`, { body: { amountCents: 100, reason: "duplicate", key: key() } })).status, 403);
  const part = await sb(ben, `/payments/${payment.id}/refund`, { body: { amountCents: 30000, reason: "service_issue", note: "Partial", key: key() } });
  assert.equal(part.status, 200, JSON.stringify(part.data));
  assert.equal(part.data.refund.status, "succeeded");
  assert.equal((await sb(ben, `/payments/${payment.id}/refund`, { body: { amountCents: 80000, reason: "other", key: key() } })).status, 400, "more than what's left");
  const k = key();
  const rest = await sb(ben, `/payments/${payment.id}/refund`, { body: { reason: "requested_by_customer", key: k } });
  assert.equal(rest.status, 200);
  assert.equal(Number(rest.data.refund.amount_cents), 70000);
  const replay = await sb(ben, `/payments/${payment.id}/refund`, { body: { reason: "requested_by_customer", key: k } });
  assert.equal(replay.status, 200, "the same refund request again is the same refund");
  assert.equal(await count("select count(*)::int n from billing_refunds where payment_id=$1", [payment.id]), 2);
  assert.equal((await sb(ben, `/payments/${payment.id}/refund`, { body: { reason: "other", key: key() } })).status, 409, "nothing left");
  const after = (await sb(ben, "/overview")).data.balance.available;
  assert.equal(before - after, 100000, "the full amount left the balance; the 2.99% fee stays with Stayblz");
  const invNow = (await sb(ben, `/invoices/${inv.id}`)).data.invoice;
  assert.equal(invNow.refunded, 100000);
  assert.equal(invNow.status, "paid");
  // Admin: can't refund a stable's payment, can refund Stayblz's own sale.
  assert.equal((await call(fay, `/api/admin/billing/payments/${payment.id}/refund`, { body: { reason: "other", key: key() } })).status, 404);
  const sale = (await db.query("select id from billing_payments where account_id=$1 and status='succeeded' and stable_id is null limit 1", [eve])).rows[0];
  assert.equal((await call(ann, `/api/admin/billing/payments/${sale.id}/refund`, { body: { reason: "other", key: key() } })).status, 403);
  const adminRefund = await call(fay, `/api/admin/billing/payments/${sale.id}/refund`, { body: { amountCents: 500, reason: "service_issue", key: key() } });
  assert.equal(adminRefund.status, 200, JSON.stringify(adminRefund.data));
  await billingAlertsSettled();
  assert.ok(await count("select count(*)::int n from chat_alerts where user_id=$1 and chat_title='Refund on its way'", [eve]) >= 1);
  // A stable can't refund another stable's (or Stayblz's) payment.
  assert.equal((await sb(ben, `/payments/${sale.id}/refund`, { body: { reason: "other", key: key() } })).status, 404);
});

test("cancelling: an unpaid invoice is voided and its charges can be billed again; one with payments can't be", async () => {
  const c = await client("Void Client");
  await sb(ben, "/charges", { body: { clientId: c, category: "board", description: "Board", quantity: 1, unitCents: 3000, serviceOn: "2026-11-02" } });
  const run = await sb(ben, "/bill-owners", { body: {} });
  const mine = run.data.invoices.find((i) => i.billTo.name === "Void Client");
  const sent = await sb(ben, `/invoices/${mine.id}/send`, { body: {} });
  const v = await sb(ben, `/invoices/${mine.id}/void`, { body: {} });
  assert.equal(v.status, 200);
  assert.equal(v.data.invoice.status, "void");
  assert.equal((await call(null, `/api/pay/${sent.data.invoice.payToken}`)).status, 404, "the pay link stops working");
  assert.ok((await sb(ben, "/charges")).data.charges.some((ch) => ch.clientId === c), "its charge is unbilled again");
  const inv = await sentInvoice(c, [{ category: "board", description: "Board", quantity: 1, unitCents: 3000 }]);
  await sb(ben, `/invoices/${inv.id}/payments`, { body: { channel: "offline", offlineKind: "cash", amountCents: 1000, key: key() } });
  const refused = await sb(ben, `/invoices/${inv.id}/void`, { body: {} });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, "has_payments");
  // A new link replaces the old one.
  const fresh = await sb(ben, `/invoices/${inv.id}/link`, { body: {} });
  assert.equal(fresh.status, 200);
  assert.equal((await call(null, `/api/pay/${inv.payToken}`)).status, 404);
  assert.equal((await call(null, `/api/pay/${fresh.data.payToken}`)).status, 200);
});

test("payouts: the available balance goes to the bank; never more than it; a refused payout comes back", async () => {
  const bal = (await sb(ben, "/payouts")).data.balance;
  assert.ok(bal.available > 0);
  assert.equal((await sb(ben, "/payouts", { body: { amountCents: bal.available + 1, key: key() } })).status, 409);
  assert.equal((await sb(ben, "/payouts", { body: { amountCents: 50, key: key() } })).status, 400, "payouts start at $1");
  const k = key();
  const out = await sb(ben, "/payouts", { body: { amountCents: 10000, key: k } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.payout.status, "paid");
  assert.match(out.data.payout.arrives_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal((await sb(ben, "/payouts", { body: { amountCents: 10000, key: k } })).data.payout.status, "paid", "same key, same payout");
  assert.equal(await count("select count(*)::int n from billing_payouts where idempotency_key=$1", [k]), 1);
  const all = await sb(ben, "/payouts", { body: { key: key() } });
  assert.equal(all.status, 200);
  assert.equal((await sb(ben, "/payouts")).data.balance.available, 0);
  // A payout to a closed account fails and the money returns.
  await db.query("update billing_merchants set payout_ref='btok_closed' where stable_id=$1", [stable]);
  const c = await client("Payout Client");
  const inv = await sentInvoice(c, [{ category: "board", description: "Board", quantity: 1, unitCents: 10000 }]);
  await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "card", token: "tok_visa", key: key() } });
  const avail = (await sb(ben, "/payouts")).data.balance.available;
  const failed = await sb(ben, "/payouts", { body: { key: key() } });
  assert.equal(failed.data.payout.status, "failed");
  assert.equal((await sb(ben, "/payouts")).data.balance.available, avail, "the money is back in the balance");
  await db.query("update billing_merchants set payout_ref='btok_ok' where stable_id=$1", [stable]);
});

test("autopay: a client's bills from a stable pay themselves on the due date, and retries when they fail", async () => {
  const card = (await db.query("select id from billing_methods where account_id=$1 and status='active' and provider_ref='tok_visa' limit 1", [eve])).rows[0].id;
  assert.equal((await call(eve, "/api/billing/autopay", { method: "PUT", body: { stableId: randomUUID(), methodId: card } })).status, 404, "only for stables that bill you");
  const on = await call(eve, "/api/billing/autopay", { method: "PUT", body: { stableId: stable, methodId: card } });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  const eveClient = (await db.query("select id from billing_clients where stable_id=$1 and email='eve@example.test'", [stable])).rows[0].id;
  const inv = await sentInvoice(eveClient, [{ category: "board", description: "December board", quantity: 31, unitCents: 4500 }], { dueOn: new Date().toISOString().slice(0, 10) });
  assert.equal(inv.autoCollect, true);
  const report = await runBillingSweep();
  assert.equal(report.collected, 1, JSON.stringify(report));
  const row = (await db.query("select status from billing_invoices where id=$1", [inv.id])).rows[0];
  assert.equal(row.status, "paid");
  await billingAlertsSettled();
  assert.ok(await count("select count(*)::int n from chat_alerts where user_id=$1 and chat_title='Autopay paid a bill'", [eve]) >= 1);
  // A failing card: retried, and the bill stays open for the client to pay.
  const failing = await addCard(eve, "tok_fail_later");
  await call(eve, "/api/billing/autopay", { method: "PUT", body: { stableId: stable, methodId: failing } });
  const inv2 = await sentInvoice(eveClient, [{ category: "board", description: "January board", quantity: 31, unitCents: 4500 }], { dueOn: new Date().toISOString().slice(0, 10) });
  await runBillingSweep();
  const r2 = (await db.query("select status,attempts,auto_collect from billing_invoices where id=$1", [inv2.id])).rows[0];
  assert.equal(r2.status, "open");
  assert.equal(r2.attempts, 1);
  assert.equal(r2.auto_collect, true);
  assert.equal((await call(eve, "/api/billing/autopay/remove", { body: { stableId: stable } })).status, 200);
  assert.equal((await db.query("select auto_collect from billing_invoices where id=$1", [inv2.id])).rows[0].auto_collect, false);
});

test("Marketplace: featuring a listing is a one-time purchase; it then shows first with a Featured tag", async () => {
  const listing = (body) => call(ann, "/api/marketplace/listings", { body: { breed: "thoroughbred", discipline: "flat-racing", type: "racehorse", gender: "mare", color: "bay", age: 4, heightIn: 64, location: "Lexington, Kentucky", price: 25000, ...body } });
  const older = await listing({ name: "Older Mare" });
  assert.equal(older.status, 201, JSON.stringify(older.data));
  await db.query("update marketplace_listings set created_at = now() - interval '10 days' where id=$1", [older.data.listing.id]);
  await listing({ name: "Newer Mare" });
  const card = (await db.query("select id from billing_methods where account_id=$1 and status='active' limit 1", [ann])).rows[0].id;
  assert.equal((await call(hal, "/api/billing/purchases", { body: { productId: "listing_feature_7", listingId: older.data.listing.id, methodId: (await db.query("select id from billing_methods where account_id=$1 and status='active' limit 1", [hal])).rows[0].id, key: key() } })).status, 403, "only your own listing");
  const bought = await call(ann, "/api/billing/purchases", { body: { productId: "listing_feature_7", listingId: older.data.listing.id, methodId: card, key: key() } });
  assert.equal(bought.status, 201, JSON.stringify(bought.data));
  assert.equal(bought.data.payment.amount, 999);
  const browse = await call(hal, "/api/marketplace/listings");
  assert.equal(browse.data.listings[0].name, "Older Mare", "featured first");
  assert.equal(browse.data.listings[0].featured, true);
  assert.equal(browse.data.listings[0].featuredUntil, undefined, "only the seller sees the end date");
  const until = new Date((await db.query("select featured_until from marketplace_listings where id=$1", [older.data.listing.id])).rows[0].featured_until);
  assert.ok(until > new Date(Date.now() + 6.9 * 86400e3) && until < new Date(Date.now() + 7.1 * 86400e3));
  // Buying again extends from the current end.
  await call(ann, "/api/billing/purchases", { body: { productId: "listing_feature_7", listingId: older.data.listing.id, methodId: card, key: key() } });
  const until2 = new Date((await db.query("select featured_until from marketplace_listings where id=$1", [older.data.listing.id])).rows[0].featured_until);
  assert.ok(until2 > new Date(Date.now() + 13.9 * 86400e3));
  assert.equal((await call(ann, "/api/billing/purchases", { body: { productId: "stallion_showcase", listingId: older.data.listing.id, methodId: card, key: key() } })).status, 404, "plans and drafts can't be bought this way");
});

test("admin report, settings and audit; live mode can't be switched on without a real processor", async () => {
  assert.equal((await call(ann, "/api/admin/billing/summary")).status, 403);
  const s = await call(fay, "/api/admin/billing/summary");
  assert.equal(s.status, 200);
  const sum = s.data.summary;
  const sales = await count("select coalesce(sum(amount_cents),0)::int n from billing_ledger where holder='platform' and entry='sale'");
  assert.equal(sum.sales, sales);
  assert.ok(sum.feeIncome > 0);
  assert.ok(sum.mrr >= 1200);
  assert.ok(sum.stableVolume > 0);
  assert.equal(sum.months.length, 12);
  assert.equal(s.data.provider.live, false);
  const live = await call(gus, "/api/admin/billing/settings", { method: "PUT", body: { ...s.data.settings, mode: "live" } });
  assert.equal(live.status, 409);
  assert.equal(live.data.code, "no_live_provider");
  const badFees = await call(gus, "/api/admin/billing/settings", { method: "PUT", body: { ...s.data.settings, fees: { card: { bps: 99999 } } } });
  assert.equal(badFees.status, 400);
  const payments = await call(fay, "/api/admin/billing/payments");
  const stablePay = payments.data.payments.find((p) => p.stableId);
  assert.equal(stablePay.payer, null, "who paid a stable stays with the stable");
  assert.ok(payments.data.payments.some((p) => p.payer?.email));
  const events = await call(fay, "/api/admin/billing/events");
  assert.ok(events.data.events.some((e) => e.event === "coupon.created"));
  assert.ok(events.data.events.some((e) => e.event === "payment.succeeded"));
  const subs = await call(fay, "/api/admin/billing/subscriptions?status=active");
  assert.ok(subs.data.subscriptions.every((x) => x.status === "active" && x.account.email));
  // Catalog: new plans start as drafts; bad prices are refused.
  assert.equal((await call(fay, "/api/admin/billing/catalog", { body: { id: "pro_barn", kind: "plan", family: "barn", name: "Barn Pro", amount: 10, interval: "month" } })).status, 400, "minimum $0.50");
  const plan = await call(fay, "/api/admin/billing/catalog", { body: { id: "pro_barn", kind: "plan", family: "barn", name: "Barn Pro", amount: 2900, interval: "month", features: ["barn.pro"] } });
  assert.equal(plan.status, 201);
  assert.equal(plan.data.item.status, "draft");
});

test("the ledger and the billing log can't be changed; browsers can't touch billing tables or functions", async () => {
  await assert.rejects(db.query("update billing_ledger set amount_cents = 0"), /append-only/);
  await assert.rejects(db.query("delete from billing_events"), /append-only/);
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    try {
      for (const table of ["billing_payments", "billing_methods", "billing_invoices", "billing_ledger", "billing_settings"])
        await assert.rejects(db.query(`select * from public.${table}`), /permission denied/, table);
      await assert.rejects(db.query("select public.billing_features($1)", [ann]), /permission denied/);
      await assert.rejects(db.query("select public.billing_payout_start($1,null,'xxxxxxxxxxxx',null)", [stable]), /permission denied/);
    } finally {
      await db.exec("reset role");
    }
  }
});

test("exports: payments and invoices as CSV, safe for spreadsheets", async () => {
  const c = await client("=HYPERLINK(\"http://evil\")");
  const inv = await sentInvoice(c, [{ category: "other", description: "Export", quantity: 1, unitCents: 1234 }]);
  await sb(ben, `/invoices/${inv.id}/payments`, { body: { channel: "offline", offlineKind: "cash", amountCents: 1234, reference: "-cash", key: key() } });
  const csv = await sb(ben, "/export.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-disposition"), /stayblz-payments\.csv/);
  assert.match(csv.data, /^Date,Invoice,Client,Client email,Paid by,Reference,Amount,Stayblz fee,Net,Refunded,Status,Test\r\n/);
  assert.ok(csv.data.includes(`"'=HYPERLINK(""http://evil"")"`), "formulas are neutralised");
  assert.ok(csv.data.includes(",'-cash,"), "a leading minus in text is neutralised");
  assert.ok(csv.data.includes(",12.34,0.00,12.34,"), "amounts stay numbers");
  const invoices = await sb(ben, "/export.csv?kind=invoices");
  assert.match(invoices.data, /^Invoice,Status,Client/);
  assert.equal((await sb(dan, "/export.csv")).status, 403);
});

test("pay links: card-testing guard limits tries per address and per link", async () => {
  const c = await client("Guard Client");
  const inv = await sentInvoice(c, [{ category: "board", description: "Board", quantity: 1, unitCents: 5000 }]);
  const statuses = [];
  for (let i = 0; i < 10; i++)
    statuses.push((await call(null, `/api/pay/${inv.payToken}/pay`, { body: { type: "card", token: "tok_declined", key: key() } })).status);
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(402));
  assert.equal(statuses[8], 429, "the 9th try on one link in 10 minutes is refused");
  assert.equal((await db.query("select status from billing_invoices where id=$1", [inv.id])).rows[0].status, "open");
});

test("customer page: totals, horses and shares, every invoice, charges waiting; another stable can't open it", async () => {
  const c = await client("Track Client", "track@example.test");
  await sb(ben, `/horses/${horses["Solo Run"]}/owners`, { method: "PUT", body: { owners: [{ clientId: c, shareBps: 2500 }] } });
  const paid = await sentInvoice(c, [{ category: "board", description: "Board", quantity: 1, unitCents: 10000 }]);
  await call(null, `/api/pay/${paid.payToken}/pay`, { body: { type: "card", token: "tok_visa", key: key() } });
  await sentInvoice(c, [{ category: "vet", description: "Vet", quantity: 1, unitCents: 5000 }], { dueOn: "2026-01-02" });
  await sb(ben, "/charges", { body: { clientId: c, category: "transport", description: "Van", quantity: 1, unitCents: 7000, serviceOn: "2026-11-03" } });
  const page = await sb(cat, `/clients/${c}`);
  assert.equal(page.status, 200, JSON.stringify(page.data));
  assert.equal(page.data.client.name, "Track Client");
  assert.deepEqual(page.data.horses.map((h) => [h.name, h.shareBps]), [["Solo Run", 2500]]);
  assert.equal(page.data.invoices.length, 2);
  assert.deepEqual(
    { billed: page.data.totals.billed, paid: page.data.totals.paid, owed: page.data.totals.owed, overdue: page.data.totals.overdue },
    { billed: 15000, paid: 10000, owed: 5000, overdue: 5000 },
  );
  assert.ok(page.data.totals.lastPaidAt);
  assert.deepEqual(page.data.charges.map((ch) => ch.description), ["Van"]);
  // Another stable (its own owner) can't read this customer.
  const other = await call(ann, "/api/workspaces", { body: { name: "Archer Farm" } });
  assert.equal(other.status, 201);
  assert.equal((await call(ann, `/api/workspace/billing/clients/${c}`, { team: other.data.stable.id })).status, 404);
  assert.equal((await sb(dan, `/clients/${c}`)).status, 403, "members can't");
});
