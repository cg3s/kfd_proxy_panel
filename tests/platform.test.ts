import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDatabase } from "../src/database";
import type { Config } from "../src/config";
import { signEpayParameters } from "../src/platform/epay";
import { PlatformStore } from "../src/platform/store";
import { createApp } from "../src/server";

const config: Config = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  kafudaApiKey: "vk_test",
  gatewayApiToken: "gateway_test_secret",
  webhookSecret: "webhook_test_secret",
  dashboardPassword: "dashboard_test_password",
  cookieSecure: false,
  publicBaseUrl: "https://shop.example.test",
  epayBaseUrl: "https://pay.example.test",
  epayPid: "12345",
  epayKey: "epay_test_secret",
  epayType: "alipay",
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPassword: "",
  smtpFrom: "",
  cdkFundingCapCents: 500,
};

function createPlatform() {
  const database = new SqliteDatabase(":memory:");
  database.migrate(readFileSync(join(process.cwd(), "migrations", "001_webhook_events.sql"), "utf8"));
  database.migrate(readFileSync(join(process.cwd(), "migrations", "002_multi_user_platform.sql"), "utf8"));
  const store = new PlatformStore(database.connection);
  const register = (email: string) => {
    store.createPendingRegistration(email, "test-password-hash", "test-code-hash", Date.now() + 60_000);
    const userId = store.completeRegistration(email, Date.now());
    if (!userId) throw new Error("Could not create test user");
    return userId;
  };
  return { database, store, register };
}

