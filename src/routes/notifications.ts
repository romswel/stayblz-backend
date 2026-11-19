import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { isPushEndpoint, pushConfig, pushTest } from "../lib/push";

/**
 * Notifications (signed in), mounted at /api/notifications. Stayblz Chat is the first thing that notifies.
 *   GET  /settings            your choices + whether alerts-when-closed (Web Push) work on this server
 *   POST /settings            change choices: enabled, chatMessages, chatRequests, chatMentions, chatReactions, paddockCalls,
 *                             previews, sound, prompted
 *   GET  /alerts              Stayblz Chat alerts for the bell, newest first (+ how many are unread); ?since= for new ones
 *   POST /alerts/read         { ids: [...] } or { all: true }
 *   POST /push/subscribe      save this device's push subscription (from PushManager.subscribe)
 *   POST /push/unsubscribe    forget this device
 *   POST /push/test           send a test alert to your devices
 * Rows: notification_settings + push_subscriptions (202611170002_notifications.sql), chat_alerts (202611190003_chat_alerts.sql).
 */
const router = Router();
router.use(requireAuth);
const me = (req: any) => (req as AuthenticatedRequest).user;
const unavailable = (res: Response) =>
  res.status(503).json({ error: "Notification settings are unavailable right now. Try again shortly." });

function pushInfo() {
  const config = pushConfig();
  return { available: !!config, publicKey: config?.publicKey ?? null };
}

router.get(
  "/settings",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.rpc("notification_settings_get", { p_user: me(req).id });
    if (error) return unavailable(res);
    res.json({ settings: data, push: pushInfo() });
  }),
);

const KEYS = ["enabled", "chatMessages", "chatRequests", "chatMentions", "chatReactions", "paddockCalls", "previews", "sound", "prompted"];
router.post(
  "/settings",
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const changes: Record<string, boolean> = {};
    for (const key of Object.keys(body)) {
      if (!KEYS.includes(key) || typeof body[key] !== "boolean")
        return res.status(400).json({ error: "Those settings couldn't be saved." });
      changes[key] = body[key];
    }
    if (!Object.keys(changes).length) return res.status(400).json({ error: "Nothing to change." });
    const { data, error } = await supabase.rpc("notification_settings_set", { p_user: me(req).id, p_changes: changes });
    if (error) return unavailable(res);
    res.json({ settings: data, push: pushInfo() });
  }),
);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get(
  "/alerts",
  asyncRoute(async (req, res) => {
    const since = typeof req.query.since === "string" && ISO.test(req.query.since) ? req.query.since : null;
    const { data, error } = await supabase.rpc("chat_alerts_list", { p_user: me(req).id, p_since: since, p_limit: 40 });
    if (error) return unavailable(res);
    res.set("Cache-Control", "no-store");
    res.json(data);
  }),
);

router.post(
  "/alerts/read",
  asyncRoute(async (req, res) => {
    const ids = req.body?.ids;
    const all = req.body?.all === true;
    if (!all && (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((id) => typeof id === "string" && UUID.test(id))))
      return res.status(400).json({ error: "Nothing to mark as read." });
    const { data, error } = await supabase.rpc("chat_alerts_mark_read", { p_user: me(req).id, p_ids: all ? null : ids });
    if (error) return unavailable(res);
    res.json({ unread: data ?? 0 });
  }),
);

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
function subscriptionInput(body: any) {
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  // Only real browser push services (lib/push.ts): this server will POST to the address.
  if (!isPushEndpoint(endpoint)) return null;
  if (typeof p256dh !== "string" || p256dh.length < 20 || p256dh.length > 200 || !B64URL.test(p256dh)) return null;
  if (typeof auth !== "string" || auth.length < 8 || auth.length > 100 || !B64URL.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

router.post(
  "/push/subscribe",
  asyncRoute(async (req, res) => {
    if (!pushConfig()) return res.status(409).json({ error: "Alerts when Stayblz is closed aren't switched on yet.", code: "push_unavailable" });
    const sub = subscriptionInput(req.body);
    if (!sub) return res.status(400).json({ error: "This browser's notification details weren't valid. Try again." });
    const agent = String(req.headers["user-agent"] ?? "").slice(0, 300) || null;
    const { data, error } = await supabase.rpc("push_subscription_save", {
      p_user: me(req).id,
      p_endpoint: sub.endpoint,
      p_p256dh: sub.p256dh,
      p_auth: sub.auth,
      p_agent: agent,
    });
    if (error) return unavailable(res);
    res.status(201).json({ ok: true, devices: data });
  }),
);

router.post(
  "/push/unsubscribe",
  asyncRoute(async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string" || endpoint.length > 1000) return res.status(400).json({ error: "Unknown device." });
    const { error } = await supabase.rpc("push_subscription_remove", { p_user: me(req).id, p_endpoint: endpoint });
    if (error) return unavailable(res);
    res.json({ ok: true });
  }),
);

// A test alert, at most 5 per 10 minutes per person.
const tests = new Map<string, number[]>();
router.post(
  "/push/test",
  asyncRoute(async (req, res) => {
    const id = me(req).id;
    const now = Date.now();
    const recent = (tests.get(id) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= 5) return res.status(429).json({ error: "That's a few tests already. Wait a few minutes.", retryAfterSeconds: 600 });
    recent.push(now);
    tests.set(id, recent);
    if (tests.size > 5000) tests.delete(tests.keys().next().value!);
    const result = await pushTest(id);
    if (!result.available) return res.status(409).json({ error: "Alerts when Stayblz is closed aren't switched on yet.", code: "push_unavailable" });
    res.json(result);
  }),
);

export default router;
