# Stayblz Billing

Plans and subscriptions, saved cards and bank accounts, invoices and receipts, one-time purchases, stable billing
("Barn office": clients, owner shares, charges, invoices, pay links, payouts), refunds, a money ledger and admin
reports. Built 2026-11-21. Migration `migrations/202611210002_billing.sql`.

**It runs in test mode.** No payment processor is connected, so the Stayblz test processor
(`src/lib/billing/testProcessor.ts`) stands in: only the test numbers below work, nothing real is ever charged or
paid out, and every row is marked `test = true`. Real card numbers are refused in the browser before they're sent.

## Test cards and bank accounts

Any future expiry (e.g. 12/34), any 3-digit code (4 for American Express), any name.

| Card number | Result |
| --- | --- |
| 4242 4242 4242 4242 | Pays (Visa) |
| 5555 5555 5555 4444 | Pays (Mastercard) |
| 3782 822463 10005 | Pays (American Express) |
| 6011 1111 1111 1117 | Pays (Discover) |
| 4000 0566 5566 5556 | Pays (Visa debit) |
| 4000 0000 0000 0341 | Saves, then every charge is declined (try failed renewals) |
| 4000 0000 0000 9995 | Declined: not enough money |
| 4000 0000 0000 0002 | Declined (refused when saving too) |
| 4000 0000 0000 0069 | Expired card |
| 4000 0000 0000 0119 | Processing error |

| Routing / account | Result |
| --- | --- |
| 110000000 / 000123456789 | Clears (after `bank_settle_minutes`, default 3 min in test) |
| 110000000 / 000222222227 | Accepted, then returned: not enough money |
| 110000000 / 000111111116 | Fails at once: account closed |

Payouts to `000111111116` fail (the money returns to the balance).

## Where things are

| Piece | File |
| --- | --- |
| Tables + all money-moving SQL | `migrations/202611210002_billing.sql` |
| Processor interface (the one place a real processor plugs in) | `src/lib/billing/provider.ts` |
| Test processor | `src/lib/billing/testProcessor.ts` |
| Pay / subscribe / purchase / refund / payout steps | `src/lib/billing/engine.ts` |
| Schedule (renewals, retries, bank clearing, crash recovery, autopay) | `src/lib/billing/schedule.ts` (started in `index.ts`) |
| Alerts (bell + push, kind `billing`) | `src/lib/billing/alerts.ts`, SQL `billing_alert` |
| Your billing `/api/billing` | `src/routes/billing.ts` |
| Stable billing `/api/workspace/billing` (owners + managers) | `src/routes/stableBilling.ts` |
| Pay links `/api/pay/:token` (no account needed) | `src/routes/pay.ts` |
| Admin `/api/admin/billing` | `src/routes/adminBilling.ts` |
| Tests | `tests/billing.test.cjs` (real SQL in PGlite) |
| Frontend | `stayblz-frontend/src/components/billing/`, pages `Billing`, `BillingInvoice`, `PayLink`, `StableBilling`, `admin/BillingAdmin` |

## How money moves (the rules that keep it safe)

- **Whole cents** (bigint) everywhere; rates in basis points (299 = 2.99%); rounding is "half up" in SQL. No floats.
- **Start → processor → finish.** `billing_pay_start` locks the invoice and records a *pending* payment with the
  browser's idempotency key; the API asks the processor to charge, using the payment's id as the processor's
  idempotency key; `billing_pay_finish` applies the result (invoice, ledger, subscription, purchase effect) in one
  transaction.
- **No double charges.** A unique index allows only one payment in flight per invoice (`billing_payments_in_flight`);
  the same key returns the same payment; two clicks or two tabs → one charge, the other gets "already in progress".
- **Crash recovery.** If the server stops between processor and finish, the payment stays pending; the schedule's
  `reconcile` asks the processor again with the same key after 2 minutes (same answer, never a second charge).
- **Bank transfers** are `processing` until they clear; nothing reaches the balance until then; a returned transfer
  makes the bill due again and tells the stable and the payer.
- **Ledger** (`billing_ledger`, append-only): stable `payment` (+), `fee` (−), `refund` (−), `payout` (−),
  `payout_reversal` (+); platform `sale`, `fee_income`, `refund`. A stable's balance is the sum of its rows;
  "available" once `available_at` passes (`payout_delay_days`). Cash/cheques a stable records never touch it.
- **Refunds** return the full amount to the payer; Stayblz's fee isn't returned (the processor keeps its cost too).
  Stables refund their clients; admins refund only Stayblz's own sales.
- **Audit**: every change goes to `billing_events` (append-only). Financial tables have no foreign keys to accounts or
  stables, so records outlive a deleted account or stable.
- **Privacy**: admins see stable payments as amount + fee + stable only; who paid a stable and for what stays with the
  stable (rule 3). No platform role opens a stable's invoices.

## Subscriptions

- One live plan per *family* (TV monthly or yearly, not both). Price locked at sign-up; catalog price changes reach
  new subscribers only. Periods count from an anchor (no 31st → 28th drift).
- Free trial once per family; needs a saved card; reminder 3 days before it ends.
- Renewal: the schedule opens the next period's invoice and charges the plan's card (or the default). Fails →
  `past_due` (access continues), retries after 1, 2 and 4 days, then the plan ends (`payment_failed`) and the invoice
  is `uncollectible`. Paying it yourself (Billing → Pay) brings the plan back at once.
