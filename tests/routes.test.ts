import { describe, expect, it } from "vitest";
import {
  documentedApiRouteCount,
  findDocumentedRoute,
  requiresIdempotencyKey,
} from "../src/kafuda/routes";

describe("documented Kafuda route allowlist", () => {
  it("matches parameterized paths and rejects undocumented operations", () => {
    expect(findDocumentedRoute("GET", "/api/v1/cards/card_123/sensitive")).toBeDefined();
    expect(findDocumentedRoute("POST", "/api/v1/gpt/orders/1001/cancel")).toBeDefined();
    expect(findDocumentedRoute("POST", "/api/v1/unknown")).toBeUndefined();
    expect(findDocumentedRoute("DELETE", "/api/v1/cdk/codes/1")).toBeUndefined();
  });

  it("covers the documented inventory and enforces write idempotency", () => {
    expect(documentedApiRouteCount).toBe(49);
    expect(requiresIdempotencyKey("POST", "/api/v1/gpt/orders")).toBe(true);
    expect(requiresIdempotencyKey("POST", "/api/v1/gpt/check")).toBe(false);
    expect(requiresIdempotencyKey("GET", "/api/v1/cards")).toBe(false);
  });
});
