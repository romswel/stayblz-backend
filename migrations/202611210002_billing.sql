-- Stayblz Billing: plans and subscriptions, saved payment methods, invoices and receipts, payments, refunds,
-- a money ledger, stable billing (clients, owner shares, charges, invoices, payouts) and admin reports.
-- Apply after 202611190004_racing_follows.sql (it extends the alert functions defined there); any order with the
-- 202611200001 / 202611210001 migrations. Runs once, in one transaction (re-running stops at the first table).
-- LOCAL until a release is approved.
--
-- Rules every function here keeps (see docs/billing.md):
--  * Money is whole cents (bigint). Rates are basis points (299 = 2.99%). No floating point anywhere.
--  * Every step that moves money runs in one SQL function, locks the rows it changes, and is safe to retry:
--    payments carry a unique idempotency key, and an invoice can only have ONE payment in flight at a time
--    (unique partial index billing_payments_in_flight), so a double click, a retry or two servers can't
--    charge twice.
--  * The payment processor is called by the API between "start" and "finish" (never inside SQL). A crash in
--    between leaves the payment "pending"; the API's sweep asks the processor again with the same key.
--  * Financial records (invoices, payments, refunds, payouts, ledger, events) have no foreign keys to accounts
--    or stables, so they outlive a deleted account or stable. The ledger and events are append-only.
--  * Until a live processor is connected, everything runs on the Stayblz test processor: only published test
--    card / bank numbers work, nothing real is ever charged, and every row is marked test = true.
begin;

-- ======================================================================================================
-- Settings (one row)
-- ======================================================================================================
create table public.billing_settings (
  id boolean primary key default true check (id),
  mode text not null default 'test' check (mode in ('test', 'live')),
  -- Paid features (STAYBLZ TV) check access only when this is on. Off = open to everyone, as before billing.
  enforce_paywalls boolean not null default false,
  -- Stayblz's fee on stable payments, per channel: {"card":{"bps":299,"fixed":0,"cap":0}, ...}. cap 0 = no cap.
  fees jsonb not null check (jsonb_typeof(fees) = 'object'),
  -- What the processor is expected to charge Stayblz (estimates for the margin report), same shape.
  costs jsonb not null check (jsonb_typeof(costs) = 'object'),
  -- Card payments to a stable become available for payout after this many days.
  payout_delay_days integer not null default 2 check (payout_delay_days between 0 and 30),
  -- Test processor: how long a bank transfer takes to clear (real ACH: 3-5 business days).
  bank_settle_minutes integer not null default 3 check (bank_settle_minutes between 0 and 10080),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
-- The boss's proposed rates (to be confirmed): cards 2.99%, bank (ACH) 1% no cap, keyed/phone 3.50%, reader 2.50%.
-- Cost estimates follow the processor's published US prices (online card 2.9% + 30c, ACH 0.8% capped at $5,
-- keyed 3.4% + 30c, in-person 2.7% + 5c). Admins can change both in Billing settings.
insert into public.billing_settings (fees, costs) values (
  '{"card":{"bps":299,"fixed":0,"cap":0},"bank":{"bps":100,"fixed":0,"cap":0},"keyed":{"bps":350,"fixed":0,"cap":0},"reader":{"bps":250,"fixed":0,"cap":0}}',
  '{"card":{"bps":290,"fixed":30,"cap":0},"bank":{"bps":80,"fixed":0,"cap":500},"keyed":{"bps":340,"fixed":30,"cap":0},"reader":{"bps":270,"fixed":5,"cap":0}}'
);

-- A rate table applied to an amount: round half up of amount x bps / 10000, plus the fixed part, capped,
-- never more than the amount itself. Offline payments (cash, cheque) never carry a fee.
create or replace function public.billing_rate(p_rates jsonb, p_channel text, p_amount bigint) returns bigint
language plpgsql immutable set search_path = '' as $$
declare r jsonb := p_rates -> p_channel; v bigint; cap bigint;
begin
  if p_channel = 'offline' or p_amount is null or p_amount <= 0 or r is null or jsonb_typeof(r) <> 'object' then return 0; end if;
  v := (p_amount * coalesce((r ->> 'bps')::bigint, 0) + 5000) / 10000 + coalesce((r ->> 'fixed')::bigint, 0);
  cap := coalesce((r ->> 'cap')::bigint, 0);
  if cap > 0 then v := least(v, cap); end if;
  return greatest(0, least(v, p_amount));
end $$;

-- "$1,234.50"
create or replace function public.billing_money(p_cents bigint) returns text
language sql immutable set search_path = '' as $$
  select case when p_cents < 0 then '-' else '' end || '$' || to_char(abs(p_cents) / 100.0, 'FM999,999,999,990.00')
$$;

-- ======================================================================================================
-- Catalog: plans (recurring) and products (one-time)
-- ======================================================================================================
create table public.billing_catalog (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,39}$'),
  kind text not null check (kind in ('plan', 'product')),
  -- One live subscription per family (e.g. the TV pass monthly OR yearly, not both).
  family text not null check (family ~ '^[a-z][a-z0-9_]{1,29}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  description text not null default '' check (length(description) <= 600),
  amount_cents integer not null check (amount_cents between 50 and 10000000),
  currency text not null default 'usd' check (currency = 'usd'),
  interval text check (interval in ('month', 'year')),
  trial_days integer not null default 0 check (trial_days between 0 and 90),
  -- What a subscription unlocks, checked by the features themselves (e.g. tv.watch).
  features text[] not null default '{}',
  -- What a one-time product does once paid.
  effect text check (effect in ('marketplace_feature')),
  effect_days integer check (effect_days between 1 and 365),
  -- Only "active" items are offered to customers. Drafts are suggestions for admins to review.
  status text not null default 'draft' check (status in ('draft', 'active', 'retired')),
  sort integer not null default 100 check (sort between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'plan') = (interval is not null)),
  check (kind = 'plan' or trial_days = 0),
  check ((effect is null) = (effect_days is null)),
  check (kind = 'product' or effect is null),
  check (kind = 'plan' or effect is not null)
);
insert into public.billing_catalog (id, kind, family, name, description, amount_cents, interval, features, status, sort) values
  ('tv_monthly', 'plan', 'tv', 'STAYBLZ TV Pass', 'Watch live race telecasts on STAYBLZ TV. Billed every month; cancel any time.',
   1200, 'month', '{tv.watch}', 'active', 10),
  ('tv_yearly', 'plan', 'tv', 'STAYBLZ TV Pass (yearly)', 'Twelve months of live race telecasts for the price of ten.',
   12000, 'year', '{tv.watch}', 'draft', 11),
  ('stallion_showcase', 'plan', 'stallion', 'Stallion Showcase', 'List and promote your stallions in Stayblz Stallions (opens with that section).',
   2500, 'month', '{stallions.list}', 'draft', 30);
insert into public.billing_catalog (id, kind, family, name, description, amount_cents, effect, effect_days, status, sort) values
  ('listing_feature_7', 'product', 'marketplace', 'Featured listing - 7 days',
   'Your horse shows first in the Marketplace with a Featured tag for 7 days.', 999, 'marketplace_feature', 7, 'active', 50),
  ('listing_feature_30', 'product', 'marketplace', 'Featured listing - 30 days',
   'Your horse shows first in the Marketplace with a Featured tag for 30 days.', 2999, 'marketplace_feature', 30, 'active', 51);

alter table public.marketplace_listings add column if not exists featured_until timestamptz;
create index if not exists marketplace_listings_featured on public.marketplace_listings (featured_until desc)
  where featured_until is not null;

