import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { authLimit } from "../middleware/authLimits";
import { supabase } from "../lib/supabase";
import { accountStore, roleRank } from "../lib/accounts";
import { featureAccess } from "../lib/billing/engine";
import { notifyChat } from "../lib/chatAlerts";
import {
  REQUEST_STATUS,
  StallionInputError,
  mareInput,
  publishProblem,
  requestInput,
  stallionInput,
} from "../lib/stallionInput";
import { sireLine } from "../lib/stallionPedigree";
import { WriterError, draftDescription, writerAvailable, type WriterFacts } from "../lib/stallionWriter";
import { chatError } from "./chat";
import { claimAndAttach, fileIds, removeStoredKeys, storedKeys, uploadRoutes } from "./stallionFiles";
import { loadProfile, stallionsDown } from "./stallionsPublic";

/**
 * Stayblz Stallions, signed in (/api/stallions): list and manage your stallions, save stallions, send and track
 * breeding requests, keep your mares, and (admins) hide a stallion. The public side is routes/stallionsPublic.ts.
 */
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.method !== "GET" && (req as AuthenticatedRequest).user.passwordSetupRequired) {
    res.status(403).json({ error: "Complete password setup before using Stayblz Stallions." });
    return;
  }
  next();
});

const MAX_STALLIONS = 50;
const MAX_MARES = 50;
const me = (req: Request) => (req as AuthenticatedRequest).user;
const isAdmin = (req: Request) => roleRank(me(req).role) >= roleRank("admin");
const perUser = (req: Request) => (req as Partial<AuthenticatedRequest>).user?.id ?? null;
const requestLimit = authLimit("stallion-request", 12, 10 * 60_000, perUser);
const writerLimit = authLimit("stallion-writer", 10, 60 * 60_000, perUser);
const badInput = (res: Response, e: unknown) =>
  res.status(400).json({ error: e instanceof StallionInputError ? e.message : "Check the form and try again." });
const notYours = (res: Response) => res.status(404).json({ error: "Stallion not found." });

/**
 * Listing is open to everyone until a Stallion Showcase plan is on sale and paywalls are on (Billing). Then
 * owners need that plan; staff always can.
 */
async function listingAccess(user: AuthenticatedRequest["user"]) {
  const access = await featureAccess(user, "stallions.list");
  if (access.allowed) return { allowed: true as const };
  const { data } = await supabase.from("billing_catalog").select("id,status,features").eq("status", "active").contains("features", ["stallions.list"]).limit(1);
  if (!data?.length) return { allowed: true as const };
  return { allowed: false as const, plan: data[0].id as string };
}
const needsPlan = (res: Response, plan: string) =>
  res.status(402).json({ error: "Listing stallions needs the Stallion Showcase plan.", code: "plan_required", plan });

async function ownStallion(req: Request, res: Response) {
  if (!isUuid(req.params.id)) {
    notYours(res);
    return null;
  }
  const { data, error } = await supabase.from("stallions").select("*").eq("id", req.params.id).eq("owner_id", me(req).id).maybeSingle();
  if (error) {
    stallionsDown(res, error);
    return null;
  }
  if (!data) notYours(res);
  return data;
}
async function respondWithProfile(req: Request, res: Response, id: string, status = 200) {
  const { data, error } = await loadProfile(id, me(req).id, isAdmin(req));
  if (error || !data) return stallionsDown(res, error);
  res.status(status).json({ stallion: data });
}

/* ---------- Your stallions ---------- */

router.get(
  "/mine",
  asyncRoute(async (req, res) => {
    const [{ data, error }, access] = await Promise.all([
      supabase.rpc("stallions_mine", { p_owner: me(req).id }),
      listingAccess(me(req)),
    ]);
    if (error) return stallionsDown(res, error);
    res.json({ stallions: data ?? [], access, writer: writerAvailable() });
  }),
);

