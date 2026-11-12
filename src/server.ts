import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { SqliteDatabase, type GatewayDatabase } from "./database";
import {
  clearDashboardCookie,
  createApiAuth,
  createDashboardSession,
  isValidDashboardSession,
  setDashboardCookie,
  verifyDashboardPassword,
} from "./middleware/dashboard-auth";
import { findDocumentedRoute, requiresIdempotencyKey } from "./kafuda/routes";
import { parseWebhookEvent, verifyKafudaSignature } from "./webhook";
import { PlatformStore } from "./platform/store";
import { mountPlatformRoutes } from "./platform/routes";
import { applyMigrations } from "./migration-runner";

const KAFUDA_API_ORIGIN = "https://kafuda.com";
const UPSTREAM_TIMEOUT_MS = 60_000;

function jsonError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createApp(
  config: ReturnType<typeof loadConfig>,
  database: GatewayDatabase,
  fetcher: typeof fetch = fetch,
  platformStore?: PlatformStore,
) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    next();
  });

  if (platformStore) mountPlatformRoutes(app, config, platformStore, fetcher);

  app.get("/healthz", async (_req, res) => {
    try {
      database.healthCheck();
      res.json({ status: "ok" });
    } catch (error) {
      console.error("Health check database query failed", error);
      jsonError(res, 503, "database_unavailable", "Database is unavailable");
    }
  });

  app.post(
    "/webhooks/kafuda",
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req: Request, res: Response) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!verifyKafudaSignature(rawBody, req.header("x-vcard-signature"), config.webhookSecret)) {
        jsonError(res, 401, "invalid_signature", "Webhook signature is invalid or expired");
        return;
      }

      const event = parseWebhookEvent(rawBody);
      if (!event) {
        jsonError(res, 400, "invalid_webhook", "Webhook payload is invalid");
        return;
      }

      try {
        if (platformStore && event.type.toLowerCase().includes("order")) {
          const nestedOrder = typeof event.data.order === "object" && event.data.order !== null
            ? event.data.order as Record<string, unknown>
            : undefined;
          const upstreamOrderId = event.data.order_id ?? nestedOrder?.id ?? event.data.id;
          const typeStatus = event.type.split(".").at(-1)?.toLowerCase();
          const statusValue = event.data.status ?? nestedOrder?.status ??
            (typeStatus && ["completed", "succeeded", "success", "paid", "failed", "cancelled", "canceled", "refunded"].includes(typeStatus)
              ? typeStatus
              : undefined);
          const orderId = typeof upstreamOrderId === "string" || typeof upstreamOrderId === "number"
            ? String(upstreamOrderId)
            : undefined;
          const status = typeof statusValue === "string" ? statusValue : undefined;
          if (orderId && status) platformStore.settleOrderFromWebhook(orderId, status);
        }
        const inserted = database.insertWebhookEvent(event, rawBody.toString("utf8"));
        res.status(200).json({ received: true, duplicate: !inserted });
      } catch (error) {
        console.error("Webhook event persistence failed", { eventId: event.id, error });
        jsonError(res, 500, "webhook_persistence_failed", "Webhook could not be stored");
      }
    },
  );

  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  app.post("/dashboard/auth/login", express.json({ limit: "16kb" }), (req, res) => {
    const now = Date.now();
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const attempts = loginAttempts.get(key);
    if (attempts && attempts.resetAt > now && attempts.count >= 5) {
      res.setHeader("Retry-After", String(Math.ceil((attempts.resetAt - now) / 1000)));
      jsonError(res, 429, "login_rate_limited", "Too many login attempts; try again later");
      return;
    }

    const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
    if (!verifyDashboardPassword(password, config.dashboardPassword)) {
      if (!attempts || attempts.resetAt <= now) {
        loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
      } else {
        attempts.count += 1;
      }
      jsonError(res, 401, "invalid_credentials", "Invalid dashboard password");
      return;
    }

    loginAttempts.delete(key);
    setDashboardCookie(res, createDashboardSession(config), config);
    res.json({ authenticated: true });
  });

  app.get("/dashboard/auth/session", (req, res) => {
    const cookie = req.headers.cookie
      ?.split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith("kafuda_dashboard="))
      ?.slice("kafuda_dashboard=".length);
    let session: string | undefined;
    try {
      session = cookie ? decodeURIComponent(cookie) : undefined;
    } catch {
      session = undefined;
    }
    res.json({ authenticated: isValidDashboardSession(session, config) });
  });

  app.post("/dashboard/auth/logout", (_req, res) => {
    clearDashboardCookie(res, config);
    res.status(204).end();
  });

  app.get("/dashboard/webhooks", createApiAuth(config), (req, res) => {
    const requestedLimit = Number(req.query.limit ?? 50);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      jsonError(res, 400, "validation_error", "limit must be an integer between 1 and 100");
      return;
    }
    try {
      res.json({ data: database.listWebhookEvents(requestedLimit) });
    } catch (error) {
      console.error("Webhook event listing failed", error);
      jsonError(res, 500, "webhook_query_failed", "Webhook events could not be loaded");
    }
  });

  app.use("/api/v1", createApiAuth(config));
  app.use("/api/v1", express.raw({ type: "application/json", limit: "1mb" }));
  app.use("/api/v1", async (req: Request, res: Response) => {
    const pathname = `${req.baseUrl}${req.path}`;
    const route = findDocumentedRoute(req.method, pathname);
    if (!route) {
      jsonError(res, 404, "unsupported_endpoint", "This Kafuda endpoint is not documented by this gateway");
      return;
    }

    if (requiresIdempotencyKey(req.method, pathname)) {
      const idempotencyKey = req.header("idempotency-key");
      if (!idempotencyKey || !/^[A-Za-z0-9._:-]{1,80}$/.test(idempotencyKey)) {
        jsonError(res, 400, "idempotency_required", "A valid Idempotency-Key header is required");
        return;
      }
    }

    const upstreamUrl = new URL(req.originalUrl, KAFUDA_API_ORIGIN);
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.kafudaApiKey}`,
      accept: req.header("accept") ?? "application/json",
    };
    const contentType = req.header("content-type");
    const idempotencyKey = req.header("idempotency-key");
    if (contentType) headers["content-type"] = contentType;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

    try {
      const upstream = await fetcher(upstreamUrl, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      const forwardedHeaders = [
        "content-type",
        "content-disposition",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
        "idempotent-replayed",
        "retry-after",
      ];
      for (const name of forwardedHeaders) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.status(upstream.status);
      if (upstream.status === 204 || req.method === "HEAD") {
        res.end();
        return;
      }
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      console.error("Kafuda upstream request failed", {
        method: req.method,
        path: req.path,
        timedOut,
      });
      jsonError(
        res,
        timedOut ? 504 : 502,
        timedOut ? "upstream_timeout" : "upstream_unavailable",
        timedOut ? "Kafuda request timed out; retry writes with the same idempotency key" : "Kafuda is unavailable",
      );
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const type = error instanceof Error && "type" in error
      ? (error as Error & { type?: unknown }).type
      : undefined;
    if (type === "entity.too.large") {
      jsonError(res, 413, "request_too_large", "Request body exceeds the allowed size");
      return;
    }
    if (type === "entity.parse.failed") {
      jsonError(res, 400, "invalid_json", "Request body is not valid JSON or form data");
      return;
    }
    console.error("Unhandled request error", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    jsonError(res, 500, "internal_error", "Internal server error");
  });

  const webDirectory = join(process.cwd(), "web", "dist");
  app.use(express.static(webDirectory, { index: false, maxAge: "1h" }));
  app.get("*", (req, res) => {
    const indexFile = join(webDirectory, "index.html");
    if (existsSync(indexFile) && req.accepts("html")) {
      res.sendFile(indexFile);
      return;
    }
    jsonError(res, 404, "not_found", "Web console is not built. Run npm run build.");
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const database = new SqliteDatabase(config.databasePath);
  try {
    await applyMigrations(database);
  } catch (error) {
    database.close();
    throw error;
  }
  const platformStore = new PlatformStore(database.connection);
  const app = createApp(config, database, fetch, platformStore);
  const server = app.listen(config.port, config.host, () => {
    console.log(`Kafuda API gateway listening on http://${config.host}:${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down`);
    server.close(() => {
      database.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error("Failed to start Kafuda API gateway", error);
    process.exitCode = 1;
  });
}