-- ======================================================================================================
-- Billing details and saved payment methods (never card numbers: only the processor's token + last 4)
-- ======================================================================================================
create table public.billing_profiles (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  name text not null default '' check (length(name) <= 120),
  email text not null default '' check (length(email) <= 254),
  line1 text not null default '' check (length(line1) <= 120),
  line2 text not null default '' check (length(line2) <= 120),
  city text not null default '' check (length(city) <= 80),
  region text not null default '' check (length(region) <= 80),
  postal text not null default '' check (length(postal) <= 20),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$'),
  default_method_id uuid,
  provider_ref text,
  updated_at timestamptz not null default now()
);

create table public.billing_methods (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  type text not null check (type in ('card', 'bank')),
  provider text not null default 'test' check (provider in ('test')),
  provider_ref text not null check (length(provider_ref) between 3 and 200),
  brand text not null default '' check (length(brand) <= 20),
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  exp_month smallint check (exp_month between 1 and 12),
  exp_year smallint check (exp_year between 2000 and 2100),
  bank_name text not null default '' check (length(bank_name) <= 80),
  holder_name text not null default '' check (length(holder_name) <= 120),
  test boolean not null default true,
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  check (type <> 'card' or (exp_month is not null and exp_year is not null))
);
create index billing_methods_account on public.billing_methods (account_id, created_at desc) where status = 'active';

-- ======================================================================================================
-- Coupons
-- ======================================================================================================
create table public.billing_coupons (
  code text primary key check (code ~ '^[A-Z0-9][A-Z0-9_-]{2,23}$'),
  percent_off smallint check (percent_off between 1 and 100),
  amount_off_cents integer check (amount_off_cents between 1 and 1000000),
  duration text not null default 'once' check (duration in ('once', 'repeating', 'forever')),
  duration_months smallint check (duration_months between 1 and 36),
  applies_to text[] not null default '{}',
  max_redemptions integer check (max_redemptions between 1 and 1000000),
  redeemed integer not null default 0 check (redeemed >= 0),
  expires_at timestamptz,
  active boolean not null default true,
  note text not null default '' check (length(note) <= 200),
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((percent_off is null) <> (amount_off_cents is null)),
  check ((duration = 'repeating') = (duration_months is not null))
);
create table public.billing_coupon_redemptions (
  code text not null references public.billing_coupons(code) on delete cascade,
  account_id uuid not null,
  subscription_id uuid,
  created_at timestamptz not null default now(),
  primary key (code, account_id)
);

-- ======================================================================================================
-- Subscriptions
-- ======================================================================================================
create table public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  plan_id text not null references public.billing_catalog(id),
  family text not null,
  -- incomplete = first payment not made yet; past_due = a renewal failed and is being retried.
  status text not null check (status in ('incomplete', 'trialing', 'active', 'past_due', 'canceled')),
  -- The price is locked when someone subscribes: later catalog price changes don't touch them.
  amount_cents integer not null check (amount_cents >= 0),
  interval text not null check (interval in ('month', 'year')),
  -- Periods are counted from the anchor, so a subscription started on the 31st doesn't drift to the 28th.
  anchor_at timestamptz not null default now(),
  periods integer not null default 0 check (periods >= 0),
  current_period_start timestamptz,
  current_period_end timestamptz,
  trial_end timestamptz,
  trial_alerted boolean not null default false,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  ended_at timestamptz,
  cancel_reason text check (cancel_reason in ('requested', 'payment_failed', 'replaced', 'admin', 'incomplete')),
  pending_plan_id text references public.billing_catalog(id),
  method_id uuid,
  coupon_code text,
  -- Invoices the coupon still applies to: null = all of them (forever), 0 = none left.
  discount_left smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index billing_subscriptions_live on public.billing_subscriptions (account_id, family)
  where status in ('incomplete', 'trialing', 'active', 'past_due');
create index billing_subscriptions_due on public.billing_subscriptions (current_period_end)
  where status in ('trialing', 'active');

create sequence public.billing_invoice_number;

-- ======================================================================================================
-- Stable payments setup (who the money goes to) and clients
-- ======================================================================================================
create table public.billing_merchants (
  stable_id uuid primary key references public.member_stables(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'restricted')),
  legal_name text not null check (length(btrim(legal_name)) between 2 and 120),
  business_type text not null check (business_type in ('individual', 'company')),
  email text not null default '' check (length(email) <= 254),
  phone text not null default '' check (length(phone) <= 40),
  -- Shown on card statements (processors allow 22 characters).
  statement_name text not null check (length(btrim(statement_name)) between 2 and 22),
  payout jsonb not null default '{}' check (jsonb_typeof(payout) = 'object'),
  payout_ref text,
  invoice_prefix text not null check (invoice_prefix ~ '^[A-Z0-9]{2,8}$'),
  next_number integer not null default 1 check (next_number >= 1),
  terms_days integer not null default 15 check (terms_days between 0 and 120),
  default_memo text not null default '' check (length(default_memo) <= 1000),
  accept_card boolean not null default true,
  accept_bank boolean not null default true,
  terms_accepted_at timestamptz not null,
  terms_accepted_by uuid not null,
  provider text not null default 'test',
  test boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.billing_clients (
  id uuid primary key default gen_random_uuid(),
  stable_id uuid not null references public.member_stables(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  email text not null default '' check (length(email) <= 254),
  phone text not null default '' check (length(phone) <= 40),
  company text not null default '' check (length(company) <= 120),
  notes text not null default '' check (length(notes) <= 1000),
  archived boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index billing_clients_stable on public.billing_clients (stable_id, lower(name));
create unique index billing_clients_email on public.billing_clients (stable_id, lower(email))
  where email <> '' and not archived;

-- Who pays for each stable horse, and how much of it (basis points: 5000 = 50%). The rest is the stable's own.
create table public.billing_horse_owners (
  horse_id uuid not null references public.member_horses(id) on delete cascade,
  client_id uuid not null references public.billing_clients(id) on delete cascade,
  stable_id uuid not null references public.member_stables(id) on delete cascade,
  share_bps integer not null check (share_bps between 1 and 10000),
  primary key (horse_id, client_id)
);
create index billing_horse_owners_stable on public.billing_horse_owners (stable_id);

-- Work done for a horse or a client, waiting to be billed ("Bill owners" turns them into invoices).
create table public.billing_charges (
  id uuid primary key default gen_random_uuid(),
  stable_id uuid not null references public.member_stables(id) on delete cascade,
  horse_id uuid references public.member_horses(id) on delete set null,
  horse_name text not null default '' check (length(horse_name) <= 120),
  client_id uuid references public.billing_clients(id) on delete set null,
  category text not null check (category in ('training', 'board', 'vet', 'farrier', 'transport', 'race_fees', 'jockey',
                                             'supplies', 'breeding', 'sale', 'other', 'credit')),
  description text not null check (length(btrim(description)) between 1 and 200),
  quantity numeric(10, 2) not null check (quantity > 0 and quantity <= 10000),
  unit_cents bigint not null check (unit_cents between -100000000 and 100000000),
  amount_cents bigint not null,
  service_on date not null,
  status text not null default 'unbilled' check (status in ('unbilled', 'billed')),
  billed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (category = 'credit' or unit_cents >= 0),
  check (category <> 'credit' or unit_cents <= 0)
);
create index billing_charges_stable on public.billing_charges (stable_id, status, service_on desc);

-- ======================================================================================================
-- Invoices, lines, payments, refunds, payouts, ledger, events
-- ======================================================================================================
create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  number text,
  issuer text not null check (issuer in ('stayblz', 'stable')),
  stable_id uuid,
  kind text not null check (kind in ('subscription', 'purchase', 'stable')),
  account_id uuid,
  client_id uuid,
  bill_to jsonb not null default '{}' check (jsonb_typeof(bill_to) = 'object'),
  subscription_id uuid,
  period_index integer,
  catalog_id text,
  target jsonb,
  status text not null default 'draft' check (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
  currency text not null default 'usd' check (currency = 'usd'),
  subtotal_cents bigint not null default 0,
  discount_cents bigint not null default 0 check (discount_cents >= 0),
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 2500),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  total_cents bigint not null default 0,
  amount_paid_cents bigint not null default 0 check (amount_paid_cents >= 0),
  amount_refunded_cents bigint not null default 0 check (amount_refunded_cents >= 0),
  allow_card boolean not null default true,
  allow_bank boolean not null default true,
  memo text not null default '' check (length(memo) <= 1000),
  coupon_code text,
  due_on date,
  issued_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  pay_token text unique,
  -- Automatic collection (subscription renewals, client autopay) and its retries.
  auto_collect boolean not null default false,
  attempts smallint not null default 0,
  next_attempt_at timestamptz,
  lock_until timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((issuer = 'stable') = (stable_id is not null)),
  check ((issuer = 'stable') = (kind = 'stable')),
  check (status = 'draft' or total_cents >= 0),
  check (amount_paid_cents <= greatest(total_cents, 0)),
  check (amount_refunded_cents <= amount_paid_cents),
  check (status = 'draft' or number is not null)
);
-- Numbers are unique per issuer: Stayblz's own (SBZ-2026-000001) and each stable's (prefix-0001).
create unique index billing_invoices_number on public.billing_invoices (coalesce(stable_id::text, 'stayblz'), number)
  where number is not null;
create index billing_invoices_account on public.billing_invoices (account_id, created_at desc);
create index billing_invoices_stable on public.billing_invoices (stable_id, created_at desc) where stable_id is not null;
create index billing_invoices_subscription on public.billing_invoices (subscription_id, created_at desc) where subscription_id is not null;
create index billing_invoices_collect on public.billing_invoices (next_attempt_at) where status = 'open' and auto_collect;
create index billing_invoices_email on public.billing_invoices (lower(bill_to ->> 'email')) where issuer = 'stable';

create table public.billing_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.billing_invoices(id) on delete cascade,
  position smallint not null check (position between 0 and 199),
  category text not null check (length(category) between 2 and 20),
  description text not null check (length(btrim(description)) between 1 and 200),
  quantity numeric(10, 2) not null check (quantity > 0 and quantity <= 10000),
  unit_cents bigint not null check (unit_cents between -100000000 and 100000000),
  -- The owner's share of the work this line bills (null = all of it).
  share_bps integer check (share_bps between 1 and 10000),
  taxable boolean not null default false,
  amount_cents bigint not null,
  horse_id uuid,
  horse_name text not null default '' check (length(horse_name) <= 120),
  service_on date,
  charge_id uuid
);
create index billing_invoice_lines_invoice on public.billing_invoice_lines (invoice_id, position);
create index billing_invoice_lines_charge on public.billing_invoice_lines (charge_id) where charge_id is not null;

create table public.billing_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.billing_invoices(id),
  stable_id uuid,
  account_id uuid,
  -- card = online card, bank = bank transfer (ACH), keyed = card typed in by the stable (phone), reader = in person,
  -- offline = cash / cheque / other money the stable received outside Stayblz (recorded, no fee, no processor).
  channel text not null check (channel in ('card', 'bank', 'keyed', 'reader', 'offline')),
  method_id uuid,
  method jsonb not null default '{}' check (jsonb_typeof(method) = 'object'),
  offline_kind text check (offline_kind in ('cash', 'check', 'bank_transfer', 'other')),
  reference text not null default '' check (length(reference) <= 80),
  amount_cents bigint not null check (amount_cents > 0),
  fee_cents bigint not null default 0 check (fee_cents >= 0),
  cost_cents bigint not null default 0 check (cost_cents >= 0),
  currency text not null default 'usd',
  status text not null check (status in ('pending', 'processing', 'succeeded', 'failed')),
  failure_code text,
  failure_message text,
  provider text not null default 'test',
  provider_ref text,
  test boolean not null default true,
  auto boolean not null default false,
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 120),
  settles_at timestamptz,
  amount_refunded_cents bigint not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check (fee_cents <= amount_cents),
  check (amount_refunded_cents between 0 and amount_cents),
  check ((channel = 'offline') = (offline_kind is not null))
);
-- The double-charge guard: at most one payment in flight per invoice.
create unique index billing_payments_in_flight on public.billing_payments (invoice_id) where status in ('pending', 'processing');
create index billing_payments_invoice on public.billing_payments (invoice_id, created_at desc);
create index billing_payments_stable on public.billing_payments (stable_id, created_at desc) where stable_id is not null;
create index billing_payments_account on public.billing_payments (account_id, created_at desc) where account_id is not null;
create index billing_payments_recent on public.billing_payments (created_at desc);
create index billing_payments_settle on public.billing_payments (settles_at) where status = 'processing';

create table public.billing_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.billing_payments(id),
  invoice_id uuid not null,
  stable_id uuid,
  amount_cents bigint not null check (amount_cents > 0),
  reason text not null check (reason in ('requested_by_customer', 'duplicate', 'fraudulent', 'service_issue', 'other')),
  note text not null default '' check (length(note) <= 300),
  status text not null check (status in ('pending', 'succeeded', 'failed')),
  provider_ref text,
  failure_message text,
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 120),
  created_by uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index billing_refunds_payment on public.billing_refunds (payment_id);

create table public.billing_payouts (
  id uuid primary key default gen_random_uuid(),
  stable_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null check (status in ('pending', 'paid', 'failed')),
  destination jsonb not null default '{}',
  provider_ref text,
  failure_message text,
  idempotency_key text not null unique check (length(idempotency_key) between 8 and 120),
  arrives_on date,
  test boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index billing_payouts_stable on public.billing_payouts (stable_id, created_at desc);

-- Where the money is. A stable's balance = the sum of its rows (available once available_at has passed).
create table public.billing_ledger (
  id bigint generated always as identity primary key,
  holder text not null check (holder in ('platform', 'stable')),
  stable_id uuid,
  entry text not null check (entry in ('payment', 'fee', 'fee_income', 'sale', 'refund', 'payout', 'payout_reversal', 'adjustment')),
  amount_cents bigint not null,
  invoice_id uuid,
  payment_id uuid,
  refund_id uuid,
  payout_id uuid,
  available_at timestamptz not null default now(),
  test boolean not null default true,
  created_at timestamptz not null default now(),
  check ((holder = 'stable') = (stable_id is not null))
);
create index billing_ledger_stable on public.billing_ledger (stable_id, available_at) where stable_id is not null;
create index billing_ledger_platform on public.billing_ledger (created_at) where holder = 'platform';

create table public.billing_grants (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  feature text not null check (feature ~ '^[a-z][a-z0-9_.]{2,39}$'),
  reason text not null default '' check (length(reason) <= 200),
  ends_at timestamptz,
  revoked_at timestamptz,
  granted_by uuid,
  created_at timestamptz not null default now()
);
create index billing_grants_account on public.billing_grants (account_id) where revoked_at is null;

-- Client autopay: "pay this stable's bills automatically with this card / bank".
create table public.billing_autopay (
  account_id uuid not null references public.accounts(id) on delete cascade,
  stable_id uuid not null references public.member_stables(id) on delete cascade,
  method_id uuid not null references public.billing_methods(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, stable_id)
);

create table public.billing_events (
  id bigint generated always as identity primary key,
  actor_id uuid,
  account_id uuid,
  stable_id uuid,
  invoice_id uuid,
  payment_id uuid,
  event text not null check (event ~ '^[a-z][a-z_.]{2,59}$'),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4096),
  created_at timestamptz not null default now()
);
create index billing_events_recent on public.billing_events (created_at desc, id desc);
create index billing_events_invoice on public.billing_events (invoice_id, created_at) where invoice_id is not null;

create or replace function public.billing_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger billing_ledger_append_only before update or delete on public.billing_ledger
  for each row execute function public.billing_append_only();
create trigger billing_events_append_only before update or delete on public.billing_events
  for each row execute function public.billing_append_only();

-- Every billing table: row level security on, nothing for browser roles, the API's service role only.
do $$
declare t text;
begin
  foreach t in array array['billing_settings', 'billing_catalog', 'billing_profiles', 'billing_methods', 'billing_coupons',
    'billing_coupon_redemptions', 'billing_subscriptions', 'billing_merchants', 'billing_clients', 'billing_horse_owners',
    'billing_charges', 'billing_invoices', 'billing_invoice_lines', 'billing_payments', 'billing_refunds', 'billing_payouts',
    'billing_ledger', 'billing_grants', 'billing_autopay', 'billing_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;
revoke all on sequence public.billing_invoice_number from public, anon, authenticated;
grant usage on sequence public.billing_invoice_number to service_role;

-- ======================================================================================================
-- Helpers: events, JSON shapes, totals
-- ======================================================================================================
create or replace function public.billing_event(p_actor uuid, p_account uuid, p_stable uuid, p_invoice uuid, p_payment uuid,
  p_event text, p_detail jsonb default '{}') returns void
language sql security definer set search_path = '' as $$
  insert into public.billing_events (actor_id, account_id, stable_id, invoice_id, payment_id, event, detail)
  values (p_actor, p_account, p_stable, p_invoice, p_payment, p_event, coalesce(p_detail, '{}'))
$$;

create or replace function public.billing_payment_json(p public.billing_payments) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'invoiceId', p.invoice_id, 'stableId', p.stable_id, 'channel', p.channel,
    'method', p.method - 'ref', 'offlineKind', p.offline_kind, 'reference', p.reference,
    'amount', p.amount_cents, 'fee', p.fee_cents, 'net', p.amount_cents - p.fee_cents, 'refunded', p.amount_refunded_cents,
    'status', p.status, 'failureCode', p.failure_code, 'failureMessage', p.failure_message, 'test', p.test, 'auto', p.auto,
    'createdAt', p.created_at, 'finishedAt', p.finished_at, 'settlesAt', p.settles_at)
$$;

create or replace function public.billing_invoice_json(i public.billing_invoices, p_lines boolean default true) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'number', i.number, 'issuer', i.issuer, 'kind', i.kind, 'status', i.status,
    'stableId', i.stable_id,
    'stableName', (select s.name from public.member_stables s where s.id = i.stable_id),
    'from', case when i.issuer = 'stable' then (select jsonb_build_object('name', m.legal_name, 'email', m.email, 'phone', m.phone)
                                                 from public.billing_merchants m where m.stable_id = i.stable_id)
                 else jsonb_build_object('name', 'Stayblz', 'email', '', 'phone', '') end,
    'billTo', i.bill_to, 'clientId', i.client_id, 'accountId', i.account_id,
    'subscriptionId', i.subscription_id, 'catalogId', i.catalog_id, 'target', i.target,
    'currency', i.currency, 'subtotal', i.subtotal_cents, 'discount', i.discount_cents, 'couponCode', i.coupon_code,
    'taxRateBps', i.tax_rate_bps, 'tax', i.tax_cents, 'total', i.total_cents,
    'paid', i.amount_paid_cents, 'refunded', i.amount_refunded_cents,
    'due', case when i.status = 'open' then greatest(i.total_cents - i.amount_paid_cents, 0) else 0 end,
    'allowCard', i.allow_card, 'allowBank', i.allow_bank, 'memo', i.memo,
    'dueOn', i.due_on, 'issuedAt', i.issued_at, 'paidAt', i.paid_at, 'voidedAt', i.voided_at,
    'periodStart', i.period_start, 'periodEnd', i.period_end,
    'autoCollect', i.auto_collect, 'attempts', i.attempts, 'nextAttemptAt', i.next_attempt_at,
    'inFlight', exists (select 1 from public.billing_payments p where p.invoice_id = i.id and p.status in ('pending', 'processing')),
    'test', true,
    'createdAt', i.created_at, 'updatedAt', i.updated_at,
    'lines', case when p_lines then coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'category', l.category, 'description', l.description, 'quantity', l.quantity, 'unit', l.unit_cents,
        'shareBps', l.share_bps, 'taxable', l.taxable, 'amount', l.amount_cents, 'horseId', l.horse_id,
        'horseName', l.horse_name, 'serviceOn', l.service_on, 'chargeId', l.charge_id) order by l.position)
      from public.billing_invoice_lines l where l.invoice_id = i.id), '[]') end)
