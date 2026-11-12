import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseWebhookEvent, verifyKafudaSignature } from "../src/webhook";

const secret = "whsec_test_secret";

function signatureFor(body: Buffer, timestamp: number): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

describe("Kafuda webhook verification", () => {
  it("verifies the signature against the exact raw body", () => {
    const body = Buffer.from('{"id":"evt_1","type":"card.opened","created_at":"2026-11-12T00:00:00Z","data":{}}');
    const timestamp = 1_800_000_000;

    expect(verifyKafudaSignature(body, signatureFor(body, timestamp), secret, timestamp)).toBe(true);
    expect(verifyKafudaSignature(Buffer.from(`${body.toString()} `), signatureFor(body, timestamp), secret, timestamp)).toBe(false);
  });

  it("rejects stale timestamps and malformed payloads", () => {
    const body = Buffer.from('{"id":"evt_1","type":"card.opened","created_at":"2026-11-12T00:00:00Z","data":{}}');
    const timestamp = 1_800_000_000;

    expect(verifyKafudaSignature(body, signatureFor(body, timestamp), secret, timestamp + 301)).toBe(false);
    expect(parseWebhookEvent(Buffer.from("{"))).toBeUndefined();
  });

  it("accepts a structurally valid event", () => {
    const event = parseWebhookEvent(
      Buffer.from('{"id":"evt_1","type":"card.opened","created_at":"2026-11-12T00:00:00Z","data":{"card_id":"card_1"}}'),
    );
    expect(event?.id).toBe("evt_1");
    expect(event?.type).toBe("card.opened");
  });
});
