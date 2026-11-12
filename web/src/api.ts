export type JsonRecord = Record<string, unknown>;

export async function callApi<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const error = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { code?: string; message?: string } }).error
      : undefined;
    throw new Error([error?.message, error?.code].filter(Boolean).join(" · ") || `HTTP ${response.status}`);
  }

  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

export function rowsFrom(value: unknown, ...keys: string[]): JsonRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ["items", "cards", "orders", "topups", "transactions", ...keys]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getRecord(value: unknown, key: string): JsonRecord | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

export function getString(value: unknown, key: string, fallback = "—"): string {
  if (!isRecord(value)) return fallback;
  const candidate = value[key];
  return typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : fallback;
}

export function getNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "number" ? candidate : undefined;
}

export function moneyCents(value: unknown): string {
  if (typeof value !== "number") return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
}

export function makeIdempotencyKey(): string {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function confirmMutation<T>(
  path: string,
  method: string,
  body: unknown,
  description: string,
  key = makeIdempotencyKey(),
): Promise<T | undefined> {
  if (!window.confirm(`${description}\n\n即将请求：${method} ${path}\n该操作可能产生真实资金或业务变更。`)) return undefined;
  return callApi<T>(path, { method, body, idempotencyKey: key });
}

export function formatDate(value: unknown): string {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