$$;

create or replace function public.billing_sub_json(s public.billing_subscriptions) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', s.id, 'planId', s.plan_id, 'family', s.family, 'status', s.status,
    'plan', (select jsonb_build_object('name', c.name, 'features', c.features, 'interval', c.interval) from public.billing_catalog c where c.id = s.plan_id),
    'amount', s.amount_cents, 'interval', s.interval,
    'currentPeriodStart', s.current_period_start, 'currentPeriodEnd', s.current_period_end, 'trialEnd', s.trial_end,
    'cancelAtPeriodEnd', s.cancel_at_period_end, 'canceledAt', s.canceled_at, 'endedAt', s.ended_at, 'cancelReason', s.cancel_reason,
    'pendingPlanId', s.pending_plan_id,
    'pendingPlan', (select jsonb_build_object('name', c.name, 'amount', c.amount_cents, 'interval', c.interval) from public.billing_catalog c where c.id = s.pending_plan_id),
    'methodId', s.method_id, 'couponCode', s.coupon_code, 'discountLeft', s.discount_left, 'createdAt', s.created_at,
    'openInvoice', (select public.billing_invoice_json(i, false) from public.billing_invoices i
                    where i.subscription_id = s.id and i.status = 'open' order by i.created_at desc limit 1))
$$;

-- Line amount = quantity x unit price x share, rounded to the cent (half away from zero).
create or replace function public.billing_line_amount(p_quantity numeric, p_unit bigint, p_share integer) returns bigint
language sql immutable set search_path = '' as $$
  select round(p_quantity * p_unit * coalesce(p_share, 10000) / 10000.0)::bigint
$$;

-- Recompute a draft invoice's totals from its lines.
create or replace function public.billing_invoice_recalc(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_sub bigint; v_taxable bigint; v_rate integer; v_disc bigint;
begin
  select coalesce(sum(l.amount_cents), 0), coalesce(sum(l.amount_cents) filter (where l.taxable), 0) into v_sub, v_taxable
    from public.billing_invoice_lines l where l.invoice_id = p_invoice;
  select i.tax_rate_bps, i.discount_cents into v_rate, v_disc from public.billing_invoices i where i.id = p_invoice;
  update public.billing_invoices set
    subtotal_cents = v_sub,
    tax_cents = case when v_taxable > 0 then (v_taxable * v_rate + 5000) / 10000 else 0 end,
    total_cents = v_sub - least(v_disc, greatest(v_sub, 0)) + case when v_taxable > 0 then (v_taxable * v_rate + 5000) / 10000 else 0 end,
    updated_at = now()
  where id = p_invoice;
end $$;

-- What a person can use right now: features from live subscriptions and staff grants.
create or replace function public.billing_features(p_account uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct f order by f), '{}') from (
    select unnest(c.features) f
      from public.billing_subscriptions s join public.billing_catalog c on c.id = s.plan_id
     where s.account_id = p_account and s.status in ('trialing', 'active', 'past_due')
    union
    select g.feature from public.billing_grants g
     where g.account_id = p_account and g.revoked_at is null and (g.ends_at is null or g.ends_at > now())
  ) x
$$;

-- ======================================================================================================
-- Billing alerts (saved in the bell list, pushed like racing alerts)
-- ======================================================================================================
alter table public.chat_alerts drop constraint if exists chat_alerts_kind_check;
alter table public.chat_alerts add constraint chat_alerts_kind_check check (kind in (
  'message', 'request', 'mention', 'reply', 'reaction', 'group_added', 'friend_request', 'friend_accepted',
  'request_accepted', 'race_entry', 'race_scratch', 'race_result', 'workout', 'billing'));

create or replace function public.chat_alert_allowed(n public.notification_settings, p_kind text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(n.enabled, false) and case
    when p_kind in ('message', 'group_added') then n.chat_messages
    when p_kind in ('request', 'friend_request', 'friend_accepted', 'request_accepted') then n.chat_requests
    when p_kind in ('mention', 'reply') then n.chat_mentions
    when p_kind = 'reaction' then n.chat_reactions
    when p_kind in ('race_entry', 'race_scratch', 'race_result', 'workout', 'billing') then true
    else false end
$$;

-- Same as 202611190004, plus 'billing' among the kinds only newer apps show (racing=1).
create or replace function public.chat_alerts_list(p_user uuid, p_since timestamptz, p_limit integer,
  p_racing boolean default false) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(public.chat_alert_out(a) order by a.created_at desc)
      from public.chat_alerts a
      where a.id in (
        select b.id from public.chat_alerts b
        where b.user_id = p_user and (p_since is null or b.created_at > p_since)
          and (coalesce(p_racing, false) or b.kind not in ('race_entry', 'race_scratch', 'race_result', 'workout', 'billing'))
          and (b.chat_kind is distinct from 'team' or exists (
            select 1 from public.stable_memberships sm where sm.stable_id = b.stable_id and sm.user_id = p_user))
        order by b.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 50))), '[]'),
    'unread', (select count(*) from public.chat_alerts a where a.user_id = p_user and a.read_at is null
      and (coalesce(p_racing, false) or a.kind not in ('race_entry', 'race_scratch', 'race_result', 'workout', 'billing'))
      and (a.chat_kind is distinct from 'team' or exists (
        select 1 from public.stable_memberships sm where sm.stable_id = a.stable_id and sm.user_id = p_user))))
$$;

