import "dotenv/config";
import cors from "cors";
import helmet from "helmet";
import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { ensureSchema } from "./ensureSchema";

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] Non-fatal error swallowed:", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] Non-fatal rejection swallowed:", reason);
});

const app = express();
const httpServer = createServer(app);

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));

app.use((_req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), accelerometer=(), gyroscope=()"
  );
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  } else if (!req.path.startsWith("/assets/")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});

const CORS_ALLOWLIST = new Set([
  "https://docera.io",
  "https://www.docera.io",
  "capacitor://localhost",
  "https://localhost",
  "ionic://localhost",
]);

app.use(cors({
  origin: (origin, callback) => {
    if (process.env.NODE_ENV !== "production") return callback(null, true);
    if (!origin || CORS_ALLOWLIST.has(origin)) return callback(null, true);
    console.warn(`[CORS] Rejected origin: ${origin}`);
    callback(new Error(`Origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Body parsers ────────────────────────────────────────────────────────────
app.use(
  express.json({
    limit: "10mb",
    verify: (req: Request & { rawBody?: unknown }, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false }));

const PgSession = connectPgSimple(session as any);
const pgPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

app.set("trust proxy", 1);

app.use(
  (session as any)({
    store: new PgSession({ pool: pgPool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET ?? "docchat-secret-key",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 90 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    },
  }),
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    if (!req.path.startsWith("/api/gmail/")) {
      capturedJsonResponse = bodyJson;
    }
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse).slice(0, 200)}`;
      }
      log(logLine);
    }
  });
  next();
});

(async () => {
  if (process.env.DATABASE_URL) {
    await ensureSchema(process.env.DATABASE_URL);
  }
  await registerRoutes(httpServer, app);

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const e = err as { status?: number; statusCode?: number; message?: string };
    const status = e.status || e.statusCode || 500;
    const message = e.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(port, "0.0.0.0", () => {
    log(`serving on port ${port}`);
  });
})();
