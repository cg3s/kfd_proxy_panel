import { useCallback, useEffect, useState } from "react";
import { callApi, confirmMutation, formatDate, getString, moneyCents, rowsFrom, type JsonRecord, prettyJson } from "./api";
import { DataTable, ErrorNotice, PageHeader, Panel } from "./components";

type CdkTab = "overview" | "batches" | "codes" | "redeem" | "settings";

export default function CdkPage() {
  const [tab, setTab] = useState<CdkTab>("overview");
  const [summary, setSummary] = useState<JsonRecord | null>(null);
  const [batches, setBatches] = useState<JsonRecord[]>([]);
  const [codes, setCodes] = useState<JsonRecord[]>([]);
  const [codeStatus, setCodeStatus] = useState("");
  const [codeSearch, setCodeSearch] = useState("");
  const [batchFilter, setBatchFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Array<string | number>>([]);
  const [batchResult, setBatchResult] = useState<JsonRecord | null>(null);
  const [plan, setPlan] = useState("plus");
  const [country, setCountry] = useState("PH");
  const [count, setCount] = useState("10");
  const [expiresDays, setExpiresDays] = useState("180");
  const [fundingCap, setFundingCap] = useState("");
  const [autoOpen, setAutoOpen] = useState(false);
  const [productCode, setProductCode] = useState("");
  const [note, setNote] = useState("");
  const [settings, setSettings] = useState<JsonRecord | null>(null);
  const [prefix, setPrefix] = useState("");
  const [origins, setOrigins] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemSession, setRedeemSession] = useState("");
  const [redemptionToken, setRedemptionToken] = useState("");
  const [redeemResult, setRedeemResult] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError("");
    const [summaryResult, batchesResult, settingsResult] = await Promise.allSettled([
      callApi<JsonRecord>("/api/v1/cdk/summary"),
      callApi<unknown>("/api/v1/cdk/batches?limit=20&offset=0"),
      callApi<JsonRecord>("/api/v1/cdk/settings"),
    ]);
    setSummary(summaryResult.status === "fulfilled" ? summaryResult.value : null);
    setBatches(batchesResult.status === "fulfilled" ? rowsFrom(batchesResult.value) : []);
    const loadedSettings = settingsResult.status === "fulfilled" ? settingsResult.value : null;
    setSettings(loadedSettings);
    setPrefix(getString(loadedSettings, "code_prefix", ""));
    const allowedOrigins = loadedSettings?.allowed_origins;
    setOrigins(Array.isArray(allowedOrigins) ? allowedOrigins.join("\n") : "");
    const failures = [summaryResult, batchesResult, settingsResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : "接口请求失败");
    if (failures.length) setError(failures.join("；"));
    setLoading(false);
  }, []);

  const loadCodes = useCallback(async () => {
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ limit: "50", offset: "0" });
    if (codeStatus) query.set("status", codeStatus);
    if (codeSearch.trim()) query.set("q", codeSearch.trim());
    if (batchFilter) query.set("batch", batchFilter);
    try {
      setCodes(rowsFrom(await callApi(`/api/v1/cdk/codes?${query}`)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CDK 列表加载失败");
    } finally {
      setLoading(false);
    }
  }, [batchFilter, codeSearch, codeStatus]);

  useEffect(() => { if (tab === "overview" || tab === "batches" || tab === "settings") void loadOverview(); }, [tab, loadOverview]);
  useEffect(() => { if (tab === "codes") void loadCodes(); }, [tab, loadCodes]);

  const createBatch = async (event: React.FormEvent) => {
    event.preventDefault();
    const countValue = Number(count);
    const daysValue = Number(expiresDays);
    if (!Number.isInteger(countValue) || countValue < 1 || countValue > 500 || !Number.isInteger(daysValue) || daysValue < 1) {
      setError("数量需为 1–500 的整数，有效期需为正整数天。");
      return;
    }
    const body: JsonRecord = {
      plan, country, count: countValue, expires_days: daysValue, auto_open: autoOpen,
      ...(fundingCap ? { funding_cap_cents: Number(fundingCap) } : {}),
      ...(autoOpen && productCode ? { product_code: productCode } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    setError("");
    try {
      const result = await confirmMutation<JsonRecord>(
        "/api/v1/cdk/batches",
        "POST",
        body,
        `生成 ${countValue} 张 ${plan} CDK；每张服务费以平台实时价格为准`,
      );
      if (result) {
        setBatchResult(result);
        setNotice("CDK 批次已创建。完整卡密仅在此处展示，请立即安全保存。");
        await loadOverview();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成 CDK 批次失败");
    }
  };

  const toggleCode = (id: string | number) => {
    setSelectedIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
  };

  const changeCodes = async (action: "disable" | "enable") => {
    if (!selectedIds.length) {
      setError("请先选择卡密。");
      return;
    }
    try {
      const result = await confirmMutation<JsonRecord>(
        `/api/v1/cdk/codes/${action}`,
        "POST",
        { ids: selectedIds },
        `${action === "disable" ? "停用" : "恢复"} ${selectedIds.length} 张 CDK`,
      );
      if (result) {
        setSelectedIds([]);
        setNotice(`${action === "disable" ? "停用" : "恢复"}操作已完成。`);
        await loadCodes();
        await loadOverview();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "批量更新 CDK 失败");
    }
  };

  const exportBatch = async (id: string) => {
    try {
      const response = await fetch(`/api/v1/cdk/batches/${encodeURIComponent(id)}/export?format=csv`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `cdk-${id}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导出批次失败");
    }
  };

  const previewCode = async () => {
    setError("");
    try {
      setRedeemResult(await callApi("/api/v1/cdk/redeem/preview", { method: "POST", body: { code: redeemCode.trim() } }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "查询卡密失败");
    }
  };

  const checkRedemption = async () => {
    setError("");
    try {
      const result = await callApi<JsonRecord>("/api/v1/cdk/redeem/check", {
        method: "POST",
        body: { code: redeemCode.trim(), session: redeemSession },
      });
      setRedemptionToken(getString(result, "redemption_token", ""));
      setRedeemSession("");
      setRedeemResult(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "检查兑换资格失败");
    }
  };

  const redeem = async () => {
    if (!redemptionToken || !redeemCode.trim()) {
      setError("请先检查兑换资格并取得 redemption_token。");
      return;
    }
    try {
      const result = await confirmMutation(
        "/api/v1/cdk/redeem/redeem",
        "POST",
        { code: redeemCode.trim(), redemption_token: redemptionToken },
        "确认兑换该 CDK。提交后请轮询进度，受理不代表已开通。",
      );
      if (result !== undefined) setRedeemResult(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交兑换失败");
    }
  };

  const checkStatus = async () => {
    if (!redemptionToken) return;
    try {
      setRedeemResult(await callApi(`/api/v1/cdk/redeem/status?${new URLSearchParams({ token: redemptionToken })}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "查询兑换进度失败");
    }
  };

  const saveSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    const allowedOrigins = origins.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    try {
      const result = await confirmMutation<JsonRecord>(
        "/api/v1/cdk/settings",
        "PUT",
        { code_prefix: prefix, allowed_origins: allowedOrigins },
        "保存 CDK 品牌前缀和允许的兑换页来源",
      );
      if (result) {
        setSettings(result);
        setNotice("CDK 兑换设置已保存。");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存设置失败");
    }
  };

  const batchRows = rowsFrom(batchResult, "codes");
  const codeIds = codes.map((code) => code.id).filter((value): value is string | number => typeof value === "number" || typeof value === "string");
  const selectedAll = codeIds.length > 0 && codeIds.every((id) => selectedIds.includes(id));

  return (
    <>
      <PageHeader eyebrow="CODE DISTRIBUTION" title="CDK 兑换码" description="生成和管理兑换码批次，查看兑换状态并代客完成兑换。" action={<button className="button button-secondary" disabled={loading} onClick={() => void loadOverview()}>{loading ? "加载中…" : "↻ 刷新"}</button>} />
      <ErrorNotice error={error} />
      {notice && <div className="notice notice-success">{notice}<button className="notice-close" onClick={() => setNotice("")}>关闭</button></div>}
      <div className="business-tabs">
        {(["overview", "batches", "codes", "redeem", "settings"] as const).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "overview" ? "概览" : value === "batches" ? "批次管理" : value === "codes" ? "卡密管理" : value === "redeem" ? "代客兑换" : "兑换设置"}</button>)}
      </div>
      {tab === "overview" && <>
        <div className="balance-grid cdk-stats-grid">{["unused", "reserved", "redeemed", "disabled", "expired", "redeemed_today"].map((key) => <div className="balance-card" key={key}><span>{key === "redeemed_today" ? "今日已兑换" : key === "unused" ? "可兑换" : key === "reserved" ? "兑换中" : key === "redeemed" ? "已兑换" : key === "disabled" ? "已停用" : "已过期"}</span><b>{String(summary?.[key] ?? "—")}</b></div>)}</div>
        <Panel title="最近批次" eyebrow="RECENT BATCHES" action={<button className="text-button" onClick={() => setTab("batches")}>全部批次 →</button>}>
          <DataTable rows={batches.slice(0, 8)} columns={[
            { key: "id", label: "批次 ID" }, { key: "plan", label: "套餐" }, { key: "country", label: "地区" },
            { key: "count", label: "数量" }, { key: "unit_price_cents", label: "单张服务费", render: (row) => moneyCents(row.unit_price_cents) },
            { key: "expires_at", label: "到期时间", render: (row) => formatDate(row.expires_at) },
            { key: "actions", label: "操作", render: (row) => <button className="text-button" onClick={() => void exportBatch(getString(row, "id", ""))}>导出 CSV</button> },
          ]} emptyText="暂无 CDK 批次" />
        </Panel>
      </>}
      {tab === "batches" && <div className="business-grid">
        <Panel title="生成 CDK 批次" eyebrow="CREATE CODES">
          <form className="business-form" onSubmit={(event) => void createBatch(event)}>
            <label>套餐<input value={plan} onChange={(event) => setPlan(event.target.value)} placeholder="plus / credit250" required /></label>
            <label>付款地区<select value={country} onChange={(event) => setCountry(event.target.value)}><option>PH</option><option>CL</option><option>EG</option><option>JP</option><option>US</option><option>AUTO</option></select></label>
            <label>生成数量<input type="number" min="1" max="500" value={count} onChange={(event) => setCount(event.target.value)} required /></label>
            <label>有效期（天）<input type="number" min="1" value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)} required /></label>
            <label>资金上限（美分，可选）<input type="number" min="100" value={fundingCap} onChange={(event) => setFundingCap(event.target.value)} placeholder="例如 2000" /></label>
            <label className="check-field"><input type="checkbox" checked={autoOpen} onChange={(event) => setAutoOpen(event.target.checked)} />兑换时自动开卡</label>
            {autoOpen && <label>自动开卡卡头<input value={productCode} onChange={(event) => setProductCode(event.target.value)} placeholder="例如 P5378XB" /></label>}
            <label className="span-all">批次备注<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如 11 月店铺批次" /></label>
            <button className="button button-primary">生成并扣除服务费 <span>→</span></button>
          </form>
        </Panel>
        <Panel title="批次列表" eyebrow="BATCH HISTORY"><DataTable rows={batches} columns={[
          { key: "id", label: "批次 ID" }, { key: "plan", label: "套餐" }, { key: "country", label: "地区" },
          { key: "count", label: "数量" }, { key: "last_used_at", label: "最近兑换", render: (row) => formatDate(row.last_used_at) },
          { key: "expires_at", label: "到期时间", render: (row) => formatDate(row.expires_at) },
          { key: "actions", label: "导出", render: (row) => <button className="text-button" onClick={() => void exportBatch(getString(row, "id", ""))}>下载 CSV</button> },
        ]} emptyText="暂无批次" /></Panel>
        {batchResult && <Panel title="新批次卡密" eyebrow="GENERATED CODES" className="full-span"><p className="muted">完整卡密仅在创建响应中返回。建议立即下载/安全保存；请勿发送到不可信渠道。</p><pre className="json-result">{prettyJson(batchResult)}</pre><DataTable rows={batchRows} columns={[{ key: "code", label: "完整卡密" }, { key: "status", label: "状态" }]} emptyText="批次响应中没有卡密列表" /></Panel>}
      </div>}
      {tab === "codes" && <Panel title="卡密列表" eyebrow="CODE INVENTORY" action={<div className="inline-filter"><input value={batchFilter} onChange={(event) => setBatchFilter(event.target.value)} placeholder="批次 ID" /><select value={codeStatus} onChange={(event) => setCodeStatus(event.target.value)}><option value="">全部状态</option><option value="unused">可兑换</option><option value="reserved">兑换中</option><option value="redeemed">已兑换</option><option value="disabled">已停用</option><option value="expired">已过期</option></select><input value={codeSearch} onChange={(event) => setCodeSearch(event.target.value)} placeholder="搜索后四位 / 邮箱" /><button className="button button-secondary" onClick={() => void loadCodes()}>搜索</button></div>}>
        {selectedIds.length > 0 && <div className="bulk-toolbar"><span>已选 {selectedIds.length} 张</span><button className="button button-secondary" onClick={() => void changeCodes("disable")}>停用</button><button className="button button-secondary" onClick={() => void changeCodes("enable")}>恢复</button><button className="text-button" onClick={() => setSelectedIds([])}>取消选择</button></div>}
        {loading ? <div className="empty-state">正在加载卡密…</div> : <div className="table-scroll"><table><thead><tr><th><input type="checkbox" checked={selectedAll} onChange={() => setSelectedIds(selectedAll ? [] : codeIds)} aria-label="全选卡密" /></th><th>完整卡密</th><th>套餐</th><th>状态</th><th>批次</th><th>兑换账号</th><th>订单号</th><th>付款卡</th><th>到期时间</th></tr></thead><tbody>
          {codes.map((code, index) => {
            const id = typeof code.id === "number" || typeof code.id === "string" ? code.id : "";
            return <tr key={String(id || index)}><td><input type="checkbox" checked={selectedIds.includes(id)} onChange={() => toggleCode(id)} aria-label={`选择卡密 ${id}`} /></td><td><code>{getString(code, "code")}</code></td><td>{getString(code, "plan")}</td><td><span className="status-tag">{getString(code, "status")}</span></td><td>{getString(code, "batch_id")}</td><td>{getString(code, "account_email")}</td><td>{getString(code, "order_id")}</td><td>{getString(code, "card_last4")}</td><td>{formatDate(code.expires_at)}</td></tr>;
          })}
          {!codes.length && <tr><td colSpan={9}><div className="empty-state">没有符合条件的卡密</div></td></tr>}
        </tbody></table></div>}
      </Panel>}
      {tab === "redeem" && <div className="business-grid">
        <Panel title="代客兑换流程" eyebrow="CUSTOMER REDEMPTION">
          <div className="workflow-steps"><span className="current">1. 查询</span><i>→</i><span className={redemptionToken ? "current" : ""}>2. 检查账号</span><i>→</i><span>3. 确认兑换</span><i>→</i><span>4. 查进度</span></div>
          <label className="standalone-field">CDK 卡密<input value={redeemCode} onChange={(event) => setRedeemCode(event.target.value)} placeholder="粘贴你自己批次生成的完整卡密" /></label>
          <div className="modal-actions"><button className="button button-secondary" onClick={() => void previewCode()}>查询卡密</button></div>
          <label className="standalone-field">客户 Session<textarea rows={4} value={redeemSession} onChange={(event) => setRedeemSession(event.target.value)} placeholder="完整 Session JSON 或 session-token；不会保存或写入日志。" /></label>
          <button className="button button-secondary" disabled={!redeemSession || !redeemCode} onClick={() => void checkRedemption()}>检查账号资格</button>
          {redemptionToken && <div className="notice notice-success">已取得有效兑换令牌。请与客户确认账号邮箱和套餐后再提交。</div>}
          <div className="modal-actions"><button className="button button-primary" disabled={!redemptionToken} onClick={() => void redeem()}>确认兑换</button><button className="button button-secondary" disabled={!redemptionToken} onClick={() => void checkStatus()}>查询兑换进度</button></div>
        </Panel>
        <Panel title="兑换状态" eyebrow="REDEMPTION STATUS">
          {redeemResult ? <pre className="json-result">{prettyJson(redeemResult)}</pre> : <div className="empty-state"><span>◇</span><b>完成预检后显示兑换信息</b></div>}
          {redemptionToken && <p className="muted small-copy">兑换令牌仅保存在当前页面内存。处理中状态请稍后继续查询。</p>}
        </Panel>
      </div>}
      {tab === "settings" && <Panel title="兑换页设置" eyebrow="BRANDING & ALLOWED ORIGINS">
        {settings && <form className="business-form settings-form" onSubmit={(event) => void saveSettings(event)}>
          <label>品牌前缀<input value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="SHOP" /></label>
          <label className="span-all">允许跨域的兑换页来源 <small>每行一个完整 Origin，例如 https://shop.example.com</small><textarea rows={5} value={origins} onChange={(event) => setOrigins(event.target.value)} placeholder="https://shop.example.com" /></label>
          <button className="button button-primary">保存设置</button>
        </form>}
        {!settings && <div className="empty-state">{loading ? "加载设置…" : "暂无设置数据"}</div>}
      </Panel>}
      {tab !== "redeem" && batchResult && tab === "overview" && <Panel title="刚生成的卡密" eyebrow="LATEST BATCH"><pre className="json-result">{prettyJson(batchResult)}</pre></Panel>}
    </>
  );
}