-- Saves one billing alert per person and returns {alerts, targets} for push (lib/billing/alerts.ts).
create or replace function public.billing_alert(p_users uuid[], p_title text, p_body text, p_link text, p_ref uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid; new_id uuid; alerts jsonb := '[]';
begin
  foreach u in array coalesce(p_users, '{}') loop
    if not exists (select 1 from public.accounts a where a.id = u and a.status = 'active') then continue; end if;
    insert into public.chat_alerts (user_id, kind, message_id, actor_name, chat_title, body, link)
    values (u, 'billing', p_ref, 'Stayblz Billing', left(p_title, 120), left(coalesce(p_body, ''), 300),
            case when p_link ~ '^/[A-Za-z0-9]' then left(p_link, 300) end)
    returning id into new_id;
    delete from public.chat_alerts where user_id = u and (created_at < now() - interval '30 days' or id in (
      select id from public.chat_alerts where user_id = u order by created_at desc offset 200));
    alerts := alerts || (select jsonb_build_array(public.chat_alert_out(x) || jsonb_build_object('userId', x.user_id))
                           from public.chat_alerts x where x.id = new_id);
  end loop;
  return jsonb_build_object('alerts', alerts, 'targets', public.chat_alert_targets(alerts));
end $$;

-- Owners and managers of a stable: who hears about its payments.
create or replace function public.billing_stable_staff(p_stable uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(user_id), '{}') from public.stable_memberships
   where stable_id = p_stable and role in ('owner', 'manager')
$$;

-- ======================================================================================================
-- Payments: start (lock + record) -> processor -> finish (apply). Offline payments finish at once.
-- ======================================================================================================
create or replace function public.billing_after_paid(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare inv public.billing_invoices; cat public.billing_catalog; days integer;
begin
  select * into inv from public.billing_invoices where id = p_invoice;
  if inv.kind = 'subscription' and inv.subscription_id is not null then
    update public.billing_subscriptions set
      status = 'active',
      periods = greatest(periods, coalesce(inv.period_index, periods)),
      current_period_start = inv.period_start,
      current_period_end = inv.period_end,
      updated_at = now()
    where id = inv.subscription_id and status in ('incomplete', 'trialing', 'active', 'past_due')
      and (current_period_end is null or inv.period_end >= current_period_end or status = 'incomplete');
  elsif inv.kind = 'purchase' then
    select * into cat from public.billing_catalog where id = inv.catalog_id;
    if cat.effect = 'marketplace_feature' and inv.target ? 'listingId' then
      days := cat.effect_days;
      update public.marketplace_listings
         set featured_until = greatest(coalesce(featured_until, now()), now()) + make_interval(days => days)
       where id = (inv.target ->> 'listingId')::uuid;
    end if;
  end if;
end $$;

create or replace function public.billing_pay_finish(p_payment uuid, p_status text, p_ref text, p_code text, p_message text,
  p_settles_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pay public.billing_payments; inv public.billing_invoices; s public.billing_settings; avail timestamptz; fully boolean := false;
begin
  select * into pay from public.billing_payments where id = p_payment for update;
  if not found then raise exception 'payment_not_found'; end if;
  if pay.status in ('succeeded', 'failed') then
    select * into inv from public.billing_invoices where id = pay.invoice_id;
    return jsonb_build_object('payment', public.billing_payment_json(pay), 'invoice', public.billing_invoice_json(inv, false),
                              'paid', inv.status = 'paid', 'already', true);
  end if;
  if p_status = 'processing' then
    update public.billing_payments set status = 'processing', provider_ref = coalesce(p_ref, provider_ref),
      settles_at = coalesce(p_settles_at, now()) where id = p_payment returning * into pay;
    select * into inv from public.billing_invoices where id = pay.invoice_id;
    perform public.billing_event(pay.created_by, pay.account_id, pay.stable_id, pay.invoice_id, pay.id, 'payment.processing',
      jsonb_build_object('amount', pay.amount_cents, 'channel', pay.channel));
    return jsonb_build_object('payment', public.billing_payment_json(pay), 'invoice', public.billing_invoice_json(inv, false), 'paid', false);
  end if;
  if p_status = 'failed' then
    update public.billing_payments set status = 'failed', provider_ref = coalesce(p_ref, provider_ref),
      failure_code = left(coalesce(p_code, 'processing_error'), 60), failure_message = left(p_message, 300), finished_at = now()
      where id = p_payment returning * into pay;
    select * into inv from public.billing_invoices where id = pay.invoice_id;
    perform public.billing_event(pay.created_by, pay.account_id, pay.stable_id, pay.invoice_id, pay.id, 'payment.failed',
      jsonb_build_object('amount', pay.amount_cents, 'channel', pay.channel, 'code', pay.failure_code));
    return jsonb_build_object('payment', public.billing_payment_json(pay), 'invoice', public.billing_invoice_json(inv, false), 'paid', false);
  end if;
  if p_status <> 'succeeded' then raise exception 'invalid_status'; end if;

  select * into inv from public.billing_invoices where id = pay.invoice_id for update;
  update public.billing_payments set status = 'succeeded', provider_ref = coalesce(p_ref, provider_ref), finished_at = now()
    where id = p_payment returning * into pay;
  fully := inv.amount_paid_cents + pay.amount_cents >= inv.total_cents;
  update public.billing_invoices set
    amount_paid_cents = amount_paid_cents + pay.amount_cents,
    status = case when fully then 'paid' else status end,
    paid_at = case when fully then now() else paid_at end,
    auto_collect = case when fully then false else auto_collect end,
    next_attempt_at = case when fully then null else next_attempt_at end,
    lock_until = null,
    updated_at = now()
  where id = inv.id returning * into inv;

  -- Money that passed through Stayblz goes on the ledger (offline money never did).
  if pay.channel <> 'offline' then
    select * into s from public.billing_settings where id;
    if inv.issuer = 'stable' then
      avail := now() + make_interval(days => s.payout_delay_days);
      insert into public.billing_ledger (holder, stable_id, entry, amount_cents, invoice_id, payment_id, available_at, test)
        values ('stable', inv.stable_id, 'payment', pay.amount_cents, inv.id, pay.id, avail, pay.test);
      if pay.fee_cents > 0 then
        insert into public.billing_ledger (holder, stable_id, entry, amount_cents, invoice_id, payment_id, available_at, test)
          values ('stable', inv.stable_id, 'fee', -pay.fee_cents, inv.id, pay.id, avail, pay.test);
        insert into public.billing_ledger (holder, entry, amount_cents, invoice_id, payment_id, test)
          values ('platform', 'fee_income', pay.fee_cents, inv.id, pay.id, pay.test);
      end if;
    else
      insert into public.billing_ledger (holder, entry, amount_cents, invoice_id, payment_id, test)
        values ('platform', 'sale', pay.amount_cents, inv.id, pay.id, pay.test);
    end if;
  end if;
  if fully then perform public.billing_after_paid(inv.id); end if;
  perform public.billing_event(pay.created_by, pay.account_id, pay.stable_id, inv.id, pay.id, 'payment.succeeded',
    jsonb_build_object('amount', pay.amount_cents, 'fee', pay.fee_cents, 'channel', pay.channel, 'paid', fully));
  select * into inv from public.billing_invoices where id = inv.id;
  return jsonb_build_object('payment', public.billing_payment_json(pay), 'invoice', public.billing_invoice_json(inv, false), 'paid', fully);
end $$;

-- p_amount null = the full amount due (online payments always pay in full; offline can record part of it).
create or replace function public.billing_pay_start(p_invoice uuid, p_payer uuid, p_channel text, p_method_id uuid,
  p_method jsonb, p_amount bigint, p_key text, p_actor uuid, p_auto boolean, p_offline_kind text, p_reference text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare inv public.billing_invoices; pay public.billing_payments; s public.billing_settings; due bigint; amt bigint;
begin
  if p_key is null or length(p_key) < 8 or length(p_key) > 120 then raise exception 'invalid_key'; end if;
  select * into pay from public.billing_payments where idempotency_key = p_key;
  if found then
    if pay.invoice_id <> p_invoice then raise exception 'idempotency_conflict'; end if;
    select * into inv from public.billing_invoices where id = pay.invoice_id;
    return jsonb_build_object('payment', public.billing_payment_json(pay), 'invoice', public.billing_invoice_json(inv, false),
                              'replayed', true, 'paid', inv.status = 'paid');
  end if;
  select * into inv from public.billing_invoices where id = p_invoice for update;
  if not found then raise exception 'invoice_not_found'; end if;
  if inv.status <> 'open' then raise exception 'invoice_not_payable'; end if;
  if exists (select 1 from public.billing_payments where invoice_id = p_invoice and status in ('pending', 'processing')) then
    raise exception 'payment_in_progress';
  end if;
  due := inv.total_cents - inv.amount_paid_cents;
  if due <= 0 then raise exception 'invoice_not_payable'; end if;
  amt := coalesce(p_amount, due);
  if amt <= 0 or amt > due then raise exception 'invalid_amount'; end if;
  if p_channel not in ('card', 'bank', 'keyed', 'reader', 'offline') then raise exception 'invalid_channel'; end if;
  if p_channel in ('keyed', 'reader', 'offline') and inv.issuer <> 'stable' then raise exception 'invalid_channel'; end if;
  if p_channel <> 'offline' and amt <> due then raise exception 'invalid_amount'; end if;
  if p_channel in ('card', 'keyed', 'reader') and not inv.allow_card then raise exception 'method_not_accepted'; end if;
  if p_channel = 'bank' and not inv.allow_bank then raise exception 'method_not_accepted'; end if;
  if p_channel <> 'offline' and amt < 50 then raise exception 'amount_too_small'; end if;
  if p_channel = 'offline' and (p_offline_kind is null or p_offline_kind not in ('cash', 'check', 'bank_transfer', 'other')) then
    raise exception 'invalid_channel';
  end if;
  select * into s from public.billing_settings where id;
  insert into public.billing_payments (invoice_id, stable_id, account_id, channel, method_id, method, offline_kind, reference,
    amount_cents, fee_cents, cost_cents, status, provider, test, auto, idempotency_key, created_by)
  values (inv.id, inv.stable_id, p_payer, p_channel, p_method_id, coalesce(p_method, '{}'),
    case when p_channel = 'offline' then p_offline_kind end, left(coalesce(p_reference, ''), 80),
    amt, case when inv.issuer = 'stable' then public.billing_rate(s.fees, p_channel, amt) else 0 end,
    public.billing_rate(s.costs, p_channel, amt), 'pending', case when p_channel = 'offline' then 'offline' else 'test' end,
    s.mode = 'test', coalesce(p_auto, false), p_key, p_actor)
  returning * into pay;
  if p_channel = 'offline' then
    return public.billing_pay_finish(pay.id, 'succeeded', null, null, null, null) || jsonb_build_object('replayed', false);
  end if;
  return jsonb_build_object('payment', public.billing_payment_json(pay), 'invoice', public.billing_invoice_json(inv, false),
                            'replayed', false, 'paid', false,
                            'charge', jsonb_build_object('amount', pay.amount_cents, 'currency', pay.currency, 'key', pay.id));
end $$;

-- Payments stuck in "pending" (the API stopped between the processor call and finish): ask the processor again.
create or replace function public.billing_stale_claim(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb := '[]'; p public.billing_payments;
begin
  for p in select * from public.billing_payments
            where status = 'pending' and created_at < now() - interval '2 minutes'
              and (settles_at is null or settles_at < now())
            order by created_at limit least(greatest(coalesce(p_limit, 20), 1), 100) for update skip locked loop
    -- settles_at doubles as "don't look again before" for pending payments.
    update public.billing_payments set settles_at = now() + interval '2 minutes' where id = p.id;
    out := out || jsonb_build_array(jsonb_build_object('id', p.id, 'channel', p.channel, 'amount', p.amount_cents,
      'currency', p.currency, 'method', p.method, 'methodId', p.method_id, 'auto', p.auto, 'invoiceId', p.invoice_id));
  end loop;
  return out;
end $$;

-- Bank payments whose clearing time has come.
create or replace function public.billing_settle_claim(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb := '[]'; p public.billing_payments;
begin
  for p in select * from public.billing_payments where status = 'processing' and settles_at <= now()
            order by settles_at limit least(greatest(coalesce(p_limit, 20), 1), 100) for update skip locked loop
    update public.billing_payments set settles_at = now() + interval '2 minutes' where id = p.id;
    out := out || jsonb_build_array(jsonb_build_object('id', p.id, 'providerRef', p.provider_ref, 'auto', p.auto,
      'invoiceId', p.invoice_id));
  end loop;
  return out;
end $$;

-- ======================================================================================================
-- Subscriptions
-- ======================================================================================================
create or replace function public.billing_period_end(p_anchor timestamptz, p_interval text, p_n integer) returns timestamptz
language sql stable set search_path = '' as $$
  select p_anchor + case when p_interval = 'year' then make_interval(years => p_n) else make_interval(months => p_n) end
$$;

-- Creates (and numbers) the invoice for a subscription's next period. Applies the coupon while it lasts.
create or replace function public.billing_sub_invoice(p_sub uuid, p_auto boolean) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.billing_subscriptions; c public.billing_coupons; cat public.billing_catalog; inv_id uuid;
  k integer; p_start timestamptz; p_end timestamptz; disc bigint := 0; prof public.billing_profiles; acct record;
begin
  select * into s from public.billing_subscriptions where id = p_sub for update;
  select * into cat from public.billing_catalog where id = s.plan_id;
  k := s.periods + 1;
  p_start := public.billing_period_end(s.anchor_at, s.interval, k - 1);
  p_end := public.billing_period_end(s.anchor_at, s.interval, k);
  if s.coupon_code is not null and (s.discount_left is null or s.discount_left > 0) then
    select * into c from public.billing_coupons where code = s.coupon_code;
    if found then
      disc := case when c.percent_off is not null then (s.amount_cents::bigint * c.percent_off + 50) / 100
                   else least(c.amount_off_cents, s.amount_cents) end;
      update public.billing_subscriptions set discount_left = case when discount_left is null then null else discount_left - 1 end
        where id = s.id;
    end if;
  end if;
  select * into prof from public.billing_profiles where account_id = s.account_id;
  select a.email, btrim(a.first_name || ' ' || a.last_name) as name into acct from public.accounts a where a.id = s.account_id;
  insert into public.billing_invoices (number, issuer, kind, account_id, bill_to, subscription_id, period_index, catalog_id,
    status, subtotal_cents, discount_cents, total_cents, coupon_code, due_on, issued_at, period_start, period_end,
    auto_collect, next_attempt_at, allow_card, allow_bank)
  values ('SBZ-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.billing_invoice_number')::text, 6, '0'),
    'stayblz', 'subscription', s.account_id,
    jsonb_build_object('name', coalesce(nullif(prof.name, ''), acct.name, ''), 'email', coalesce(nullif(prof.email, ''), acct.email, ''),
      'line1', coalesce(prof.line1, ''), 'line2', coalesce(prof.line2, ''), 'city', coalesce(prof.city, ''),
      'region', coalesce(prof.region, ''), 'postal', coalesce(prof.postal, ''), 'country', coalesce(prof.country, '')),
    s.id, k, s.plan_id, 'open', s.amount_cents, disc, s.amount_cents - disc, case when disc > 0 then s.coupon_code end,
    greatest(p_start, now())::date, now(), p_start, p_end, p_auto, case when p_auto then now() end, true, true)
  returning id into inv_id;
  insert into public.billing_invoice_lines (invoice_id, position, category, description, quantity, unit_cents, amount_cents)
  values (inv_id, 0, 'subscription',
    left(cat.name || ' (' || to_char(p_start, 'Mon FMDD, YYYY') || ' - ' || to_char(p_end, 'Mon FMDD, YYYY') || ')', 200),
    1, s.amount_cents, s.amount_cents);
  if s.amount_cents - disc <= 0 then
    update public.billing_invoices set status = 'paid', paid_at = now(), auto_collect = false, next_attempt_at = null where id = inv_id;
    perform public.billing_after_paid(inv_id);
  end if;
  return inv_id;
end $$;

create or replace function public.billing_subscribe(p_account uuid, p_plan text, p_method uuid, p_coupon text, p_actor uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare plan public.billing_catalog; s public.billing_subscriptions; old public.billing_subscriptions; c public.billing_coupons;
  trial boolean; disc_left smallint; inv_id uuid; inv public.billing_invoices; v_code text := upper(btrim(coalesce(p_coupon, '')));
begin
  select * into plan from public.billing_catalog where id = p_plan;
  if not found or plan.kind <> 'plan' or plan.status <> 'active' then raise exception 'plan_unavailable'; end if;
  -- One subscribe at a time per person.
  perform 1 from public.accounts where id = p_account for update;
  if not found then raise exception 'unknown_account'; end if;
  -- A first payment that failed earlier is replaced by this new try.
  for old in select * from public.billing_subscriptions where account_id = p_account and family = plan.family and status = 'incomplete' loop
    if exists (select 1 from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
                where i.subscription_id = old.id and p.status in ('pending', 'processing')) then
      raise exception 'payment_in_progress';
    end if;
    update public.billing_subscriptions set status = 'canceled', ended_at = now(), cancel_reason = 'replaced', updated_at = now()
      where id = old.id;
    update public.billing_invoices set status = 'void', voided_at = now(), auto_collect = false, updated_at = now()
      where subscription_id = old.id and status = 'open';
    if old.coupon_code is not null then
      delete from public.billing_coupon_redemptions where code = old.coupon_code and account_id = p_account and subscription_id = old.id;
      update public.billing_coupons set redeemed = greatest(redeemed - 1, 0) where code = old.coupon_code;
    end if;
  end loop;
  if exists (select 1 from public.billing_subscriptions where account_id = p_account and family = plan.family
               and status in ('trialing', 'active', 'past_due')) then
    raise exception 'already_subscribed';
  end if;
  if not exists (select 1 from public.billing_methods where id = p_method and account_id = p_account and status = 'active') then
    raise exception 'method_not_found';
  end if;
  if v_code <> '' then
    select * into c from public.billing_coupons where code = v_code for update;
    if not found or not c.active or (c.expires_at is not null and c.expires_at <= now())
       or (c.max_redemptions is not null and c.redeemed >= c.max_redemptions)
       or (cardinality(c.applies_to) > 0 and not plan.id = any(c.applies_to))
       or exists (select 1 from public.billing_coupon_redemptions r where r.code = c.code and r.account_id = p_account) then
      raise exception 'coupon_invalid';
    end if;
    disc_left := case c.duration when 'once' then 1 when 'repeating' then c.duration_months else null end;
  end if;
  -- A free trial only once per family.
  trial := plan.trial_days > 0 and not exists (
    select 1 from public.billing_subscriptions where account_id = p_account and family = plan.family
      and (status <> 'canceled' or cancel_reason is distinct from 'replaced'));
  insert into public.billing_subscriptions (account_id, plan_id, family, status, amount_cents, interval, anchor_at,
    current_period_start, current_period_end, trial_end, method_id, coupon_code, discount_left)
  values (p_account, plan.id, plan.family, case when trial then 'trialing' else 'incomplete' end, plan.amount_cents, plan.interval,
    case when trial then now() + make_interval(days => plan.trial_days) else now() end,
    case when trial then now() end, case when trial then now() + make_interval(days => plan.trial_days) end,
    case when trial then now() + make_interval(days => plan.trial_days) end, p_method,
    case when v_code <> '' then c.code end, case when v_code <> '' then disc_left else 0 end)
  returning * into s;
  if v_code <> '' then
    insert into public.billing_coupon_redemptions (code, account_id, subscription_id) values (c.code, p_account, s.id);
    update public.billing_coupons set redeemed = redeemed + 1 where code = c.code;
  end if;
  update public.billing_profiles set default_method_id = coalesce(default_method_id, p_method) where account_id = p_account;
  perform public.billing_event(p_actor, p_account, null, null, null, case when trial then 'subscription.trial_started' else 'subscription.started' end,
    jsonb_build_object('plan', plan.id, 'amount', plan.amount_cents, 'coupon', nullif(v_code, '')));
  if trial then
    return jsonb_build_object('subscription', public.billing_sub_json(s), 'invoice', null);
  end if;
  inv_id := public.billing_sub_invoice(s.id, false);
  select * into inv from public.billing_invoices where id = inv_id;
  select * into s from public.billing_subscriptions where id = s.id;
  return jsonb_build_object('subscription', public.billing_sub_json(s), 'invoice', public.billing_invoice_json(inv, true));
end $$;

-- Renewals: end what was cancelled, start next periods (the invoice is then collected by the API).
create or replace function public.billing_cycle(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.billing_subscriptions; nxt public.billing_catalog; created jsonb := '[]'; ended jsonb := '[]'; trials jsonb := '[]';
  inv_id uuid; n integer := least(greatest(coalesce(p_limit, 50), 1), 500);
begin
  for s in select * from public.billing_subscriptions
            where status in ('active', 'trialing') and current_period_end <= now()
            order by current_period_end limit n for update skip locked loop
    if s.cancel_at_period_end then
      update public.billing_subscriptions set status = 'canceled', ended_at = s.current_period_end,
        canceled_at = coalesce(canceled_at, now()), cancel_reason = coalesce(cancel_reason, 'requested'), updated_at = now()
        where id = s.id;
      perform public.billing_event(null, s.account_id, null, null, null, 'subscription.ended', jsonb_build_object('plan', s.plan_id));
      ended := ended || jsonb_build_array(jsonb_build_object('id', s.id, 'accountId', s.account_id, 'planId', s.plan_id));
      continue;
    end if;
    if exists (select 1 from public.billing_invoices where subscription_id = s.id and status = 'open') then continue; end if;
    if s.pending_plan_id is not null then
      select * into nxt from public.billing_catalog where id = s.pending_plan_id;
      if found and nxt.status = 'active' and nxt.kind = 'plan' and nxt.family = s.family then
        update public.billing_subscriptions set plan_id = nxt.id, amount_cents = nxt.amount_cents, interval = nxt.interval,
          anchor_at = s.current_period_end, periods = 0, pending_plan_id = null, updated_at = now() where id = s.id;
        perform public.billing_event(null, s.account_id, null, null, null, 'subscription.plan_changed',
          jsonb_build_object('from', s.plan_id, 'to', nxt.id));
      else
        update public.billing_subscriptions set pending_plan_id = null where id = s.id;
      end if;
    end if;
    inv_id := public.billing_sub_invoice(s.id, true);
    created := created || jsonb_build_array(jsonb_build_object('invoiceId', inv_id, 'subscriptionId', s.id, 'accountId', s.account_id));
  end loop;
  -- A first payment never made: give up after a day.
  for s in select * from public.billing_subscriptions where status = 'incomplete' and created_at < now() - interval '1 day'
            and not exists (select 1 from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
                            where i.subscription_id = billing_subscriptions.id and p.status in ('pending', 'processing'))
            limit n for update skip locked loop
    update public.billing_subscriptions set status = 'canceled', ended_at = now(), cancel_reason = 'incomplete', updated_at = now()
      where id = s.id;
    update public.billing_invoices set status = 'void', voided_at = now(), auto_collect = false, updated_at = now()
      where subscription_id = s.id and status = 'open';
  end loop;
  -- Trials ending within 3 days: one reminder each.
  for s in select * from public.billing_subscriptions where status = 'trialing' and not trial_alerted
            and trial_end <= now() + interval '3 days' and trial_end > now() limit n for update skip locked loop
    update public.billing_subscriptions set trial_alerted = true where id = s.id;
    trials := trials || jsonb_build_array(jsonb_build_object('id', s.id, 'accountId', s.account_id, 'planId', s.plan_id,
      'trialEnd', s.trial_end, 'amount', s.amount_cents));
  end loop;
  return jsonb_build_object('created', created, 'ended', ended, 'trialsEnding', trials);
end $$;

-- Invoices to collect automatically now, with the card/bank to use (leased for 10 minutes).
create or replace function public.billing_collect_claim(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out jsonb := '[]'; i public.billing_invoices; mid uuid; m public.billing_methods;
begin
  for i in select * from public.billing_invoices
            where status = 'open' and auto_collect and next_attempt_at <= now() and (lock_until is null or lock_until < now())
              and not exists (select 1 from public.billing_payments p where p.invoice_id = billing_invoices.id and p.status in ('pending', 'processing'))
            order by next_attempt_at limit least(greatest(coalesce(p_limit, 20), 1), 100) for update skip locked loop
    update public.billing_invoices set lock_until = now() + interval '10 minutes' where id = i.id;
    mid := null;
    if i.kind = 'subscription' then
      select coalesce((select s.method_id from public.billing_subscriptions s join public.billing_methods bm on bm.id = s.method_id
                        where s.id = i.subscription_id and bm.status = 'active'),
                      (select p.default_method_id from public.billing_profiles p join public.billing_methods bm on bm.id = p.default_method_id
                        where p.account_id = i.account_id and bm.status = 'active'))
        into mid;
    elsif i.kind = 'stable' and i.account_id is not null then
      select a.method_id into mid from public.billing_autopay a join public.billing_methods bm on bm.id = a.method_id
       where a.account_id = i.account_id and a.stable_id = i.stable_id and bm.status = 'active';
    end if;
    select * into m from public.billing_methods where id = mid;
    out := out || jsonb_build_array(jsonb_build_object('invoiceId', i.id, 'kind', i.kind, 'accountId', i.account_id,
      'stableId', i.stable_id, 'subscriptionId', i.subscription_id, 'attempts', i.attempts,
      'method', case when mid is null then null else jsonb_build_object('id', m.id, 'type', m.type, 'ref', m.provider_ref,
        'brand', m.brand, 'last4', m.last4, 'bankName', m.bank_name, 'expMonth', m.exp_month, 'expYear', m.exp_year) end));
  end loop;
  return out;
end $$;

-- An automatic attempt failed: retry after 1, 2 and 4 days, then stop (a subscription is then cancelled).
create or replace function public.billing_collect_failed(p_invoice uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare i public.billing_invoices; final boolean; sub_status text;
begin
  select * into i from public.billing_invoices where id = p_invoice for update;
  if not found or i.status <> 'open' then return jsonb_build_object('skipped', true); end if;
  if exists (select 1 from public.billing_payments where invoice_id = p_invoice and status in ('pending', 'processing')) then
    update public.billing_invoices set lock_until = null where id = p_invoice;
    return jsonb_build_object('skipped', true);
  end if;
  final := i.attempts + 1 >= 4;
  update public.billing_invoices set
    attempts = attempts + 1,
    auto_collect = not final,
    next_attempt_at = case when final then null else now() + make_interval(days => case i.attempts when 0 then 1 when 1 then 2 else 4 end) end,
    status = case when final and kind = 'subscription' then 'uncollectible' else status end,
    lock_until = null, updated_at = now()
  where id = p_invoice returning * into i;
  if i.kind = 'subscription' then
    if final then
      update public.billing_subscriptions set status = 'canceled', ended_at = now(), canceled_at = now(),
        cancel_reason = 'payment_failed', updated_at = now()
        where id = i.subscription_id and status in ('active', 'trialing', 'past_due') returning status into sub_status;
    else
      update public.billing_subscriptions set status = 'past_due', updated_at = now()
        where id = i.subscription_id and status in ('active', 'trialing', 'past_due') returning status into sub_status;
    end if;
  end if;
  perform public.billing_event(null, i.account_id, i.stable_id, i.id, null, 'invoice.collect_failed',
    jsonb_build_object('attempt', i.attempts, 'final', final, 'code', left(p_code, 60)));
  return jsonb_build_object('invoice', public.billing_invoice_json(i, false), 'final', final, 'subscriptionStatus', sub_status,
    'nextAttemptAt', i.next_attempt_at);
end $$;

-- ======================================================================================================
-- One-time purchases (e.g. featuring a Marketplace listing)
-- ======================================================================================================
create or replace function public.billing_purchase(p_account uuid, p_product text, p_target jsonb, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cat public.billing_catalog; inv_id uuid; inv public.billing_invoices; prof public.billing_profiles; acct record; listing record;
  label text := '';
begin
  select * into cat from public.billing_catalog where id = p_product;
  if not found or cat.kind <> 'product' or cat.status <> 'active' then raise exception 'product_unavailable'; end if;
  if cat.effect = 'marketplace_feature' then
    if p_target is null or not (p_target ? 'listingId') then raise exception 'invalid_target'; end if;
    select l.id, l.name, l.seller_id into listing from public.marketplace_listings l where l.id::text = p_target ->> 'listingId';
    if not found then raise exception 'listing_not_found'; end if;
    if listing.seller_id <> p_account then raise exception 'not_your_listing'; end if;
    label := ': ' || listing.name;
  end if;
  -- Reuse an unpaid invoice for the same thing instead of piling up new ones.
  select * into inv from public.billing_invoices
   where account_id = p_account and kind = 'purchase' and catalog_id = cat.id and status = 'open' and target = p_target
   order by created_at desc limit 1 for update;
  if found then
    return jsonb_build_object('invoice', public.billing_invoice_json(inv, true), 'reused', true);
  end if;
  select * into prof from public.billing_profiles where account_id = p_account;
  select a.email, btrim(a.first_name || ' ' || a.last_name) as name into acct from public.accounts a where a.id = p_account;
  insert into public.billing_invoices (number, issuer, kind, account_id, bill_to, catalog_id, target, status, subtotal_cents,
    total_cents, due_on, issued_at, created_by)
  values ('SBZ-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.billing_invoice_number')::text, 6, '0'),
    'stayblz', 'purchase', p_account,
    jsonb_build_object('name', coalesce(nullif(prof.name, ''), acct.name, ''), 'email', coalesce(nullif(prof.email, ''), acct.email, '')),
    cat.id, p_target, 'open', cat.amount_cents, cat.amount_cents, now()::date, now(), p_actor)
  returning id into inv_id;
  insert into public.billing_invoice_lines (invoice_id, position, category, description, quantity, unit_cents, amount_cents)
  values (inv_id, 0, 'purchase', left(cat.name || label, 200), 1, cat.amount_cents, cat.amount_cents);
  select * into inv from public.billing_invoices where id = inv_id;
  perform public.billing_event(p_actor, p_account, null, inv_id, null, 'purchase.started', jsonb_build_object('product', cat.id));
  return jsonb_build_object('invoice', public.billing_invoice_json(inv, true), 'reused', false);
end $$;

-- ======================================================================================================
-- Refunds
-- ======================================================================================================
-- p_stable: the stable refunding its own client's payment; null = Stayblz refunding its own sale (admins).
create or replace function public.billing_refund_start(p_payment uuid, p_stable uuid, p_amount bigint, p_reason text, p_note text,
  p_key text, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pay public.billing_payments; r public.billing_refunds; pending bigint; amt bigint;
begin
  if p_key is null or length(p_key) < 8 or length(p_key) > 120 then raise exception 'invalid_key'; end if;
  select * into r from public.billing_refunds where idempotency_key = p_key;
  if found then
    if r.payment_id <> p_payment then raise exception 'idempotency_conflict'; end if;
    return jsonb_build_object('refund', to_jsonb(r), 'replayed', true);
  end if;
  select * into pay from public.billing_payments where id = p_payment for update;
  if not found then raise exception 'payment_not_found'; end if;
  if p_stable is null and pay.stable_id is not null then raise exception 'payment_not_found'; end if;
  if p_stable is not null and pay.stable_id is distinct from p_stable then raise exception 'payment_not_found'; end if;
  if pay.status <> 'succeeded' then raise exception 'not_refundable'; end if;
  if p_reason not in ('requested_by_customer', 'duplicate', 'fraudulent', 'service_issue', 'other') then raise exception 'invalid_reason'; end if;
  select coalesce(sum(amount_cents), 0) into pending from public.billing_refunds where payment_id = p_payment and status = 'pending';
  amt := coalesce(p_amount, pay.amount_cents - pay.amount_refunded_cents - pending);
  if amt <= 0 then raise exception 'not_refundable'; end if;
  if amt > pay.amount_cents - pay.amount_refunded_cents - pending then raise exception 'refund_too_large'; end if;
  insert into public.billing_refunds (payment_id, invoice_id, stable_id, amount_cents, reason, note, status, idempotency_key, created_by)
  values (pay.id, pay.invoice_id, pay.stable_id, amt, p_reason, left(coalesce(p_note, ''), 300), 'pending', p_key, p_actor)
  returning * into r;
  return jsonb_build_object('refund', to_jsonb(r), 'replayed', false, 'channel', pay.channel, 'paymentRef', pay.provider_ref,
    'offline', pay.channel = 'offline');
end $$;

create or replace function public.billing_refund_finish(p_refund uuid, p_ok boolean, p_ref text, p_message text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.billing_refunds; pay public.billing_payments; inv public.billing_invoices;
begin
  select * into r from public.billing_refunds where id = p_refund for update;
  if not found then raise exception 'refund_not_found'; end if;
  if r.status <> 'pending' then return jsonb_build_object('refund', to_jsonb(r), 'already', true); end if;
  if not p_ok then
    update public.billing_refunds set status = 'failed', failure_message = left(p_message, 300), provider_ref = p_ref, finished_at = now()
      where id = r.id returning * into r;
    return jsonb_build_object('refund', to_jsonb(r));
  end if;
  select * into pay from public.billing_payments where id = r.payment_id for update;
  update public.billing_payments set amount_refunded_cents = amount_refunded_cents + r.amount_cents where id = pay.id returning * into pay;
  update public.billing_invoices set amount_refunded_cents = amount_refunded_cents + r.amount_cents, updated_at = now()
    where id = r.invoice_id returning * into inv;
  update public.billing_refunds set status = 'succeeded', provider_ref = p_ref, finished_at = now() where id = r.id returning * into r;
  -- The card/bank money goes back out. Stayblz's fee isn't returned (the processor keeps its cost too).
  if pay.channel <> 'offline' then
    if pay.stable_id is not null then
      insert into public.billing_ledger (holder, stable_id, entry, amount_cents, invoice_id, payment_id, refund_id, test)
        values ('stable', pay.stable_id, 'refund', -r.amount_cents, r.invoice_id, pay.id, r.id, pay.test);
    else
      insert into public.billing_ledger (holder, entry, amount_cents, invoice_id, payment_id, refund_id, test)
        values ('platform', 'refund', -r.amount_cents, r.invoice_id, pay.id, r.id, pay.test);
    end if;
  end if;
  perform public.billing_event(r.created_by, pay.account_id, pay.stable_id, r.invoice_id, pay.id, 'payment.refunded',
    jsonb_build_object('amount', r.amount_cents, 'reason', r.reason));
  return jsonb_build_object('refund', to_jsonb(r), 'payment', public.billing_payment_json(pay),
    'invoice', public.billing_invoice_json(inv, false));
end $$;

-- ======================================================================================================
-- Stable billing: owners, invoices, "Bill owners", balance, payouts
-- ======================================================================================================
-- Replaces who pays for a horse. p_owners: [{"clientId": "...", "shareBps": 5000}, ...] (total at most 100%).
create or replace function public.billing_set_owners(p_stable uuid, p_horse uuid, p_owners jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o jsonb; total integer := 0; n integer := 0;
begin
  if not exists (select 1 from public.member_horses where id = p_horse and stable_id = p_stable) then raise exception 'horse_not_found'; end if;
  if p_owners is null or jsonb_typeof(p_owners) <> 'array' or jsonb_array_length(p_owners) > 20 then raise exception 'invalid_owners'; end if;
  perform 1 from public.member_horses where id = p_horse for update;
  delete from public.billing_horse_owners where horse_id = p_horse;
  for o in select * from jsonb_array_elements(p_owners) loop
    if jsonb_typeof(o -> 'shareBps') <> 'number' or (o ->> 'shareBps')::numeric <> floor((o ->> 'shareBps')::numeric)
       or (o ->> 'shareBps')::integer not between 1 and 10000 then raise exception 'invalid_owners'; end if;
    if not exists (select 1 from public.billing_clients where id::text = o ->> 'clientId' and stable_id = p_stable and not archived) then
      raise exception 'client_not_found';
    end if;
    total := total + (o ->> 'shareBps')::integer;
    n := n + 1;
    insert into public.billing_horse_owners (horse_id, client_id, stable_id, share_bps)
      values (p_horse, (o ->> 'clientId')::uuid, p_stable, (o ->> 'shareBps')::integer);
  end loop;
  if total > 10000 then raise exception 'shares_over'; end if;
  return jsonb_build_object('owners', n, 'totalBps', total);
end $$;

-- Saves a draft stable invoice (new when p_invoice is null).
-- p_lines: [{category, description, quantity, unitCents, taxable?, horseId?, serviceOn?, shareBps?, chargeId?}] (1-100)
create or replace function public.billing_invoice_save(p_stable uuid, p_actor uuid, p_invoice uuid, p_client uuid, p_lines jsonb,
  p_memo text, p_due_on date, p_tax_bps integer, p_allow_card boolean, p_allow_bank boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare inv public.billing_invoices; c public.billing_clients; l jsonb; pos integer := 0; qty numeric; unit bigint; share integer;
  horse uuid; hname text; charge uuid; cat text; old_charges uuid[] := '{}';
begin
  select * into c from public.billing_clients where id = p_client and stable_id = p_stable and not archived;
  if not found then raise exception 'client_not_found'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 100 then
    raise exception 'invalid_lines';
  end if;
  if p_tax_bps is null or p_tax_bps not between 0 and 2500 then raise exception 'invalid_lines'; end if;
  if p_invoice is null then
    insert into public.billing_invoices (issuer, stable_id, kind, client_id, status, created_by)
      values ('stable', p_stable, 'stable', c.id, 'draft', p_actor) returning * into inv;
  else
    select * into inv from public.billing_invoices where id = p_invoice and stable_id = p_stable for update;
    if not found then raise exception 'invoice_not_found'; end if;
    if inv.status <> 'draft' then raise exception 'invoice_not_draft'; end if;
    select coalesce(array_agg(charge_id), '{}') into old_charges from public.billing_invoice_lines
     where invoice_id = inv.id and charge_id is not null;
    delete from public.billing_invoice_lines where invoice_id = inv.id;
  end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    cat := l ->> 'category';
    if cat is null or cat not in ('training', 'board', 'vet', 'farrier', 'transport', 'race_fees', 'jockey', 'supplies', 'breeding',
                                  'sale', 'other', 'credit') then raise exception 'invalid_lines'; end if;
    if jsonb_typeof(l -> 'quantity') <> 'number' or jsonb_typeof(l -> 'unitCents') <> 'number' then raise exception 'invalid_lines'; end if;
    qty := (l ->> 'quantity')::numeric;
    if qty <= 0 or qty > 10000 or qty <> round(qty, 2) then raise exception 'invalid_lines'; end if;
    if (l ->> 'unitCents')::numeric <> floor((l ->> 'unitCents')::numeric) then raise exception 'invalid_lines'; end if;
    unit := (l ->> 'unitCents')::bigint;
    if unit not between -100000000 and 100000000 or (cat = 'credit' and unit > 0) or (cat <> 'credit' and unit < 0) then
      raise exception 'invalid_lines';
    end if;
    share := null;
    if l ? 'shareBps' and jsonb_typeof(l -> 'shareBps') = 'number' then
      share := (l ->> 'shareBps')::integer;
      if share not between 1 and 10000 then raise exception 'invalid_lines'; end if;
    end if;
    if length(btrim(coalesce(l ->> 'description', ''))) not between 1 and 200 then raise exception 'invalid_lines'; end if;
    horse := null; hname := '';
    if coalesce(l ->> 'horseId', '') <> '' then
      select h.id, coalesce(h.inventory ->> 'horseName', '') into horse, hname from public.member_horses h
       where h.id::text = l ->> 'horseId' and h.stable_id = p_stable;
      if horse is null then raise exception 'horse_not_found'; end if;
    end if;
    charge := null;
    if coalesce(l ->> 'chargeId', '') <> '' then
      select ch.id into charge from public.billing_charges ch where ch.id::text = l ->> 'chargeId' and ch.stable_id = p_stable
         and (ch.status = 'unbilled' or ch.id = any(old_charges));
    end if;
    insert into public.billing_invoice_lines (invoice_id, position, category, description, quantity, unit_cents, share_bps, taxable,
      amount_cents, horse_id, horse_name, service_on, charge_id)
    values (inv.id, pos, cat, btrim(l ->> 'description'), qty, unit, share, coalesce((l ->> 'taxable')::boolean, false),
      public.billing_line_amount(qty, unit, share), horse, left(hname, 120),
      case when coalesce(l ->> 'serviceOn', '') ~ '^\d{4}-\d{2}-\d{2}$' then (l ->> 'serviceOn')::date end, charge);
    pos := pos + 1;
  end loop;
  update public.billing_invoices set client_id = c.id,
    bill_to = jsonb_build_object('name', c.name, 'email', c.email, 'company', c.company, 'phone', c.phone),
    memo = left(coalesce(p_memo, ''), 1000), due_on = p_due_on, tax_rate_bps = p_tax_bps,
    allow_card = coalesce(p_allow_card, true), allow_bank = coalesce(p_allow_bank, true), updated_at = now()
  where id = inv.id;
  -- "Billed" means "on a live invoice, draft or sent": charges on this draft can't be billed twice,
  -- and charges taken off it are free to bill again.
  update public.billing_charges set status = 'billed', billed_at = coalesce(billed_at, now()), updated_at = now()
   where id in (select charge_id from public.billing_invoice_lines where invoice_id = inv.id and charge_id is not null);
  update public.billing_charges bc set status = 'unbilled', billed_at = null, updated_at = now()
   where bc.id = any(old_charges)
     and not exists (select 1 from public.billing_invoice_lines l join public.billing_invoices i on i.id = l.invoice_id
                      where l.charge_id = bc.id and i.status <> 'void');
  perform public.billing_invoice_recalc(inv.id);
  select * into inv from public.billing_invoices where id = inv.id;
  return public.billing_invoice_json(inv, true);
end $$;

-- Charges go back to "unbilled" once no live invoice bills them any more.
create or replace function public.billing_release_charges(p_invoice uuid) returns void
language sql security definer set search_path = '' as $$
  update public.billing_charges c set status = 'unbilled', billed_at = null, updated_at = now()
   where c.id in (select charge_id from public.billing_invoice_lines where invoice_id = p_invoice and charge_id is not null)
     and not exists (select 1 from public.billing_invoice_lines l join public.billing_invoices i on i.id = l.invoice_id
                      where l.charge_id = c.id and i.id <> p_invoice and i.status <> 'void')
$$;

create or replace function public.billing_invoice_send(p_stable uuid, p_invoice uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.billing_merchants; inv public.billing_invoices; payer uuid; auto boolean := false; alert jsonb := null;
  n integer; num text;
begin
  select * into m from public.billing_merchants where stable_id = p_stable for update;
  if not found or m.status <> 'active' then raise exception 'payments_not_set_up'; end if;
  select * into inv from public.billing_invoices where id = p_invoice and stable_id = p_stable for update;
  if not found then raise exception 'invoice_not_found'; end if;
  if inv.status <> 'draft' then raise exception 'invoice_not_draft'; end if;
  if not exists (select 1 from public.billing_invoice_lines where invoice_id = inv.id) then raise exception 'empty_invoice'; end if;
  perform public.billing_invoice_recalc(inv.id);
  select * into inv from public.billing_invoices where id = inv.id;
  if inv.total_cents < 0 then raise exception 'negative_total'; end if;
  if inv.total_cents > 0 and inv.total_cents < 50 then raise exception 'amount_too_small'; end if;
  if not (inv.allow_card or inv.allow_bank) then raise exception 'no_payment_methods'; end if;
  -- The client's Stayblz account, when their email belongs to one (the bill then shows in their Billing page).
  if coalesce(inv.bill_to ->> 'email', '') <> '' then
    select a.id into payer from public.accounts a where lower(a.email) = lower(inv.bill_to ->> 'email') and a.status = 'active' limit 1;
  end if;
  if payer is not null then
    auto := exists (select 1 from public.billing_autopay a join public.billing_methods bm on bm.id = a.method_id
                     where a.account_id = payer and a.stable_id = p_stable and bm.status = 'active');
  end if;
  -- The next free number (a changed prefix never reuses one already given).
  n := m.next_number;
  loop
    num := m.invoice_prefix || '-' || lpad(n::text, 4, '0');
    exit when not exists (select 1 from public.billing_invoices where stable_id = p_stable and number = num);
    n := n + 1;
  end loop;
  update public.billing_invoices set
    number = num,
    status = case when total_cents = 0 then 'paid' else 'open' end,
    paid_at = case when total_cents = 0 then now() end,
    issued_at = now(),
    due_on = coalesce(due_on, (now() + make_interval(days => m.terms_days))::date),
    account_id = payer,
    pay_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
    allow_card = allow_card and m.accept_card,
    allow_bank = allow_bank and m.accept_bank,
    auto_collect = auto and total_cents > 0,
    updated_at = now()
  where id = inv.id returning * into inv;
  if not (inv.allow_card or inv.allow_bank) then raise exception 'no_payment_methods'; end if;
  if inv.auto_collect then
    update public.billing_invoices set next_attempt_at = greatest(inv.due_on::timestamptz, now()) where id = inv.id returning * into inv;
  end if;
  update public.billing_merchants set next_number = n + 1, updated_at = now() where stable_id = p_stable;
  update public.billing_charges set status = 'billed', billed_at = coalesce(billed_at, now()), updated_at = now()
   where id in (select charge_id from public.billing_invoice_lines where invoice_id = inv.id and charge_id is not null);
  perform public.billing_event(p_actor, payer, p_stable, inv.id, null, 'invoice.sent',
    jsonb_build_object('number', inv.number, 'total', inv.total_cents, 'autopay', inv.auto_collect));
  if payer is not null and inv.status = 'open' then
    alert := public.billing_alert(array[payer], 'New bill from ' || coalesce((select name from public.member_stables where id = p_stable), 'a stable'),
      inv.number || ' · ' || public.billing_money(inv.total_cents) || ' due ' || to_char(inv.due_on, 'Mon FMDD')
        || case when inv.auto_collect then ' (autopay is on)' else '' end,
      '/billing/invoices/' || inv.id, inv.id);
  end if;
  return jsonb_build_object('invoice', public.billing_invoice_json(inv, true) || jsonb_build_object('payToken', inv.pay_token),
    'notify', alert);
end $$;

-- Draft: deleted. Open with nothing paid: voided. Either way its charges can be billed again.
create or replace function public.billing_invoice_void(p_stable uuid, p_invoice uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare inv public.billing_invoices;
begin
  select * into inv from public.billing_invoices where id = p_invoice and stable_id = p_stable for update;
  if not found then raise exception 'invoice_not_found'; end if;
  if inv.status = 'draft' then
    perform public.billing_release_charges(inv.id);
    delete from public.billing_invoices where id = inv.id;
    return jsonb_build_object('deleted', true);
  end if;
  if inv.status <> 'open' then raise exception 'invoice_not_voidable'; end if;
  if inv.amount_paid_cents > 0 then raise exception 'has_payments'; end if;
  if exists (select 1 from public.billing_payments where invoice_id = inv.id and status in ('pending', 'processing')) then
    raise exception 'payment_in_progress';
  end if;
  update public.billing_invoices set status = 'void', voided_at = now(), auto_collect = false, next_attempt_at = null,
    pay_token = null, updated_at = now() where id = inv.id returning * into inv;
  perform public.billing_release_charges(inv.id);
  perform public.billing_event(p_actor, inv.account_id, p_stable, inv.id, null, 'invoice.voided', jsonb_build_object('number', inv.number));
  return jsonb_build_object('invoice', public.billing_invoice_json(inv, true));
end $$;

-- "Bill owners": every unbilled charge up to p_through becomes lines on one draft invoice per client.
-- Horse charges are split by the horse's owner shares; a charge for a named client goes to that client.
create or replace function public.billing_bill_owners(p_stable uuid, p_actor uuid, p_through date, p_horses uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ch record; o record; inv_id uuid; skipped jsonb := '[]'; made jsonb := '{}'; pos integer; any_line boolean;
  amt bigint; c public.billing_clients; m public.billing_merchants; result jsonb := '[]'; k text;
begin
  select * into m from public.billing_merchants where stable_id = p_stable;
  for ch in select * from public.billing_charges
             where stable_id = p_stable and status = 'unbilled' and service_on <= coalesce(p_through, now()::date)
               and (p_horses is null or cardinality(p_horses) = 0 or horse_id = any(p_horses))
             order by service_on, created_at for update loop
    any_line := false;
    for o in
      select ch.client_id as client_id, null::integer as share_bps where ch.client_id is not null
      union all
      select ho.client_id, ho.share_bps from public.billing_horse_owners ho
       where ch.client_id is null and ch.horse_id is not null and ho.horse_id = ch.horse_id
    loop
      select * into c from public.billing_clients where id = o.client_id and not archived;
      if not found then continue; end if;
      amt := public.billing_line_amount(ch.quantity, ch.unit_cents, o.share_bps);
      if amt = 0 then continue; end if;
      k := c.id::text;
      if made ? k then
        inv_id := (made ->> k)::uuid;
      else
        insert into public.billing_invoices (issuer, stable_id, kind, client_id, bill_to, status, memo, created_by,
          allow_card, allow_bank)
        values ('stable', p_stable, 'stable', c.id,
          jsonb_build_object('name', c.name, 'email', c.email, 'company', c.company, 'phone', c.phone), 'draft',
          coalesce(m.default_memo, ''), p_actor, coalesce(m.accept_card, true), coalesce(m.accept_bank, true))
        returning id into inv_id;
        made := made || jsonb_build_object(k, inv_id);
      end if;
      select coalesce(max(position) + 1, 0) into pos from public.billing_invoice_lines where invoice_id = inv_id;
      if pos > 199 then raise exception 'too_many_lines'; end if;
      insert into public.billing_invoice_lines (invoice_id, position, category, description, quantity, unit_cents, share_bps,
        amount_cents, horse_id, horse_name, service_on, charge_id)
      values (inv_id, pos, ch.category, ch.description, ch.quantity, ch.unit_cents, o.share_bps, amt, ch.horse_id,
        ch.horse_name, ch.service_on, ch.id);
      any_line := true;
    end loop;
    if any_line then
      update public.billing_charges set status = 'billed', billed_at = now(), updated_at = now() where id = ch.id;
    else
      skipped := skipped || jsonb_build_array(jsonb_build_object('chargeId', ch.id, 'horseName', ch.horse_name,
        'description', ch.description, 'amount', ch.amount_cents,
        'reason', case when ch.horse_id is null and ch.client_id is null then 'no_payer' else 'no_owners' end));
    end if;
  end loop;
  for k in select jsonb_object_keys(made) loop
    perform public.billing_invoice_recalc((made ->> k)::uuid);
    result := result || jsonb_build_array((select public.billing_invoice_json(i, false) from public.billing_invoices i
                                            where i.id = (made ->> k)::uuid));
  end loop;
  if jsonb_array_length(result) > 0 then
    perform public.billing_event(p_actor, null, p_stable, null, null, 'invoice.bill_owners',
      jsonb_build_object('invoices', jsonb_array_length(result), 'skipped', jsonb_array_length(skipped)));
  end if;
  return jsonb_build_object('invoices', result, 'skipped', skipped);
end $$;

create or replace function public.billing_balance(p_stable uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'available', coalesce(sum(amount_cents) filter (where available_at <= now()), 0),
    'pending', coalesce(sum(amount_cents) filter (where available_at > now()), 0),
    'gross', coalesce(sum(amount_cents) filter (where entry = 'payment'), 0),
    'fees', -coalesce(sum(amount_cents) filter (where entry = 'fee'), 0),
    'refunds', -coalesce(sum(amount_cents) filter (where entry = 'refund'), 0),
    'paidOut', -coalesce(sum(amount_cents) filter (where entry in ('payout', 'payout_reversal')), 0))
  from public.billing_ledger where holder = 'stable' and stable_id = p_stable
$$;

-- Payout: the funds leave the balance at once (and come back if the transfer fails).
create or replace function public.billing_payout_start(p_stable uuid, p_amount bigint, p_key text, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare m public.billing_merchants; p public.billing_payouts; avail bigint; amt bigint;
begin
  if p_key is null or length(p_key) < 8 or length(p_key) > 120 then raise exception 'invalid_key'; end if;
  select * into p from public.billing_payouts where idempotency_key = p_key;
  if found then
    if p.stable_id <> p_stable then raise exception 'idempotency_conflict'; end if;
    return jsonb_build_object('payout', to_jsonb(p), 'replayed', true);
  end if;
  select * into m from public.billing_merchants where stable_id = p_stable for update;
  if not found or m.status <> 'active' then raise exception 'payments_not_set_up'; end if;
  if m.payout_ref is null then raise exception 'no_payout_account'; end if;
  select coalesce(sum(amount_cents), 0) into avail from public.billing_ledger
   where holder = 'stable' and stable_id = p_stable and available_at <= now();
  amt := coalesce(p_amount, avail);
  if amt < 100 then raise exception 'payout_too_small'; end if;
  if amt > avail then raise exception 'insufficient_balance'; end if;
  insert into public.billing_payouts (stable_id, amount_cents, status, destination, idempotency_key, created_by, test)
    values (p_stable, amt, 'pending', m.payout, p_key, p_actor, m.test) returning * into p;
  insert into public.billing_ledger (holder, stable_id, entry, amount_cents, payout_id, test)
    values ('stable', p_stable, 'payout', -amt, p.id, m.test);
  return jsonb_build_object('payout', to_jsonb(p), 'replayed', false, 'destinationRef', m.payout_ref);
end $$;

create or replace function public.billing_payout_finish(p_payout uuid, p_ok boolean, p_ref text, p_message text, p_arrives date)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.billing_payouts;
begin
  select * into p from public.billing_payouts where id = p_payout for update;
  if not found then raise exception 'payout_not_found'; end if;
  if p.status <> 'pending' then return jsonb_build_object('payout', to_jsonb(p), 'already', true); end if;
  if p_ok then
    update public.billing_payouts set status = 'paid', provider_ref = p_ref, arrives_on = p_arrives, finished_at = now()
      where id = p.id returning * into p;
  else
    update public.billing_payouts set status = 'failed', provider_ref = p_ref, failure_message = left(p_message, 300), finished_at = now()
      where id = p.id returning * into p;
    insert into public.billing_ledger (holder, stable_id, entry, amount_cents, payout_id, test)
      values ('stable', p.stable_id, 'payout_reversal', p.amount_cents, p.id, p.test);
  end if;
  perform public.billing_event(p.created_by, null, p.stable_id, null, null, case when p_ok then 'payout.paid' else 'payout.failed' end,
    jsonb_build_object('amount', p.amount_cents));
  return jsonb_build_object('payout', to_jsonb(p));
end $$;

-- ======================================================================================================
-- Admin report
-- ======================================================================================================
create or replace function public.billing_admin_summary() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sales', (select coalesce(sum(amount_cents), 0) from public.billing_ledger where holder = 'platform' and entry = 'sale'),
    'feeIncome', (select coalesce(sum(amount_cents), 0) from public.billing_ledger where holder = 'platform' and entry = 'fee_income'),
    'refunds', (select -coalesce(sum(amount_cents), 0) from public.billing_ledger where holder = 'platform' and entry = 'refund'),
    'estimatedCost', (select coalesce(sum(cost_cents), 0) from public.billing_payments where status = 'succeeded' and channel <> 'offline'),
    'stableVolume', (select coalesce(sum(amount_cents), 0) from public.billing_payments where status = 'succeeded' and stable_id is not null and channel <> 'offline'),
    'offlineVolume', (select coalesce(sum(amount_cents), 0) from public.billing_payments where status = 'succeeded' and channel = 'offline'),
    'mrr', (select coalesce(sum(case when interval = 'year' then (amount_cents + 6) / 12 else amount_cents end), 0)
              from public.billing_subscriptions where status in ('active', 'past_due')),
    'subscriptions', (select coalesce(jsonb_agg(x order by x ->> 'planId'), '[]') from (
        select jsonb_build_object('planId', s.plan_id, 'name', c.name,
          'active', count(*) filter (where s.status = 'active'), 'trialing', count(*) filter (where s.status = 'trialing'),
          'pastDue', count(*) filter (where s.status = 'past_due'), 'canceled', count(*) filter (where s.status = 'canceled')) x
        from public.billing_subscriptions s join public.billing_catalog c on c.id = s.plan_id group by s.plan_id, c.name) y),
    'payments', (select jsonb_build_object('succeeded', count(*) filter (where status = 'succeeded'),
        'failed', count(*) filter (where status = 'failed'), 'processing', count(*) filter (where status in ('pending', 'processing')))
        from public.billing_payments),
    'stables', (select count(*) from public.billing_merchants where status = 'active'),
    'months', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
        'sales', (select coalesce(sum(amount_cents), 0) from public.billing_ledger where holder = 'platform' and entry = 'sale'
                   and created_at >= m and created_at < m + interval '1 month'),
        'feeIncome', (select coalesce(sum(amount_cents), 0) from public.billing_ledger where holder = 'platform' and entry = 'fee_income'
                   and created_at >= m and created_at < m + interval '1 month'),
        'refunds', (select -coalesce(sum(amount_cents), 0) from public.billing_ledger where holder = 'platform' and entry = 'refund'
                   and created_at >= m and created_at < m + interval '1 month'),
        'stableVolume', (select coalesce(sum(amount_cents), 0) from public.billing_payments where status = 'succeeded' and stable_id is not null
                   and channel <> 'offline' and finished_at >= m and finished_at < m + interval '1 month')) order by m), '[]')
      from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m))
$$;

-- ======================================================================================================
-- Subscription changes (atomic)
-- ======================================================================================================
-- p_now false: stop at the end of the period you've paid for (a trial just ends). true: end it now (staff, or
-- when nothing has been paid: an unfinished first payment, or a renewal that keeps failing).
create or replace function public.billing_sub_cancel(p_sub uuid, p_account uuid, p_now boolean, p_actor uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.billing_subscriptions; immediate boolean;
begin
  select * into s from public.billing_subscriptions where id = p_sub and (p_account is null or account_id = p_account) for update;
  if not found then raise exception 'subscription_not_found'; end if;
  if s.status = 'canceled' then return jsonb_build_object('subscription', public.billing_sub_json(s)); end if;
  immediate := coalesce(p_now, false) or s.status in ('incomplete', 'past_due');
  if immediate then
    if exists (select 1 from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
                where i.subscription_id = s.id and p.status in ('pending', 'processing')) then
      raise exception 'payment_in_progress';
    end if;
    update public.billing_subscriptions set status = 'canceled', canceled_at = now(), ended_at = now(), cancel_at_period_end = false,
      cancel_reason = coalesce(p_reason, 'requested'), updated_at = now() where id = s.id returning * into s;
    update public.billing_invoices set status = 'void', voided_at = now(), auto_collect = false, next_attempt_at = null, updated_at = now()
      where subscription_id = s.id and status = 'open' and amount_paid_cents = 0;
  else
    update public.billing_subscriptions set cancel_at_period_end = true, canceled_at = now(), cancel_reason = coalesce(p_reason, 'requested'),
      pending_plan_id = null, updated_at = now() where id = s.id returning * into s;
  end if;
  perform public.billing_event(p_actor, s.account_id, null, null, null,
    case when immediate then 'subscription.canceled' else 'subscription.cancel_scheduled' end, jsonb_build_object('plan', s.plan_id));
  return jsonb_build_object('subscription', public.billing_sub_json(s));
end $$;

create or replace function public.billing_sub_resume(p_sub uuid, p_account uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.billing_subscriptions;
begin
  select * into s from public.billing_subscriptions where id = p_sub and account_id = p_account for update;
  if not found then raise exception 'subscription_not_found'; end if;
  if s.status not in ('active', 'trialing') or not s.cancel_at_period_end then raise exception 'not_resumable'; end if;
  update public.billing_subscriptions set cancel_at_period_end = false, canceled_at = null, cancel_reason = null, updated_at = now()
    where id = s.id returning * into s;
  perform public.billing_event(p_actor, s.account_id, null, null, null, 'subscription.resumed', jsonb_build_object('plan', s.plan_id));
  return jsonb_build_object('subscription', public.billing_sub_json(s));
end $$;

-- Switch to another plan of the same family at the next renewal (no proration: you keep what you paid for).
-- p_plan = the current plan clears a pending switch.
create or replace function public.billing_sub_change(p_sub uuid, p_account uuid, p_plan text, p_method uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.billing_subscriptions; c public.billing_catalog;
begin
  select * into s from public.billing_subscriptions where id = p_sub and account_id = p_account for update;
  if not found then raise exception 'subscription_not_found'; end if;
  if s.status not in ('trialing', 'active', 'past_due', 'incomplete') then raise exception 'subscription_not_found'; end if;
  if p_plan is not null then
    if s.cancel_at_period_end then raise exception 'not_resumable'; end if;
    if p_plan = s.plan_id then
      update public.billing_subscriptions set pending_plan_id = null, updated_at = now() where id = s.id returning * into s;
    else
      select * into c from public.billing_catalog where id = p_plan;
      if not found or c.kind <> 'plan' or c.status <> 'active' or c.family <> s.family then raise exception 'plan_unavailable'; end if;
      update public.billing_subscriptions set pending_plan_id = c.id, updated_at = now() where id = s.id returning * into s;
      perform public.billing_event(p_actor, s.account_id, null, null, null, 'subscription.change_scheduled',
        jsonb_build_object('from', s.plan_id, 'to', c.id));
    end if;
  end if;
  if p_method is not null then
    if not exists (select 1 from public.billing_methods where id = p_method and account_id = p_account and status = 'active') then
      raise exception 'method_not_found';
    end if;
    update public.billing_subscriptions set method_id = p_method, updated_at = now() where id = s.id returning * into s;
  end if;
  return jsonb_build_object('subscription', public.billing_sub_json(s));
end $$;

-- Test mode only: move a subscription's clock forward so its period ends now (renewals and retries can be tried
-- without waiting a month). Due retries of its open invoice are brought forward too.
create or replace function public.billing_test_advance(p_sub uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.billing_subscriptions; shift interval;
begin
  if (select mode from public.billing_settings where id) <> 'test' then raise exception 'test_mode_only'; end if;
  select * into s from public.billing_subscriptions where id = p_sub for update;
  if not found then raise exception 'subscription_not_found'; end if;
  if s.status in ('trialing', 'active') and s.current_period_end > now() then
    shift := s.current_period_end - now();
    update public.billing_subscriptions set anchor_at = anchor_at - shift, current_period_end = now(),
      trial_end = case when status = 'trialing' then now() else trial_end end, updated_at = now() where id = s.id returning * into s;
  end if;
  update public.billing_invoices set next_attempt_at = now() where subscription_id = s.id and status = 'open' and auto_collect;
  perform public.billing_event(p_actor, s.account_id, null, null, null, 'subscription.test_advanced', '{}');
  return jsonb_build_object('subscription', public.billing_sub_json(s));
end $$;

-- ======================================================================================================
-- Reads for the API
-- ======================================================================================================
-- Your Billing page: details, cards/banks, plans, what you can use, bills from stables, autopay, the catalog.
create or replace function public.billing_overview(p_account uuid, p_email text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'settings', (select jsonb_build_object('mode', s.mode, 'enforcePaywalls', s.enforce_paywalls) from public.billing_settings s where s.id),
    'profile', (select jsonb_build_object('name', p.name, 'email', p.email, 'line1', p.line1, 'line2', p.line2, 'city', p.city,
                  'region', p.region, 'postal', p.postal, 'country', p.country, 'defaultMethodId', p.default_method_id)
                from public.billing_profiles p where p.account_id = p_account),
    'methods', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'type', m.type, 'brand', m.brand, 'last4', m.last4,
                  'expMonth', m.exp_month, 'expYear', m.exp_year, 'bankName', m.bank_name, 'holderName', m.holder_name,
                  'test', m.test, 'createdAt', m.created_at) order by m.created_at desc)
                from public.billing_methods m where m.account_id = p_account and m.status = 'active'), '[]'),
    'subscriptions', coalesce((select jsonb_agg(public.billing_sub_json(s) order by s.created_at desc)
                from public.billing_subscriptions s where s.account_id = p_account
                  and (s.status <> 'canceled' or s.ended_at > now() - interval '90 days')
                  and s.cancel_reason is distinct from 'replaced'), '[]'),
    'features', to_jsonb(public.billing_features(p_account)),
    -- Families this account already had a plan in (a free trial is once per family; same rule as billing_subscribe).
    'trialUsed', coalesce((select jsonb_agg(distinct s.family) from public.billing_subscriptions s
                  where s.account_id = p_account and (s.status <> 'canceled' or s.cancel_reason is distinct from 'replaced')), '[]'),
    'bills', coalesce((select jsonb_agg(public.billing_invoice_json(i, false) order by i.due_on, i.created_at)
                from public.billing_invoices i where i.issuer = 'stable' and i.status = 'open'
                  and (i.account_id = p_account or (coalesce(p_email, '') <> '' and lower(i.bill_to ->> 'email') = lower(p_email)))), '[]'),
    'autopay', coalesce((select jsonb_agg(jsonb_build_object('stableId', a.stable_id, 'stableName', st.name, 'methodId', a.method_id,
                  'createdAt', a.created_at) order by st.name)
                from public.billing_autopay a join public.member_stables st on st.id = a.stable_id where a.account_id = p_account), '[]'),
    'billers', coalesce((select jsonb_agg(jsonb_build_object('stableId', x.stable_id, 'stableName', st.name) order by st.name)
                from (select distinct i.stable_id from public.billing_invoices i where i.issuer = 'stable' and i.status <> 'draft'
                        and (i.account_id = p_account or (coalesce(p_email, '') <> '' and lower(i.bill_to ->> 'email') = lower(p_email)))) x
                join public.member_stables st on st.id = x.stable_id), '[]'),
    'catalog', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'family', c.family, 'name', c.name,
                  'description', c.description, 'amount', c.amount_cents, 'currency', c.currency, 'interval', c.interval,
                  'trialDays', c.trial_days, 'features', c.features, 'effect', c.effect, 'effectDays', c.effect_days)
                  order by c.sort, c.id)
                from public.billing_catalog c where c.status = 'active'), '[]'))
$$;

-- Is this bill yours to see and pay? (Stayblz's own invoices to you, or a stable's bill to your account or email.)
create or replace function public.billing_payer_can_see(i public.billing_invoices, p_account uuid, p_email text) returns boolean
language sql stable set search_path = '' as $$
  select i.status <> 'draft' and (i.account_id = p_account
    or (i.issuer = 'stable' and coalesce(p_email, '') <> '' and lower(i.bill_to ->> 'email') = lower(p_email)))
$$;

create or replace function public.billing_invoices_for(p_account uuid, p_email text, p_limit integer, p_before timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.billing_invoice_json(i, false) order by i.created_at desc), '[]')
  from public.billing_invoices i
  where i.id in (select x.id from public.billing_invoices x
                  where public.billing_payer_can_see(x, p_account, p_email) and (p_before is null or x.created_at < p_before)
                  order by x.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 100))
$$;

-- Payments and refunds on one invoice, for whoever may see it.
create or replace function public.billing_invoice_activity(p_invoice uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'payments', coalesce((select jsonb_agg(public.billing_payment_json(p) order by p.created_at desc)
                 from public.billing_payments p where p.invoice_id = p_invoice), '[]'),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'paymentId', r.payment_id, 'amount', r.amount_cents,
                 'reason', r.reason, 'note', r.note, 'status', r.status, 'createdAt', r.created_at) order by r.created_at desc)
                 from public.billing_refunds r where r.invoice_id = p_invoice), '[]'))
