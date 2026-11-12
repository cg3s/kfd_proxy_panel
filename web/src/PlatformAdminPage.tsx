import { useCallback, useEffect, useState } from "react";
import { DataTable, ErrorNotice, PageHeader, Panel } from "./components";
import type { JsonRecord } from "./api";

type AdminTab = "users" | "prices" | "topups" | "orders" | "cdk";

async function adminRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    throw new Error(typeof error?.message === "string" ? error.message : `HTTP ${response.status}`);
  }
  return payload as T;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function cny(fen: unknown): string {
  return typeof fen === "number"
    ? new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(fen / 100)
    : "—";
}

function idempotencyKey(): string {
  return `admin-${crypto.randomUUID()}`;
}

function parseFen(value: string): number | undefined {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return undefined;
  const [yuan, fraction = ""] = value.split(".");
  const result = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : undefined;
}

export default function PlatformAdminPage() {
  const [tab, setTab] = useState<AdminTab>("users");
  const [users, setUsers] = useState<JsonRecord[]>([]);
  const [prices, setPrices] = useState<JsonRecord[]>([]);
  const [topups, setTopups] = useState<JsonRecord[]>([]);
  const [orders, setOrders] = useState<JsonRecord[]>([]);
  const [cdkPurchases, setCdkPurchases] = useState<JsonRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adjustUserId, setAdjustUserId] = useState("");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustMemo, setAdjustMemo] = useState("");
  const [product, setProduct] = useState("gpt");
  const [plan, setPlan] = useState("");
  const [country, setCountry] = useState("AUTO");
  const [price, setPrice] = useState("");
  const [enabled, setEnabled] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [userResult, priceResult, topupResult, orderResult, cdkResult] = await Promise.all([
        adminRequest<{ data: JsonRecord[] }>("/admin/platform/users"),
        adminRequest<{ data: JsonRecord[] }>("/admin/platform/prices"),
        adminRequest<{ data: JsonRecord[] }>("/admin/platform/topups"),
        adminRequest<{ data: JsonRecord[] }>("/admin/platform/orders"),
        adminRequest<{ data: JsonRecord[] }>("/admin/platform/cdk-purchases"),
      ]);
      const loadedUsers = records(userResult.data);
      setUsers(loadedUsers);
      setPrices(records(priceResult.data));
      setTopups(records(topupResult.data));
      setOrders(records(orderResult.data));
      setCdkPurchases(records(cdkResult.data));
      if (!adjustUserId && loadedUsers.length) setAdjustUserId(String(loadedUsers[0].id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法加载平台数据");
    } finally {
      setLoading(false);
    }
  }, [adjustUserId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateStatus = async (user: JsonRecord) => {
    const nextStatus = user.status === "active" ? "disabled" : "active";
    if (!window.confirm(`确定将 ${String(user.email)} 的账户状态改为 ${nextStatus}？`)) return;
    try {
      await adminRequest(`/admin/platform/users/${encodeURIComponent(String(user.id))}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      });
      setNotice("账户状态已更新。");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "更新失败");
    }
  };

  const adjustWallet = async (event: React.FormEvent) => {
    event.preventDefault();
    const negative = adjustAmount.startsWith("-");
    const amountFen = parseFen(negative ? adjustAmount.slice(1) : adjustAmount);
    if (!amountFen || !adjustMemo.trim()) {
      setError("请输入正数金额和调整说明；负数扣款请使用负号。");
      return;
    }
    const signedAmount = negative ? -amountFen : amountFen;
    if (!window.confirm(`确认调整用户 ${adjustUserId} 余额 ${cny(signedAmount)}？此操作会写入不可删除的账本。`)) return;
    try {
      await adminRequest(`/admin/platform/users/${encodeURIComponent(adjustUserId)}/wallet-adjust`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify({ amount_fen: signedAmount, memo: adjustMemo.trim() }),
      });
      setAdjustAmount("");
      setAdjustMemo("");
      setNotice("余额调整已记账。");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "余额调整失败");
    }
  };

  const savePrice = async (event: React.FormEvent) => {
    event.preventDefault();
    const priceFen = parseFen(price);
    if (!plan.trim() || !priceFen) {
      setError("套餐名称和大于零的人民币价格为必填项。");
      return;
    }
    try {
      await adminRequest("/admin/platform/prices", {
        method: "POST",
        body: JSON.stringify({ product, plan: plan.trim(), country, price_fen: priceFen, enabled }),
      });
      setNotice("价格已保存。");
      setPrice("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "价格保存失败");
    }
  };

  const resolvePurchase = async (type: "orders" | "cdk-purchases", row: JsonRecord, action: "refund" | "settle") => {
    const note = window.prompt("请先在 Kafuda 核实上游结果，并填写处理依据：")?.trim();
    if (!note) return;
    if (!window.confirm(`${action === "refund" ? "退回余额" : "确认为成功结算"}？此操作会写入账本或结算状态，无法撤销。`)) return;
    try {
      await adminRequest(`/admin/platform/${type}/${encodeURIComponent(String(row.id))}/resolve`, {
        method: "POST",
        body: JSON.stringify({ action, memo: note }),
      });
      setNotice(action === "refund" ? "已退回用户余额。" : "订单已标记为成功结算。");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "人工处理失败");
    }
  };

  const tabs: Array<{ id: AdminTab; label: string }> = [
    { id: "users", label: "用户与余额" },
    { id: "prices", label: "固定售价" },
    { id: "topups", label: "充值记录" },
    { id: "orders", label: "直充订单" },
    { id: "cdk", label: "CDK 购买" },
  ];

  return (
    <>
      <PageHeader
        eyebrow="MULTI-USER PLATFORM"
        title="多用户运营"
        description="管理用户、人民币价格和共享商户账户下的客户业务记录。"
        action={<button className="button button-secondary" disabled={loading} onClick={() => void refresh()}>↻ 刷新</button>}
      />
      <ErrorNotice error={error} />
      {notice && <div className="notice notice-success">{notice}<button className="notice-close" onClick={() => setNotice("")}>关闭</button></div>}
      <div className="business-tabs">{tabs.map((item) => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}</button>)}</div>
      {tab === "users" && <div className="business-grid">
        <Panel title="用户账户" eyebrow="CUSTOMERS">
          <DataTable rows={users} columns={[
            { key: "email", label: "邮箱" },
            { key: "balance_fen", label: "人民币余额", render: (row) => cny(row.balance_fen) },
            { key: "status", label: "状态" },
            { key: "created_at", label: "注册时间" },
            { key: "actions", label: "操作", render: (row) => <button className="text-button" onClick={() => void updateStatus(row)}>{row.status === "active" ? "停用" : "启用"}</button> },
          ]} emptyText="暂无用户" />
        </Panel>
        <Panel title="人工余额调整" eyebrow="AUDITED WALLET ENTRY">
          <form className="business-form" onSubmit={(event) => void adjustWallet(event)}>
            <label>用户<select value={adjustUserId} onChange={(event) => setAdjustUserId(event.target.value)}>{users.map((user) => <option key={String(user.id)} value={String(user.id)}>{String(user.email)}</option>)}</select></label>
            <label>调整金额（元）<input value={adjustAmount} onChange={(event) => setAdjustAmount(event.target.value)} placeholder="正数加款；负数扣款" required /></label>
            <label className="span-all">原因 / 备注<input value={adjustMemo} onChange={(event) => setAdjustMemo(event.target.value)} maxLength={200} required /></label>
            <button className="button button-primary" disabled={!users.length}>确认并记账 <span>→</span></button>
          </form>
          <p className="muted">所有人工调整都会追加到只增不删的钱包账本，并使用幂等键防止重复提交。</p>
        </Panel>
      </div>}
      {tab === "prices" && <div className="business-grid">
        <Panel title="配置固定售价" eyebrow="CNY PRICE TABLE">
          <form className="business-form" onSubmit={(event) => void savePrice(event)}>
            <label>产品<select value={product} onChange={(event) => setProduct(event.target.value)}><option value="gpt">ChatGPT / Codex</option><option value="claude">Claude</option><option value="grok">Grok</option><option value="cdk">CDK</option></select></label>
            <label>套餐<input value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="plus / credit250" required /></label>
            <label>地区<select value={country} onChange={(event) => setCountry(event.target.value)}><option>AUTO</option><option>PH</option><option>CL</option><option>EG</option><option>JP</option><option>US</option></select></label>
            <label>售价（人民币元）<input value={price} onChange={(event) => setPrice(event.target.value)} placeholder="例如 99.00" required /></label>
            <label className="check-field"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />立即上架</label>
            <button className="button button-primary">保存价格 <span>→</span></button>
          </form>
          <p className="muted">同一产品/套餐/地区会覆盖旧价；报价创建时会保存价格快照，之后调价不会改变既有订单。</p>
        </Panel>
        <Panel title="在售价格表" eyebrow="ACTIVE & DISABLED">
          <DataTable rows={prices} columns={[
            { key: "product", label: "产品" }, { key: "plan", label: "套餐" },
            { key: "country", label: "地区" }, { key: "price_fen", label: "人民币", render: (row) => cny(row.price_fen) },
            { key: "enabled", label: "状态", render: (row) => row.enabled === 1 ? "上架" : "下架" },
          ]} emptyText="尚未配置销售价格" />
        </Panel>
      </div>}
      {tab === "topups" && <Panel title="充值订单" eyebrow="PAYMENT CALLBACKS"><DataTable rows={topups} columns={[
        { key: "id", label: "订单号" }, { key: "email", label: "用户邮箱" },
        { key: "amount_fen", label: "金额", render: (row) => cny(row.amount_fen) },
        { key: "status", label: "状态" }, { key: "gateway_trade_no", label: "支付平台订单号" },
        { key: "created_at", label: "创建时间" },
      ]} emptyText="暂无充值订单" /></Panel>}
      {tab === "orders" && <Panel title="用户直充订单" eyebrow="CUSTOMER ORDERS"><DataTable rows={orders} columns={[
        { key: "id", label: "本站订单号" }, { key: "email", label: "用户邮箱" },
        { key: "product", label: "产品" }, { key: "plan", label: "套餐" },
        { key: "price_fen", label: "售价", render: (row) => cny(row.price_fen) },
        { key: "status", label: "上游状态" }, { key: "charge_status", label: "账务状态" },
        { key: "error_message", label: "说明" },
        { key: "resolve", label: "核对后处理", render: (row) => row.status === "needs_review" && row.charge_status === "charged"
          ? <span className="table-actions"><button className="text-button" onClick={() => void resolvePurchase("orders", row, "refund")}>退款</button><button className="text-button" onClick={() => void resolvePurchase("orders", row, "settle")}>确认成功</button></span>
          : "—" },
      ]} emptyText="暂无直充订单" /></Panel>}
      {tab === "cdk" && <Panel title="CDK 购买记录" eyebrow="OWNED CODE BATCHES"><DataTable rows={cdkPurchases} columns={[
        { key: "id", label: "本站订单号" }, { key: "email", label: "用户邮箱" },
        { key: "plan", label: "套餐" }, { key: "country", label: "地区" },
        { key: "count", label: "数量" }, { key: "total_price_fen", label: "售价", render: (row) => cny(row.total_price_fen) },
        { key: "status", label: "状态" }, { key: "created_at", label: "创建时间" },
        { key: "resolve", label: "核对后处理", render: (row) => row.status === "needs_review" && row.charge_status === "charged"
          ? <span className="table-actions"><button className="text-button" onClick={() => void resolvePurchase("cdk-purchases", row, "refund")}>退款</button><button className="text-button" onClick={() => void resolvePurchase("cdk-purchases", row, "settle")}>确认成功</button></span>
          : "—" },
      ]} emptyText="暂无 CDK 购买记录" /></Panel>}
    </>
  );
}
