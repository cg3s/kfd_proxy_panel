import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Config } from "../config";
import { createApiAuth } from "../middleware/dashboard-auth";
import { PlatformError, PlatformStore, type PortalUser } from "./store";
import { amountToFen, createEpayCheckoutUrl, verifyEpayParameters, type EpayParameters } from "./epay";
import { sendVerificationEmail } from "./email";
import { hashPassword, verifyPassword } from "./password";

const KAFUDA_API_ORIGIN = "https://kafuda.com";
const UPSTREAM_TIMEOUT_MS = 60_000;
const PORTAL_COOKIE = "kafuda_portal";
const PORTAL_SESSION_SECONDS = 7 * 24 * 60 * 60;
const EMAIL_CODE_SECONDS = 10 * 60;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPortalCookie(request: Request): string | undefined {
  for (const cookie of request.headers.cookie?.split(";") ?? []) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== PORTAL_COOKIE) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function setPortalCookie(response: Response, token: string, config: Config): void {
  const attributes = [
    `${PORTAL_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${PORTAL_SESSION_SECONDS}`,
  ];
  if (config.cookieSecure) attributes.push("Secure");
  response.setHeader("Set-Cookie", attributes.join("; "));
}

function clearPortalCookie(response: Response, config: Config): void {
  const attributes = [`${PORTAL_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (config.cookieSecure) attributes.push("Secure");
  response.setHeader("Set-Cookie", attributes.join("; "));
}

function portalUser(response: Response): PortalUser {
  return response.locals.portalUser as PortalUser;
}

function sendError(response: Response, status: number, code: string, message: string): void {
  response.status(status).json({ error: { code, message } });
}

function hitLimit(
  counters: Map<string, { count: number; resetAt: number }>,
  key: string,
  maximum: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const current = counters.get(key);
  if (!current || current.resetAt <= now) {
    counters.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    current.count += 1;
    if (current.count > maximum) return false;
  }
  if (counters.size > 5000) {
    for (const [entryKey, value] of counters) {
      if (value.resetAt <= now) counters.delete(entryKey);
    }
  }
  return true;
}

function codeDigest(code: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(code).digest();
}

function validCode(candidate: string, expectedHex: string, secret: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const supplied = codeDigest(candidate, secret);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function validateEpayInput(value: unknown): EpayParameters | undefined {
  if (!isRecord(value)) return undefined;
  const parameters: EpayParameters = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.length > 2000) return undefined;
    parameters[name] = entry;
  }
  return parameters;
}

function unwrapData(payload: unknown): unknown {
  return isRecord(payload) && "data" in payload ? payload.data : payload;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function requireIdempotencyKey(request: Request, response: Response): string | undefined {
  const key = request.header("idempotency-key");
  if (!key || !/^[A-Za-z0-9._:-]{1,80}$/.test(key)) {
    sendError(response, 400, "idempotency_required", "A valid Idempotency-Key header is required");
    return undefined;
  }
  return key;
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    void handler(request, response).catch(next);
  };
}

export function mountPlatformRoutes(
  app: Express,
  config: Config,
  store: PlatformStore,
  fetcher: typeof fetch,
): void {
  app.use("/portal", express.json({ limit: "64kb" }));
  app.use("/admin/platform", express.json({ limit: "32kb" }));
  const loginLimits = new Map<string, { count: number; resetAt: number }>();
  const registrationLimits = new Map<string, { count: number; resetAt: number }>();
  const emailLimits = new Map<string, { count: number; resetAt: number }>();
  const purchaseLimits = new Map<string, { count: number; resetAt: number }>();
  const portalAuth = (request: Request, response: Response, next: NextFunction) => {
    const token = readPortalCookie(request);
    const user = token ? store.getSessionUser(token, Date.now()) : undefined;
    if (!user) {
      sendError(response, 401, "unauthorized", "Please sign in");
      return;
    }
    response.locals.portalUser = user;
    next();
  };

  app.post("/portal/auth/register", asyncRoute(async (request, response) => {
    const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
    if (!hitLimit(registrationLimits, ip, 8, 60 * 60_000)) {
      sendError(response, 429, "rate_limited", "Too many registration attempts; try again later");
      return;
    }
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      sendError(response, 400, "validation_error", "Enter a valid email address");
      return;
    }
    if (password.length < 12 || password.length > 128) {
      sendError(response, 400, "validation_error", "Password must be between 12 and 128 characters");
      return;
    }
    if (store.findUserByEmail(email)) {
      response.status(202).json({ message: "If this address can be registered, a verification code will be sent" });
      return;
    }
    if (!hitLimit(emailLimits, email, 3, 15 * 60_000)) {
      response.status(202).json({ message: "If this address can be registered, a verification code will be sent" });
      return;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(password);
    } catch (error) {
      console.error("Registration password hashing failed", error);
      sendError(response, 500, "registration_failed", "Registration could not be completed");
      return;
    }
    const codeHash = codeDigest(code, config.gatewayApiToken).toString("hex");
    try {
      store.createPendingRegistration(email, passwordHash, codeHash, Date.now() + EMAIL_CODE_SECONDS * 1000);
    } catch (error) {
      console.error("Pending registration persistence failed", error);
      sendError(response, 500, "registration_failed", "Registration could not be completed");
      return;
    }
    try {
      await sendVerificationEmail(config, email, code);
    } catch (error) {
      store.deletePendingRegistration(email);
      console.error("Verification email delivery failed", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      sendError(response, 503, "email_unavailable", "Verification email could not be sent; try again later");
      return;
    }
    response.status(202).json({ message: "If this address can be registered, a verification code will be sent" });
  }));

  app.post("/portal/api/cdk/purchases/:id/retry", portalAuth, asyncRoute(async (request, response) => {
    if (!hitLimit(purchaseLimits, `cdk-retry:${portalUser(response).id}`, 10, 60 * 60_000)) {
      sendError(response, 429, "rate_limited", "Too many CDK status checks; try again later");
      return;
    }
    const purchase = store.getCdkPurchase(routeParam(request.params.id));
    if (!purchase || purchase.user_id !== portalUser(response).id) {
      sendError(response, 404, "not_found", "CDK purchase not found");
      return;
    }
    if (!["creating", "needs_review"].includes(purchase.status) || purchase.charge_status !== "charged") {
      sendError(response, 409, "purchase_not_retryable", "This purchase cannot be safely resubmitted");
      return;
    }
    const result = await submitCdkPurchase(store, config, fetcher, purchase.id);
    response.status(result.status).json({ data: result.data });
  }));

  app.post("/portal/auth/verify", asyncRoute(async (request, response) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) {
      sendError(response, 400, "validation_error", "Enter a valid email and six-digit verification code");
      return;
    }
    const pending = store.getPendingRegistration(email);
    if (!pending || pending.expires_at <= Date.now() || pending.attempts >= 5) {
      sendError(response, 400, "invalid_code", "The code is invalid or expired");
      return;
    }
    if (!validCode(code, pending.code_hash, config.gatewayApiToken)) {
      store.incrementPendingAttempts(email);
      sendError(response, 400, "invalid_code", "The code is invalid or expired");
      return;
    }
    const userId = store.completeRegistration(email, Date.now());
    if (!userId) {
      sendError(response, 409, "registration_conflict", "This email address is already registered");
      return;
    }
    const token = randomBytes(32).toString("base64url");
    store.createSession(token, userId, Date.now() + PORTAL_SESSION_SECONDS * 1000);
    setPortalCookie(response, token, config);
    response.status(201).json({ authenticated: true, email });
  }));

  app.post("/portal/auth/login", asyncRoute(async (request, response) => {
    const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
    if (!hitLimit(loginLimits, ip, 10, 15 * 60_000)) {
      response.setHeader("Retry-After", "900");
      sendError(response, 429, "rate_limited", "Too many sign-in attempts; try again later");
      return;
    }
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (password.length > 128) {
      sendError(response, 401, "invalid_credentials", "Invalid email or password");
      return;
    }
    const user = store.findUserByEmail(email);
    let passwordMatches = false;
    try {
      passwordMatches = user ? await verifyPassword(password, user.password_hash) : (await hashPassword(password), false);
    } catch (error) {
      console.error("Portal password verification failed", error);
      sendError(response, 500, "login_failed", "Sign-in could not be completed");
      return;
    }
    if (!user || user.status !== "active" || !passwordMatches) {
      sendError(response, 401, "invalid_credentials", "Invalid email or password");
      return;
    }
    const token = randomBytes(32).toString("base64url");
    store.createSession(token, user.id, Date.now() + PORTAL_SESSION_SECONDS * 1000);
    setPortalCookie(response, token, config);
    response.json({ authenticated: true, email: user.email });
  }));

  app.get("/portal/auth/session", (request, response) => {
    const token = readPortalCookie(request);
    const user = token ? store.getSessionUser(token, Date.now()) : undefined;
    if (!user) {
      response.json({ authenticated: false });
      return;
    }
    response.json({ authenticated: true, user: { id: user.id, email: user.email }, wallet: store.getWallet(user.id) });
  });

  app.post("/portal/auth/logout", (request, response) => {
    const token = readPortalCookie(request);
    if (token) store.deleteSession(token);
    clearPortalCookie(response, config);
    response.status(204).end();
  });

  app.get("/portal/api/wallet", portalAuth, (_request, response) => {
    const user = portalUser(response);
    response.json({ wallet: store.getWallet(user.id), ledger: store.listLedger(user.id) });
  });

  app.get("/portal/api/prices", portalAuth, (_request, response) => {
    response.json({ data: store.listPrices(true) });
  });

  app.get("/portal/api/topups", portalAuth, (_request, response) => {
    response.json({ data: store.listTopups(portalUser(response).id) });
  });

  app.post("/portal/api/topups", portalAuth, asyncRoute(async (request, response) => {
    const user = portalUser(response);
    const key = requireIdempotencyKey(request, response);
    if (!key) return;
    if (!hitLimit(purchaseLimits, `topup:${user.id}`, 10, 60 * 60_000)) {
      sendError(response, 429, "rate_limited", "Too many recharge attempts; try again later");
      return;
    }
    const amountFen = request.body?.amount_fen;
    if (!Number.isSafeInteger(amountFen) || amountFen < 1000 || amountFen > 10_000_000) {
      sendError(response, 400, "validation_error", "Recharge amount must be between 10 and 100000 CNY");
      return;
    }
    if (!config.epayBaseUrl || !config.epayPid || !config.epayKey || !config.publicBaseUrl) {
      sendError(response, 503, "payment_unavailable", "Payment gateway is not configured");
      return;
    }
    let orderId: string;
    try {
      orderId = store.createTopup(
        `T${Date.now()}${randomBytes(8).toString("hex")}`,
        user.id,
        amountFen,
        config.epayType,
        key,
      );
      const topup = store.getTopup(orderId);
      if (!topup || topup.status !== "pending") {
        sendError(response, 409, "topup_not_pending", "This recharge order is no longer payable");
        return;
      }
      const checkoutUrl = createEpayCheckoutUrl(config, {
        id: topup.id,
        amountFen: topup.amount_fen,
        subject: "平台余额充值",
      });
      response.status(201).json({ data: { id: topup.id, amount_fen: topup.amount_fen, checkout_url: checkoutUrl } });
    } catch (error) {
      handlePlatformError(response, error);
    }
  }));

  app.post("/portal/api/orders/check", portalAuth, asyncRoute(async (request, response) => {
    const user = portalUser(response);
    const product = request.body?.product;
    const country = request.body?.country;
    const session = request.body?.session;
    if (!["gpt", "claude", "grok"].includes(product) || typeof country !== "string" ||
        !/^[A-Z]{2,5}$/.test(country) || typeof session !== "string" || !session.trim() || session.length > 20_000) {
      sendError(response, 400, "validation_error", "Product, country, and account session are required");
      return;
    }
    if (!hitLimit(loginLimits, `check:${user.id}`, 10, 60_000)) {
      sendError(response, 429, "rate_limited", "Too many account checks; try again shortly");
      return;
    }
    const productCode = typeof request.body?.product_code === "string" ? request.body.product_code.trim() : "";
    const body = product === "gpt"
      ? { country, pay_mode: "auto_card", session, ...(productCode ? { product_code: productCode.slice(0, 40) } : {}) }
      : { product, country, pay_mode: "auto_card", session };
    try {
      const upstream = await fetcher(new URL(`/api/v1/${product === "gpt" ? "gpt" : "direct"}/check`, KAFUDA_API_ORIGIN), {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.kafudaApiKey}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const payload: unknown = await upstream.json().catch(() => undefined);
      if (!upstream.ok || !isRecord(unwrapData(payload))) {
        sendError(response, upstream.status >= 500 ? 502 : 422, "account_check_failed", "Account check failed; verify the session and try again");
        return;
      }
      const data = unwrapData(payload) as JsonRecord;
      const plans = Array.isArray(data.plans) ? data.plans : [];
      const pricedPlans = plans.map((item) => {
        if (!isRecord(item)) return item;
        const quoteId = stringValue(item.quote_id);
        const plan = stringValue(item.plan);
        const priceFen = plan ? store.getSellPrice(product, plan, country) : undefined;
        const status = item.status === "available" && priceFen !== undefined ? "available" : "unavailable";
        if (quoteId && plan && priceFen !== undefined && item.status === "available") {
          store.saveQuote({
            quote_id: quoteId,
            user_id: user.id,
            product,
            plan,
            country,
            price_fen: priceFen,
            expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
            used_at: null,
          });
        }
        return {
          ...item,
          ...(quoteId ? { quote_id: quoteId } : {}),
          status,
          sell_price_fen: priceFen ?? null,
          sell_currency: "CNY",
        };
      });
      response.json({ data: { ...data, plans: pricedPlans } });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      sendError(response, timedOut ? 504 : 502, "upstream_unavailable", "Account check could not be completed");
    }
  }));

  app.get("/portal/api/orders", portalAuth, (_request, response) => {
    response.json({ data: store.listCustomerOrders(portalUser(response).id) });
  });

  app.post("/portal/api/orders", portalAuth, asyncRoute(async (request, response) => {
    const user = portalUser(response);
    const key = requireIdempotencyKey(request, response);
    if (!key) return;
    if (!hitLimit(purchaseLimits, `order:${user.id}`, 10, 60 * 60_000)) {
      sendError(response, 429, "rate_limited", "Too many order submissions; try again later");
      return;
    }
    const quoteId = typeof request.body?.quote_id === "string" ? request.body.quote_id : "";
    const reference = typeof request.body?.reference === "string" ? request.body.reference.trim().slice(0, 100) : null;
    if (!quoteId || quoteId.length > 200) {
      sendError(response, 400, "validation_error", "A valid quote_id is required");
      return;
    }
    const orderId = randomBytes(16).toString("hex");
    try {
      const created = store.createCustomerOrder(orderId, quoteId, user.id, reference, key);
      const saved = store.getCustomerOrder(created.id, user.id);
      if (saved && (saved.upstream_order_id || saved.charge_status !== "charged")) {
        response.json({ data: saved });
        return;
      }
      const result = await submitCustomerOrder(store, config, fetcher, created.id);
      response.status(result.status).json({ data: result.data });
    } catch (error) {
      handlePlatformError(response, error);
    }
  }));

  app.post("/portal/api/orders/:id/retry", portalAuth, asyncRoute(async (request, response) => {
    if (!hitLimit(purchaseLimits, `order-retry:${portalUser(response).id}`, 10, 60 * 60_000)) {
      sendError(response, 429, "rate_limited", "Too many order checks; try again later");
      return;
    }
    const order = store.getCustomerOrder(routeParam(request.params.id), portalUser(response).id);
    if (!order) {
      sendError(response, 404, "not_found", "Order not found");
      return;
    }
    if (order.upstream_order_id || !["submitting", "needs_review"].includes(order.status) || order.charge_status !== "charged") {
      sendError(response, 409, "order_not_retryable", "This order cannot be safely resubmitted");
      return;
    }
    const result = await submitCustomerOrder(store, config, fetcher, order.id);
    response.status(result.status).json({ data: result.data });
  }));

  app.post("/portal/api/orders/:id/refresh", portalAuth, asyncRoute(async (request, response) => {
    if (!hitLimit(purchaseLimits, `order-refresh:${portalUser(response).id}`, 30, 60_000)) {
      sendError(response, 429, "rate_limited", "Too many order status checks; try again shortly");
      return;
    }
    const order = store.getCustomerOrder(routeParam(request.params.id), portalUser(response).id);
    if (!order) {
      sendError(response, 404, "not_found", "Order not found");
      return;
    }
    if (!order.upstream_order_id) {
      sendError(response, 409, "upstream_order_missing", "The upstream order has not been confirmed");
      return;
    }
    try {
      const upstream = await fetcher(
        new URL(`/api/v1/gpt/orders/${encodeURIComponent(order.upstream_order_id)}`, KAFUDA_API_ORIGIN),
        {
          headers: { authorization: `Bearer ${config.kafudaApiKey}`, accept: "application/json" },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        },
      );
      const payload: unknown = await upstream.json().catch(() => undefined);
      if (!upstream.ok) {
        sendError(response, 502, "upstream_unavailable", "Order status could not be refreshed");
        return;
      }
      const data = unwrapData(payload);
      const orderData = isRecord(data) && isRecord(data.order) ? data.order : data;
      const status = isRecord(orderData) ? stringValue(orderData.status) : undefined;
      if (status) store.settleOrderFromWebhook(order.upstream_order_id, status);
      response.json({ data: store.getCustomerOrder(order.id, order.user_id) });
    } catch {
      sendError(response, 502, "upstream_unavailable", "Order status could not be refreshed");
    }
  }));

  app.post("/portal/api/cdk/purchases", portalAuth, asyncRoute(async (request, response) => {
    const user = portalUser(response);
    const key = requireIdempotencyKey(request, response);
    if (!key) return;
    if (!hitLimit(purchaseLimits, `cdk:${user.id}`, 10, 60 * 60_000)) {
      sendError(response, 429, "rate_limited", "Too many CDK purchase attempts; try again later");
      return;
    }
    const plan = typeof request.body?.plan === "string" ? request.body.plan.trim() : "";
    const country = typeof request.body?.country === "string" ? request.body.country : "";
    const count = request.body?.count;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(plan) || !/^[A-Z]{2,5}$/.test(country) ||
        !Number.isSafeInteger(count) || count < 1 || count > 50) {
      sendError(response, 400, "validation_error", "Plan, country, or quantity is invalid");
      return;
    }
    if (config.cdkFundingCapCents <= 0) {
      sendError(response, 503, "cdk_unavailable", "CDK funding cap is not configured");
      return;
    }
    const unitPriceFen = store.getSellPrice("cdk", plan, country);
    if (unitPriceFen === undefined) {
      sendError(response, 404, "price_unavailable", "This CDK product is not currently for sale");
      return;
    }
    const purchaseId = randomBytes(16).toString("hex");
    try {
      const effectiveId = store.createCdkPurchase(
        purchaseId, user.id, plan, country, count, 180, config.cdkFundingCapCents, unitPriceFen, key,
      );
      const saved = store.getCdkPurchase(effectiveId);
      if (saved?.status === "completed") {
        response.json({
          data: { id: effectiveId, status: saved.status, codes: store.listCdkCodesForPurchase(effectiveId, user.id) },
        });
        return;
      }
      const result = await submitCdkPurchase(store, config, fetcher, effectiveId);
      response.status(result.status).json({ data: result.data });
    } catch (error) {
      handlePlatformError(response, error);
    }
  }));

  app.get("/portal/api/cdk/purchases", portalAuth, (_request, response) => {
    response.json({ data: store.listCdkPurchases(portalUser(response).id) });
  });

  app.get("/portal/api/cdk/codes", portalAuth, (_request, response) => {
    response.json({ data: store.listCdkCodes(portalUser(response).id) });
  });

  app.get("/portal/api/payments/:id", portalAuth, (request, response) => {
    const topup = store.getTopup(routeParam(request.params.id));
    if (!topup || topup.user_id !== portalUser(response).id) {
      sendError(response, 404, "not_found", "Recharge order not found");
      return;
    }
    response.json({ data: topup });
  });

  app.all(
    "/payments/epay/notify",
    express.urlencoded({ extended: false, limit: "16kb" }),
    (request, response) => {
      const input = request.method === "POST" ? request.body : request.query;
      const parameters = validateEpayInput(input);
      if (!parameters || !config.epayPid || !config.epayKey ||
          parameters.sign_type !== "MD5" || !verifyEpayParameters(parameters, config.epayKey)) {
        response.status(400).type("text/plain").send("fail");
        return;
      }
      const id = parameters.out_trade_no;
      const tradeNo = parameters.trade_no;
      const amountFen = amountToFen(parameters.money ?? "");
      const order = id ? store.getTopup(id) : undefined;
      if (parameters.pid !== config.epayPid || parameters.trade_status !== "TRADE_SUCCESS" ||
          !id || !tradeNo || tradeNo.length > 100 || !amountFen || !order ||
          order.amount_fen !== amountFen || order.payment_type !== parameters.type) {
        response.status(400).type("text/plain").send("fail");
        return;
      }
      if (order.status === "paid") {
        response.status(order.gateway_trade_no === tradeNo ? 200 : 400).type("text/plain")
          .send(order.gateway_trade_no === tradeNo ? "success" : "fail");
        return;
      }
      try {
        const credited = store.creditTopup(id, tradeNo);
        if (!credited) {
          const current = store.getTopup(id);
          if (current?.status !== "paid" || current.gateway_trade_no !== tradeNo) {
            response.status(400).type("text/plain").send("fail");
            return;
          }
        }
        response.status(200).type("text/plain").send("success");
      } catch (error) {
        console.error("Epay settlement failed", { orderId: id, error });
        response.status(500).type("text/plain").send("fail");
      }
    },
  );

  const adminAuth = createApiAuth(config);
  app.get("/admin/platform/users", adminAuth, (_request, response) => {
    response.json({ data: store.listUsers() });
  });
  app.patch("/admin/platform/users/:id/status", adminAuth, (request, response) => {
    const id = Number(request.params.id);
    const status = request.body?.status;
    if (!Number.isSafeInteger(id) || id < 1 || !["active", "disabled"].includes(status)) {
      sendError(response, 400, "validation_error", "User ID or status is invalid");
      return;
    }
    if (!store.setUserStatus(id, status)) {
      sendError(response, 404, "not_found", "User not found");
      return;
    }
    response.json({ updated: true });
  });
  app.post("/admin/platform/users/:id/wallet-adjust", adminAuth, (request, response) => {
    const id = Number(request.params.id);
    const amountFen = request.body?.amount_fen;
    const memo = typeof request.body?.memo === "string" ? request.body.memo.trim() : "";
    const key = requireIdempotencyKey(request, response);
    if (!key) return;
    if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(amountFen) ||
        amountFen === 0 || Math.abs(amountFen) > 10_000_000 || !memo) {
      sendError(response, 400, "validation_error", "User, amount, and adjustment memo are required");
      return;
    }
    try {
      store.adjustWallet(id, amountFen, key, memo);
      response.json({ updated: true, wallet: store.getWallet(id) });
    } catch (error) {
      handlePlatformError(response, error);
    }
  });
  app.get("/admin/platform/prices", adminAuth, (_request, response) => {
    response.json({ data: store.listPrices() });
  });
  app.post("/admin/platform/prices", adminAuth, (request, response) => {
    const { product, plan, country, price_fen: priceFen, enabled } = request.body ?? {};
    if (!["gpt", "claude", "grok", "cdk"].includes(product) ||
        typeof plan !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(plan) ||
        typeof country !== "string" || !/^(?:AUTO|[A-Z]{2,5})$/.test(country) ||
        !Number.isSafeInteger(priceFen) || priceFen < 1 || priceFen > 10_000_000 ||
        typeof enabled !== "boolean") {
      sendError(response, 400, "validation_error", "Price entry is invalid");
      return;
    }
    store.upsertPrice(product, plan, country, priceFen, enabled);
    response.json({ saved: true });
  });
  app.delete("/admin/platform/prices/:id", adminAuth, (request, response) => {
    const id = Number(routeParam(request.params.id));
    if (!Number.isSafeInteger(id) || id < 1) {
      sendError(response, 400, "validation_error", "Price ID is invalid");
      return;
    }
    if (!store.deletePrice(id)) {
      sendError(response, 404, "not_found", "Price entry not found");
      return;
    }
    response.json({ deleted: true });
  });
  app.get("/admin/platform/topups", adminAuth, (_request, response) => {
    response.json({ data: store.listTopups() });
  });
  app.get("/admin/platform/orders", adminAuth, (_request, response) => {
    response.json({ data: store.listCustomerOrders() });
  });
  app.post("/admin/platform/orders/:id/resolve", adminAuth, (request, response) => {
    const action = request.body?.action;
    const memo = typeof request.body?.memo === "string" ? request.body.memo.trim() : "";
    if (!["refund", "settle"].includes(action) || !memo) {
      sendError(response, 400, "validation_error", "Choose refund or settle and provide a resolution note");
      return;
    }
    try {
      store.resolveCustomerOrder(routeParam(request.params.id), action, memo);
      response.json({ updated: true });
    } catch (error) {
      handlePlatformError(response, error);
    }
  });
  app.get("/admin/platform/cdk-purchases", adminAuth, (_request, response) => {
    response.json({ data: store.listCdkPurchases() });
  });
  app.post("/admin/platform/cdk-purchases/:id/resolve", adminAuth, (request, response) => {
    const action = request.body?.action;
    const memo = typeof request.body?.memo === "string" ? request.body.memo.trim() : "";
    if (!["refund", "settle"].includes(action) || !memo) {
      sendError(response, 400, "validation_error", "Choose refund or settle and provide a resolution note");
      return;
    }
    try {
      store.resolveCdkPurchase(routeParam(request.params.id), action, memo);
      response.json({ updated: true });
    } catch (error) {
      handlePlatformError(response, error);
    }
  });

}

async function submitCustomerOrder(
  store: PlatformStore,
  config: Config,
  fetcher: typeof fetch,
  id: string,
): Promise<{ status: number; data: JsonRecord }> {
  const order = store.getCustomerOrder(id);
  if (!order) throw new PlatformError("order_not_found", "订单不存在");
  const body: JsonRecord = {
    quote_id: order.quote_id,
    ...(order.reference ? { reference: order.reference } : {}),
  };
  try {
    const upstream = await fetcher(new URL("/api/v1/gpt/orders", KAFUDA_API_ORIGIN), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.kafudaApiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": id,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const payload: unknown = await upstream.json().catch(() => undefined);
    if (!upstream.ok) {
      if (upstream.status >= 500) {
        store.markOrderForReview(id, "上游返回不确定错误，余额暂未退回");
        return { status: 202, data: { id, status: "needs_review" } };
      }
      store.refundUnsubmittedOrder(id, "上游拒绝订单，已退回余额");
      throw new PlatformError("upstream_rejected", "上游拒绝订单，已退回余额");
    }
    const rawData = unwrapData(payload);
    const data = isRecord(rawData) && isRecord(rawData.order) ? rawData.order : rawData;
    const upstreamId = isRecord(data) ? stringValue(data.id) : undefined;
    const status = isRecord(data) ? stringValue(data.status) ?? "processing" : undefined;
    if (!upstreamId || !status) {
      store.markOrderForReview(id, "上游响应缺少订单标识，余额暂未退回");
      return { status: 202, data: { id, status: "needs_review" } };
    }
    store.attachUpstreamOrder(id, upstreamId, status);
    if (["failed", "cancelled", "canceled", "completed", "succeeded", "success", "paid"].includes(status.toLowerCase())) {
      store.settleOrderFromWebhook(upstreamId, status);
    }
    return { status: 202, data: { id, upstream_order_id: upstreamId, status } };
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    store.markOrderForReview(id, "上游连接结果不确定，余额暂未退回");
    return { status: 202, data: { id, status: "needs_review" } };
  }
}

async function submitCdkPurchase(
  store: PlatformStore,
  config: Config,
  fetcher: typeof fetch,
  id: string,
): Promise<{ status: number; data: JsonRecord }> {
  const details = store.getCdkPurchase(id);
  if (!details) throw new PlatformError("purchase_not_found", "CDK 购买订单不存在");
  try {
    const upstream = await fetcher(new URL("/api/v1/cdk/batches", KAFUDA_API_ORIGIN), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.kafudaApiKey}`,
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": id,
      },
      body: JSON.stringify({
        plan: details.plan,
        country: details.country,
        count: details.count,
        expires_days: details.expires_days,
        funding_cap_cents: details.funding_cap_cents,
        auto_open: false,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const payload: unknown = await upstream.json().catch(() => undefined);
    if (!upstream.ok) {
      if (upstream.status >= 500) {
        store.markCdkPurchaseForReview(id, "上游返回不确定错误，余额暂未退回");
        return { status: 202, data: { id, status: "needs_review" } };
      }
      store.refundCdkPurchase(id, "上游拒绝 CDK 批次，已退回余额");
      throw new PlatformError("upstream_rejected", "上游拒绝 CDK 批次，已退回余额");
    }
    const rawData = unwrapData(payload);
    const data = isRecord(rawData) && isRecord(rawData.batch) ? rawData.batch : rawData;
    const codes = isRecord(data) && Array.isArray(data.codes)
      ? data.codes
      : isRecord(rawData) && Array.isArray(rawData.codes) ? rawData.codes : [];
    const batchId = isRecord(data) ? stringValue(data.id) : isRecord(rawData) ? stringValue(rawData.batch_id) : undefined;
    if (!batchId || codes.length !== details.count ||
        codes.some((item) => !isRecord(item) || typeof item.code !== "string" || !item.code)) {
      store.markCdkPurchaseForReview(id, "上游批次或卡密数量与请求不匹配，余额暂未退回");
      return { status: 202, data: { id, status: "needs_review" } };
    }
    store.finishCdkPurchase(id, batchId, codes.map((item) => ({
      code: String((item as JsonRecord).code),
      status: stringValue((item as JsonRecord).status),
      expiresAt: stringValue((item as JsonRecord).expires_at),
    })));
    return { status: 201, data: { id, batch_id: batchId, status: "completed", codes } };
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    store.markCdkPurchaseForReview(id, "上游连接结果不确定，余额暂未退回");
    return { status: 202, data: { id, status: "needs_review" } };
  }
}

function handlePlatformError(response: Response, error: unknown): void {
  if (error instanceof PlatformError) {
    const conflictCodes = [
      "idempotency_conflict",
      "balance_limit",
      "order_not_reviewable",
      "purchase_not_reviewable",
      "codes_incomplete",
    ];
    const status = error.code === "user_not_found" || error.code.endsWith("_not_found")
      ? 404
      : error.code === "insufficient_balance" ? 402
      : conflictCodes.includes(error.code) ? 409
      : 400;
    sendError(response, status, error.code, error.message);
    return;
  }
  console.error("Platform transaction failed", error);
  sendError(response, 500, "platform_error", "The operation could not be completed");
}