$$;

create or replace function public.billing_payer_invoice(p_invoice uuid, p_account uuid, p_email text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select (select public.billing_invoice_json(i, true) || public.billing_invoice_activity(i.id)
            || jsonb_build_object('autopay', exists (select 1 from public.billing_autopay a
                                                      where a.account_id = p_account and a.stable_id = i.stable_id))
          from public.billing_invoices i where i.id = p_invoice and public.billing_payer_can_see(i, p_account, p_email))
$$;

create or replace function public.billing_payments_for(p_account uuid, p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.billing_payment_json(p) || jsonb_build_object('invoiceNumber', i.number, 'kind', i.kind,
           'stableName', (select name from public.member_stables where id = i.stable_id)) order by p.created_at desc), '[]')
  from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
  where p.id in (select x.id from public.billing_payments x where x.account_id = p_account order by x.created_at desc
                  limit least(greatest(coalesce(p_limit, 50), 1), 500))
$$;

-- Pay link: what the person paying may see. Null when the link isn't (or is no longer) valid.
create or replace function public.billing_by_token(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select (select (public.billing_invoice_json(i, true) - 'accountId' - 'clientId' - 'target' - 'autoCollect' - 'attempts' - 'nextAttemptAt')
      || jsonb_build_object('payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount_cents,
           'channel', p.channel, 'method', p.method - 'ref', 'status', p.status, 'refunded', p.amount_refunded_cents,
           'createdAt', p.created_at, 'failureMessage', p.failure_message) order by p.created_at desc)
           from public.billing_payments p where p.invoice_id = i.id and p.status <> 'pending'), '[]'))
    from public.billing_invoices i
    where p_token ~ '^[0-9a-f]{64}$' and i.pay_token = p_token and i.status in ('open', 'paid'))
