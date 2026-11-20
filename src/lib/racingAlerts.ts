import { supabase } from "./supabase";
import { deliver, pushConfig, type PushPayload, type Target } from "./push";

/**
 * Racing alerts (migration 202611190004_racing_follows.sql). After the publishing tool publishes a card, adds
 * runners, scratches one, makes a race official or publishes a workout, the route calls notifyRacing (fire and
 * forget). The SQL decides who follows that horse / person / family, saves one alert per person (bell + on-screen),
 * skips anything already sent and old history; this file sends Web Push to their devices.
 *
 * A future licensed data feed calls the same function after each import, so alerts work the same either way.
 */
export type RacingEvent = "day" | "race" | "scratch" | "workout";

interface RacingAlert {
  id: string;
  userId: string;
  kind: string;
  title: string | null;
  body: string;
  link: string | null;
}
interface NotifyResult {
  alerts?: RacingAlert[];
  targets?: (Target & { alertId: string })[];
}

/** One push per person: their alert, or a short digest when one change touched several of their follows. */
export function racingPushes(event: RacingEvent, ref: string, alerts: RacingAlert[]) {
  const byUser = new Map<string, RacingAlert[]>();
  for (const alert of alerts) byUser.set(alert.userId, [...(byUser.get(alert.userId) ?? []), alert]);
  const payloads = new Map<string, PushPayload>();
  for (const [userId, list] of byUser) {
    const [first] = list;
    payloads.set(
      userId,
      list.length === 1
        ? {
            kind: "racing",
            alert: first.kind,
            alertId: first.id,
            tag: `racing-${first.id}`,
            url: first.link ?? "/my-racing",
            title: first.title ?? "Racing update",
            body: first.body,
          }
        : {
            kind: "racing",
            alert: "digest",
            tag: `racing-${event}-${ref}`,
            url: event === "day" ? `/racing/days/${ref}` : "/my-racing",
            title: `${list.length} updates on racing you follow`,
            body: `${first.title ?? "Racing update"} and ${list.length - 1} more`,
          },
    );
  }
  return payloads;
}

/** Saves the alerts and pushes them. Never throws; returns what happened (tests use it). */
export async function sendRacingAlerts(event: RacingEvent, ref: string) {
  try {
    const { data, error } = await supabase.rpc("racing_notify", { p_event: event, p_ref: ref });
    if (error || !data) return { saved: 0, pushed: 0 };
    const { alerts = [], targets = [] } = data as NotifyResult;
    if (!alerts.length || !targets.length || !pushConfig()) return { saved: alerts.length, pushed: 0 };
    const payloads = racingPushes(event, ref, alerts);
    // The SQL returns a device once per alert; each device gets one push.
    const devices = new Map<string, Target>();
    for (const target of targets) if (target.userId && payloads.has(target.userId)) devices.set(target.endpoint, target);
    const pushed = await deliver([...devices.values()], (t) => payloads.get(t.userId!)!);
    return { saved: alerts.length, pushed };
  } catch {
    return { saved: 0, pushed: 0 };
  }
}

let pending: Promise<unknown> = Promise.resolve();
/** Fire and forget, in order (a scratch never overtakes the card it belongs to). */
export function notifyRacing(event: RacingEvent, ref: string) {
  pending = pending.then(() => sendRacingAlerts(event, ref));
}
/** Resolves when every alert queued so far has been sent (tests). */
export function racingAlertsSettled() {
  return pending;
}
