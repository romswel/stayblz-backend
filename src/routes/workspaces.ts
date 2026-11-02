import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import {
  requireStable,
  requireStableManager,
  isUuid,
} from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { scope, text } from "../lib/workspace";
const router = Router();
router.use(requireAuth);
const failure = (res: any) =>
  res
    .status(503)
    .json({
      error:
        "Stable services are temporarily unavailable. Please try again later.",
    });
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const { data, error } = await supabase
      .from("stable_memberships")
      .select("stable_id,role,member_stables(id,name)")
      .eq("user_id", user.id)
      .order("stable_id");
    if (error) return failure(res);
    res.json({
      stables: (data ?? [])
        .filter((r: any) => r.member_stables)
        .map((r: any) => ({
          id: r.stable_id,
          name: r.member_stables.name,
          role: r.role,
        })),
    });
  }),
);
router.post(
  "/",
  asyncRoute(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (user.passwordSetupRequired || !isUuid(user.id))
      return res
        .status(403)
        .json({
          error:
            "Use a verified account with a completed password setup to create a stable.",
        });
    let name;
    try {
      name = text(req.body?.name, 100);
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a stable name of 1–100 characters." });
    }
    const { data, error } = await supabase.rpc("create_member_stable", {
      p_user: user.id,
      p_name: name,
      p_display: user.displayName,
    });
    if (error) {
      if (error.message?.includes("stable_limit"))
        return res
          .status(409)
          .json({ error: "You can own up to ten stables." });
      return failure(res);
    }
    res.status(201).json({ stable: { id: data, name, role: "owner" } });
  }),
);
router.post(
  "/accept-invitation",
  asyncRoute(async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    const token = req.body?.token;
    if (user.passwordSetupRequired)
      return res.status(403).json({ error: "Complete password setup first." });
    if (
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !user.email
    )
      return res
        .status(400)
        .json({ error: "This invitation cannot be accepted." });
    const { data, error } = await supabase.rpc("accept_stable_invitation", {
      p_user: user.id,
      p_email: user.email.toLowerCase(),
      p_display: user.displayName,
      p_hash: createHash("sha256").update(token).digest("hex"),
    });
    if (error) {
      if (error.message?.includes("invalid_invitation"))
        return res
          .status(400)
          .json({
            error:
              "This invitation is expired, already used, revoked, or addressed to a different email.",
          });
      return failure(res);
    }
    res.json({ stableId: data });
  }),
);
router.get(
  "/members",
  requireStable,
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("stable_memberships")
      .select("user_id,display_name,role")
      .eq("stable_id", scope(req).stable.id)
      .order("display_name");
    if (error) return failure(res);
    res.json({
      members: (data ?? []).map((r) => ({
        id: r.user_id,
        displayName: r.display_name,
        role: r.role,
      })),
    });
  }),
);
router.patch(
  "/members/:id",
  requireStable,
  requireStableManager,
  asyncRoute(async (req, res) => {
    const { stable, user } = scope(req);
    const role = req.body?.role;
    if (stable.role !== "owner")
      return res
        .status(403)
        .json({ error: "Only the stable owner can change team roles." });
    if (
      !isUuid(req.params.id) ||
      req.params.id === user.id ||
      !["manager", "member"].includes(role)
    )
      return res
        .status(400)
        .json({
          error:
            "Choose a teammate and a valid stable role. The owner cannot be changed here.",
        });
    const { data, error } = await supabase
      .from("stable_memberships")
      .update({ role })
      .eq("stable_id", stable.id)
      .eq("user_id", req.params.id)
      .neq("role", "owner")
      .select("user_id")
      .maybeSingle();
    if (error) return failure(res);
    if (!data) return res.status(404).json({ error: "Team member not found." });
    res.json({ ok: true });
  }),
);
router.post(
  "/members/:id/remove",
  requireStable,
  requireStableManager,
  asyncRoute(async (req, res) => {
    const { stable } = scope(req);
    if (!isUuid(req.params.id))
      return res.status(400).json({ error: "Invalid team member." });
    // Managers can remove ordinary members only; ownership cannot be removed.
    let query = supabase
      .from("stable_memberships")
      .delete()
      .eq("stable_id", stable.id)
      .eq("user_id", req.params.id)
      .neq("role", "owner");
    if (stable.role === "manager") query = query.eq("role", "member");
    const { data, error } = await query.select("user_id").maybeSingle();
    if (error) return failure(res);
    if (!data)
      return res
        .status(404)
        .json({ error: "Member not found or role cannot be removed." });
    res.json({ ok: true });
  }),
);
router.get(
  "/invitations",
  requireStable,
  requireStableManager,
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("stable_invitations")
      .select("id,email,role,expires_at")
      .eq("stable_id", scope(req).stable.id)
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    if (error) return failure(res);
    res.json({ invitations: data ?? [] });
  }),
);
router.post(
  "/invitations",
  requireStable,
  requireStableManager,
  asyncRoute(async (req, res) => {
    const { stable, user } = scope(req);
    let email;
    try {
      email = text(req.body?.email, 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Error();
    } catch {
      return res
        .status(400)
        .json({ error: "Enter the teammate’s account email." });
    }
    const role = req.body?.role ?? "member";
    if (
      !["member", "manager"].includes(role) ||
      (role === "manager" && stable.role !== "owner")
    )
      return res
        .status(403)
        .json({ error: "Only the stable owner can invite a manager." });
    const token = randomBytes(32).toString("hex");
    const { data, error } = await supabase
      .from("stable_invitations")
      .insert({
        stable_id: stable.id,
        email,
        role,
        invited_by: user.id,
        token_hash: createHash("sha256").update(token).digest("hex"),
      })
      .select("id,email,role,expires_at")
      .single();
    if (error) return failure(res);
    res.status(201).json({ invitation: data, token });
  }),
);
router.post(
  "/invitations/:id/revoke",
  requireStable,
  requireStableManager,
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id))
      return res.status(400).json({ error: "Invalid invitation." });
    let query = supabase
      .from("stable_invitations")
      .delete()
      .eq("id", req.params.id)
      .eq("stable_id", scope(req).stable.id)
      .is("accepted_at", null);
    if (scope(req).stable.role === "manager")
      query = query.eq("role", "member");
    const { error } = await query;
    if (error) return failure(res);
    res.json({ ok: true });
  }),
);
export default router;
