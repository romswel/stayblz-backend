import { supabase } from "./supabase";
import { bumpPeople } from "./chatLive";
import { deliver, pushConfig, type Target } from "./push";

/**
 * Bell alerts for co-owned horses (chat_alerts kind "horse", SQL horse_alert in 202611250001_horse_coowners.sql):
 * a co-owner invite, an invite accepted, an owner's edit, a change waiting for approval and its answer.
 * Worded here, saved by SQL, pushed like racing alerts. Fire and forget, in order; never throws.
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

async function send(users: string[], actor: string, title: string, body: string, link: string, horseId: string, collapse: boolean) {
  try {
    const unique = [...new Set(users.filter((u) => u && u !== actor))];
    if (!unique.length) return 0;
    const { data, error } = await supabase.rpc("horse_alert", {
      p_users: unique,
      p_actor: actor,
      p_title: title,
      p_body: body,
      p_link: link,
      p_ref: horseId,
      p_collapse: collapse,
    });
    if (error || !data) return 0;
    const result = data as NotifyResult;
    const alerts = result.alerts ?? [];
    bumpPeople(alerts.map((a) => a.userId));
    const targets = result.targets ?? [];
    if (alerts.length && targets.length && pushConfig()) {
      const byId = new Map(alerts.map((a) => [a.id, a]));
      const devices = new Map<string, Target & { alertId: string }>();
      for (const t of targets) if (byId.has(t.alertId)) devices.set(t.endpoint, t);
      await deliver([...devices.values()], (t) => {
        const a = byId.get((t as Target & { alertId: string }).alertId)!;
        return { kind: "racing", alert: "horse", alertId: a.id, tag: `horse-${horseId}`, url: a.link ?? "/account/horses", title: a.title ?? "Stayblz", body: a.body };
      });
    }
    return alerts.length;
  } catch {
    return 0;
  }
}

let pending: Promise<unknown> = Promise.resolve();

/** Alert `users` (never the actor) about a horse. `collapse` merges a burst of similar alerts into one. */
export function horseAlert(
  users: string[],
  actor: string,
  horseId: string,
  words: { title: string; body: string; link: string },
  collapse = false,
) {
  pending = pending.then(() => send(users, actor, words.title, words.body, words.link, horseId, collapse));
}

/** Resolves when every queued alert has been handled (tests). */
export function horseAlertsSettled() {
  return pending;
}
