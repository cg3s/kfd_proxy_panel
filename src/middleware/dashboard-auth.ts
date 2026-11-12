import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { Config } from "../config";

export const DASHBOARD_COOKIE = "kafuda_dashboard";
export const DASHBOARD_SESSION_SECONDS = 8 * 60 * 60;

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function signature(payload: string, config: Config): string {
  return createHmac("sha256", `${config.gatewayApiToken}:${config.dashboardPassword}`)
    .update(payload)
    .digest("base64url");
}

function readCookie(request: Request, name: string): string | undefined {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function isValidDashboardSession(value: string | undefined, config: Config): boolean {
  if (!value) return false;
  const [timestampText, nonce, suppliedSignature, extra] = value.split(".");
  if (extra !== undefined || !timestampText || !nonce || !suppliedSignature) return false;
  if (!/^\d+$/.test(timestampText) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;

  const issuedAt = Number(timestampText);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60 || now - issuedAt > DASHBOARD_SESSION_SECONDS) {
    return false;
  }

  return safeEqual(signature(`${timestampText}.${nonce}`, config), suppliedSignature);
}

export function createDashboardSession(config: Config): string {
  const payload = `${Math.floor(Date.now() / 1000)}.${randomBytes(18).toString("base64url")}`;
  return `${payload}.${signature(payload, config)}`;
}

export function setDashboardCookie(res: Response, value: string, config: Config): void {
  const attributes = [
    `${DASHBOARD_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${DASHBOARD_SESSION_SECONDS}`,
  ];
  if (config.cookieSecure) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

export function clearDashboardCookie(res: Response, config: Config): void {
  const attributes = [`${DASHBOARD_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
  if (config.cookieSecure) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

export function createApiAuth(config: Config) {
  const expectedTokenDigest = createHash("sha256").update(config.gatewayApiToken).digest();

  return (req: Request, res: Response, next: NextFunction): void => {
    const bearer = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      const suppliedDigest = createHash("sha256").update(bearer).digest();
      if (timingSafeEqual(expectedTokenDigest, suppliedDigest)) {
        next();
        return;
      }
    }

    if (isValidDashboardSession(readCookie(req, DASHBOARD_COOKIE), config)) {
      next();
      return;
    }

    res.status(401).json({ error: { code: "unauthorized", message: "Authentication required" } });
  };
}

export function verifyDashboardPassword(password: string, expectedPassword: string): boolean {
  return safeEqual(password, expectedPassword);
}
