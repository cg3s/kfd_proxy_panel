import { useCallback, useEffect, useMemo, useState } from "react";

type JsonRecord = Record<string, unknown>;
type User = { id: number; email: string };
type Tab = "wallet" | "orders" | "cdk" | "codes";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "same-origin" });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    throw new Error(typeof error?.message === "string" ? error.message : `请求失败 (${response.status})`);
  }
  return payload as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rows(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function fen(value: unknown): string {
  return typeof value === "number"
    ? new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(value / 100)
    : "—";
}

function parseFenAmount(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return undefined;
  const [yuan, fraction = ""] = value.split(".");
  const amount = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : undefined;
}

function newKey(): string {
  return `portal-${crypto.randomUUID()}`;
}

export default function PortalApp() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("wallet");
  const [authMode, setAuthMode] = useState<"login" | "register" | "verify">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [balanceFen, setBalanceFen] = useState(0);
  const [ledger, setLedger] = useState<JsonRecord[]>([]);
  const [topups, setTopups] = useState<JsonRecord[]>([]);
  const [orders, setOrders] = useState<JsonRecord[]>([]);
  const [prices, setPrices] = useState<JsonRecord[]>([]);
  const [purchases, setPurchases] = useState<JsonRecord[]>([]);
  const [codes, setCodes] = useState<JsonRecord[]>([]);
  const [amount, setAmount] = useState("50");
  const [product, setProduct] = useState("gpt");
  const [country, setCountry] = useState("PH");
  const [productCode, setProductCode] = useState("");
  const [session, setSession] = useState("");
  const [plans, setPlans] = useState<JsonRecord[]>([]);
  const [selectedQuote, setSelectedQuote] = useState<JsonRecord | null>(null);
  const [cdkPlan, setCdkPlan] = useState("");
  const [cdkCountry, setCdkCountry] = useState("AUTO");
  const [cdkCount, setCdkCount] = useState("1");

  const loadSession = useCallback(async () => {
    try {
      const payload = await request<{ authenticated: boolean; user?: User }>("/portal/auth/session");
      setUser(payload.authenticated ? payload.user ?? null : null);
    } catch {
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [walletData, topupData, orderData, priceData, purchaseData, codeData] = await Promise.all([
        request<{ wallet: { balance_fen: number }; ledger: JsonRecord[] }>("/portal/api/wallet"),
        request<{ data: JsonRecord[] }>("/portal/api/topups"),
        request<{ data: JsonRecord[] }>("/portal/api/orders"),
        request<{ data: JsonRecord[] }>("/portal/api/prices"),
        request<{ data: JsonRecord[] }>("/portal/api/cdk/purchases"),
        request<{ data: JsonRecord[] }>("/portal/api/cdk/codes"),
      ]);
      setBalanceFen(walletData.wallet.balance_fen);
      setLedger(rows(walletData.ledger));
      setTopups(rows(topupData.data));
      setOrders(rows(orderData.data));
      const loadedPrices = rows(priceData.data);
      setPrices(loadedPrices);
      setPurchases(rows(purchaseData.data));
      setCodes(rows(codeData.data));
      const firstCdk = loadedPrices.find((item) => item.product === "cdk");
      if (firstCdk) {
        setCdkPlan((current) => current || String(firstCdk.plan));
        setCdkCountry((current) => current === "AUTO" ? String(firstCdk.country) : current);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法加载账户数据");
    }
  }, []);

  useEffect(() => { void loadSession(); }, [loadSession]);
  useEffect(() => { if (user) void refresh(); }, [user, refresh]);
  useEffect(() => {
    const paymentId = new URLSearchParams(window.location.search).get("payment");
    if (!user || !paymentId) return;
    let active = true;
    let attempts = 0;
    const poll = async () => {
      try {
        const result = await request<{ data: JsonRecord }>(`/portal/api/payments/${encodeURIComponent(paymentId)}`);
        if (!active) return;
        if (result.data.status === "paid") {
          setNotice("充值已到账，人民币余额已更新。");
          await refresh();
          return;
        }
      } catch {
        if (!active) return;
      }
      attempts += 1;
      if (active && attempts < 10) window.setTimeout(() => void poll(), 3000);
      else if (active) setNotice("支付结果仍在确认中；到账以服务端异步通知为准，可稍后刷新余额。");
    };
    void poll();
    return () => { active = false; };
  }, [user, refresh]);

  const cdkOptions = useMemo(
    () => prices.filter((item) => item.product === "cdk" && item.enabled === 1),
    [prices],
  );
  const selectedCdkPrice = cdkOptions.find(
    (item) => item.plan === cdkPlan && item.country === cdkCountry,
  ) ?? cdkOptions.find((item) => item.plan === cdkPlan && item.country === "AUTO");

  const submitAuth = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setAuthError("");
    try {
      if (authMode === "register") {
        await request("/portal/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        setAuthMode("verify");
        setNotice("如果邮箱可以注册，验证码已发送，请查看收件箱。");
      } else if (authMode === "verify") {
        await request("/portal/auth/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, code: verificationCode }),
        });
        await loadSession();
      } else {
        await request("/portal/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        await loadSession();
      }
      setPassword("");
    } catch (caught) {
      setAuthError(caught instanceof Error ? caught.message : "操作失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await request("/portal/auth/logout", { method: "POST" });
    setUser(null);
    setTab("wallet");
  };

  const startTopup = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    const amountFen = parseFenAmount(amount);
    if (amountFen === undefined || amountFen < 1000 || amountFen > 10_000_000) {
      setError("充值金额需为 10 至 100000 元，最多两位小数。");
      setBusy(false);
      return;
    }
    try {
      const result = await request<{ data: { checkout_url: string } }>("/portal/api/topups", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newKey() },
        body: JSON.stringify({ amount_fen: amountFen }),
      });
      window.location.assign(result.data.checkout_url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法创建充值订单");
      setBusy(false);
    }
  };

  const checkAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    setPlans([]);
    setSelectedQuote(null);
    try {
      const result = await request<{ data: JsonRecord }>("/portal/api/orders/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product, country, session, ...(productCode ? { product_code: productCode } : {}) }),
      });
      setPlans(rows(result.data.plans));
      setSession("");
      setNotice("检查完成。Session 已清除，请选择已定价的套餐下单。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号检查失败");
    } finally {
      setBusy(false);
    }
  };

  const placeOrder = async () => {
    const quoteId = selectedQuote?.quote_id;
    if (typeof quoteId !== "string") return;
    setBusy(true);
    setError("");
    try {
      const result = await request<{ data: JsonRecord }>("/portal/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newKey() },
        body: JSON.stringify({ quote_id: quoteId }),
      });
      setNotice(`订单已提交，状态：${String(result.data.status ?? "processing")}。余额会在失败时自动退回。`);
      setSelectedQuote(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "订单提交失败");
    } finally {
      setBusy(false);
    }
  };

  const buyCdk = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await request<{ data: JsonRecord }>("/portal/api/cdk/purchases", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newKey() },
        body: JSON.stringify({ plan: cdkPlan, country: cdkCountry, count: Number(cdkCount) }),
      });
      setNotice(result.data.status === "completed" ? "CDK 已生成并归入你的账户。" : "购买请求已受理，请查看订单状态。");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CDK 购买失败");
    } finally {
      setBusy(false);
    }
  };

  const reconcileOrder = async (order: JsonRecord) => {
    const id = typeof order.id === "string" ? order.id : "";
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const action = order.upstream_order_id ? "refresh" : "retry";
      const result = await request<{ data: JsonRecord }>(`/portal/api/orders/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
      });
      setNotice(`订单状态：${String(result.data.status ?? "processing")}`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "订单状态更新失败");
    } finally {
      setBusy(false);
    }
  };

  const retryCdk = async (purchase: JsonRecord) => {
    const id = typeof purchase.id === "string" ? purchase.id : "";
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      await request(`/portal/api/cdk/purchases/${encodeURIComponent(id)}/retry`, { method: "POST" });
      setNotice("已重新核对 CDK 生成结果。");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CDK 状态更新失败");
    } finally {
      setBusy(false);
    }
  };

  if (checking) return <div className="portal-loading">正在安全连接…</div>;
  if (!user) {
    return (
      <main className="portal-auth">
        <div className="portal-auth-card">
          <a className="portal-brand" href="/shop"><span className="brand-mark">K</span><b>卡付达<span>用户中心</span></b></a>
          <p className="eyebrow">CUSTOMER PORTAL</p>
          <h1>{authMode === "login" ? "登录账户" : authMode === "register" ? "创建账户" : "验证邮箱"}</h1>
          <p className="muted">充值、提交直充订单并管理专属 CDK。</p>
          <form className="portal-form" onSubmit={(event) => void submitAuth(event)}>
            <label>邮箱<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
            {authMode !== "verify" && <label>密码<input type="password" autoComplete={authMode === "login" ? "current-password" : "new-password"} minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
            {authMode === "verify" && <label>邮箱验证码<input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} /></label>}
            {authError && <p className="form-error">{authError}</p>}
            {notice && <p className="portal-notice">{notice}</p>}
            <button className="button button-primary button-wide" disabled={busy}>{busy ? "请稍候…" : authMode === "login" ? "登录" : authMode === "register" ? "发送验证码" : "验证并进入"}<span>→</span></button>
          </form>
          <div className="portal-auth-switch">
            {authMode === "login" && <><button onClick={() => { setAuthMode("register"); setNotice(""); setAuthError(""); }}>注册新账户</button><a href="/">运营后台</a></>}
            {authMode === "register" && <button onClick={() => { setAuthMode("login"); setNotice(""); setAuthError(""); }}>已有账户？登录</button>}
            {authMode === "verify" && <button onClick={() => { setAuthMode("register"); setNotice(""); }}>返回注册</button>}
          </div>
          <p className="portal-foot">人民币余额使用分为单位记账。支付成功以服务端异步通知为准。</p>
        </div>
      </main>
    );
  }

  const nav: Array<{ id: Tab; label: string; icon: string }> = [
    { id: "wallet", label: "余额与充值", icon: "￥" },
    { id: "orders", label: "直充订单", icon: "↗" },
    { id: "cdk", label: "购买 CDK", icon: "⌘" },
    { id: "codes", label: "我的卡密", icon: "▣" },
  ];

  return (
    <div className="portal-shell">
      <aside className="portal-sidebar">
        <a className="portal-brand" href="/shop"><span className="brand-mark">K</span><b>卡付达<span>用户中心</span></b></a>
        <p className="portal-side-label">我的服务</p>
        <nav>{nav.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => {
          setTab(item.id);
          if (item.id === "cdk") void refresh();
        }}><i>{item.icon}</i>{item.label}</button>)}</nav>
        <div className="portal-side-bottom">
          <small>{user.email}</small>
          <button onClick={() => void logout()}>退出登录</button>
          <a href="/">运营后台入口</a>
        </div>
      </aside>
      <main className="portal-main">
        <header className="portal-topbar">
          <div><span>用户中心</span><b>/</b><strong>{nav.find((item) => item.id === tab)?.label}</strong></div>
          <button className="button button-secondary" onClick={() => void refresh()}>↻ 刷新</button>
        </header>
        <div className="portal-content">
          <div className="portal-heading">
            <div><p className="eyebrow">ACCOUNT PORTAL</p><h1>{tab === "wallet" ? "余额与充值" : tab === "orders" ? "直充订单" : tab === "cdk" ? "购买 CDK" : "我的卡密"}</h1><p className="muted">服务费由平台固定定价；订单及卡密仅对所属账户可见。</p></div>
            <div className="portal-balance"><span>可用余额</span><b>{fen(balanceFen)}</b></div>
          </div>
          {error && <div className="notice notice-error">{error}</div>}
          {notice && <div className="notice notice-success">{notice}<button className="notice-close" onClick={() => setNotice("")}>关闭</button></div>}

          {tab === "wallet" && <div className="portal-grid">
            <section className="panel portal-panel">
              <div className="panel-header"><div><p className="eyebrow">ADD FUNDS</p><h2>在线充值</h2></div><span className="status-pill status-good">易支付</span></div>
              <form className="portal-form" onSubmit={(event) => void startTopup(event)}>
                <label>充值金额（CNY）<input type="number" min="10" max="100000" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label>
                <p className="muted">充值金额范围 10–100000 元。离开支付页后可返回此页查看到账状态。</p>
                <button className="button button-primary" disabled={busy}>{busy ? "正在创建…" : "前往支付"} <span>→</span></button>
              </form>
              <h3 className="portal-subheading">充值记录</h3>
              <div className="table-scroll"><table><thead><tr><th>订单号</th><th>金额</th><th>状态</th><th>创建时间</th></tr></thead><tbody>
                {topups.map((row) => <tr key={String(row.id)}><td><code>{String(row.id)}</code></td><td>{fen(row.amount_fen)}</td><td><span className={`status-tag status-${String(row.status)}`}>{String(row.status)}</span></td><td>{String(row.created_at ?? "—")}</td></tr>)}
                {!topups.length && <tr><td colSpan={4}>暂无充值记录</td></tr>}
              </tbody></table></div>
            </section>
            <section className="panel portal-panel">
              <div className="panel-header"><div><p className="eyebrow">WALLET LEDGER</p><h2>余额流水</h2></div><span className="count-badge">{ledger.length} 条</span></div>
              <div className="table-scroll"><table><thead><tr><th>类型</th><th>变动</th><th>余额</th><th>说明</th></tr></thead><tbody>
                {ledger.map((row, index) => <tr key={`${String(row.reference)}-${index}`}><td>{String(row.entry_type)}</td><td className={Number(row.amount_fen) < 0 ? "amount-negative" : "amount-positive"}>{fen(row.amount_fen)}</td><td>{fen(row.balance_after_fen)}</td><td>{String(row.memo)}</td></tr>)}
                {!ledger.length && <tr><td colSpan={4}>暂无账务记录</td></tr>}
              </tbody></table></div>
            </section>
          </div>}

          {tab === "orders" && <div className="portal-grid">
            <section className="panel portal-panel">
              <div className="panel-header"><div><p className="eyebrow">ACCOUNT CHECK</p><h2>检查账号并获取固定报价</h2></div></div>
              <form className="portal-form" onSubmit={(event) => void checkAccount(event)}>
                <div className="portal-form-row">
                  <label>产品<select value={product} onChange={(event) => { setProduct(event.target.value); setPlans([]); }}><option value="gpt">ChatGPT / Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select></label>
                  <label>地区<select value={country} onChange={(event) => { setCountry(event.target.value); setPlans([]); }}><option>PH</option><option>CL</option><option>EG</option><option>JP</option><option>US</option><option>AUTO</option></select></label>
                </div>
                {product === "gpt" && <label>卡头代码（可选）<input value={productCode} onChange={(event) => setProductCode(event.target.value)} /></label>}
                <label>客户 Session<textarea rows={5} value={session} onChange={(event) => setSession(event.target.value)} required placeholder="仅用于本次上游检查，不会保存在平台数据库或日志。" /></label>
                <div className="sensitive-warning">请确认已获得客户授权。检查完成后 Session 会从表单清除。</div>
                <button className="button button-primary" disabled={busy}>{busy ? "正在检查…" : "检查并报价"} <span>→</span></button>
              </form>
              {plans.length > 0 && <div className="portal-plan-list">{plans.map((item, index) => {
                const available = item.status === "available" && typeof item.quote_id === "string";
                const selected = selectedQuote?.quote_id === item.quote_id;
                return <button key={`${String(item.plan)}-${index}`} className={`portal-plan ${selected ? "selected" : ""}`} disabled={!available} onClick={() => setSelectedQuote(item)}>
                  <span><b>{String(item.label ?? item.plan ?? "套餐")}</b><small>{available ? "可购买" : "暂不可购买"}</small></span>
                  <strong>{fen(item.sell_price_fen)}</strong>
                </button>;
              })}</div>}
              {selectedQuote && <button className="button button-primary portal-buy-button" disabled={busy} onClick={() => void placeOrder()}>确认下单并扣款 {fen(selectedQuote.sell_price_fen)}</button>}
            </section>
            <section className="panel portal-panel">
              <div className="panel-header"><div><p className="eyebrow">MY ORDERS</p><h2>我的订单</h2></div><span className="count-badge">{orders.length} 笔</span></div>
              <div className="table-scroll"><table><thead><tr><th>订单号</th><th>套餐</th><th>价格</th><th>状态</th></tr></thead><tbody>
                {orders.map((row) => <tr key={String(row.id)}><td><code>{String(row.id).slice(0, 12)}</code></td><td>{String(row.product)} / {String(row.plan)}</td><td>{fen(row.price_fen)}</td><td><span className={`status-tag status-${String(row.status)}`}>{String(row.status)}</span>{typeof row.error_message === "string" && <small className="portal-row-note">{row.error_message}</small>}{["needs_review", "submitting", "processing"].includes(String(row.status)) && <button className="text-button portal-refresh-order" disabled={busy} onClick={() => void reconcileOrder(row)}>{row.upstream_order_id ? "刷新状态" : "重试核对"}</button>}</td></tr>)}
                {!orders.length && <tr><td colSpan={4}>暂无直充订单</td></tr>}
              </tbody></table></div>
            </section>
          </div>}

          {tab === "cdk" && <div className="portal-grid">
            <section className="panel portal-panel">
              <div className="panel-header"><div><p className="eyebrow">CDK SHOP</p><h2>生成专属 CDK</h2></div></div>
              {cdkOptions.length ? <form className="portal-form" onSubmit={(event) => void buyCdk(event)}>
                <label>套餐<select value={`${cdkPlan}|${cdkCountry}`} onChange={(event) => {
                  const [nextPlan, nextCountry] = event.target.value.split("|");
                  setCdkPlan(nextPlan);
                  setCdkCountry(nextCountry);
                }}>{cdkOptions.map((item, index) => <option key={`${item.plan}-${item.country}-${index}`} value={`${String(item.plan)}|${String(item.country)}`}>{String(item.plan)} · {String(item.country)}</option>)}</select></label>
                <label>数量<input type="number" min="1" max="50" step="1" value={cdkCount} onChange={(event) => setCdkCount(event.target.value)} required /></label>
                <div className="portal-price-note">单价 {fen(selectedCdkPrice?.price_fen)} · 合计 {fen(typeof selectedCdkPrice?.price_fen === "number" ? selectedCdkPrice.price_fen * Number(cdkCount) : undefined)}</div>
                <p className="muted">上游生成成功后卡密会归入你的账户；如果上游结果不确定，余额暂时冻结并由运营人员核对。</p>
                <button className="button button-primary" disabled={busy}>{busy ? "正在提交…" : "购买并生成"} <span>→</span></button>
              </form> : <div className="empty-state"><b>暂未开放 CDK 产品</b><small>当前没有已上架的 CDK 售价，请联系平台运营配置。</small></div>}
              <h3 className="portal-subheading">购买记录</h3>
              <div className="table-scroll"><table><thead><tr><th>订单号</th><th>套餐</th><th>数量</th><th>金额</th><th>状态</th></tr></thead><tbody>
                {purchases.map((row) => <tr key={String(row.id)}><td><code>{String(row.id).slice(0, 12)}</code></td><td>{String(row.plan)} · {String(row.country)}</td><td>{String(row.count)}</td><td>{fen(row.total_price_fen)}</td><td><span className={`status-tag status-${String(row.status)}`}>{String(row.status)}</span>{["needs_review", "creating"].includes(String(row.status)) && <button className="text-button portal-refresh-order" disabled={busy} onClick={() => void retryCdk(row)}>重试核对</button>}</td></tr>)}
                {!purchases.length && <tr><td colSpan={5}>暂无 CDK 购买记录</td></tr>}
              </tbody></table></div>
            </section>
            <section className="panel portal-panel">
              <div className="panel-header"><div><p className="eyebrow">PRICING</p><h2>在售价格</h2></div></div>
              <div className="table-scroll"><table><thead><tr><th>类型</th><th>套餐</th><th>地区</th><th>单价</th></tr></thead><tbody>
                {prices.map((row, index) => <tr key={`${String(row.product)}-${String(row.plan)}-${index}`}><td>{String(row.product)}</td><td>{String(row.plan)}</td><td>{String(row.country)}</td><td>{fen(row.price_fen)}</td></tr>)}
                {!prices.length && <tr><td colSpan={4}>暂无在售价格</td></tr>}
              </tbody></table></div>
            </section>
          </div>}

          {tab === "codes" && <section className="panel portal-panel">
            <div className="panel-header"><div><p className="eyebrow">PRIVATE INVENTORY</p><h2>仅属于你的卡密</h2></div><span className="count-badge">{codes.length} 张</span></div>
            <p className="muted">完整卡密仅向所属账户展示。请妥善保管，不要分享给他人。</p>
            <div className="table-scroll"><table><thead><tr><th>卡密</th><th>状态</th><th>到期时间</th><th>生成时间</th></tr></thead><tbody>
              {codes.map((row) => <tr key={String(row.id)}><td><code className="portal-code">{String(row.code)}</code></td><td>{String(row.status)}</td><td>{String(row.expires_at ?? "—")}</td><td>{String(row.created_at)}</td></tr>)}
              {!codes.length && <tr><td colSpan={4}>还没有可显示的卡密</td></tr>}
            </tbody></table></div>
          </section>}
          <p className="portal-disclaimer">支付回调、余额变化及订单归属均在服务端校验。浏览器支付跳转页不代表充值成功。</p>
        </div>
      </main>
    </div>
  );
}