router.post(
  "/",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = stallionInput(req.body);
    } catch (e) {
      return badInput(res, e);
    }
    const files = fileIds(req.body);
    if (typeof files === "string") return res.status(400).json({ error: files });
    const publish = req.body?.publish === true;
    if (publish) {
      const problem = publishProblem(input);
      if (problem) return res.status(400).json({ error: problem });
    }
    const access = await listingAccess(me(req));
    if (!access.allowed) return needsPlan(res, access.plan);
    const { data: mine, error: countError } = await supabase.from("stallions").select("id").eq("owner_id", me(req).id).limit(MAX_STALLIONS + 1);
    if (countError) return stallionsDown(res, countError);
    if ((mine ?? []).length >= MAX_STALLIONS) return res.status(409).json({ error: `You can list up to ${MAX_STALLIONS} stallions.` });
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from("stallions")
      .insert({
        ...input,
        owner_id: me(req).id,
        owner_name: me(req).displayName.slice(0, 120) || "Stayblz member",
        owner_confirmed_at: now,
        status: publish ? "published" : "draft",
        published_at: publish ? now : null,
      })
      .select("*")
      .single();
    if (error || !data) return stallionsDown(res, error);
    try {
      const problem = await claimAndAttach(me(req).id, data.id, files.mediaIds, files.documentIds, false);
      if (problem) {
        await supabase.from("stallions").delete().eq("id", data.id);
        return res.status(400).json({ error: problem });
      }
    } catch (e) {
      await supabase.from("stallion_files").update({ stallion_id: null }).eq("stallion_id", data.id);
      await supabase.from("stallions").delete().eq("id", data.id);
      return stallionsDown(res, e as any);
    }
    void accountStore.record(publish ? "stallion.published" : "stallion.created", me(req).id, me(req).id, { stallion: data.id });
    await respondWithProfile(req, res, data.id, 201);
  }),
);

router.patch(
  "/:id",
  asyncRoute(async (req, res) => {
    const own = await ownStallion(req, res);
    if (!own) return;
    let input;
    try {
      input = stallionInput(req.body);
    } catch (e) {
      return badInput(res, e);
    }
    const files = fileIds(req.body);
    if (typeof files === "string") return res.status(400).json({ error: files });
    if (own.status === "published") {
      const problem = publishProblem(input);
      if (problem) return res.status(400).json({ error: problem });
    }
    const { error } = await supabase
      .from("stallions")
      .update({ ...input, owner_name: me(req).displayName.slice(0, 120) || own.owner_name, owner_confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", own.id)
      .eq("owner_id", me(req).id);
    if (error) return stallionsDown(res, error);
    if (files.given)
      try {
        const problem = await claimAndAttach(me(req).id, own.id, files.mediaIds, files.documentIds, true);
        if (problem) return res.status(400).json({ error: problem });
      } catch (e) {
        return stallionsDown(res, e as any);
      }
    await respondWithProfile(req, res, own.id);
  }),
);

/** POST /:id/publish {publish: true | false} */
router.post(
  "/:id/publish",
  asyncRoute(async (req, res) => {
    const own = await ownStallion(req, res);
    if (!own) return;
    const publish = req.body?.publish === true;
    if (own.status === "hidden")
      return res.status(403).json({ error: `A Stayblz admin hid this stallion${own.hidden_reason ? `: ${own.hidden_reason}` : "."} Contact support to bring him back.`, code: "hidden" });
    if (publish) {
      const problem = publishProblem(own);
      if (problem) return res.status(400).json({ error: problem });
      const access = await listingAccess(me(req));
      if (!access.allowed) return needsPlan(res, access.plan);
    }
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("stallions")
      .update({ status: publish ? "published" : "draft", published_at: publish ? (own.published_at ?? now) : own.published_at, updated_at: now })
      .eq("id", own.id)
      .eq("owner_id", me(req).id);
    if (error) return stallionsDown(res, error);
    void accountStore.record(publish ? "stallion.published" : "stallion.unpublished", me(req).id, me(req).id, { stallion: own.id });
    await respondWithProfile(req, res, own.id);
  }),
);

/** POST /:id/remove — the owner, or an admin (moderation). Requests keep the stallion's name. */
router.post(
  "/:id/remove",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return notYours(res);
    const { data: row, error } = await supabase.from("stallions").select("id,owner_id,name").eq("id", req.params.id).maybeSingle();
    if (error) return stallionsDown(res, error);
    if (!row || (row.owner_id !== me(req).id && !isAdmin(req))) return notYours(res);
    // Keys first, then the row (file rows go with it), then storage: a failed delete leaves him whole.
    let keys: string[];
    try {
      keys = await storedKeys(row.id);
    } catch (e) {
      return stallionsDown(res, e as any);
    }
    const { error: deleteError } = await supabase.from("stallions").delete().eq("id", row.id);
    if (deleteError) return stallionsDown(res, deleteError);
    await removeStoredKeys(keys);
    void accountStore.record("stallion.removed", row.owner_id, me(req).id, { stallion: row.id, byAdmin: row.owner_id !== me(req).id });
    res.json({ ok: true });
  }),
);

