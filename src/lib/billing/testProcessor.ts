import { createHash } from "node:crypto";

/**
 * The Stayblz test processor: a stand-in for a real payment processor while Billing runs in test mode.
 *
 * - Only the published test card / bank numbers below work. The browser turns the number someone types into
 *   a test token (frontend components/billing/testCards.ts) and refuses anything else, so a real card number
 *   never leaves the browser and is never stored. The server only ever accepts the tokens below.
 * - Results are decided by the token alone and are deterministic: the same idempotency key always gives the
 *   same reference and result, exactly like a real processor's retry-safe API. That's what makes "ask again
 *   after a crash" (engine.reconcile) safe.
 * - Nothing here moves money. A real processor (e.g. Stripe) replaces this file behind lib/billing/provider.ts.
 */

export type Outcome = "ok" | "card_declined" | "insufficient_funds" | "expired_card" | "processing_error" | "account_closed";

interface TestCard {
  brand: "visa" | "mastercard" | "amex" | "discover";
  last4: string;
  /** What happens when this card is charged. */
  charge: Outcome;
}
interface TestBank {
  last4: string;
  bankName: string;
  /** "ok" clears; "insufficient_funds" fails when it would clear (like an ACH return); account_closed fails at once. */
  charge: Outcome;
}

export const TEST_CARDS: Record<string, TestCard> = {
  tok_visa: { brand: "visa", last4: "4242", charge: "ok" },
  tok_visa_debit: { brand: "visa", last4: "5556", charge: "ok" },
  tok_mastercard: { brand: "mastercard", last4: "4444", charge: "ok" },
  tok_amex: { brand: "amex", last4: "0005", charge: "ok" },
  tok_discover: { brand: "discover", last4: "1117", charge: "ok" },
  tok_declined: { brand: "visa", last4: "0002", charge: "card_declined" },
  tok_insufficient: { brand: "visa", last4: "9995", charge: "insufficient_funds" },
  tok_expired: { brand: "visa", last4: "0069", charge: "expired_card" },
  tok_error: { brand: "visa", last4: "0119", charge: "processing_error" },
  // Saves fine, then every charge is declined: for trying failed renewals and retries.
  tok_fail_later: { brand: "visa", last4: "0341", charge: "card_declined" },
};

export const TEST_BANKS: Record<string, TestBank> = {
  btok_ok: { last4: "6789", bankName: "Stayblz Test Bank", charge: "ok" },
  btok_insufficient: { last4: "2227", bankName: "Stayblz Test Bank", charge: "insufficient_funds" },
  btok_closed: { last4: "1116", bankName: "Stayblz Test Bank", charge: "account_closed" },
};

/** Tokens that can't even be saved (the card is refused when added). */
const REFUSED_ON_SAVE = new Set(["tok_declined", "tok_expired"]);

export const FAILURE_WORDS: Record<Exclude<Outcome, "ok">, string> = {
  card_declined: "The card was declined.",
  insufficient_funds: "There isn't enough money on this card or account.",
  expired_card: "The card has expired.",
  processing_error: "The card couldn't be charged right now. Try again in a moment.",
  account_closed: "This bank account is closed.",
};

export interface MethodDetails {
  type: "card" | "bank";
  brand: string;
  last4: string;
  bankName: string;
}

/** Checks a token and returns what may be shown about it. Null = not a test token we know. */
export function describeToken(token: unknown, type: "card" | "bank"): MethodDetails | null {
  if (typeof token !== "string") return null;
  if (type === "card") {
    const card = Object.hasOwn(TEST_CARDS, token) ? TEST_CARDS[token] : null;
    return card ? { type, brand: card.brand, last4: card.last4, bankName: "" } : null;
  }
  const bank = Object.hasOwn(TEST_BANKS, token) ? TEST_BANKS[token] : null;
  return bank ? { type, brand: "", last4: bank.last4, bankName: bank.bankName } : null;
}

/** Saving a card: some test cards are refused right away, like a real processor's check. */
export function saveCheck(token: string): Exclude<Outcome, "ok"> | null {
  if (!REFUSED_ON_SAVE.has(token)) return null;
  return token === "tok_expired" ? "expired_card" : "card_declined";
}

