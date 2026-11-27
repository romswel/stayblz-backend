import { Router, type Request, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import * as ff from "../lib/formFav";
import * as idx from "../lib/formFavIndex";

/**
 * Stayblz Data → FormFav (signed in): racing form, results, predictions and stats from FormFav, through our server.
 * GET /status, /meetings, /race, /search, /jockey/:name, /trainer/:name, /runner/:id, /track-bias/:track,
 * and the A–Z lists built by lib/formFavIndex.ts: /horses, /horse, /people.
 */
const router = Router();
router.use(requireAuth);

const DAY = 86_400_000;

class Invalid extends Error {}
/** One query value: undefined when absent; a repeated or non-string value is invalid. */
function one(req: Request, name: string): string | undefined {
  const v = req.query[name];
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string") throw new Invalid();
  return v;
}
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Invalid();
  return v;
}
function date(v: string | undefined) {
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Invalid();
  const at = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== v) throw new Invalid();
  // FormFav serves 30 days back to 7 ahead; a day of slack either side covers time zones.
  const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  if (at < today - 31 * DAY || at > today + 8 * DAY) throw new Invalid();
  return v;
}
/** One value that must be in `allowed`. */
function oneOf<T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new Invalid();
  return v as T;
}
/** A comma-separated list, each value in `allowed` (duplicates dropped); absent = all of them. */
function someOf<T extends string>(v: string | undefined, allowed: readonly T[]): T[] {
  if (v === undefined) return [...allowed];
  const picked = [...new Set(v.split(","))];
  if (!picked.length || picked.length > allowed.length) throw new Invalid();
  for (const p of picked) if (!(allowed as readonly string[]).includes(p)) throw new Invalid();
  return picked as T[];
}
const raceCode = (v: string | undefined) => oneOf(v, ff.RACE_CODES);
/** Stayblz Data → FormFav covers the United States and Canada, by New York or Los Angeles days. */
const country = (v: string | undefined) => oneOf(v, ff.COUNTRIES);
const timezone = (v: string | undefined) => oneOf(v, ff.TIMEZONES);
function int(v: string | undefined, min: number, max: number) {
  if (v === undefined) return undefined;
  if (!/^\d{1,9}$/.test(v)) throw new Invalid();
  const n = Number(v);
  if (n < min || n > max) throw new Invalid();
  return n;
}
function match(v: string | undefined, re: RegExp) {
  if (v === undefined) return undefined;
  if (!re.test(v)) throw new Invalid();
  return v;
}
const SLUG = /^[a-z0-9-]{2,100}$/;
const DISTANCE = /^\d{3,4}(?:-\d{3,4})?$/;
/** A person's name as FormFav spells it (letters in any script, spaces, . ' - &). */
const NAME = /^[\p{L}\p{M}0-9 .'&(),/-]{2,100}$/u;

/**
 * `make` validates the request (throwing Invalid → 400) and returns the FormFav read; the read only runs after the
 * person's rate limit allows it. FormFav failures become friendly errors.
 */
function handle(make: (req: Request) => () => Promise<unknown>) {
  return asyncRoute(async (req: Request, res: Response) => {
    let run: () => Promise<unknown>;
    try {
      run = make(req);
    } catch (e) {
      if (e instanceof Invalid) return void res.status(400).json({ error: "Invalid FormFav request." });
      throw e;
    }
    if (!ff.formFavAllowed((req as AuthenticatedRequest).user.id)) {
      return void res.status(429).json({ error: "That's a lot of lookups. Wait a moment.", retryAfterSeconds: 60 });
    }
    try {
      const body = await run();
      res.set("Cache-Control", "private, max-age=60");
      res.json(body);
    } catch (e) {
      if (e instanceof ff.FormFavError && e.status === 404) return void res.status(404).json({ error: "Not found." });
      if (e instanceof ff.FormFavError && e.status === 400)
        return void res.status(400).json({ error: "Invalid FormFav request." });
      res.status(503).json({ error: "FormFav data isn't available right now." });
    }
  });
}

router.get(
  "/status",
  asyncRoute(async (_req, res) => void res.json(await ff.status())),
);

router.get(
  "/meetings",
  handle((req) => {
    // ?from=&to= (to defaults to from: a single day), at most MAX_RANGE_DAYS days.
    const from = need(date(one(req, "from")));
    const to = date(one(req, "to")) ?? from;
    if (to < from || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) >= ff.MAX_RANGE_DAYS * DAY) throw new Invalid();
    const q = {
      from,
      to,
      raceCodes: someOf(one(req, "race_codes"), ff.RACE_CODES),
      timezones: someOf(one(req, "timezones"), ff.TIMEZONES),
      countries: someOf(one(req, "countries"), ff.COUNTRIES),
    };
    return () => ff.meetings(q);
  }),
);

