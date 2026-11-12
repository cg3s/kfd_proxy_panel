import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { documentedRoutes, requiresIdempotencyKey } from "../../src/kafuda/routes";
import AccountPage from "./AccountPage";
import CardsPage from "./CardsPage";
import CdkPage from "./CdkPage";
import OrdersPage from "./OrdersPage";
import PlatformAdminPage from "./PlatformAdminPage";
import PortalApp from "./PortalApp";
import "./style.css";

type Route = (typeof documentedRoutes)[number];
type Section = "dashboard" | "account" | "cards" | "orders" | "cdk" | "webhooks" | "api" | "platform";
type ApiResult = { status: number; contentType: string; body: string };
type WebhookRecord = {
  event_id: string;
  event_type: string;
  created_at: string;
  received_at: string;
  payload: string;
};

const sections: Array<{ id: Section; label: string; icon: string }> = [
  { id: "dashboard", label: "总览", icon: "◫" },
  { id: "account", label: "账户与充值", icon: "＄" },
  { id: "cards", label: "虚拟卡", icon: "▣" },
  { id: "orders", label: "直充与订单", icon: "↗" },
  { id: "cdk", label: "CDK 兑换码", icon: "⌘" },
  { id: "webhooks", label: "Webhook 事件", icon: "⌁" },
  { id: "api", label: "高级 API 工具", icon: "⌘" },
  { id: "platform", label: "多用户运营", icon: "◎" },
];

const routeSection = (route: Route): Section => {
  if (route.path.startsWith("/api/v1/topups") || route.path.includes("/ledger") || route.path.includes("/account")) return "account";
  if (route.path.includes("/cards") || route.path.includes("card-transactions") || route.path.includes("card-products")) return "cards";
  if (route.path.includes("/gpt") || route.path.includes("/direct")) return "orders";
  return "cdk";
};