/** POST /:id/moderate {hidden: boolean, reason} — admins hide a stallion from the directory (or let the owner republish). */
router.post(
  "/:id/moderate",
  asyncRoute(async (req, res) => {
    if (!isAdmin(req) || !isUuid(req.params.id)) return notYours(res);
    const hidden = req.body?.hidden === true;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    if (hidden && reason.length < 3) return res.status(400).json({ error: "Say why (the owner sees this)." });
    let update = supabase
      .from("stallions")
      .update({ status: hidden ? "hidden" : "draft", hidden_reason: hidden ? reason : "", updated_at: new Date().toISOString() })
      .eq("id", req.params.id);
    if (!hidden) update = update.eq("status", "hidden");
    const { data, error } = await update.select("id,owner_id").maybeSingle();
    if (error) return stallionsDown(res, error);
    // Unhiding a stallion that isn't hidden changes nothing.
    if (!data) return hidden ? notYours(res) : respondWithProfile(req, res, req.params.id);
    void accountStore.record(hidden ? "stallion.hidden" : "stallion.unhidden", data.owner_id, me(req).id, { stallion: data.id, reason });
    await respondWithProfile(req, res, data.id);
  }),
);

/* ---------- Saves ---------- */

/** POST /:id/save {on: boolean} */
router.post(
  "/:id/save",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return notYours(res);
    const on = req.body?.on !== false;
    if (on) {
      const { data: s, error } = await supabase.from("stallions").select("id,status").eq("id", req.params.id).maybeSingle();
      if (error) return stallionsDown(res, error);
      if (!s || s.status !== "published") return res.status(404).json({ error: "This stallion isn't listed any more." });
      const { error: saveError } = await supabase.from("stallion_saves").insert({ account_id: me(req).id, stallion_id: s.id });
      // Already saved (23505) is fine: saving twice is still saved.
      if (saveError && saveError.code !== "23505") return stallionsDown(res, saveError);
    } else {
      const { error } = await supabase.from("stallion_saves").delete().eq("account_id", me(req).id).eq("stallion_id", req.params.id);
      if (error) return stallionsDown(res, error);
    }
    const { data: all } = await supabase.from("stallion_saves").select("account_id").eq("stallion_id", req.params.id);
    res.json({ saved: on, saves: (all ?? []).length });
  }),
);

/* ---------- Breeding requests ---------- */

const money = (cents: number | null, currency: string) =>
  cents === null || cents === undefined
    ? "Private fee"
    : new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(cents / 100);

/** POST /:id/request {message, clientId, mare: {name, sire, dam, damSire, foaled, status, registration, breed}, seasonYear, method} */
router.post(
  "/:id/request",
  requestLimit,
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return notYours(res);
    let input;
    try {
      input = requestInput(req.body);
    } catch (e) {
      return badInput(res, e);
    }
    const { data: s, error } = await loadProfile(req.params.id, me(req).id, false);
    if (error) return stallionsDown(res, error);
    if (!s || s.status !== "published") return res.status(404).json({ error: "This stallion isn't listed any more.", code: "stallion_not_found" });
    if (s.mine) return res.status(400).json({ error: "This is your own stallion.", code: "self" });
    if (input.method && !s.methods.includes(input.method))
      return res.status(400).json({ error: "This stallion isn't offered that way. Choose another breeding method." });
    // The card under the message in Stayblz Chat (a snapshot; opening it shows the page as it is now).
    const snapshot = {
      kind: "stallion",
      id: s.id,
      name: s.name,
      price: s.fee === null ? 0 : Math.round(s.fee / 100),
      fee: `${money(s.fee, s.feeCurrency)}${s.fee !== null && s.feeTerms === "live_foal" ? " · live foal" : ""}`,
      location: s.farm ? `${s.farm}, ${s.location}` : s.location,
      cover: s.cover ? { id: s.cover.id, kind: s.cover.kind, poster: !!s.cover.poster } : null,
    };
    const mareLine = [input.mare.name, input.mare.sire && `by ${input.mare.sire}`, input.mare.dam && `out of ${input.mare.dam}`]
      .filter(Boolean)
      .join(" ");
    const body = `${input.message}\n\nMare: ${mareLine}${input.season ? `\nSeason: ${input.season}` : ""}`.slice(0, 2000);
    const { data, error: sendError } = await supabase.rpc("stallion_inquiry", {
      p_user: me(req).id,
      p_display: me(req).displayName,
      p_stallion: s.id,
      p_snapshot: snapshot,
      p_body: body,
      p_client: input.clientId,
      p_mare: input.mare,
      p_season: input.season,
      p_method: input.method,
    });
    if (sendError) {
      const reason = sendError.message ?? "";
      if (reason.includes("stallion_not_found")) return res.status(404).json({ error: "This stallion isn't listed any more.", code: "stallion_not_found" });
      if (reason.includes("requests_closed")) return res.status(409).json({ error: "The owner isn't taking requests for him right now.", code: "closed" });
      if (reason.includes("self")) return res.status(400).json({ error: "This is your own stallion.", code: "self" });
      if (reason.includes("blocked")) return res.status(403).json({ error: "You can't message this owner.", code: "blocked" });
      if (reason.includes("no_account")) return res.status(404).json({ error: "This owner's account is no longer active.", code: "no_account" });
      if (["PGRST202", "42883"].includes(sendError.code ?? "")) return stallionsDown(res, sendError);
      return chatError(res, sendError);
    }
    res.status(data?.replayed ? 200 : 201).json({ conversationId: data?.conversationId, requestId: data?.requestId });
    if (data?.messageId) void notifyChat("personal", data.conversationId, me(req).id, { type: "message", messageId: data.messageId });
  }),
);