- Cancel = at the end of the paid period (undo until then); unfinished or past-due plans end at once.
- Switch monthly ↔ yearly at the next renewal (no proration).
- Promo codes: % or $ off, once / N payments / forever, max uses, end date, one per account.
- Admin **Test: renew now** moves a plan's clock to the end of its period and runs billing (test mode only).
- Seeded catalog: `tv_monthly` $12/month **on sale** (the boss's price); `tv_yearly` $120/year, `stallion_showcase`
  $25/month (for the Stallions section) as **drafts**; `listing_feature_7` $9.99 and `listing_feature_30` $29.99 on sale.
  Drafts are suggestions: admins put them on sale in Billing admin → Plans.

## Paid access (paywall)

`billing_settings.enforce_paywalls` (Billing admin → Fees & settings, superadmin). **Off by default**: everyone can
watch STAYBLZ TV as before, and plans can still be bought and tested. On: `/api/tv/playback` needs the `tv.watch`
feature (TV Pass or a free-access grant); staff can always watch. If billing can't be read, TV stays open (fails open
so paying people are never locked out by an outage).

## Stable billing ("Barn office")

Clients → owner shares per horse (basis points, up to 100%; the rest is the stable's) → charges (day rates, board,
vet, farrier, shipping, entry fees, jockey, supplies, breeding/stud fees, sales, credits) → **Bill owners** (one draft
per owner, each horse charge split by share, rounded per line) → send (number `PREFIX-0001`, pay link, the client's
Stayblz account sees it when the email matches) → paid by link (card/ACH, no account), saved card, autopay, card by
phone (keyed), card reader (simulated in test), or recorded cash/cheque (part payments allowed) → payout to the
stable's bank (owner only). CSV exports of payments and invoices for an accountant / QuickBooks.

## Fees: the boss's proposed rates vs. processor costs (checked 2026-11-21)

Seeded as the boss proposed (to be confirmed): card 2.99%, ACH 1% no cap, keyed 3.50%, reader 2.50%. Cost estimates
use the processor's published US prices: online card 2.9% + 30¢, ACH 0.8% capped at $5, keyed ~3.4% + 30¢, in-person
2.7% + 5¢; Connect payouts add ~0.25% + 25¢ per payout and ~$2 per active stable per month.

What that means (Billing admin → Fees & settings shows it as a margin table):
- **Card 2.99%** loses money on every payment under about $333 (the 30¢ fixed cost). Add a fixed part, e.g. 2.99% + 30¢.
- **Reader 2.50%** always loses money (cost is 2.7% + 5¢). Needs at least ~2.9% + 10¢.
- **Keyed 3.50%** loses money under about $300. 3.5% + 30¢ fixes it.
- **ACH 1% no cap** is very profitable on big bills (a $50,000 sale → $500 fee vs ≤ $5 cost) but competitors usually
  cap ACH; a cap (e.g. $25–$50) may win big stables and horse sales.
- Card surcharging (passing the fee to the client) is regulated by state and card networks: not built, ask a lawyer.

## Going live (connecting a real processor) — checklist

The processor is not connected on purpose: untested real-money code is worse than none. When the boss picks one
(Stripe Connect fits: marketplace-style payments, card + ACH + readers, stables onboard themselves, payouts handled):

1. Create the processor account (business details, bank), get **test** keys first. Decide the fees above.
2. Backend: add `src/lib/billing/stripeProvider.ts` implementing `PaymentProvider`: `charge` = PaymentIntent
   (confirm with the saved PaymentMethod, `Idempotency-Key` = our payment id; for stable invoices
   `application_fee_amount` = our fee and `transfer_data.destination` = the stable's connected account);
   `retrieve` = PaymentIntent status; `refund` = Refund with `refund_application_fee=false`;
   `payout` = rely on the processor's automatic payouts for connected accounts (change the payout route to show them).
   Select it in `paymentProvider()` when `STRIPE_SECRET_KEY` is set; make `liveProviderConfigured()` true.
3. Webhooks: `POST /api/billing/webhook` (raw body, signature check, store each event id once) for
   `payment_intent.succeeded/processing/payment_failed`, `charge.refunded`, `charge.dispute.*` → call
   `billing_pay_finish` / refund finish. Add a `billing_provider_events` table for event idempotency.
4. Frontend: replace the test-card step in `CardFields.tsx` with the processor's hosted card fields (Stripe Elements /
   Payment Element) so card numbers go straight to the processor (PCI SAQ-A). Add the processor's script and frames
   to `vercel.json` CSP. ACH via the processor's bank-link flow (Financial Connections).
5. Stables: "Set up payments" becomes the processor's onboarding (identity, bank); store the connected account id in
   `billing_merchants.payout_ref`/`provider`.
6. Readers: the processor's Terminal SDK (registration + `card_present` PaymentIntents).
7. Sales tax on Stayblz's own plans (processor tax product) and email receipts (Resend or the processor's).
8. Legal: payments terms, refund/cancellation policy, privacy update; check dispute handling.
9. Switch `billing_settings.mode` to `live` only after a full run with test keys; then turn paid access on.

## Settings and environment

- `billing_settings` (one row): `mode`, `enforce_paywalls`, `fees`, `costs`, `payout_delay_days`, `bank_settle_minutes`.
- `BILLING_SCHEDULE=off` stops the every-minute schedule (e.g. a second server). `BILLING_LINK_PAY_LIMIT`
  (default 12 per 10 minutes per address) is the pay-link card-testing guard; 8 tries per link per 10 minutes.
- Deploy order: apply the migration **before** the backend (the marketplace list reads `featured_until`).
