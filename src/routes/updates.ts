import { Router } from "express";
import { optionalAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { isUuid } from "../middleware/stable";
import { UPDATE_KINDS, UPDATE_REACTIONS, UpdateError, updateStore, type UpdateKind, type UpdateReaction } from "../lib/updates";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const reader = (req: unknown) => (req as Partial<AuthenticatedRequest>).user ?? null;
/** Reactions are cheap, but one account shouldn't be able to hammer the table. */
const reactLimit = authLimit("update-react", 120, 10 * 60_000, (req) => reader(req)?.id ?? null);

/** Public Updates feed. Signed-in accounts also see members-only posts. */
const router = Router();
router.use(optionalAuth);

router.get(
  "/",
  asyncRoute(async (req, res) => {
    const members = !!(req as Partial<AuthenticatedRequest>).user;
    const kind = typeof req.query.kind === "string" && req.query.kind ? req.query.kind : null;
    const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const before = typeof req.query.before === "string" && req.query.before ? req.query.before : null;
    const limit = Number(req.query.limit ?? 12);
    if (
      (kind && !UPDATE_KINDS.includes(kind as UpdateKind)) ||
      (before && Number.isNaN(Date.parse(before))) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 30
    ) {
      res.status(400).json({ error: "Those filters aren't valid." });
      return;
    }
    try {
      const feed = await updateStore.list({
        members,
        kind,
        query: query || null,
        before: before ? new Date(before).toISOString() : null,
        limit,
      });
      res.json({ ...feed, signedIn: members });
    } catch {
      res.status(503).json({ error: "Updates are unavailable right now. Try again shortly." });
    }
  }),
);

/** Reaction counts for up to 30 posts at once: `?slugs=a,b,c`. Anyone who can read a post sees its counts. */
router.get(
  "/reactions",
  asyncRoute(async (req, res) => {
    const raw = typeof req.query.slugs === "string" ? req.query.slugs : "";
    const slugs = [...new Set(raw.split(",").map((slug) => slug.trim()).filter(Boolean))];
    if (slugs.length > 30 || slugs.some((slug) => slug.length > 80 || !SLUG.test(slug))) {
      res.status(400).json({ error: "Those posts aren't valid." });
      return;
    }
    if (!slugs.length) {
      res.json({ reactions: {} });
      return;
    }
    const user = reader(req);
    try {
      const reactions = await updateStore.reactions(slugs, !!user, user && isUuid(user.id) ? user.id : null);
      res.json({ reactions: reactions ?? {} });
    } catch {
      res.status(503).json({ error: "Reactions are unavailable right now." });
    }
  }),
);

/** Add or take back a reaction: `{ reaction: "like", on: true }`. Signed in only. */
router.post(
  "/:slug/reactions",
  reactLimit,
  asyncRoute(async (req, res) => {
    const user = reader(req);
    if (!user) {
      res.status(401).json({ error: "Log in to react to posts." });
      return;
    }
    const slug = String(req.params.slug);
    const reaction = (req.body ?? {}).reaction;
    const on = (req.body ?? {}).on;
    if (!SLUG.test(slug) || slug.length > 80 || !UPDATE_REACTIONS.includes(reaction) || typeof on !== "boolean") {
      res.status(400).json({ error: "That reaction isn't valid." });
      return;
    }
    if (!isUuid(user.id)) {
      res.status(409).json({ error: "Development profiles can't react to posts." });
      return;
    }
    try {
      const summary = await updateStore.react(user.id, slug, reaction as UpdateReaction, on);
      res.json({ reactions: summary ?? { counts: {}, mine: [] } });
    } catch (error) {
      const code = error instanceof UpdateError ? error.code : "unavailable";
      if (code === "unknown_update") res.status(404).json({ error: "That update was not found." });
      else if (code === "not_allowed") res.status(403).json({ error: "This account can't react to posts." });
      else if (code === "unknown_reaction") res.status(400).json({ error: "That reaction isn't valid." });
      else res.status(503).json({ error: "Reactions are unavailable right now. Try again shortly." });
    }
  }),
);

router.get(
  "/:slug",
  asyncRoute(async (req, res) => {
    const slug = String(req.params.slug);
    if (!SLUG.test(slug) || slug.length > 80) {
      res.status(404).json({ error: "That update was not found." });
      return;
    }
    const members = !!(req as Partial<AuthenticatedRequest>).user;
    try {
      const found = await updateStore.get(slug, members);
      if (!found) {
        res.status(404).json({
          code: members ? "not_found" : "not_found_or_members",
          error: "That update was not found.",
        });
        return;
      }
      res.json(found);
    } catch {
      res.status(503).json({ error: "Updates are unavailable right now. Try again shortly." });
    }
  }),
);

export default router;
