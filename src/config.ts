import "dotenv/config";
import { join, resolve } from "node:path";

export interface Config {
  port: number;
  host: string;
  databasePath: string;
  kafudaApiKey: string;
  gatewayApiToken: string;
  webhookSecret: string;
  dashboardPassword: string;
  cookieSecure: boolean;
}

export function loadDatabasePath(): string {
  return resolve(process.cwd(), process.env.DATABASE_PATH ?? join("db", "kafuda.sqlite"));
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const dashboardPassword = required("DASHBOARD_PASSWORD");
  if (dashboardPassword.length < 16) {
    throw new Error("DASHBOARD_PASSWORD must be at least 16 characters long");
  }
  const cookieSecureValue = process.env.COOKIE_SECURE ?? "false";
  if (cookieSecureValue !== "true" && cookieSecureValue !== "false") {
    throw new Error("COOKIE_SECURE must be either true or false");
  }

  return {
    port,
    host: process.env.HOST?.trim() || "0.0.0.0",
    databasePath: loadDatabasePath(),
    kafudaApiKey: required("KAFUDA_API_KEY"),
    gatewayApiToken: required("GATEWAY_API_TOKEN"),
    webhookSecret: required("KAFUDA_WEBHOOK_SECRET"),
    dashboardPassword,
    cookieSecure: cookieSecureValue === "true",
  };
}