$$;

-- ---------- Stable side ----------
create or replace function public.billing_stable_overview(p_stable uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'settings', (select jsonb_build_object('mode', s.mode, 'fees', s.fees, 'payoutDelayDays', s.payout_delay_days)
                 from public.billing_settings s where s.id),
    'merchant', (select to_jsonb(m) - 'payout_ref' from public.billing_merchants m where m.stable_id = p_stable),
    'balance', public.billing_balance(p_stable),
    'invoices', (select jsonb_build_object(
        'drafts', count(*) filter (where status = 'draft'),
        'open', count(*) filter (where status = 'open'),
        'openTotal', coalesce(sum(total_cents - amount_paid_cents) filter (where status = 'open'), 0),
        'overdue', count(*) filter (where status = 'open' and due_on < now()::date),
        'overdueTotal', coalesce(sum(total_cents - amount_paid_cents) filter (where status = 'open' and due_on < now()::date), 0),
        'paid30', coalesce(sum(amount_paid_cents) filter (where status = 'paid' and paid_at > now() - interval '30 days'), 0))
      from public.billing_invoices where stable_id = p_stable),
    'charges', (select jsonb_build_object('unbilled', count(*), 'unbilledTotal', coalesce(sum(amount_cents), 0))
      from public.billing_charges where stable_id = p_stable and status = 'unbilled'),
    'clients', (select count(*) from public.billing_clients where stable_id = p_stable and not archived),
    'recentPayments', coalesce((select jsonb_agg(public.billing_payment_json(p) || jsonb_build_object('invoiceNumber', i.number,
         'client', i.bill_to ->> 'name') order by p.created_at desc)
       from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
      where p.id in (select x.id from public.billing_payments x where x.stable_id = p_stable order by x.created_at desc limit 8)), '[]'))
