import { supabase } from "../supabase";
import { deliver, pushConfig, type Target } from "../push";

/**
 * Billing alerts: saved in the bell list (chat_alerts kind "billing", SQL billing_alert) and pushed to the
 * person's devices like racing alerts. Fire and forget, in order; never throws.
 *
 * Who hears what: a client hears about a new bill, autopay and refunds; a stable's owner and managers hear
 * about payments received and payouts; a subscriber hears about failed or upcoming charges.
 */
interface SavedAlert {
  id: string;
  userId: string;
  title: string | null;
  body: string;
  link: string | null;
}
interface NotifyResult {
  alerts?: SavedAlert[];
  targets?: (Target & { alertId: string })[];
}

export const money = (cents: number) =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Pushes alerts that SQL already saved (e.g. billing_invoice_send returns them). */
export async function pushSaved(result: NotifyResult | null | undefined) {
  const alerts = result?.alerts ?? [];
  const targets = result?.targets ?? [];
  if (!alerts.length || !targets.length || !pushConfig()) return 0;
  const byId = new Map(alerts.map((a) => [a.id, a]));
  const devices = new Map<string, Target & { alertId: string }>();
  for (const t of targets) if (byId.has(t.alertId)) devices.set(t.endpoint, t);
  return deliver([...devices.values()], (t) => {
    const a = byId.get((t as Target & { alertId: string }).alertId)!;
    return { kind: "billing", alert: "billing", alertId: a.id, tag: `billing-${a.id}`, url: a.link ?? "/billing", title: a.title ?? "Stayblz Billing", body: a.body };
  });
}

async function send(users: string[], title: string, body: string, link: string, ref: string | null) {
  try {
    const unique = [...new Set(users.filter(Boolean))];
    if (!unique.length) return 0;
    const { data, error } = await supabase.rpc("billing_alert", { p_users: unique, p_title: title, p_body: body, p_link: link, p_ref: ref });
    if (error || !data) return 0;
    await pushSaved(data as NotifyResult);
    return (data as NotifyResult).alerts?.length ?? 0;
  } catch {
    return 0;
  }
}

let pending: Promise<unknown> = Promise.resolve();
export function billingAlert(users: string[], title: string, body: string, link: string, ref: string | null = null) {
  pending = pending.then(() => send(users, title, body, link, ref));
}
export function billingPushSaved(result: NotifyResult | null | undefined) {
  pending = pending.then(() => pushSaved(result).catch(() => 0));
}
/** Resolves when every queued alert has been handled (tests). */
export function billingAlertsSettled() {
  return pending;
}

/** The owners and managers of a stable. */
export async function stableStaff(stableId: string): Promise<string[]> {
  const { data } = await supabase.rpc("billing_stable_staff", { p_stable: stableId });
  return Array.isArray(data) ? (data as string[]) : [];
}