router.get(
  "/race",
  handle((req) => {
    const w = {
      date: need(date(one(req, "date"))),
      track: need(match(one(req, "track"), SLUG)),
      race: need(int(one(req, "race"), 1, 20)),
      raceCode: raceCode(one(req, "race_code")) ?? "gallops",
      country: country(one(req, "country")) ?? "us",
      timezone: timezone(one(req, "timezone")) ?? "America/New_York",
    };
    return () => ff.race(w);
  }),
);

/**
 * Jockeys, trainers and tracks are shown only when they're in the US/Canada window of the A–Z index (FormFav's own
 * stats are worldwide): 404 otherwise, 503 while the index is still being built.
 */
function northAmerican(known: () => boolean) {
  idx.ensureIndex();
  if (idx.indexStatus().building) throw new ff.FormFavError(503);
  if (!known()) throw new ff.FormFavError(404);
}

router.get(
  "/search",
  handle((req) => {
    const kind = one(req, "kind");
    if (kind !== "jockey" && kind !== "trainer" && kind !== "runner") throw new Invalid();
    const q = need(one(req, "q")).trim();
    if (q.length < 3 || q.length > 100) throw new Invalid();
    const code = raceCode(one(req, "race_code"));
    // Runner results are kept to the US and Canada in ff.search; people to those in the US/Canada index.
    if (kind === "runner") return () => ff.search(kind, q, code);
    return async () => {
      northAmerican(() => true);
      const found = await ff.search(kind, q, code);
      return { ...found, results: found.results.filter((r: any) => r.name && idx.knownPerson(kind, r.name)) };
    };
  }),
);

for (const kind of ["jockey", "trainer"] as const) {
  router.get(
    `/${kind}/:name`,
    handle((req) => {
      const name = need(match(String(req.params.name).trim(), NAME));
      const code = raceCode(one(req, "race_code"));
      const window = int(one(req, "window"), 14, 365);
      return async () => {
        northAmerican(() => idx.knownPerson(kind, name));
        return kind === "jockey" ? ff.jockey(name, code, window) : ff.trainer(name, code, window);
      };
    }),
  );
}

router.get(
  "/runner/:id",
  handle((req) => {
    const id = need(int(String(req.params.id), 1, 999_999_999));
    const window = int(one(req, "window"), 14, 365);
    return () => ff.runner(id, window);
  }),
);

router.get(
  "/track-bias/:track",
  handle((req) => {
    const track = need(match(String(req.params.track), SLUG));
    const o = {
      raceCode: raceCode(one(req, "race_code")),
      country: country(one(req, "country")) ?? "us",
      window: int(one(req, "window"), 14, 365),
      distance: match(one(req, "distance"), DISTANCE),
    };
    return async () => {
      northAmerican(() => idx.knownTrack(track));
      return ff.trackBias(track, o);
    };
  }),
);

// ── A–Z lists (lib/formFavIndex.ts) ─────────────────────────────────────────────────────────────────────────────────
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** ?offset&limit&q&codes&countries for the A–Z lists. */
function listQuery(req: Request): idx.ListQuery {
  const offset = int(one(req, "offset"), 0, 100_000) ?? 0;
  const limit = int(one(req, "limit"), 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
  const q = one(req, "q")?.trim().slice(0, 60);
  return { offset, limit, q: q || undefined, codes: someOf(one(req, "codes"), idx.INDEX_CODES), countries: someOf(one(req, "countries"), ff.COUNTRIES) };
}

router.get(
  "/horses",
  handle((req) => {
    const q = listQuery(req);
    return async () => {
      idx.ensureIndex();
      return idx.listHorses(q);
    };
  }),
);

router.get(
  "/horse",
  handle((req) => {
    const name = need(one(req, "name")).trim();
    if (!name || name.length > 100) throw new Invalid();
    const code = need(oneOf(one(req, "code"), idx.INDEX_CODES));
    return async () => {
      idx.ensureIndex();
      const horse = idx.getHorse(name, code);
      if (!horse) throw new ff.FormFavError(404);
      return horse;
    };
  }),
);

/** GET /overview?codes&countries&track — the dashboard's race data, from the index (no FormFav calls). */
router.get(
  "/overview",
  handle((req) => {
    const q = {
      codes: someOf(one(req, "codes"), idx.INDEX_CODES),
      countries: someOf(one(req, "countries"), ff.COUNTRIES),
      track: match(one(req, "track"), SLUG),
    };
    return async () => {
      idx.ensureIndex();
      return idx.overview(q);
    };
  }),
);

router.get(
  "/people",
  handle((req) => {
    const kind = need(oneOf(one(req, "kind"), ["jockey", "trainer"] as const));
    const q = listQuery(req);
    return async () => {
      idx.ensureIndex();
      return idx.listPeople(kind, q);
    };
  }),
);

export default router;
