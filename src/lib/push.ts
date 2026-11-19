import webpush from "web-push";
import { supabase } from "./supabase";

/**
 * Web Push ("alerts when Stayblz is closed"). Switched on only when the server has VAPID keys:
 *   PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY, PUSH_CONTACT (mailto: or https: address for the push services).
 * Without them every function here is a quiet no-op and /api/notifications says push isn't available, so the
 * site never claims to send alerts it can't. Generate keys with `npm run push:keys`.
 *
 * Sending never blocks a chat request: callers fire and forget. Gone subscriptions (404/410) are deleted.
 * Stayblz Chat alerts are built in lib/chatAlerts.ts; Paddock alerts below.
 */
export interface PushPayload {
  title: string;
  body: string;
  /** Same tag = the phone replaces the earlier alert for that chat instead of stacking them. */
  tag: string;
  url: string;
  kind: "chat" | "test" | "call" | "meeting" | "racing";
  /** Stayblz Chat: what happened (message, mention, reaction…). Racing: race_entry, race_result, workout, digest… */
  alert?: string;
  /** The saved alert (chat) or the call alert (Paddock, so "Decline" on the notification can answer it). */
  alertId?: string;
  /** Same-origin picture for the notification (a photo message); the service worker loads it with the cookie. */
  image?: string;
  /** Same-origin profile picture of who it's from. */
  icon?: string;
  /** Team chats: the stable, sent with the picture request. */
  stableId?: string;
}
export interface Target {
  userId?: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  previews?: boolean;
  request?: boolean;
}

/**
 * Only the browsers' own push services. A subscription is an address our server will POST to, so anything else
 * (an internal host, someone's own server) is refused when saving and again before every send.
 */
const PUSH_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge on Android, Opera, Brave, Samsung Internet
  "android.googleapis.com",
  "updates.push.services.mozilla.com", // Firefox
  "push.services.mozilla.com",
  "web.push.apple.com", // Safari, iPhone home-screen apps
  "notify.windows.com", // Edge on Windows (*.notify.windows.com)
];
export function isPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length < 20 || endpoint.length > 1000) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    return PUSH_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

let configuredFor = "";
export function pushConfig() {
  const publicKey = process.env.PUSH_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.PUSH_VAPID_PRIVATE_KEY?.trim() ?? "";
  const contact = process.env.PUSH_CONTACT?.trim() || "mailto:support@stayblz-app.com";
  if (!publicKey || !privateKey) return null;
  if (configuredFor !== publicKey + privateKey + contact) {
    try {
      webpush.setVapidDetails(contact, publicKey, privateKey);
      configuredFor = publicKey + privateKey + contact;
    } catch {
      return null;
    }
  }
  return { publicKey };
}

/** Overridable in tests. */
export const pushSender = {
  send: (target: Target, payload: string) =>
    webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
      TTL: 60 * 60 * 6,
      urgency: "high",
    }),
};

export async function deliver(targets: Target[], payload: (t: Target) => PushPayload) {
  let sent = 0;
  await Promise.all(
    targets.filter((target) => isPushEndpoint(target.endpoint)).map(async (target) => {
      try {
        await pushSender.send(target, JSON.stringify(payload(target)));
        sent++;
        await supabase.rpc("push_subscription_result", { p_endpoint: target.endpoint, p_ok: true });
      } catch (error: any) {
        const status = Number(error?.statusCode ?? 0);
        if (status === 404 || status === 410)
          await supabase.rpc("push_subscription_result", { p_endpoint: target.endpoint, p_ok: false });
      }
    }),
  );
  return sent;
}

// A burst of messages in one chat sends one alert per person every few seconds, not one per message.
const recent = new Map<string, number>();
const BURST_MS = 6_000;
export function throttled(key: string) {
  const now = Date.now();
  const last = recent.get(key) ?? 0;
  if (now - last < BURST_MS) return true;
  recent.set(key, now);
  if (recent.size > 5000) recent.delete(recent.keys().next().value!);
  return false;
}

const clip = (text: string, max = 140) => (text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text);

/** What a message says in an alert: its text, or what was sent. */
export function messageSummary(message: { body?: string; attachment?: { type?: string; name?: string } | null }) {
  const body = (message.body ?? "").replace(/\s+/g, " ").trim();
  if (body) return clip(body);
  const type = message.attachment?.type ?? "";
  if (type.startsWith("image/")) return "📷 Sent a photo";
  if (type.startsWith("audio/")) return "🎤 Sent a voice message";
  if (type.startsWith("video/")) return "🎬 Sent a video";
  if (message.attachment) return "📎 Sent a file";
  return "Sent a message";
}

/** Paddock alerts (incoming call, meeting started, invited) for people who allow call alerts. Never throws. */
export async function pushPaddock(
  alert: { id: string; kind: "ring" | "started" | "invited"; meetingId: string; code: string; title: string; fromName: string; video: boolean; when?: string },
  targets: { endpoint: string; p256dh: string; auth: string }[],
) {
  try {
    if (!pushConfig() || !targets.length) return 0;
    const url = `/paddock/${alert.code}`;
    const payload: PushPayload =
      alert.kind === "ring"
        ? {
            kind: "call",
            alertId: alert.id,
            tag: `call-${alert.meetingId}`,
            url,
            title: `${alert.fromName} is calling you`,
            body: `${alert.video ? "Video" : "Voice"} call on Stayblz Paddock · ${clip(alert.title, 80)}`,
          }
        : alert.kind === "started"
          ? { kind: "meeting", tag: `meeting-${alert.meetingId}`, url, title: `${clip(alert.title, 80)} has started`, body: `${alert.fromName} is in the meeting. Tap to join.` }
          : {
              kind: "meeting",
              tag: `meeting-${alert.meetingId}`,
              url,
              title: `${alert.fromName} invited you to a meeting`,
              body: alert.when ? `${clip(alert.title, 80)} · ${alert.when}` : clip(alert.title, 120),
            };
    return await deliver(targets, () => payload);
  } catch {
    return 0;
  }
}

/** "Send a test notification" for this account's devices. */
export async function pushTest(userId: string) {
  if (!pushConfig()) return { available: false, sent: 0, devices: 0 };
  const { data } = await supabase.rpc("push_subscriptions_for", { p_user: userId });
  const targets: Target[] = Array.isArray(data) ? data : [];
  const sent = await deliver(targets, () => ({
    kind: "test",
    tag: "stayblz-test",
    url: "/account/notifications",
    title: "Stayblz notifications are on",
    body: "This is how Stayblz Chat messages, mentions and calls will show on this device.",
  }));
  return { available: true, sent, devices: targets.length };
}

/** For tests. */
export function resetPush() {
  recent.clear();
  configuredFor = "";
}
