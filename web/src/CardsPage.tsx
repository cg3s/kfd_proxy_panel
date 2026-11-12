import { useCallback, useEffect, useMemo, useState } from "react";
import { callApi, confirmMutation, getString, moneyCents, rowsFrom, type JsonRecord, prettyJson } from "./api";
import { dollarsToCents } from "./AccountPage";
import { ErrorNotice, PageHeader, Panel } from "./components";

type CardAction = "details" | "funds" | "settings";

export default function CardsPage() {
  const [cards, setCards] = useState<JsonRecord[]>([]);
  const [products, setProducts] = useState<JsonRecord[]>([]);
  const [counts, setCounts] = useState<unknown>(null);
  const [view, setView] = useState("active");
  const [search, setSearch] = useState("");
  const [productFilter, setProductFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkAction, setBulkAction] = useState("freeze");
  const [activeCard, setActiveCard] = useState<JsonRecord | null>(null);
  const [activeTab, setActiveTab] = useState<CardAction>("details");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [productCode, setProductCode] = useState("");
  const [initialAmount, setInitialAmount] = useState("20.00");
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ view, limit: "100", sort: "new" });
    if (search.trim()) params.set("q", search.trim());
    if (productFilter) params.set("product_code", productFilter);
    const [cardResult, productResult, countResult] = await Promise.allSettled([
      callApi<unknown>(`/api/v1/cards?${params}`),
      callApi<unknown>("/api/v1/card-products"),
      callApi<unknown>("/api/v1/cards/counts"),
    ]);
    setCards(cardResult.status === "fulfilled" ? rowsFrom(cardResult.value) : []);
    setProducts(productResult.status === "fulfilled" ? rowsFrom(productResult.value) : []);
    setCounts(countResult.status === "fulfilled" ? countResult.value : null);
    const failures = [cardResult, productResult, countResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : "接口请求失败");
    if (failures.length) setError(failures.join("；"));
    setLoading(false);
  }, [productFilter, search, view]);

  useEffect(() => { void refresh(); }, [refresh]);

  const createCard = async (event: React.FormEvent) => {
    event.preventDefault();
    const initAmount = dollarsToCents(initialAmount);
    if (!productCode || !firstName.trim() || !lastName.trim() || !initAmount) {
      setError("请填写卡头、持卡人姓名和有效的初始金额。");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const result = await confirmMutation<JsonRecord>(
        "/api/v1/cards",
        "POST",
        { product_code: productCode, first_name: firstName.trim(), last_name: lastName.trim(), init_amount_cents: initAmount },
        `开立虚拟卡 ${productCode}，初始充值 ${moneyCents(initAmount)}`,
      );
      if (result) {
        setCreateNotice(`开卡请求已提交，卡状态：${getString(result, "status", "处理中")}`);
        setFirstName("");
        setLastName("");
        await refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "开卡失败");
    } finally {
      setCreating(false);
    }
  };

  const runBulk = async () => {
    if (!selectedIds.length) {
      setError("请先选择要操作的卡片。");
      return;
    }
    try {
      const result = await confirmMutation<JsonRecord>(
        "/api/v1/cards/bulk",
        "POST",
        { action: bulkAction, ids: selectedIds },
        `批量执行 ${bulkAction}，共 ${selectedIds.length} 张卡`,
      );
      if (result) {
        setSelectedIds([]);
        setCreateNotice("批量操作已提交。");
        await refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "批量操作失败");
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  };

  const allVisibleSelected = cards.length > 0 && cards.every((card) => selectedIds.includes(cardId(card)));
  const countSummary = useMemo(() => {
    if (Array.isArray(counts)) return `${counts.length} 个视图`;
    if (counts && typeof counts === "object") return Object.entries(counts).slice(0, 4).map(([key, value]) => `${key}: ${typeof value === "number" ? value : "—"}`).join(" · ");
    return "—";
  }, [counts]);

  return (
    <>
      <PageHeader eyebrow="CARD MANAGEMENT" title="虚拟卡" description="管理卡片、查看交易、充值退款和设置自动充值。" action={<button className="button button-secondary" onClick={() => void refresh()} disabled={loading}>{loading ? "加载中…" : "↻ 刷新卡片"}</button>} />
      <ErrorNotice error={error} />
      {createNotice && <div className="notice notice-success">{createNotice}<button className="notice-close" onClick={() => setCreateNotice("")}>关闭</button></div>}
      <div className="card-overview-strip">
        <div><span className="strip-icon blue">▣</span><span><small>当前视图</small><b>{view === "active" ? "使用中" : view === "archived" ? "已归档" : view === "deleted" ? "已删除" : "全部卡片"}</b></span></div>
        <div><span className="strip-icon green">◉</span><span><small>卡片统计</small><b>{countSummary}</b></span></div>
        <button className="button button-primary" onClick={() => document.getElementById("new-card-form")?.scrollIntoView({ behavior: "smooth" })}>＋ 开立新卡</button>
      </div>
      <Panel title="卡片列表" eyebrow="YOUR CARDS" action={<div className="inline-filter">
        <select value={view} onChange={(event) => setView(event.target.value)}><option value="active">使用中</option><option value="archived">已归档</option><option value="deleted">已删除</option><option value="all">全部</option></select>
        <select value={productFilter} onChange={(event) => setProductFilter(event.target.value)}><option value="">全部卡头</option>{products.map((product) => <option key={getString(product, "product_code")} value={getString(product, "product_code")}>{getString(product, "name", getString(product, "product_code"))}</option>)}</select>
        <input aria-label="搜索卡片" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void refresh()} placeholder="搜索后四位 / 备注" />
      </div>}>
        {selectedIds.length > 0 && <div className="bulk-toolbar"><span>已选 {selectedIds.length} 张</span><select value={bulkAction} onChange={(event) => setBulkAction(event.target.value)}><option value="freeze">冻结</option><option value="unfreeze">解冻</option><option value="refund">退款（保留 $1）</option><option value="delete">删卡</option><option value="sync">刷新</option><option value="archive">归档</option><option value="unarchive">取消归档</option></select><button className="button button-secondary" onClick={() => void runBulk()}>执行批量操作</button><button className="text-button" onClick={() => setSelectedIds([])}>取消选择</button></div>}
        {loading ? <div className="empty-state">正在加载卡片…</div> : <div className="table-scroll"><table><thead><tr>
          <th><input type="checkbox" checked={allVisibleSelected} onChange={() => setSelectedIds(allVisibleSelected ? [] : cards.map(cardId))} aria-label="全选卡片" /></th><th>卡片</th><th>卡头</th><th>持卡人</th><th>状态</th><th>可用余额</th><th>备注</th><th>操作</th>
        </tr></thead><tbody>
          {cards.map((card, index) => {
            const id = cardId(card);
            return <tr key={id || index}>
              <td><input type="checkbox" checked={selectedIds.includes(id)} onChange={() => toggleSelected(id)} aria-label={`选择卡片 ${id}`} /></td>
              <td><button className="card-number-button" onClick={() => { setActiveCard(card); setActiveTab("details"); }}>{`•••• ${getString(card, "last4")}`}</button><small className="cell-subtext">{id}</small></td>
              <td>{getString(card, "product_code")}</td><td>{getString(card, "holder_name")}</td>
              <td><span className={`status-tag status-${getString(card, "status").toLowerCase()}`}>{getString(card, "status")}</span></td>
              <td className="money-cell">{moneyCents(card.available_cents)}</td><td>{getString(card, "remark")}</td>
              <td><button className="button button-small button-secondary" onClick={() => { setActiveCard(card); setActiveTab("details"); }}>管理</button></td>
            </tr>;
          })}
          {!cards.length && <tr><td colSpan={8}><div className="empty-state">当前筛选条件下没有卡片</div></td></tr>}
        </tbody></table></div>}
      </Panel>
      <Panel title="开立虚拟卡" eyebrow="NEW CARD" className="new-card-panel">
        <form id="new-card-form" className="business-form" onSubmit={(event) => void createCard(event)}>
          <label>卡头<select value={productCode} onChange={(event) => setProductCode(event.target.value)} required><option value="">选择可用卡头</option>{products.map((product) => <option key={getString(product, "product_code")} value={getString(product, "product_code")}>{getString(product, "name")} · 最低充值 {moneyCents(product.min_amount_cents)}</option>)}</select></label>
          <label>初始金额（USD）<input inputMode="decimal" value={initialAmount} onChange={(event) => setInitialAmount(event.target.value)} placeholder="20.00" required /></label>
          <label>持卡人名（英文）<input value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="John" required /></label>
          <label>持卡人姓（英文）<input value={lastName} onChange={(event) => setLastName(event.target.value)} placeholder="Doe" required /></label>
          <button className="button button-primary" disabled={creating}>{creating ? "提交中…" : "确认开卡"} <span>→</span></button>
        </form>
      </Panel>
      {activeCard && <CardManager card={activeCard} tab={activeTab} onTab={setActiveTab} onClose={() => setActiveCard(null)} onUpdated={refresh} />}
    </>
  );
}

