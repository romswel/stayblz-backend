import { Router } from "express";
import type { AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { isUuid } from "../middleware/stable";
import { supabase } from "../lib/supabase";

/**
 * Your own chat folders (shared by personal and team chats). Chats are put in a folder with
 * POST /api/(team-)messages/:id/settings { folder }. Mounted at /api/messages/folders.
 */
const router = Router();
const me = (req: any) => (req as AuthenticatedRequest).user.id;
const MAX_FOLDERS = 20;
const unavailable = (res: any) => res.status(503).json({ error: "Folders are unavailable right now. Try again shortly." });
const cleanName = (value: unknown) =>
  typeof value === "string" && value.trim().length >= 1 && value.trim().length <= 40 ? value.trim() : null;
const duplicate = (error: any) => error?.code === "23505" || /chat_folders_name|duplicate/.test(error?.message ?? "");

router.get(
  "/",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase
      .from("chat_folders")
      .select("id,name,position")
      .eq("user_id", me(req))
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return unavailable(res);
    res.json({ folders: data ?? [] });
  }),
);

router.post(
  "/",
  asyncRoute(async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: "Use 1–40 characters for the folder name." });
    const { data: existing, error: countError } = await supabase.from("chat_folders").select("id").eq("user_id", me(req));
    if (countError) return unavailable(res);
    if ((existing ?? []).length >= MAX_FOLDERS) return res.status(409).json({ error: `You can have up to ${MAX_FOLDERS} folders.` });
    const { data, error } = await supabase
      .from("chat_folders")
      .insert({ user_id: me(req), name, position: (existing ?? []).length })
      .select("id,name,position")
      .single();
    if (error) return duplicate(error) ? res.status(409).json({ error: "You already have a folder with that name." }) : unavailable(res);
    res.status(201).json({ folder: data });
  }),
);

router.post(
  "/:folder/rename",
  asyncRoute(async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!isUuid(req.params.folder)) return res.status(404).json({ error: "Folder not found." });
    if (!name) return res.status(400).json({ error: "Use 1–40 characters for the folder name." });
    const { data, error } = await supabase
      .from("chat_folders")
      .update({ name })
      .eq("id", req.params.folder)
      .eq("user_id", me(req))
      .select("id,name,position")
      .maybeSingle();
    if (error) return duplicate(error) ? res.status(409).json({ error: "You already have a folder with that name." }) : unavailable(res);
    if (!data) return res.status(404).json({ error: "Folder not found." });
    res.json({ folder: data });
  }),
);

/** Deleting a folder keeps its chats; they just leave the folder. */
router.post(
  "/:folder/delete",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.folder)) return res.status(404).json({ error: "Folder not found." });
    const { error } = await supabase.from("chat_folders").delete().eq("id", req.params.folder).eq("user_id", me(req));
    if (error) return unavailable(res);
    res.json({ ok: true });
  }),
);

export default router;