/** GET /requests?side=received|sent */
router.get(
  "/requests",
  asyncRoute(async (req, res) => {
    const side = req.query.side === "sent" ? "sent" : "received";
    const { data, error } = await supabase.rpc("stallion_requests", { p_user: me(req).id, p_side: side });
    if (error) return stallionsDown(res, error);
    res.json({ side, requests: data ?? [] });
  }),
);

/** PATCH /requests/:id {status?, ownerNote?} — the stallion's owner only. The breeder sees the status, not the note. */
router.patch(
  "/requests/:id",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "Request not found." });
    const change: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (req.body?.status !== undefined) {
      if (!REQUEST_STATUS.includes(req.body.status)) return res.status(400).json({ error: "Choose a status." });
      change.status = req.body.status;
    }
    if (req.body?.ownerNote !== undefined) {
      if (typeof req.body.ownerNote !== "string" || req.body.ownerNote.length > 1000) return res.status(400).json({ error: "Notes can be up to 1,000 characters." });
      change.owner_note = req.body.ownerNote.replace(/\r\n?/g, "\n").trim();
    }
    const { data, error } = await supabase
      .from("stallion_inquiries")
      .update(change)
      .eq("id", req.params.id)
      .eq("owner_id", me(req).id)
      .select("id,status,owner_note,updated_at")
      .maybeSingle();
    if (error) return stallionsDown(res, error);
    if (!data) return res.status(404).json({ error: "Request not found." });
    res.json({ request: { id: data.id, status: data.status, ownerNote: data.owner_note, updatedAt: data.updated_at } });
  }),
);

/* ---------- My mares ---------- */

const mareView = (m: any) => ({
  id: m.id,
  name: m.name,
  breed: m.breed,
  foaled: m.foaled_year,
  color: m.color,
  registration: m.registration,
  racingHorseId: m.racing_horse_id,
  pedigree: m.pedigree ?? {},
  genetics: m.genetics ?? {},
  notes: m.notes,
  updatedAt: m.updated_at,
});

router.get(
  "/mares",
  asyncRoute(async (req, res) => {
    const { data, error } = await supabase.from("stallion_mares").select("*").eq("account_id", me(req).id).order("name", { ascending: true }).limit(MAX_MARES);
    if (error) return stallionsDown(res, error);
    res.json({ mares: (data ?? []).map(mareView) });
  }),
);

router.post(
  "/mares",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = mareInput(req.body);
    } catch (e) {
      return badInput(res, e);
    }
    const { data: mine, error: countError } = await supabase.from("stallion_mares").select("id").eq("account_id", me(req).id).limit(MAX_MARES + 1);
    if (countError) return stallionsDown(res, countError);
    if ((mine ?? []).length >= MAX_MARES) return res.status(409).json({ error: `You can save up to ${MAX_MARES} mares.` });
    const { data, error } = await supabase.from("stallion_mares").insert({ ...input, account_id: me(req).id }).select("*").single();
    if (error || !data) return stallionsDown(res, error);
    res.status(201).json({ mare: mareView(data) });
  }),
);

router.patch(
  "/mares/:id",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: "Mare not found." });
    let input;
    try {
      input = mareInput(req.body);
    } catch (e) {
      return badInput(res, e);
    }
    const { data, error } = await supabase
      .from("stallion_mares")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("account_id", me(req).id)
      .select("*")
      .maybeSingle();
    if (error) return stallionsDown(res, error);
    if (!data) return res.status(404).json({ error: "Mare not found." });
    res.json({ mare: mareView(data) });
  }),
);

router.post(
  "/mares/:id/remove",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return res.json({ ok: true });
    const { error } = await supabase.from("stallion_mares").delete().eq("id", req.params.id).eq("account_id", me(req).id);
    if (error) return stallionsDown(res, error);
    res.json({ ok: true });
  }),
);