const sectionTitle = (section: Section) => sections.find((item) => item.id === section)?.label ?? "控制台";
const routeLabel = (route: Route) => route.path.replace("/api/v1/", "").replaceAll("/", " / ");
const isReadOnly = (method: string) => ["GET", "HEAD", "OPTIONS"].includes(method);
const makeIdempotencyKey = () => `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

async function requestJson(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, { ...init, credentials: "same-origin" });
}

function extractError(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error?: { message?: string; code?: string } }).error;
      return [error?.message, error?.code].filter(Boolean).join(" · ");
    }
  } catch {
    return body;
  }
  return body;
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | undefined>(undefined);
  const [section, setSection] = useState<Section>("dashboard");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);

  const checkSession = useCallback(async () => {
    try {
      const response = await requestJson("/dashboard/auth/session");
      const data = (await response.json()) as { authenticated: boolean };
      setAuthenticated(data.authenticated);
    } catch {
      setAuthenticated(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setLoginError("");
    try {
      const response = await requestJson("/dashboard/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: loginPassword }),
      });
      if (!response.ok) {
        const body = await response.text();
        setLoginError(extractError(body) || "登录失败");
        return;
      }
      setLoginPassword("");
      setAuthenticated(true);
    } catch {
      setLoginError("无法连接服务，请确认后端已启动");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await requestJson("/dashboard/auth/logout", { method: "POST" });
    setAuthenticated(false);
    setSection("dashboard");
  };

  if (authenticated === undefined) {
    return <div className="boot-screen"><span className="brand-mark">K</span><p>正在连接控制台…</p></div>;
  }
  if (!authenticated) {
    return (
      <main className="login-screen">
        <div className="login-card">
          <div className="brand-lockup"><span className="brand-mark">K</span><span>卡付达<span className="brand-light">控制台</span></span></div>
          <p className="eyebrow">KAFUDA API GATEWAY</p>
          <h1>欢迎回来</h1>
          <p className="muted">输入控制台密码以安全访问你的账户。</p>
          <form onSubmit={login}>
            <label htmlFor="password">控制台密码</label>
            <input id="password" type="password" autoComplete="current-password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} required autoFocus />
            {loginError && <p className="form-error">{loginError}</p>}
            <button className="button button-primary button-wide" disabled={busy}>{busy ? "正在登录…" : "登录控制台"}<span>→</span></button>
          </form>
          <p className="login-foot">凭据保存在服务端；浏览器仅使用 HttpOnly 会话。</p>
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup sidebar-brand"><span className="brand-mark">K</span><span>卡付达<span className="brand-light">控制台</span></span></div>
        <div className="side-label">工作空间</div>
        <nav className="side-nav">
          {sections.map((item) => (
            <button key={item.id} className={`nav-item ${section === item.id ? "active" : ""}`} onClick={() => setSection(item.id)}>
              <span className="nav-icon">{item.icon}</span>{item.label}
              {item.id === "dashboard" && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-note"><span className="secure-dot" /><span><b>服务端密钥已保护</b><small>API Key 不会发送到浏览器</small></span></div>
          <button className="nav-item logout-button" onClick={() => void logout()}><span className="nav-icon">↪</span>退出登录</button>
          <a className="nav-item" href="/shop"><span className="nav-icon">↗</span>用户中心预览</a>
          <div className="version">KAFUDA GATEWAY · LOCAL</div>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>控制台</span><span className="crumb-sep">/</span><b>{sectionTitle(section)}</b></div>
          <div className="topbar-right"><span className="connection-indicator"><i /> 本地服务已连接</span><button className="avatar" title="已登录">K</button></div>
        </header>
        <div className="page-content">
          {section === "dashboard" && <Dashboard onOpen={setSection} />}
          {section === "webhooks" && <WebhookInbox />}
          {section === "account" && <AccountPage />}
          {section === "cards" && <CardsPage />}
          {section === "orders" && <OrdersPage />}
          {section === "cdk" && <CdkPage />}
          {section === "api" && <ApiWorkspace section={section} />}
          {section === "platform" && <PlatformAdminPage />}
        </div>
      </main>
    </div>
  );
}

function Dashboard({ onOpen }: { onOpen: (section: Section) => void }) {
  const [account, setAccount] = useState<Record<string, unknown> | null>(null);
  const [counts, setCounts] = useState<Record<string, unknown> | null>(null);
  const [orders, setOrders] = useState<Record<string, unknown> | null>(null);
  const [cdk, setCdk] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    const paths = ["/api/v1/account", "/api/v1/cards/counts", "/api/v1/gpt/orders/stats?period=day", "/api/v1/cdk/summary"];
    const results = await Promise.allSettled(paths.map(async (path) => {
      const response = await requestJson(path);
      const text = await response.text();
      if (!response.ok) throw new Error(extractError(text) || `${path}: HTTP ${response.status}`);
      return JSON.parse(text) as { data?: Record<string, unknown> };
    }));
    setAccount(results[0].status === "fulfilled" ? results[0].value.data ?? null : null);
    setCounts(results[1].status === "fulfilled" ? results[1].value.data ?? null : null);
    setOrders(results[2].status === "fulfilled" ? results[2].value.data ?? null : null);
    setCdk(results[3].status === "fulfilled" ? results[3].value.data ?? null : null);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : "接口请求失败");
    if (errors.length) setError(errors.join("；"));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "无法加载账户概览");
      setLoading(false);
    });
  }, [refresh]);

  const balance = account?.balance as Record<string, number> | undefined;
  const summary = orders?.summary as Record<string, number> | undefined;
  const cardActive = (counts?.active as Record<string, number> | undefined)?.count
    ?? (counts?.active_count as number | undefined)
    ?? "—";

  return (
    <>
      <div className="page-heading heading-row">
        <div><p className="eyebrow">OVERVIEW</p><h1>账户总览</h1><p className="muted">查看你的 Kafuda 账户状态和业务活动。</p></div>
        <button className="button button-secondary" onClick={() => void refresh()} disabled={loading}><span className={loading ? "spin" : ""}>↻</span> 刷新数据</button>
      </div>
      {error && <div className="notice notice-error"><b>数据暂不可用</b><span>{error}</span><small>确认 KAFUDA_API_KEY 有效并拥有 read 权限；概览请求不会修改账户。</small></div>}
      <section className="metric-grid">
        <MetricCard label="可用余额" value={money(balance?.available_cents)} meta={`冻结 ${money(balance?.frozen_cents)}`} icon="$" tone="blue" loading={loading} />
        <MetricCard label="活跃虚拟卡" value={String(cardActive)} meta="当前账户卡片" icon="▣" tone="violet" loading={loading} />
        <MetricCard label="今日订单" value={summary?.total === undefined ? "—" : String(summary.total)} meta={`${summary?.completed ?? 0} 笔已完成`} icon="↗" tone="green" loading={loading} />
        <MetricCard label="可用 CDK" value={cdk?.unused === undefined ? "—" : String(cdk.unused)} meta={`${cdk?.redeemed_today ?? 0} 张今日兑换`} icon="⌘" tone="amber" loading={loading} />
      </section>
      <div className="dashboard-columns">
        <section className="panel welcome-panel">
          <div className="panel-kicker"><span className="panel-symbol">✦</span> QUICK START</div>
          <h2>准备好开始了吗？</h2>
          <p className="muted">选择业务模块，查询数据或创建操作。写入操作会要求二次确认，凭据只在本次请求期间使用。</p>
          <div className="quick-actions">
            <button className="quick-action" onClick={() => onOpen("cards")}><span className="quick-icon blue">▣</span><span><b>管理虚拟卡</b><small>查询、充值与卡片设置</small></span><i>→</i></button>
            <button className="quick-action" onClick={() => onOpen("orders")}><span className="quick-icon green">↗</span><span><b>查看直充订单</b><small>报价、下单与状态查询</small></span><i>→</i></button>
            <button className="quick-action" onClick={() => onOpen("cdk")}><span className="quick-icon amber">⌘</span><span><b>管理 CDK</b><small>生成批次、导出与兑换</small></span><i>→</i></button>
          </div>
        </section>
        <section className="panel health-panel">
          <div className="panel-header"><div><p className="eyebrow">SYSTEM</p><h2>连接状态</h2></div><span className="status-pill status-good"><i /> 已连接</span></div>
          <div className="health-row"><span>本地 API 网关</span><b><i />运行中</b></div>
          <div className="health-row"><span>本地 SQLite</span><b><i />可用</b></div>
          <div className="health-row"><span>上游 Kafuda API</span><b className={error ? "health-warn" : ""}><i />{error ? "待检查" : "可访问"}</b></div>
          <button className="text-button" onClick={() => onOpen("webhooks")}>查看 Webhook 收件箱 <span>→</span></button>
        </section>
      </div>
      <div className="disclaimer"><span>ⓘ</span><span>此控制台会直接调用真实 Kafuda 服务。开卡、充值、退款、下单、发码等操作会产生实际业务影响，请核对金额与参数后再确认。</span></div>
    </>
  );
}

function MetricCard({ label, value, meta, icon, tone, loading }: { label: string; value: string; meta: string; icon: string; tone: string; loading: boolean }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div className="metric-label">{label}</div><div className="metric-value">{loading ? <span className="skeleton" /> : value}</div><div className="metric-meta">{meta}</div><div className={`metric-accent ${tone}`} /></article>;
}

function money(cents: number | undefined): string {
  return cents === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function ApiWorkspace({ section }: { section: Section }) {
  const routes = useMemo(() => documentedRoutes.filter((route) => section === "api" || routeSection(route) === section), [section]);
  const [selected, setSelected] = useState<Route>(routes[0]);
  const [query, setQuery] = useState("");
  const [body, setBody] = useState(bodyExample(routes[0]));
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ApiResult | null>(null);
  const [requestError, setRequestError] = useState("");
  const [running, setRunning] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(makeIdempotencyKey);

  useEffect(() => {
    setSelected(routes[0]);
    setQuery("");
    setBody(bodyExample(routes[0]));
    setPathValues({});
    setResult(null);
    setRequestError("");
    setIdempotencyKey(makeIdempotencyKey());
  }, [routes]);

  const params = [...selected.path.matchAll(/:([a-zA-Z]+)/g)].map((match) => match[1]);
  const requestPath = selected.path.replace(/:([a-zA-Z]+)/g, (_match, name: string) => encodeURIComponent(pathValues[name] ?? `:${name}`));
  const writeRequiresKey = requiresIdempotencyKey(selected.method, selected.path);

  const run = async () => {
    setRequestError("");
    setResult(null);
    if (params.some((name) => !pathValues[name]?.trim())) {
      setRequestError("请先填写路径中的资源 ID 或产品名称。");
      return;
    }

    let parsedBody: unknown;
    if (!isReadOnly(selected.method)) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        setRequestError("请求体不是合法 JSON，请检查格式。");
        return;
      }
      const action = `${selected.method} ${requestPath}`;
      if (!window.confirm(`即将执行真实 Kafuda 操作：\n${action}\n\n请确认请求参数正确。此操作可能改变资金或业务状态。`)) return;
    } else if (selected.path.endsWith("/sensitive")) {
      if (!window.confirm("即将读取完整卡号、CVV 和账单地址等敏感信息。请确认当前屏幕和网络环境可信。")) return;
    }

    const queryString = query.trim().replace(/^[?&]/, "");
    const url = `${requestPath}${queryString ? `?${queryString}` : ""}`;
    const headers: Record<string, string> = {};
    if (!isReadOnly(selected.method)) headers["content-type"] = "application/json";
    if (writeRequiresKey) headers["Idempotency-Key"] = idempotencyKey;

    setRunning(true);
    try {
      const response = await requestJson(url, {
        method: selected.method,
        headers,
        body: isReadOnly(selected.method) ? undefined : JSON.stringify(parsedBody),
      });
      const responseBody = await response.text();
      const contentType = response.headers.get("content-type") ?? "text/plain";
      if (contentType.includes("text/csv") || contentType.includes("application/octet-stream")) {
        const blob = new Blob([responseBody], { type: contentType });
        const downloadUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = `kafuda-export-${Date.now()}.csv`;
        anchor.click();
        URL.revokeObjectURL(downloadUrl);
      }
      setResult({ status: response.status, contentType, body: prettyPrint(responseBody, contentType) });
    } catch (caught) {
      setRequestError(caught instanceof Error ? caught.message : "请求失败");
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="page-heading"><p className="eyebrow">{section.toUpperCase()} · API WORKSPACE</p><h1>高级 API 工具</h1><p className="muted">面向高级调试的通用请求器；常用业务操作请使用账户、卡片、订单和 CDK 页面。</p></div>
      <div className="workspace-grid">
        <section className="panel endpoint-panel">
          <div className="panel-header"><div><p className="eyebrow">ENDPOINTS</p><h2>接口目录</h2></div><span className="count-badge">{routes.length} 个接口</span></div>
          <div className="endpoint-list">
            {routes.map((route) => (
              <button key={`${route.method}:${route.path}`} className={`endpoint-item ${selected === route ? "selected" : ""}`} onClick={() => {
                setSelected(route);
                setQuery("");
                setBody(bodyExample(route));
                setPathValues({});
                setResult(null);
                setRequestError("");
              }}>
                <span className={`method-badge method-${route.method.toLowerCase()}`}>{route.method}</span><span className="endpoint-name">{routeLabel(route)}</span><span className="endpoint-arrow">›</span>
              </button>
            ))}
          </div>
        </section>
        <section className="panel request-panel">
          <div className="panel-header request-title"><div><p className="eyebrow">REQUEST BUILDER</p><h2>发送请求</h2></div><span className={`method-badge method-${selected.method.toLowerCase()}`}>{selected.method}</span></div>
          <div className="request-url"><span className="url-origin">/api/v1</span><code>{selected.path.replace("/api/v1", "")}</code></div>
          {params.map((name) => <label className="field" key={name}><span>{name === "id" ? "资源 ID" : name === "product" ? "产品名称" : name}</span><input value={pathValues[name] ?? ""} onChange={(event) => setPathValues((current) => ({ ...current, [name]: event.target.value }))} placeholder={`输入 ${name}`} /></label>)}
          <label className="field"><span>查询参数 <small>可选，例如 limit=20&amp;offset=0</small></span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="limit=20&offset=0" /></label>
          {!isReadOnly(selected.method) && (
            <>
              {selected.method !== "DELETE" && <label className="field"><span>JSON 请求体</span><textarea className="code-input" value={body} onChange={(event) => setBody(event.target.value)} rows={8} spellCheck={false} /></label>}
              {writeRequiresKey && <div className="field"><span>幂等键 <small>同一次操作重试时请复用此键</small></span><div className="key-row"><code>{idempotencyKey}</code><button type="button" className="small-button" onClick={() => setIdempotencyKey(makeIdempotencyKey())}>生成新键</button></div></div>}
              {selected.path.endsWith("/sensitive") && <div className="notice notice-warn">敏感卡数据：上游密钥需有 cards:sensitive 权限并配置 IP 白名单。仅在可信网络查看。</div>}
              <div className="notice notice-warn">该请求会连接真实 Kafuda 服务；资金或业务操作不可撤销时请特别核对。</div>
            </>
          )}
          {requestError && <div className="form-error request-error">{requestError}</div>}
          <button className="button button-primary send-button" onClick={() => void run()} disabled={running}>{running ? "请求中…" : "发送请求"}<span>→</span></button>
          {result && <div className="response-panel"><div className="response-heading"><b>响应</b><span className={`response-status ${result.status < 400 ? "good" : "bad"}`}>HTTP {result.status}</span></div><pre>{result.body || "(空响应)"}</pre></div>}
        </section>
      </div>
    </>
  );
}

function bodyExample(route: Route): string {
  const examples: Record<string, unknown> = {
    "POST /api/v1/topups": { network: "TRC20", tx_hash: "填写真实交易哈希", amount_cents: 50000 },
    "POST /api/v1/cards": { product_code: "P5378XB", first_name: "John", last_name: "Doe", init_amount_cents: 3000 },
    "POST /api/v1/cards/:id/recharge": { amount_cents: 2000 },
    "POST /api/v1/cards/:id/refund": { amount_cents: 1000 },
    "PUT /api/v1/cards/:id/auto-topup": { enabled: true, threshold_cents: 1000, amount_cents: 2000, daily_max: 3 },
    "POST /api/v1/cards/:id/remark": { remark: "备注" },
    "POST /api/v1/cards/bulk": { action: "freeze", ids: ["card_..."] },
    "POST /api/v1/gpt/check": { country: "PH", pay_mode: "own_card", session: "填写客户 ChatGPT Session" },
    "POST /api/v1/gpt/quotes": { plan: "plus", country: "PH", session: "填写客户 ChatGPT Session", pay_mode: "own_card" },
    "POST /api/v1/gpt/orders": { quote_id: "填写报价 quote_id", card_id: "auto", reference: "你的订单号" },
    "POST /api/v1/direct/check": { product: "grok", session: "填写客户 Session", pay_mode: "own_card" },
    "POST /api/v1/cdk/batches": { plan: "plus", country: "PH", count: 10, expires_days: 180, note: "批次备注" },
    "POST /api/v1/cdk/codes/disable": { ids: [101, 102] },
    "POST /api/v1/cdk/codes/enable": { ids: [101, 102] },
    "PUT /api/v1/cdk/settings": { code_prefix: "SHOP", allowed_origins: [] },
    "POST /api/v1/cdk/redeem/preview": { code: "输入完整 CDK" },
    "POST /api/v1/cdk/redeem/check": { code: "输入完整 CDK", session: "填写客户 ChatGPT Session" },
    "POST /api/v1/cdk/redeem/redeem": { code: "输入完整 CDK", redemption_token: "填写兑换令牌" },
  };
  return JSON.stringify(examples[`${route.method} ${route.path}`] ?? {}, null, 2);
}

function prettyPrint(text: string, contentType: string): string {
  if (contentType.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

function WebhookInbox() {
  const [events, setEvents] = useState<WebhookRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<WebhookRecord | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await requestJson("/dashboard/webhooks?limit=100");
      const text = await response.text();
      if (!response.ok) throw new Error(extractError(text));
      const payload = JSON.parse(text) as { data: WebhookRecord[] };
      setEvents(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载 Webhook 失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <div className="page-heading heading-row">
        <div><p className="eyebrow">EVENT INBOX</p><h1>Webhook 事件</h1><p className="muted">已验签并保存到本地 SQLite 的最近事件。</p></div>
        <button className="button button-secondary" onClick={() => void refresh()} disabled={loading}>↻ 刷新事件</button>
      </div>
      {error && <div className="notice notice-error">{error}</div>}
      <section className="panel table-panel">
        <div className="panel-header"><div><p className="eyebrow">RECENT DELIVERIES</p><h2>事件收件箱</h2></div><span className="count-badge">{events.length} 条</span></div>
        {loading ? <div className="empty-state">正在读取事件…</div> : events.length === 0 ? <div className="empty-state"><span>⌁</span><b>暂时没有事件</b><small>配置 Kafuda 控制台回调 URL 后，新事件会显示在这里。</small></div> : (
          <div className="table-scroll"><table><thead><tr><th>事件类型</th><th>事件 ID</th><th>发生时间</th><th>接收时间</th><th /></tr></thead><tbody>
            {events.map((event) => <tr key={event.event_id}><td><span className="event-type">{event.event_type}</span></td><td><code>{event.event_id}</code></td><td>{formatDate(event.created_at)}</td><td>{formatDate(event.received_at)}</td><td><button className="text-button" onClick={() => setSelected(selected?.event_id === event.event_id ? null : event)}>查看数据</button></td></tr>)}
          </tbody></table></div>
        )}
        {selected && <div className="response-panel webhook-payload"><div className="response-heading"><b>{selected.event_type}</b><button className="small-button" onClick={() => setSelected(null)}>关闭</button></div><pre>{prettyPrint(selected.payload, "application/json")}</pre></div>}
      </section>
      <div className="disclaimer"><span>ⓘ</span><span>Webhook 签名密钥只存在于服务端。事件按唯一 ID 去重；页面显示最近最多 100 条。</span></div>
    </>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function RootApp() {
  return window.location.pathname.startsWith("/admin") ? <App /> : <PortalApp />;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><RootApp /></React.StrictMode>);