function cardId(card: JsonRecord): string {
  return String(card.id ?? "");
}

function CardManager({ card, tab, onTab, onClose, onUpdated }: {
  card: JsonRecord;
  tab: CardAction;
  onTab: (tab: CardAction) => void;
  onClose: () => void;
  onUpdated: () => Promise<void>;
}) {
  const id = cardId(card);
  const path = `/api/v1/cards/${encodeURIComponent(id)}`;
  const [amount, setAmount] = useState("");
  const [remark, setRemark] = useState(getString(card, "remark", ""));
  const [threshold, setThreshold] = useState("10.00");
  const [autoAmount, setAutoAmount] = useState("20.00");
  const [detail, setDetail] = useState<unknown>(card);
  const [operationMessage, setOperationMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const execute = async (endpoint: string, method: string, body: unknown, label: string) => {
    setError("");
    setBusy(true);
    try {
      const result = await confirmMutation<unknown>(`${path}${endpoint}`, method, body, label);
      if (result !== undefined) {
        setOperationMessage("操作已受理。");
        setDetail(result);
        await onUpdated();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const fetchDetail = async (endpoint = "") => {
    setError("");
    setBusy(true);
    try {
      setDetail(await callApi(`${path}${endpoint}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "查询失败");
    } finally {
      setBusy(false);
    }
  };

  const transfer = async (kind: "recharge" | "refund") => {
    const cents = dollarsToCents(amount);
    if (!cents) {
      setError("请输入有效的美元金额，例如 20.00。");
      return;
    }
    await execute(`/${kind}`, "POST", { amount_cents: cents }, `${kind === "recharge" ? "给卡充值" : "从卡退款"} ${moneyCents(cents)}`);
    setAmount("");
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="card-modal" role="dialog" aria-modal="true" aria-labelledby="card-modal-title">
        <header className="modal-header"><div><p className="eyebrow">CARD · {id}</p><h2 id="card-modal-title">•••• {getString(card, "last4")} <span className="status-tag">{getString(card, "status")}</span></h2></div><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></header>
        <div className="business-tabs modal-tabs">
          {(["details", "funds", "settings"] as const).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => { onTab(value); setError(""); setOperationMessage(""); }}>{value === "details" ? "卡片详情" : value === "funds" ? "资金与交易" : "卡片设置"}</button>)}
        </div>
        <ErrorNotice error={error} />
        {operationMessage && <div className="notice notice-success">{operationMessage}<button className="notice-close" onClick={() => setOperationMessage("")}>关闭</button></div>}
        {tab === "details" && <>
          <div className="detail-list compact-details"><DetailLine label="持卡人" value={getString(card, "holder_name")} /><DetailLine label="卡头" value={getString(card, "product_code")} /><DetailLine label="余额" value={moneyCents(card.available_cents)} /><DetailLine label="创建时间" value={getString(card, "created_at")} /></div>
          <div className="modal-actions"><button className="button button-secondary" disabled={busy} onClick={() => void fetchDetail()}>刷新卡片详情</button><button className="button button-secondary" disabled={busy} onClick={() => void fetchDetail("/statement")}>财务报表</button><button className="button button-secondary" disabled={busy} onClick={() => void fetchDetail("/transactions")}>消费记录</button><button className="button button-secondary" disabled={busy} onClick={async () => { if (!window.confirm("将读取完整卡号、CVV 和账单地址等敏感信息。请确认当前环境安全。")) return; await fetchDetail("/sensitive"); }}>查看敏感信息</button></div>
          <pre className="json-result">{prettyJson(detail)}</pre>
        </>}
        {tab === "funds" && <>
          <form className="modal-inline-form" onSubmit={(event) => { event.preventDefault(); void transfer("recharge"); }}><label>充值金额（USD）<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="例如 20.00" /></label><button className="button button-primary" disabled={busy}>给卡充值</button></form>
          <form className="modal-inline-form" onSubmit={(event) => { event.preventDefault(); void transfer("refund"); }}><label>退款金额（USD）<input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="卡内需至少保留 $1" /></label><button className="button button-secondary" disabled={busy}>退回余额</button></form>
          <div className="modal-actions"><button className="button button-secondary" disabled={busy} onClick={() => void execute("/sync", "POST", undefined, "立即同步卡片余额与状态")}>同步卡片</button><button className="button button-secondary" disabled={busy} onClick={() => void fetchDetail("/statement")}>查看财务报表</button><button className="button button-secondary" disabled={busy} onClick={() => void fetchDetail("/transactions")}>查看消费记录</button></div>
          <pre className="json-result">{prettyJson(detail)}</pre>
        </>}
        {tab === "settings" && <>
          <div className="modal-actions">
            <button className="button button-secondary" disabled={busy} onClick={() => void execute("/freeze", "POST", undefined, "冻结该卡")}>冻结</button>
            <button className="button button-secondary" disabled={busy} onClick={() => void execute("/unfreeze", "POST", undefined, "解冻该卡")}>解冻</button>
            <button className="button button-danger" disabled={busy} onClick={async () => { if (!window.confirm(`删除卡片 ${id}？卡内余额将退回可用余额。`)) return; setBusy(true); try { await callApi(path, { method: "DELETE", idempotencyKey: `web-${Date.now()}-delete` }); setOperationMessage("删卡请求已提交。"); await onUpdated(); } catch (caught) { setError(caught instanceof Error ? caught.message : "删卡失败"); } finally { setBusy(false); } }}>删除卡片</button>
          </div>
          <form className="modal-inline-form" onSubmit={(event) => { event.preventDefault(); void execute("/remark", "POST", { remark }, "更新卡片备注"); }}><label>卡片备注<input value={remark} maxLength={100} onChange={(event) => setRemark(event.target.value)} placeholder="最多 100 字" /></label><button className="button button-secondary" disabled={busy}>保存备注</button></form>
          <form className="business-form settings-form" onSubmit={(event) => { event.preventDefault(); const thresholdCents = dollarsToCents(threshold); const amountCents = dollarsToCents(autoAmount); if (!thresholdCents || !amountCents) { setError("自动充值金额格式无效。"); return; } void execute("/auto-topup", "PUT", { enabled: true, threshold_cents: thresholdCents, amount_cents: amountCents, daily_max: 3 }, "启用该卡自动充值"); }}>
            <label>触发阈值（USD）<input value={threshold} onChange={(event) => setThreshold(event.target.value)} /></label><label>充值金额（USD）<input value={autoAmount} onChange={(event) => setAutoAmount(event.target.value)} /></label><button className="button button-primary" disabled={busy}>启用自动充值</button>
          </form>
          <button className="text-button" onClick={() => void execute("/auto-topup", "PUT", { enabled: false }, "停用自动充值")}>停用自动充值</button>
        </>}
      </section>
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return <div className="detail-row"><span>{label}</span><b>{value}</b></div>;
}

