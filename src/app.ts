import express, { Request, Response, ErrorRequestHandler } from "express";
import cors from "cors";
import authRoutes from "./routes/auth";
import racingRoutes from "./routes/racing";
import publicRacingRoutes from "./routes/publicRacing";
import workspaceRoutes from "./routes/workspaces";
import {
  memberInventory,
  memberHorses,
  memberFeed,
} from "./routes/memberStable";
import memberMessages from "./routes/memberMessages";
import watchlistRoutes from "./routes/watchlist";
import adminRoutes from "./routes/admin";
import personalMessages from "./routes/personalMessages";
import myRacingRoutes from "./routes/myRacing";
import { supabase } from "./lib/supabase";
import { createHash } from "node:crypto";
import { apiLimit } from "./middleware/authLimits";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.RENDER === "true" ? 1 : false);
const production =
  process.env.NODE_ENV === "production" || process.env.RENDER === "true";
app.use((_req, res, next) => {
  // The API only ever returns JSON: nothing here may be framed, cached or run as a page.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  if (production)
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  next();
});

const allowedOrigins = (
  process.env.FRONTEND_URL ??
  (process.env.NODE_ENV === "production"
    ? "https://stayblz-frontend.vercel.app"
    : "http://localhost:5173")
)
  .split(",")
  .map((origin) => origin.trim());

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use("/api", (req, res, next) =>
  req.path === "/health" ? next() : apiLimit(req, res, next),
);
app.use(express.json({ limit: "32kb" }));
app.use("/api", (req, res, next) => {
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
    req.headers.origin &&
    !allowedOrigins.includes(req.headers.origin)
  ) {
    res.status(403).json({ error: "This request origin is not allowed." });
    return;
  }
  next();
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "stayblz-api",
    version: process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? "local",
    authProvider: createHash("sha256")
      .update(process.env.SUPABASE_URL ?? "")
      .digest("hex")
      .slice(0, 12),
    time: new Date().toISOString(),
  });
});

app.get("/api/db-health", async (_req: Request, res: Response) => {
  try {
    const { error } = await supabase
      .from("accounts")
      .select("id", { count: "exact", head: true });

    if (error) {
      return res.status(500).json({
        ok: false,
        error: "Database connection failed",
      });
    }

    return res.json({ ok: true, database: "connected" });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Database connection failed",
    });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/public", publicRacingRoutes);
app.use("/api/racing", racingRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/feed", memberFeed);
app.use("/api/messages", personalMessages);
app.use("/api/team-messages", memberMessages);
app.use("/api/my-racing", myRacingRoutes);
app.use("/api/inventory", memberInventory);
app.use("/api/horses", memberHorses);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/admin", adminRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found." });
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const status =
    error?.type === "entity.too.large"
      ? 413
      : error?.type === "entity.parse.failed"
        ? 400
        : 500;
  res.status(status).json({
    error:
      status === 413
        ? "Request body is too large."
        : status === 400
          ? "Invalid JSON body."
          : "Something went wrong. Please try again.",
  });
};
app.use(errorHandler);
