import {
  describeToken,
  saveCheck,
  testCharge,
  testPayout,
  testRefund,
  testRetrieve,
  FAILURE_WORDS,
  type ChargeOutcome,
  type MethodDetails,
} from "./testProcessor";

/**
 * The one place Stayblz talks to a payment processor. Everything else (routes, SQL, the schedule) only uses
 * this interface, so connecting a real processor means adding one implementation here — see docs/billing.md
 * ("Going live") for the exact checklist. Until then `paymentProvider()` is the Stayblz test processor.
 *
 * Contract every implementation keeps:
 *  - charge/refund/payout take an idempotency key and return the SAME result when called again with it
 *    (the engine relies on that to recover after a crash without charging twice);
 *  - nothing throws for a declined card: declines come back as { status: "failed" } with a code + words;
 *  - a thrown error means "we don't know what happened" and the payment stays pending until asked again.
 */
export interface PaymentProvider {
  readonly name: "test";
  readonly live: boolean;
  /** Checks a token from the browser and returns what may be shown (brand, last 4). Null = unusable. */
  describe(token: unknown, type: "card" | "bank"): MethodDetails | null;
  /** Before saving a method: null = fine, otherwise why it was refused. */
  verify(token: string, type: "card" | "bank"): Promise<{ code: string; message: string } | null>;
  charge(input: {
    token: string;
    type: "card" | "bank";
    amountCents: number;
    idempotencyKey: string;
    expMonth?: number | null;
    expYear?: number | null;
  }): Promise<ChargeOutcome>;
  /** The final state of a charge that was "processing" (bank transfers), or of one we lost track of. */
  retrieve(providerRef: string): Promise<ChargeOutcome>;
  refund(input: { paymentRef: string; amountCents: number; idempotencyKey: string }): Promise<{ ok: boolean; providerRef: string; message?: string }>;
  payout(input: { destinationToken: string; amountCents: number; idempotencyKey: string }): Promise<
    { ok: true; providerRef: string; arrivesOn: string } | { ok: false; providerRef: string; message: string }
  >;
}

const testProvider: PaymentProvider = {
  name: "test",
  live: false,
  describe: describeToken,
  async verify(token, type) {
    if (!describeToken(token, type)) return { code: "invalid_method", message: "Use one of the Stayblz test cards or banks." };
    const refused = type === "card" ? saveCheck(token) : null;
    return refused ? { code: refused, message: FAILURE_WORDS[refused] } : null;
  },
  async charge(input) {
    return testCharge(input);
  },
  async retrieve(providerRef) {
    return testRetrieve(providerRef);
  },
  async refund(input) {
    return testRefund(input.idempotencyKey);
  },
  async payout(input) {
    return testPayout(input.destinationToken, input.idempotencyKey);
  },
};

/** Swappable in tests (e.g. a processor that throws, to check crash recovery). */
let current: PaymentProvider = testProvider;
export const paymentProvider = () => current;
export function setPaymentProviderForTests(provider: PaymentProvider | null) {
  current = provider ?? testProvider;
}
/** No live processor is connected yet; the admin "Go live" switch says so. */
export const liveProviderConfigured = () => false;
