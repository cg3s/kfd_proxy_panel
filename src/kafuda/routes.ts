export interface ApiRoute {
  method: string;
  path: string;
}

export const documentedRoutes: ApiRoute[] = [
  { method: "GET", path: "/api/v1/account" },
  { method: "GET", path: "/api/v1/ledger" },
  { method: "GET", path: "/api/v1/topups/instructions" },
  { method: "POST", path: "/api/v1/topups" },
  { method: "GET", path: "/api/v1/topups" },
  { method: "GET", path: "/api/v1/card-products" },
  { method: "GET", path: "/api/v1/cards" },
  { method: "GET", path: "/api/v1/cards/counts" },
  { method: "POST", path: "/api/v1/cards" },
  { method: "GET", path: "/api/v1/cards/:id" },
  { method: "POST", path: "/api/v1/cards/:id/sync" },
  { method: "GET", path: "/api/v1/cards/:id/statement" },
  { method: "GET", path: "/api/v1/cards/:id/transactions" },
  { method: "GET", path: "/api/v1/card-transactions" },
  { method: "GET", path: "/api/v1/cards/:id/sensitive" },
  { method: "POST", path: "/api/v1/cards/:id/recharge" },
  { method: "POST", path: "/api/v1/cards/:id/refund" },
  { method: "POST", path: "/api/v1/cards/:id/freeze" },
  { method: "POST", path: "/api/v1/cards/:id/unfreeze" },
  { method: "DELETE", path: "/api/v1/cards/:id" },
  { method: "PUT", path: "/api/v1/cards/:id/auto-topup" },
  { method: "POST", path: "/api/v1/cards/:id/remark" },
  { method: "POST", path: "/api/v1/cards/bulk" },
  { method: "GET", path: "/api/v1/gpt/catalog" },
  { method: "POST", path: "/api/v1/gpt/check" },
  { method: "POST", path: "/api/v1/gpt/quotes" },
  { method: "GET", path: "/api/v1/gpt/orders" },
  { method: "POST", path: "/api/v1/gpt/orders" },
  { method: "GET", path: "/api/v1/gpt/orders/stats" },
  { method: "GET", path: "/api/v1/gpt/orders/:id" },
  { method: "POST", path: "/api/v1/gpt/orders/:id/refresh" },
  { method: "POST", path: "/api/v1/gpt/orders/:id/cancel" },
  { method: "GET", path: "/api/v1/direct/products" },
  { method: "GET", path: "/api/v1/direct/:product/catalog" },
  { method: "POST", path: "/api/v1/direct/check" },
  { method: "GET", path: "/api/v1/cdk/price" },
  { method: "POST", path: "/api/v1/cdk/batches" },
  { method: "GET", path: "/api/v1/cdk/batches" },
  { method: "GET", path: "/api/v1/cdk/batches/:id/export" },
  { method: "GET", path: "/api/v1/cdk/codes" },
  { method: "GET", path: "/api/v1/cdk/summary" },
  { method: "POST", path: "/api/v1/cdk/codes/disable" },
  { method: "POST", path: "/api/v1/cdk/codes/enable" },
  { method: "GET", path: "/api/v1/cdk/settings" },
  { method: "PUT", path: "/api/v1/cdk/settings" },
  { method: "POST", path: "/api/v1/cdk/redeem/preview" },
  { method: "POST", path: "/api/v1/cdk/redeem/check" },
  { method: "POST", path: "/api/v1/cdk/redeem/redeem" },
  { method: "GET", path: "/api/v1/cdk/redeem/status" },
];

const idempotencyExemptPaths = new Set([
  "/api/v1/gpt/check",
  "/api/v1/gpt/quotes",
  "/api/v1/direct/check",
  "/api/v1/cdk/redeem/preview",
  "/api/v1/cdk/redeem/check",
]);

function pathMatches(pattern: string, pathname: string): boolean {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  return expected.length === actual.length && expected.every((part, index) =>
    part.startsWith(":") ? actual[index].length > 0 : part === actual[index],
  );
}

export function findDocumentedRoute(method: string, pathname: string): ApiRoute | undefined {
  return documentedRoutes.find(
    (route) => route.method === method.toUpperCase() && pathMatches(route.path, pathname),
  );
}

export function requiresIdempotencyKey(method: string, pathname: string): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) {
    return false;
  }
  return !idempotencyExemptPaths.has(pathname);
}

export const documentedApiRouteCount = documentedRoutes.length;