$$;

create or replace function public.billing_stable_invoices(p_stable uuid, p_status text, p_client uuid, p_limit integer, p_before timestamptz)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.billing_invoice_json(i, false) order by i.created_at desc), '[]')
  from public.billing_invoices i
  where i.id in (select x.id from public.billing_invoices x
     where x.stable_id = p_stable
       and (p_status is null or p_status = '' or x.status = p_status
            or (p_status = 'overdue' and x.status = 'open' and x.due_on < now()::date))
       and (p_client is null or x.client_id = p_client)
       and (p_before is null or x.created_at < p_before)
     order by x.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200))
$$;

create or replace function public.billing_stable_invoice(p_stable uuid, p_invoice uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select (select public.billing_invoice_json(i, true) || public.billing_invoice_activity(i.id)
      || jsonb_build_object('payToken', i.pay_token,
           'events', coalesce((select jsonb_agg(jsonb_build_object('event', e.event, 'at', e.created_at, 'detail', e.detail) order by e.id)
                     from public.billing_events e where e.invoice_id = i.id), '[]'))
    from public.billing_invoices i where i.id = p_invoice and i.stable_id = p_stable)
$$;

create or replace function public.billing_stable_payments(p_stable uuid, p_limit integer, p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.billing_payment_json(p) || jsonb_build_object('invoiceNumber', i.number,
           'client', i.bill_to ->> 'name', 'clientEmail', i.bill_to ->> 'email') order by p.created_at desc), '[]')
  from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
  where p.id in (select x.id from public.billing_payments x where x.stable_id = p_stable
          and (p_from is null or x.created_at >= p_from) and (p_to is null or x.created_at < p_to + 1)
          order by x.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 5000))
