import { describe, expect, it } from "vitest";
import {
  createDashboardSession,
  isValidDashboardSession,
  verifyDashboardPassword,
} from "../src/middleware/dashboard-auth";

const config = {
  port: 3000,
  host: "127.0.0.1",
  databasePath: ":memory:",
  kafudaApiKey: "vk_test",
  gatewayApiToken: "gateway_secret",
  webhookSecret: "whsec_test",
  dashboardPassword: "dashboard_secret",
  cookieSecure: false,
};

describe("dashboard authentication", () => {
  it("issues a signed session that is bound to the configured secrets", () => {
    const session = createDashboardSession(config);
    expect(isValidDashboardSession(session, config)).toBe(true);
    expect(isValidDashboardSession(session, { ...config, dashboardPassword: "changed" })).toBe(false);
    expect(isValidDashboardSession("malformed", config)).toBe(false);
  });

  it("compares login passwords without accepting a different value", () => {
    expect(verifyDashboardPassword("dashboard_secret", config.dashboardPassword)).toBe(true);
    expect(verifyDashboardPassword("incorrect", config.dashboardPassword)).toBe(false);
  });
});
