import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server";

const config = {
  port: 0,
  host: "127.0.0.1",
  databasePath: ":memory:",
  kafudaApiKey: "vk_upstream_secret",
  gatewayApiToken: "local_secret",
  webhookSecret: "whsec_secret",
  dashboardPassword: "dashboard_secret",
  cookieSecure: false,
};

describe("API gateway", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  async function start(fetcher: typeof fetch) {
    const database = {
      healthCheck: vi.fn(),
      insertWebhookEvent: vi.fn().mockReturnValue(true),
      listWebhookEvents: vi.fn().mockReturnValue([]),
      migrate: vi.fn(),
      close: vi.fn(),
    };
    server = createServer(createApp(config, database, fetcher));
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it("requires the local bearer token before contacting Kafuda", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const baseUrl = await start(fetcher);

    const response = await fetch(`${baseUrl}/api/v1/account`);
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards a documented preflight request and injects the upstream key", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response('{"data":{"check_id":"chk_1"}}', {
        status: 200,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "19" },
      });
    };
    const baseUrl = await start(fetcher);

    const response = await fetch(`${baseUrl}/api/v1/gpt/check?expand=plans`, {
      method: "POST",
      headers: {
        authorization: "Bearer local_secret",
        "content-type": "application/json",
      },
      body: '{"country":"PH"}',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-remaining")).toBe("19");
    expect(capturedUrl).toBe("https://kafuda.com/api/v1/gpt/check?expand=plans");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer vk_upstream_secret");
    const body = capturedInit?.body;
    expect(Buffer.isBuffer(body) ? body.toString("utf8") : body).toBe('{"country":"PH"}');
  });

  it("rejects state-changing requests without an idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const baseUrl = await start(fetcher);

    const response = await fetch(`${baseUrl}/api/v1/cards`, {
      method: "POST",
      headers: {
        authorization: "Bearer local_secret",
        "content-type": "application/json",
      },
      body: '{"product_code":"P5378XB"}',
    });

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("authenticates the dashboard and uses its HttpOnly session for API requests", async () => {
    const fetcher: typeof fetch = async () => new Response('{"data":{"available":true}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const baseUrl = await start(fetcher);
    const login = await fetch(`${baseUrl}/dashboard/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "dashboard_secret" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const response = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { cookie: cookie!.split(";")[0] },
    });
    expect(response.status).toBe(200);
  });
});
