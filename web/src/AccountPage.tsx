import { useCallback, useEffect, useState } from "react";
import { callApi, formatDate, getRecord, getString, moneyCents, rowsFrom, type JsonRecord, confirmMutation } from "./api";
import { DataTable, ErrorNotice, PageHeader, Panel } from "./components";

type AccountTab = "overview" | "ledger" | "topups";

export default function AccountPage() {
  const [tab, setTab] = useState<AccountTab>("overview");
  const [account, setAccount] = useState<JsonRecord | null>(null);
  const [instructions, setInstructions] = useState<JsonRecord | null>(null);
  const [ledger, setLedger] = useState<JsonRecord[]>([]);
  const [topups, setTopups] = useState<JsonRecord[]>([]);
  const [network, setNetwork] = useState("TRC20");
  const [txHash, setTxHash] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    const [accountResult, instructionsResult, ledgerResult, topupsResult] = await Promise.allSettled([
      callApi<JsonRecord>("/api/v1/account"),
      callApi<JsonRecord>("/api/v1/topups/instructions"),
      callApi<unknown>("/api/v1/ledger?limit=20&offset=0"),
      callApi<unknown>("/api/v1/topups?limit=20&offset=0"),
    ]);
    setAccount(accountResult.status === "fulfilled" ? accountResult.value : null);
    setInstructions(instructionsResult.status === "fulfilled" ? instructionsResult.value : null);
    setLedger(ledgerResult.status === "fulfilled" ? rowsFrom(ledgerResult.value) : []);
    setTopups(topupsResult.status === "fulfilled" ? rowsFrom(topupsResult.value) : []);
    const failures = [accountResult, instructionsResult, ledgerResult, topupsResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : "接口请求失败");
    if (failures.length) setError(failures.join("；"));
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const submitTopup = async (event: React.FormEvent) => {
    event.preventDefault();
    const amountCents = dollarsToCents(amount);
    if (!amountCents || !txHash.trim()) {
      setError("请填写有效金额和交易哈希。");
      return;
    }
    try {
      const result = await confirmMutation<JsonRecord>(
        "/api/v1/topups",
        "POST",
        { network, tx_hash: txHash.trim(), amount_cents: amountCents },
        `提交 ${network} 充值申报 ${moneyCents(amountCents)}`,
      );
      if (result) {
        setNotice("充值申报已提交。请等待平台核验到账状态。");
        setTxHash("");
        setAmount("");
        await refresh();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交充值失败");
    }
  };

  const balance = getRecord(account, "balance");
  const user = getRecord(account, "user");
  const level = getRecord(account, "level");
  const receiveAddress = getString(instructions, "address", "请先加载充值说明");
  const feeBps = Number(instructions?.fee_bps ?? 0);

  return (
    <>
      <PageHeader eyebrow="ACCOUNT · BILLING" title="账户与充值" description="查看账户余额、资金流水和充值记录。" action={<button className="button button-secondary" onClick={() => void refresh()} disabled={loading}>{loading ? "加载中…" : "↻ 刷新"}</button>} />
      <ErrorNotice error={error} />
      {notice && <div className="notice notice-success">{notice}<button className="notice-close" onClick={() => setNotice("")}>关闭</button></div>}
      <div className="business-tabs">
        {(["overview", "ledger", "topups"] as const).map((value) => <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "overview" ? "余额总览" : value === "ledger" ? "资金流水" : "充值记录"}</button>)}
      </div>
      {tab === "overview" && (
        <div className="business-grid">
          <div className="balance-grid">
            <BalanceCard label="可用余额" value={moneyCents(balance?.available_cents)} tone="blue" />
            <BalanceCard label="冻结金额" value={moneyCents(balance?.frozen_cents)} tone="violet" />
            <BalanceCard label="保证金" value={moneyCents(balance?.reserve_cents)} tone="amber" />
            <BalanceCard label="欠款" value={moneyCents(balance?.debt_cents)} tone="red" />
          </div>
          <Panel title="账户资料" eyebrow="PROFILE">
            <div className="detail-list">
              <Detail label="邮箱" value={getString(user, "email")} />
              <Detail label="账户状态" value={getString(user, "status")} />
              <Detail label="会员等级" value={getString(level, "name")} />
              <Detail label="活跃卡片" value={getString(account, "cards_active")} />
            </div>
          </Panel>
          <Panel title="USDT 充值" eyebrow="TOP UP">
            <div className="address-box"><span>收款网络</span><b>{getString(instructions, "network", network)}</b><span>收款地址</span><code>{receiveAddress}</code></div>
            <p className="muted small-copy">充值手续费率：{(feeBps / 100).toFixed(2)}%。请转账后填写交易哈希并提交申报。</p>
            <form className="business-form" onSubmit={(event) => void submitTopup(event)}>
              <label>网络<input value={network} onChange={(event) => setNetwork(event.target.value)} placeholder="例如 TRC20" required /></label>
              <label>转账金额（USD）<input inputMode="decimal" placeholder="例如 50.00" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
              <label className="span-all">交易哈希<input value={txHash} onChange={(event) => setTxHash(event.target.value)} placeholder="粘贴链上交易哈希" /></label>
              <button className="button button-primary" disabled={loading}>提交充值申报 <span>→</span></button>
            </form>
          </Panel>
          <Panel title="最近资金流水" eyebrow="RECENT ACTIVITY" action={<button className="text-button" onClick={() => setTab("ledger")}>全部流水 →</button>} className="full-span">
            <DataTable rows={ledger.slice(0, 5)} columns={[
              { key: "created_at", label: "时间", render: (row) => formatDate(row.created_at) },
              { key: "type_label", label: "类型" },
              { key: "memo", label: "说明" },
              { key: "amount_cents", label: "金额", render: (row) => moneyCents(row.amount_cents) },
              { key: "balance_after_cents", label: "变动后余额", render: (row) => moneyCents(row.balance_after_cents) },
            ]} emptyText="暂无资金流水" />
          </Panel>
        </div>
      )}
      {tab === "ledger" && <Panel title="资金流水" eyebrow="LEDGER"><DataTable rows={ledger} columns={[
        { key: "created_at", label: "时间", render: (row) => formatDate(row.created_at) },
        { key: "type_label", label: "类型" }, { key: "memo", label: "说明" },
        { key: "amount_cents", label: "金额", render: (row) => moneyCents(row.amount_cents) },
        { key: "available_after_cents", label: "可用余额", render: (row) => moneyCents(row.available_after_cents) },
      ]} emptyText="暂无资金流水" /></Panel>}
      {tab === "topups" && <Panel title="平台充值记录" eyebrow="TOP UP HISTORY"><DataTable rows={topups} columns={[
        { key: "created_at", label: "提交时间", render: (row) => formatDate(row.created_at) },
        { key: "network", label: "网络" }, { key: "tx_hash", label: "交易哈希" },
        { key: "claimed_amount_cents", label: "申报金额", render: (row) => moneyCents(row.claimed_amount_cents) },
        { key: "credited_amount_cents", label: "到账金额", render: (row) => moneyCents(row.credited_amount_cents) },
        { key: "status", label: "状态", render: (row) => <span className="status-tag">{getString(row, "status")}</span> },
      ]} emptyText="暂无充值记录" /></Panel>}
    </>
  );
}

function BalanceCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <article className={`balance-card balance-${tone}`}><span>{label}</span><b>{value}</b></article>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="detail-row"><span>{label}</span><b>{value}</b></div>;
}

export function dollarsToCents(text: string): number | undefined {
  const match = text.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return undefined;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const value = whole * 100 + fraction;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