describe("customer wallet and payment platform", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
      server = undefined;
    }
  });

  it("allows an operator to unpublish and delete a catalog price", async () => {
    const { database, store } = createPlatform();
    try {
      store.upsertPrice("cdk", "plus", "AUTO", 2500, true);
      const [price] = store.listPrices();
      server = createServer(createApp(config, database, async () => new Response("{}"), store));
      await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const headers = {
        authorization: `Bearer ${config.gatewayApiToken}`,
        "content-type": "application/json",
      };

      const unpublished = await fetch(`${baseUrl}/admin/platform/prices`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...price, enabled: false }),
      });
      expect(unpublished.status).toBe(200);
      expect(store.listPrices()[0].enabled).toBe(0);

      const deleted = await fetch(`${baseUrl}/admin/platform/prices/${price.id}`, {
        method: "DELETE",
        headers: { authorization: headers.authorization },
      });
      expect(deleted.status).toBe(200);
      expect(store.listPrices()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("credits an Epay recharge once and rejects mismatched callback amounts", async () => {
    const { database, store, register } = createPlatform();
    const userId = register("payer@example.test");
    const topupId = store.createTopup("T-test-1", userId, 5000, "alipay", "topup-key-1");
    const fetcher: typeof fetch = async () => new Response("{}", { status: 200 });
    server = createServer(createApp(config, database, fetcher, store));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const unauthenticated = await fetch(`${baseUrl}/portal/api/wallet`);
    expect(unauthenticated.status).toBe(401);

    const valid = {
      pid: config.epayPid,
      type: "alipay",
      out_trade_no: topupId,
      trade_no: "gateway-trade-1",
      trade_status: "TRADE_SUCCESS",
      money: "50.00",
      sign_type: "MD5",
    };
    const sign = (parameters: Record<string, string>) => {
      const signed = { ...parameters, sign: signEpayParameters(parameters, config.epayKey) };
      return new URLSearchParams(signed);
    };
    const first = await fetch(`${baseUrl}/payments/epay/notify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: sign(valid),
    });
    const duplicate = await fetch(`${baseUrl}/payments/epay/notify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: sign(valid),
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("success");
    expect(duplicate.status).toBe(200);
    expect(store.getWallet(userId).balance_fen).toBe(5000);
    expect(store.listLedger(userId)).toHaveLength(1);

    const invalidAmount = await fetch(`${baseUrl}/payments/epay/notify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: sign({ ...valid, out_trade_no: "T-test-1", trade_no: "gateway-trade-2", money: "49.99" }),
    });
    expect(invalidAmount.status).toBe(400);
    expect(store.getWallet(userId).balance_fen).toBe(5000);
    const invalidSignature = await fetch(`${baseUrl}/payments/epay/notify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...valid, sign: "0".repeat(32) }),
    });
    expect(invalidSignature.status).toBe(400);
    database.close();
  });

  it("isolates quotes and refunds a failed order only once", () => {
    const { database, store, register } = createPlatform();
    try {
      const firstUser = register("first@example.test");
      const secondUser = register("second@example.test");
      const topupId = store.createTopup("T-test-2", firstUser, 5000, "alipay", "topup-key-2");
      expect(store.creditTopup(topupId, "gateway-trade-2")).toBe(true);
      store.upsertPrice("gpt", "plus", "PH", 3000, true);
      store.saveQuote({
        quote_id: "quote-user-one",
        user_id: firstUser,
        product: "gpt",
        plan: "plus",
        country: "PH",
        price_fen: 3000,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        used_at: null,
      });
      expect(store.getQuote("quote-user-one", secondUser)).toBeUndefined();
      const order = store.createCustomerOrder("order-local-1", "quote-user-one", firstUser, null, "order-key-1");
      expect(order.id).toBe("order-local-1");
      store.attachUpstreamOrder(order.id, "kf-order-1", "processing");
      expect(store.getWallet(firstUser).balance_fen).toBe(2000);
      expect(store.settleOrderFromWebhook("kf-order-1", "failed")).toBe(true);
      expect(store.settleOrderFromWebhook("kf-order-1", "failed")).toBe(true);
      expect(store.getWallet(firstUser).balance_fen).toBe(5000);
      expect(store.listLedger(firstUser)).toHaveLength(3);
      expect(store.listCustomerOrders(secondUser)).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("stores generated CDKs only under the purchasing user", () => {
    const { database, store, register } = createPlatform();
    try {
      const buyer = register("buyer@example.test");
      const other = register("other@example.test");
      const topupId = store.createTopup("T-test-3", buyer, 2000, "alipay", "topup-key-3");
      store.creditTopup(topupId, "gateway-trade-3");
      const purchaseId = store.createCdkPurchase(
        "cdk-local-1", buyer, "plus", "AUTO", 1, 180, 500, 1000, "cdk-key-1",
      );
      store.markCdkPurchaseForReview(purchaseId, "upstream response uncertain");
      store.finishCdkPurchase(purchaseId, "batch-1", [{ code: "PRIVATE-CODE-1", status: "unused" }]);
      expect(store.listCdkCodes(buyer)).toHaveLength(1);
      expect(store.listCdkCodes(other)).toHaveLength(0);
      expect(store.getWallet(buyer).balance_fen).toBe(1000);
      expect(store.getCdkPurchase(purchaseId)?.charge_status).toBe("settled");
    } finally {
      database.close();
    }
  });

  it("allows an audited manual refund only once for a held order", () => {
    const { database, store, register } = createPlatform();
    try {
      const userId = register("review@example.test");
      const topupId = store.createTopup("T-test-4", userId, 5000, "alipay", "topup-key-4");
      store.creditTopup(topupId, "gateway-trade-4");
      store.saveQuote({
        quote_id: "quote-review",
        user_id: userId,
        product: "gpt",
        plan: "plus",
        country: "PH",
        price_fen: 3000,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        used_at: null,
      });
      store.createCustomerOrder("order-review", "quote-review", userId, null, "order-key-review");
      store.markOrderForReview("order-review", "upstream state unknown");
      store.resolveCustomerOrder("order-review", "refund", "upstream confirmed not created");
      expect(store.getWallet(userId).balance_fen).toBe(5000);
      expect(store.getCustomerOrder("order-review")?.charge_status).toBe("refunded");
      expect(() => store.resolveCustomerOrder("order-review", "refund", "duplicate")).toThrow();
    } finally {
      database.close();
    }
  });
});
