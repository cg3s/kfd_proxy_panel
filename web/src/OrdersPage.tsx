import { useCallback, useEffect, useState } from "react";
import { callApi, confirmMutation, formatDate, getRecord, getString, moneyCents, rowsFrom, type JsonRecord, prettyJson } from "./api";
import { DataTable, ErrorNotice, PageHeader, Panel } from "./components";

type OrderTab = "check" | "orders" | "catalog" | "stats";
type CheckKind = "gpt" | "claude" | "grok";

export default function OrdersPage() {
  const [tab, setTab] = useState<OrderTab>("check");
  const [checkKind, setCheckKind] = useState<CheckKind>("gpt");
  const [country, setCountry] = useState("PH");
  const [payMode, setPayMode] = useState("auto_card");
  const [productCode, setProductCode] = useState("");
  const [session, setSession] = useState("");
  const [checkResult, setCheckResult] = useState<JsonRecord | null>(null);
  const [selectedQuote, setSelectedQuote] = useState<JsonRecord | null>(null);
  const [cardId, setCardId] = useState("auto");
  const [reference, setReference] = useState("");
  const [orders, setOrders] = useState<JsonRecord[]>([]);
  const [orderQuery, setOrderQuery] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [cursor, setCursor] = useState("");
  const [nextCursor, setNextCursor] = useState<unknown>(null);
  const [catalog, setCatalog] = useState<unknown>(null);
  const [products, setProducts] = useState<unknown>(null);
  const [stats, setStats] = useState<unknown>(null);
  const [period, setPeriod] = useState("day");
  const [selectedOrder, setSelectedOrder] = useState<JsonRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ limit: "20" });
    if (orderQuery.trim()) query.set("email", orderQuery.trim());
    if (orderStatus) query.set("status", orderStatus);
    if (cursor) query.set("cursor", cursor);
    try {
      const result = await callApi<JsonRecord>(`/api/v1/gpt/orders?${query}`);
      setOrders(rowsFrom(result));
      setNextCursor(result.next_cursor ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "订单加载失败");
    } finally {
      setLoading(false);
    }
  }, [cursor, orderQuery, orderStatus]);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError("");
    const [gptResult, productResult] = await Promise.allSettled([
      callApi<unknown>("/api/v1/gpt/catalog"),
      callApi<unknown>("/api/v1/direct/products"),
    ]);
    setCatalog(gptResult.status === "fulfilled" ? gptResult.value : null);
    setProducts(productResult.status === "fulfilled" ? productResult.value : null);
    const failures = [gptResult, productResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : "接口请求失败");
    if (failures.length) setError(failures.join("；"));
    setLoading(false);
  }, []);

  const loadStats = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setStats(await callApi(`/api/v1/gpt/orders/stats?${new URLSearchParams({ period })}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "订单统计加载失败");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { if (tab === "orders") void loadOrders(); }, [tab, loadOrders]);
  useEffect(() => { if (tab === "catalog") void loadCatalog(); }, [tab, loadCatalog]);
  useEffect(() => { if (tab === "stats") void loadStats(); }, [tab, loadStats]);

  const checkAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!session.trim()) {
      setError("请粘贴客户 Session 后再检查。");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    setCheckResult(null);
    setSelectedQuote(null);
    try {
      const result = checkKind === "gpt"
        ? await callApi<JsonRecord>("/api/v1/gpt/check", { method: "POST", body: { country, pay_mode: payMode, session, ...(productCode ? { product_code: productCode } : {}) } })
        : await callApi<JsonRecord>("/api/v1/direct/check", { method: "POST", body: { product: checkKind, country, pay_mode: payMode, session } });
      setCheckResult(result);
      setSession("");
      setNotice("账号检查完成。报价有效期有限，请让客户确认后及时下单。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "检查账号失败");
    } finally {
      setLoading(false);
    }
  };

  const placeOrder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedQuote?.quote_id) {
      setError("请先选择一个可购买的报价。");
      return;
    }
    try {
      const result = await confirmMutation<JsonRecord>(
        "/api/v1/gpt/orders",
        "POST",
        { quote_id: selectedQuote.quote_id, ...(payMode === "own_card" ? { card_id: cardId || "auto" } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) },
        `为 ${getString(checkResult?.account, "email", "客户账号")} 创建 ${getString(selectedQuote, "plan")} 订单`,
      );
      if (result) {
        setNotice(`订单已提交，订单号 ${getString(result, "id")}，当前状态 ${getString(result, "status")}`);
        setSelectedQuote(null);
        setReference("");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建订单失败");
    }
  };

  const refreshOrder = async (order: JsonRecord, action: "refresh" | "cancel") => {
    const id = getString(order, "id", "");
    if (!id) return;
    try {
      const result = action === "refresh"
        ? await confirmMutation<unknown>(`/api/v1/gpt/orders/${encodeURIComponent(id)}/refresh`, "POST", undefined, `核对订单 ${id} 的最新状态`)
        : await confirmMutation<unknown>(`/api/v1/gpt/orders/${encodeURIComponent(id)}/cancel`, "POST", undefined, `取消订单 ${id}`);
      if (result !== undefined) {
        setSelectedOrder(result as JsonRecord);
        await loadOrders();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "订单操作失败");
    }
  };

  const loadOrderDetails = async (order: JsonRecord) => {
    const id = getString(order, "id", "");
    try {
      setSelectedOrder(await callApi(`/api/v1/gpt/orders/${encodeURIComponent(id)}`) as JsonRecord);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "订单详情加载失败");
    }
  };

  const plans = rowsFrom(checkResult, "plans");
  const statsPlans = rowsFrom(stats, "plans");

  return (
    <>
      <PageHeader eyebrow="SUBSCRIPTIONS · ORDERS" title="直充与订单" description="检查账号资格和实时报价，创建订单并跟踪开通状态。" />
      <ErrorNotice error={error} />
      {notice && <div className="notice notice-success">{notice}<button className="notice-close" onClick={() => setNotice("")}>关闭</button></div>}
      <div className="business-tabs">
        {(["check", "orders", "catalog", "stats"] as const).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "check" ? "账号检查 / 下单" : value === "orders" ? "订单管理" : value === "catalog" ? "产品目录" : "订单统计"}</button>)}
      </div>
      {tab === "check" && <div className="business-grid orders-grid">
        <Panel title="检查客户账号" eyebrow="CHECK & QUOTE">
          <form className="business-form" onSubmit={(event) => void checkAccount(event)}>
            <label>产品<select value={checkKind} onChange={(event) => setCheckKind(event.target.value as CheckKind)}><option value="gpt">ChatGPT / Codex</option><option value="claude">Claude</option><option value="grok">Grok</option></select></label>
            <label>付款地区<select value={country} onChange={(event) => setCountry(event.target.value)}><option value="PH">菲律宾 (PH)</option><option value="CL">智利 (CL)</option><option value="EG">埃及 (EG)</option><option value="JP">日本 (JP)</option><option value="US">美国 (US)</option><option value="AUTO">自动 (AUTO)</option></select></label>
            <label>付款方式<select value={payMode} onChange={(event) => setPayMode(event.target.value)}><option value="auto_card">自动开卡</option><option value="own_card">使用已有卡</option></select></label>
            {checkKind === "gpt" && payMode === "auto_card" && <label>卡头代码（可选）<input value={productCode} onChange={(event) => setProductCode(event.target.value)} placeholder="例如 P5378XB" /></label>}
            <label className="span-all">客户 ChatGPT Session<textarea rows={4} value={session} onChange={(event) => setSession(event.target.value)} placeholder="粘贴完整 Session JSON 或 session-token；不会保存或写入日志。" /></label>
            <div className="span-all sensitive-warning">请确认客户授权后再提交 Session。检查完成后该凭据会从表单清除。</div>
            <button className="button button-primary" disabled={loading}>{loading ? "正在检查…" : "检查账号并获取报价"} <span>→</span></button>
          </form>
        </Panel>
        <Panel title="报价结果" eyebrow="AVAILABLE PLANS" className="quote-panel">
          {!checkResult ? <div className="empty-state"><span>◇</span><b>检查账号后显示可用套餐</b><small>套餐资格、地区锁定和实时价格以平台返回为准。</small></div> : <>
            <div className="account-confirm"><span>开通账号</span><b>{getString(getRecord(checkResult, "account"), "email", "已验证")}</b><span>当前套餐</span><b>{getString(getRecord(checkResult, "account"), "current_plan")}</b></div>
            {plans.length ? <div className="plan-list">{plans.map((plan, index) => {
              const status = getString(plan, "status", "unavailable");
              const selected = selectedQuote?.quote_id === plan.quote_id;
              return <button key={`${getString(plan, "plan")}-${index}`} className={`plan-card ${selected ? "selected" : ""} ${status !== "available" ? "disabled" : ""}`} onClick={() => status === "available" && setSelectedQuote(plan)} disabled={status !== "available"}>
                <span className="plan-top"><b>{getString(plan, "label", getString(plan, "plan"))}</b><span className={`status-tag status-${status}`}>{status}</span></span>
                <span className="plan-price">{moneyCents(plan.plan_usd_cents)}</span>
                <span className="plan-meta">{getString(plan, "currency")} {getString(plan, "payment_amount_minor")} · 服务费 {moneyCents(plan.price_cents)}</span>
                {typeof plan.reason === "string" && <span className="plan-reason">{plan.reason}</span>}
              </button>;
            })}</div> : <pre className="json-result">{prettyJson(checkResult)}</pre>}
          </>}
        </Panel>
        {selectedQuote && <Panel title="确认并创建订单" eyebrow="PLACE ORDER" className="full-span">
          <form className="business-form order-form" onSubmit={(event) => void placeOrder(event)}>
            {payMode === "own_card" && <label>支付卡 ID<input value={cardId} onChange={(event) => setCardId(event.target.value)} placeholder="输入卡 ID 或 auto" /></label>}
            <label>商户订单号（可选）<input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="用于对账的唯一订单号" maxLength={80} /></label>
            <div className="quote-summary"><span>套餐</span><b>{getString(selectedQuote, "label", getString(selectedQuote, "plan"))}</b><span>服务费</span><b>{moneyCents(selectedQuote.price_cents)}</b><span>报价有效期</span><b>{getString(selectedQuote, "expires_at")}</b></div>
            <button className="button button-primary">确认下单 <span>→</span></button>
          </form>
        </Panel>}
      </div>}
      {tab === "orders" && <>
        <Panel title="订单列表" eyebrow="ORDER MANAGEMENT" action={<div className="inline-filter"><input value={orderQuery} onChange={(event) => setOrderQuery(event.target.value)} placeholder="按客户邮箱搜索" /><select value={orderStatus} onChange={(event) => setOrderStatus(event.target.value)}><option value="">全部状态</option><option>processing</option><option>completed</option><option>failed</option><option>needs_review</option></select><button className="button button-secondary" onClick={() => { setCursor(""); void loadOrders(); }}>搜索</button></div>}>
          {loading ? <div className="empty-state">正在加载订单…</div> : <DataTable rows={orders} columns={[
            { key: "id", label: "订单号" }, { key: "product", label: "产品" }, { key: "plan", label: "套餐" },
            { key: "account_email", label: "客户账号" }, { key: "price_cents", label: "服务费", render: (row) => moneyCents(row.price_cents) },
            { key: "status", label: "状态", render: (row) => <span className={`status-tag status-${getString(row, "status")}`}>{getString(row, "status_text", getString(row, "status"))}</span> },
            { key: "created_at", label: "创建时间", render: (row) => formatDate(getString(row, "created_at", "")) },
            { key: "actions", label: "操作", render: (row) => <span className="table-actions"><button className="text-button" onClick={(event) => { event.stopPropagation(); void loadOrderDetails(row); }}>详情</button><button className="text-button" onClick={(event) => { event.stopPropagation(); void refreshOrder(row, "refresh"); }}>刷新</button></span> },
          ]} emptyText="暂无订单" />}
          {nextCursor !== null && nextCursor !== undefined && <button className="button button-secondary pagination-button" onClick={() => setCursor(String(nextCursor))}>下一页 →</button>}
        </Panel>
        {selectedOrder && <Panel title={`订单详情 · ${getString(selectedOrder, "id")}`} eyebrow="ORDER DETAIL" action={<button className="small-button" onClick={() => setSelectedOrder(null)}>关闭</button>}><pre className="json-result">{prettyJson(selectedOrder)}</pre>{selectedOrder.cancellable === true && <button className="button button-danger" onClick={() => void refreshOrder(selectedOrder, "cancel")}>取消订单</button>}</Panel>}
      </>}
      {tab === "catalog" && <div className="business-grid">
        <Panel title="ChatGPT 套餐目录" eyebrow="GPT CATALOG" action={<button className="button button-secondary" disabled={loading} onClick={() => void loadCatalog()}>↻ 刷新</button>}>
          {catalog ? <pre className="json-result">{prettyJson(catalog)}</pre> : <div className="empty-state">{loading ? "加载中…" : "目录暂无数据"}</div>}
        </Panel>
        <Panel title="直充产品" eyebrow="DIRECT PRODUCTS">
          {products ? <pre className="json-result">{prettyJson(products)}</pre> : <div className="empty-state">{loading ? "加载中…" : "产品暂无数据"}</div>}
          <p className="muted small-copy">Claude / Grok 直充使用上方账号检查流程；下单、查单共用订单接口。</p>
        </Panel>
      </div>}
      {tab === "stats" && <Panel title="订单统计" eyebrow="ORDER ANALYTICS" action={<div className="inline-filter"><select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="day">今日</option><option value="week">本周</option><option value="month">本月</option><option value="all">全部时间</option></select><button className="button button-secondary" disabled={loading} onClick={() => void loadStats()}>刷新统计</button></div>}>
        {stats ? <><div className="balance-grid stats-grid">{Object.entries(getRecord(stats, "summary") ?? {}).map(([key, value]) => <div className="balance-card" key={key}><span>{key}</span><b>{String(value)}</b></div>)}</div><DataTable rows={statsPlans} columns={[{ key: "product", label: "产品" }, { key: "plan", label: "套餐" }, { key: "total", label: "总计" }, { key: "completed", label: "已完成" }, { key: "processing", label: "处理中" }, { key: "failed", label: "失败" }]} emptyText="此时间段暂无订单统计" /></> : <div className="empty-state">{loading ? "加载统计…" : "暂无统计数据"}</div>}
      </Panel>}
    </>
  );
}

