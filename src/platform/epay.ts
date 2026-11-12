import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "../config";

export type EpayParameters = Record<string, string>;

export function signEpayParameters(parameters: EpayParameters, key: string): string {
  const canonical = Object.entries(parameters)
    .filter(([name, value]) => name !== "sign" && name !== "sign_type" && value !== "")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return createHash("md5").update(`${canonical}${key}`, "utf8").digest("hex");
}

export function verifyEpayParameters(parameters: EpayParameters, key: string): boolean {
  const supplied = parameters.sign;
  if (!supplied || !/^[a-f\d]{32}$/i.test(supplied)) return false;
  const expected = signEpayParameters(parameters, key);
  return timingSafeEqual(Buffer.from(expected.toLowerCase()), Buffer.from(supplied.toLowerCase()));
}

export function createEpayCheckoutUrl(
  config: Config,
  order: { id: string; amountFen: number; subject: string },
): string {
  const baseUrl = new URL(config.epayBaseUrl);
  const publicUrl = new URL(config.publicBaseUrl);
  if (
    !isSecureEndpoint(baseUrl) ||
    !isSecureEndpoint(publicUrl) ||
    baseUrl.username || baseUrl.password || publicUrl.username || publicUrl.password ||
    baseUrl.search || baseUrl.hash || publicUrl.search || publicUrl.hash
  ) {
    throw new Error("Payment gateway and public base URLs must be valid HTTPS URLs (HTTP is allowed for localhost)");
  }
  baseUrl.search = "";
  baseUrl.hash = "";
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  const checkoutUrl = new URL("submit.php", baseUrl);
  const parameters: EpayParameters = {
    pid: config.epayPid,
    type: config.epayType,
    out_trade_no: order.id,
    notify_url: `${config.publicBaseUrl}/payments/epay/notify`,
    return_url: `${config.publicBaseUrl}/shop?payment=${encodeURIComponent(order.id)}`,
    name: order.subject,
    money: (order.amountFen / 100).toFixed(2),
    sign_type: "MD5",
  };
  parameters.sign = signEpayParameters(parameters, config.epayKey);
  for (const [name, value] of Object.entries(parameters)) checkoutUrl.searchParams.set(name, value);
  return checkoutUrl.toString();
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function isSecureEndpoint(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

export function amountToFen(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return undefined;
  const [yuan, fraction = ""] = value.split(".");
  const amount = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : undefined;
}
