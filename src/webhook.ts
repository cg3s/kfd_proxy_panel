import { createHmac, timingSafeEqual } from "node:crypto";

export interface KafudaWebhookEvent {
  id: string;
  type: string;
  created_at: string;
  data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function verifyKafudaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader) return false;

  const fields = new Map<string, string>();
  for (const component of signatureHeader.split(",")) {
    const separator = component.indexOf("=");
    if (separator <= 0) return false;
    fields.set(component.slice(0, separator).trim(), component.slice(separator + 1).trim());
  }

  const timestampText = fields.get("t");
  const suppliedSignature = fields.get("v1");
  if (!timestampText || !/^\d+$/.test(timestampText) || !suppliedSignature || !/^[\da-f]{64}$/i.test(suppliedSignature)) {
    return false;
  }

  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestampText}.`)
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(suppliedSignature, "hex");
  return supplied.length === expected.length && timingSafeEqual(expected, supplied);
}

export function parseWebhookEvent(rawBody: Buffer): KafudaWebhookEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return undefined;
  }

  if (!isRecord(value)) return undefined;
  const event = value;
  if (
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    typeof event.created_at !== "string" ||
    !isRecord(event.data)
  ) {
    return undefined;
  }

  return {
    id: event.id,
    type: event.type,
    created_at: event.created_at,
    data: event.data,
  };
}