$$;

create or replace function public.billing_sub_one(p_sub uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select (select public.billing_sub_json(s) from public.billing_subscriptions s where s.id = p_sub)
$$;

-- ---------- Admin ----------
-- Stable payments show amounts, fees and the stable only: who paid and what for stay with the stable.
create or replace function public.billing_admin_payments(p_status text, p_limit integer, p_before timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.billing_payment_json(p) || jsonb_build_object('invoiceNumber', i.number, 'kind', i.kind,
           'stableName', (select name from public.member_stables where id = i.stable_id),
           'payer', case when i.issuer = 'stayblz' then (select jsonb_build_object('id', a.id, 'email', a.email,
                      'name', btrim(a.first_name || ' ' || a.last_name)) from public.accounts a where a.id = i.account_id) end)
           order by p.created_at desc), '[]')
  from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
  where p.id in (select x.id from public.billing_payments x
         where (p_status is null or p_status = '' or x.status = p_status) and (p_before is null or x.created_at < p_before)
         order by x.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200))
$$;

create or replace function public.billing_admin_subscriptions(p_status text, p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.billing_sub_json(s) || jsonb_build_object('account', jsonb_build_object('id', a.id,
           'email', a.email, 'name', btrim(a.first_name || ' ' || a.last_name))) order by s.created_at desc), '[]')
  from public.billing_subscriptions s left join public.accounts a on a.id = s.account_id
  where s.id in (select x.id from public.billing_subscriptions x
         where (p_status is null or p_status = '' or x.status = p_status) and x.cancel_reason is distinct from 'replaced'
         order by x.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500))
$$;

-- ======================================================================================================
-- Functions are for the API's service role only.
-- ======================================================================================================
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname like 'billing\_%' or p.proname in ('chat_alerts_list', 'chat_alert_allowed')) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