/* ---------- Writing help ---------- */

const short = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const BREED_NAMES: Record<string, string> = {
  thoroughbred: "Thoroughbred", quarter_horse: "Quarter Horse", standardbred: "Standardbred", arabian: "Arabian",
  paint: "Paint", appaloosa: "Appaloosa", warmblood: "Warmblood", other: "Horse",
};
const METHOD_NAMES: Record<string, string> = { live_cover: "live cover", cooled: "cooled shipped semen", frozen: "frozen semen" };
// Only our own keys (never "__proto__" and friends) and sensible numbers reach the writer.
const named = (names: Record<string, string>, key: unknown) => (typeof key === "string" && Object.hasOwn(names, key) ? names[key] : "");
const count = (v: unknown, max = 100_000) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : null);

/** POST /write-description {the form as it is} — a description draft from the facts given. */
router.post(
  "/write-description",
  writerLimit,
  asyncRoute(async (req, res) => {
    if (!writerAvailable()) return res.status(503).json({ error: "Writing help isn't set up yet.", code: "unavailable" });
    const b = req.body ?? {};
    const name = short(b.name, 60);
    if (!name) return res.status(400).json({ error: "Add his name first." });
    const pedigree = b.pedigree && typeof b.pedigree === "object" ? (b.pedigree as Record<string, unknown>) : {};
    const ped = Object.fromEntries(Object.entries(pedigree).filter(([k, v]) => /^[sd]{1,4}$/.test(k) && typeof v === "string").map(([k, v]) => [k, short(v, 40)]));
    const record = b.raceRecord && typeof b.raceRecord === "object" ? b.raceRecord : {};
    const starts = count(record.starts, 500);
    const earned = count(record.earnings, 1_000_000_000);
    const recordText =
      starts !== null
        ? `${starts} starts, ${count(record.wins, starts) ?? 0} wins, ${count(record.places, starts) ?? 0} seconds, ${count(record.shows, starts) ?? 0} thirds${earned !== null ? `, earned ${earned.toLocaleString("en-US")} ${/^[A-Z]{3}$/.test(record.currency) ? record.currency : "USD"}` : ""}`
        : "";
    const height = count(b.heightIn, 80);
    const facts: WriterFacts = {
      name,
      breed: named(BREED_NAMES, b.breed) || "Horse",
      foaled: Number.isInteger(b.foaled) ? b.foaled : null,
      color: short(b.color, 30),
      height: height !== null && height >= 48 ? `${Math.floor(height / 4)}.${height % 4} hands` : "",
      sire: ped.s,
      dam: ped.d,
      damSire: ped.ds,
      sireLine: sireLine(ped as any).slice(1),
      standingAt: [short(b.farm, 80), short(b.location, 80)].filter(Boolean).join(", "),
      seasonYear: Number.isInteger(b.seasonYear) ? b.seasonYear : undefined,
      firstSeason: Number.isInteger(b.firstSeason) ? b.firstSeason : null,
      methods: Array.isArray(b.methods) ? b.methods.slice(0, 3).map((m: unknown) => named(METHOD_NAMES, m)).filter(Boolean) : [],
      raceRecord: recordText,
      highlights: Array.isArray(b.highlights) ? b.highlights.map((h: unknown) => short(h, 120)).filter(Boolean).slice(0, 8) : [],
      programs: short(b.programs, 300),
      ownerNotes: typeof b.description === "string" ? b.description.slice(0, 1500) : "",
    };
    // His numbers in Stayblz racing data (facts we can stand behind).
    const [own, kids] = await Promise.all([
      isUuid(b.racingHorseId) ? supabase.rpc("stallion_progeny_json", { p_horses: [b.racingHorseId] }) : Promise.resolve({ data: null }),
      supabase.rpc("stallion_offspring", { p_name: name }),
    ]);
    const o = own.data as any;
    if (o?.starts) facts.stayblzRecord = `${o.starts} starts and ${o.wins} wins in Stayblz racing data`;
    const k = kids.data as any;
    if (k?.runners) facts.offspring = `${k.runners} runners and ${k.winners} winners${k.stakesWinners ? ` (${k.stakesWinners} stakes winners)` : ""} by him in Stayblz racing data`;
    try {
      res.json({ description: await draftDescription(facts) });
    } catch (e) {
      if (e instanceof WriterError)
        return res.status(e.code === "busy" ? 429 : e.code === "refused" ? 422 : 503).json({ error: e.message, code: e.code });
      throw e;
    }
  }),
);

/* ---------- Files ---------- */
uploadRoutes(router);

export default router;
