import { describe, expect, it } from "vitest";
import { dollarsToCents } from "../web/src/AccountPage";

describe("USD form amount conversion", () => {
  it("converts decimal amounts to integer cents without floating point", () => {
    expect(dollarsToCents("20")).toBe(2000);
    expect(dollarsToCents("0.05")).toBe(5);
    expect(dollarsToCents("1.2")).toBe(120);
  });

  it("rejects malformed, fractional-cent, and non-positive amounts", () => {
    expect(dollarsToCents("1.001")).toBeUndefined();
    expect(dollarsToCents("-1")).toBeUndefined();
    expect(dollarsToCents("0")).toBeUndefined();
  });
});
