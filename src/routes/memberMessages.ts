import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireStable, isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { scope, participantIds } from "../lib/workspace";
import { chatError, chatRoutes, loadThread } from "./chat";

/** Team chats inside the selected stable (X-Stayblz-Stable). Only teammates can be added. */
const router = Router();
// Images in <img> tags can't send the stable header, so the file route may name the stable in the query.
router.use((req, _res, next) => {
  const stable = req.query.stable;
  if (req.method === "GET" && /^\/[^/]+\/files\/[^/]+$/.test(req.path) && typeof stable === "string" && !req.get("X-Stayblz-Stable"))
    req.headers["x-stayblz-stable"] = stable;
  next();
});
router.use(requireAuth, requireStable);

/** Start (or reopen) a one-to-one chat with a teammate. */
router.post(
  "/direct",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.body?.memberId))
      return res.status(400).json({ error: "Choose a teammate." });
    const { stable, user } = scope(req);
    const { data, error } = await supabase.rpc("chat_start_team_direct", {
      p_user: user.id,
      p_stable: stable.id,
      p_other: req.body.memberId,
    });
    if (error) {
      if (error.message?.includes("invalid_participants"))
        return res.status(400).json({ error: "Choose someone else in this stable." });
      return chatError(res, error);
    }
    const thread = await loadThread(req, "team", data);
    if (thread.error) return chatError(res, thread.error);
    res.status(201).json(thread.data);
  }),
);

/** New group chat with chosen teammates. */
router.post(
  "/",
  asyncRoute(async (req, res) => {
    const rawTitle = req.body?.title;
    let members: string[];
    try {
      members = participantIds(req.body?.memberIds ?? []);
      if (typeof rawTitle !== "string" || !rawTitle.trim() || rawTitle.trim().length > 120)
        throw Error();
    } catch {
      return res
        .status(400)
        .json({ error: "Enter a group name and select up to 29 teammates." });
    }
    const { stable, user } = scope(req);
    const { data, error } = await supabase.rpc("create_member_conversation", {
      p_user: user.id,
      p_stable: stable.id,
      p_title: rawTitle.trim(),
      p_members: members,
    });
    if (error) {
      if (error.message?.includes("invalid_participants"))
        return res
          .status(400)
          .json({ error: "Every participant must belong to this stable." });
      return res.status(503).json({ error: "Group could not be created. Try again." });
    }
    const thread = await loadThread(req, "team", data.id);
    if (thread.error) return chatError(res, thread.error);
    res.status(201).json(thread.data);
  }),
);

router.use(chatRoutes("team"));
export default router;
