import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { isUuid } from "../middleware/stable";
import { asyncRoute } from "../middleware/asyncRoute";
import { supabase } from "../lib/supabase";
import { roleRank } from "../lib/accounts";
import { listingFilters, listingInput } from "../lib/marketplaceInput";

// Horse marketplace: every signed-in member can browse; sellers add, edit and remove
// their own listings. Admins can also remove any listing (moderation).
const router = Router();
router.use(requireAuth);
router.use((req, res, next) => {
  if (req.method !== "GET" && (req as AuthenticatedRequest).user.passwordSetupRequired) {
    res.status(403).json({ error: "Complete password setup before listing a horse." });
    return;
  }
  next();
});

const PAGE = 60;
const COLUMNS =
  "id,seller_id,seller_name,name,price,breed,discipline,horse_type,gender,color,age,height_in,location,created_at,updated_at";
const user = (req: Request) => (req as AuthenticatedRequest).user;
const unavailable = (res: Response) =>
  res.status(503).json({ error: "The marketplace is temporarily unavailable. Please try again." });
const notFound = (res: Response) => res.status(404).json({ error: "Listing not found." });
const badListing = (res: Response) =>
  res.status(400).json({
    error:
      "Check the listing: name, price, breed, discipline, type, gender, colour, age, height and location are all required.",
  });

/** The seller's account id stays on the server; the page only learns whether it is yours. */
function view(row: any, viewer: string) {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    breed: row.breed,
    discipline: row.discipline,
    type: row.horse_type,
    gender: row.gender,
    color: row.color,
    age: row.age,
    heightIn: row.height_in,
    location: row.location,
    sellerName: row.seller_name,
    mine: row.seller_id === viewer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get(
  "/listings",
  asyncRoute(async (req, res) => {
    let f;
    try {
      f = listingFilters(req.query as Record<string, unknown>);
    } catch {
      return res.status(400).json({ error: "Those filters aren't valid. Clear them and try again." });
    }
    const me = user(req).id;
    let query = supabase.from("marketplace_listings").select(COLUMNS);
    if (f.mine) query = query.eq("seller_id", me);
    if (f.breed) query = query.eq("breed", f.breed);
    if (f.discipline) query = query.eq("discipline", f.discipline);
    if (f.type) query = query.eq("horse_type", f.type);
    if (f.gender) query = query.eq("gender", f.gender);
    if (f.color) query = query.eq("color", f.color);
    if (f.priceMin !== undefined) query = query.gte("price", f.priceMin);
    if (f.priceMax !== undefined) query = query.lte("price", f.priceMax);
    if (f.ageMin !== undefined) query = query.gte("age", f.ageMin);
    if (f.ageMax !== undefined) query = query.lte("age", f.ageMax);
    if (f.heightMin !== undefined) query = query.gte("height_in", f.heightMin);
    if (f.heightMax !== undefined) query = query.lte("height_in", f.heightMax);
    if (f.location) query = query.ilike("location", `%${f.location}%`);
    if (f.sort === "price-asc" || f.sort === "price-desc")
      query = query.order("price", { ascending: f.sort === "price-asc" });
    else if (f.sort === "age-asc") query = query.order("age", { ascending: true });
    query = query.order("created_at", { ascending: false }).order("id", { ascending: false });
    // One extra row tells the page there are more than it shows.
    const { data, error } = await query.limit(PAGE + 1);
    if (error) return unavailable(res);
    const rows = data ?? [];
    res.json({ listings: rows.slice(0, PAGE).map((row) => view(row, me)), more: rows.length > PAGE });
  }),
);

router.post(
  "/listings",
  asyncRoute(async (req, res) => {
    let input;
    try {
      input = listingInput(req.body);
    } catch {
      return badListing(res);
    }
    const me = user(req);
    const { data, error } = await supabase
      .from("marketplace_listings")
      .insert({ ...input, seller_id: me.id, seller_name: me.displayName.slice(0, 120) || "Stayblz member" })
      .select(COLUMNS)
      .single();
    if (error || !data) return unavailable(res);
    res.status(201).json({ listing: view(data, me.id) });
  }),
);

router.patch(
  "/listings/:id",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return notFound(res);
    let input;
    try {
      input = listingInput(req.body);
    } catch {
      return badListing(res);
    }
    const me = user(req);
    const { data, error } = await supabase
      .from("marketplace_listings")
      .update({ ...input, updated_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("seller_id", me.id)
      .select(COLUMNS)
      .maybeSingle();
    if (error) return unavailable(res);
    if (!data) return notFound(res);
    res.json({ listing: view(data, me.id) });
  }),
);

router.post(
  "/listings/:id/remove",
  asyncRoute(async (req, res) => {
    if (!isUuid(req.params.id)) return notFound(res);
    const me = user(req);
    let query = supabase.from("marketplace_listings").delete().eq("id", req.params.id);
    // Sellers remove their own listings; admins (acting as admin) can remove any.
    if (roleRank(me.role) < roleRank("admin")) query = query.eq("seller_id", me.id);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) return unavailable(res);
    if (!data) return notFound(res);
    res.json({ ok: true });
  }),
);

export default router;