const ref = (prefix: string, key: string, suffix = "") =>
  `${prefix}_${createHash("sha256").update(key).digest("hex").slice(0, 24)}${suffix ? `_${suffix}` : ""}`;

export interface ChargeInput {
  token: string;
  type: "card" | "bank";
  amountCents: number;
  idempotencyKey: string;
  /** Card expiry from the saved method (a saved card can expire after it was added). */
  expMonth?: number | null;
  expYear?: number | null;
  now?: Date;
}
export type ChargeOutcome =
  | { status: "succeeded"; providerRef: string }
  | { status: "processing"; providerRef: string }
  | { status: "failed"; providerRef: string; failureCode: string; failureMessage: string };

function expired(expMonth: number | null | undefined, expYear: number | null | undefined, now: Date) {
  if (!expMonth || !expYear) return false;
  // Valid through the last day of the expiry month.
  return now.getUTCFullYear() > expYear || (now.getUTCFullYear() === expYear && now.getUTCMonth() + 1 > expMonth);
}

export function testCharge(input: ChargeInput): ChargeOutcome {
  const now = input.now ?? new Date();
  if (input.type === "card") {
    const card = Object.hasOwn(TEST_CARDS, input.token) ? TEST_CARDS[input.token] : null;
    const providerRef = ref("tpc", input.idempotencyKey);
    if (!card) return { status: "failed", providerRef, failureCode: "invalid_method", failureMessage: "This card can't be used." };
    if (expired(input.expMonth, input.expYear, now))
      return { status: "failed", providerRef, failureCode: "expired_card", failureMessage: FAILURE_WORDS.expired_card };
    if (card.charge !== "ok")
      return { status: "failed", providerRef, failureCode: card.charge, failureMessage: FAILURE_WORDS[card.charge] };
    return { status: "succeeded", providerRef };
  }
  const bank = Object.hasOwn(TEST_BANKS, input.token) ? TEST_BANKS[input.token] : null;
  if (!bank)
    return { status: "failed", providerRef: ref("tpb", input.idempotencyKey), failureCode: "invalid_method", failureMessage: "This bank account can't be used." };
  if (bank.charge === "account_closed")
    return { status: "failed", providerRef: ref("tpb", input.idempotencyKey), failureCode: "account_closed", failureMessage: FAILURE_WORDS.account_closed };
  // Bank transfers take time to clear. The reference remembers how this one will end.
  return { status: "processing", providerRef: ref("tpb", input.idempotencyKey, bank.charge === "ok" ? "ok" : "r01") };
}

/** How a bank transfer ended (asked when its clearing time has come). */
export function testRetrieve(providerRef: string): ChargeOutcome {
  if (/^tpb_[0-9a-f]{24}_ok$/.test(providerRef)) return { status: "succeeded", providerRef };
  if (/^tpb_[0-9a-f]{24}_r01$/.test(providerRef))
    return { status: "failed", providerRef, failureCode: "insufficient_funds", failureMessage: FAILURE_WORDS.insufficient_funds };
  if (/^tpc_[0-9a-f]{24}$/.test(providerRef)) return { status: "succeeded", providerRef };
  return { status: "failed", providerRef, failureCode: "processing_error", failureMessage: FAILURE_WORDS.processing_error };
}

export function testRefund(idempotencyKey: string) {
  return { ok: true as const, providerRef: ref("tpr", idempotencyKey) };
}

/** Payouts to the test bank. btok_closed fails (the money returns to the balance). */
export function testPayout(destinationToken: string, idempotencyKey: string, now = new Date()) {
  const bank = Object.hasOwn(TEST_BANKS, destinationToken) ? TEST_BANKS[destinationToken] : null;
  const providerRef = ref("tpo", idempotencyKey);
  if (!bank || bank.charge === "account_closed")
    return { ok: false as const, providerRef, message: "The bank account refused the payout." };
  // Standard payouts land in about two business days.
  const arrives = new Date(now);
  let added = 0;
  while (added < 2) {
    arrives.setUTCDate(arrives.getUTCDate() + 1);
    const day = arrives.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return { ok: true as const, providerRef, arrivesOn: arrives.toISOString().slice(0, 10) };
}
