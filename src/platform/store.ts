import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface PortalUser {
  id: number;
  email: string;
  status: "active" | "disabled";
}

export interface PriceEntry {
  id: number;
  product: string;
  plan: string;
  country: string;
  price_fen: number;
  enabled: number;
}

export interface CustomerQuote {
  quote_id: string;
  user_id: number;
  product: string;
  plan: string;
  country: string;
  price_fen: number;
  expires_at: string;
  used_at: string | null;
}

export class PlatformStore {
  constructor(private readonly db: Database.Database) {}

  createPendingRegistration(email: string, passwordHash: string, codeHash: string, expiresAt: number): void {
    this.db.prepare("DELETE FROM pending_registrations WHERE expires_at <= ?").run(Date.now());
    this.db.prepare(
      `INSERT INTO pending_registrations (email, password_hash, code_hash, expires_at, attempts)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash,
         code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
         created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(email, passwordHash, codeHash, expiresAt);
  }

  deletePendingRegistration(email: string): void {
    this.db.prepare("DELETE FROM pending_registrations WHERE email = ?").run(email);
  }

  getPendingRegistration(email: string) {
    return this.db.prepare(
      "SELECT email, password_hash, code_hash, expires_at, attempts FROM pending_registrations WHERE email = ?",
    ).get(email) as {
      email: string;
      password_hash: string;
      code_hash: string;
      expires_at: number;
      attempts: number;
    } | undefined;
  }

  incrementPendingAttempts(email: string): void {
    this.db.prepare("UPDATE pending_registrations SET attempts = attempts + 1 WHERE email = ?").run(email);
  }

  completeRegistration(email: string, now: number): number | undefined {
    const transaction = this.db.transaction(() => {
      const pending = this.db.prepare(
        "SELECT password_hash, expires_at FROM pending_registrations WHERE email = ?",
      ).get(email) as { password_hash: string; expires_at: number } | undefined;
      if (!pending || pending.expires_at <= now) return undefined;
      const result = this.db.prepare(
        `INSERT INTO users (email, password_hash, verified_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(email) DO NOTHING`,
      ).run(email, pending.password_hash);
      this.db.prepare("DELETE FROM pending_registrations WHERE email = ?").run(email);
      if (result.changes === 0) return undefined;
      const userId = Number(result.lastInsertRowid);
      this.db.prepare("INSERT INTO wallets (user_id) VALUES (?)").run(userId);
      return userId;
    });
    return transaction();
  }

  findUserByEmail(email: string) {
    return this.db.prepare(
      "SELECT id, email, password_hash, status FROM users WHERE email = ?",
    ).get(email) as (PortalUser & { password_hash: string }) | undefined;
  }

  createSession(token: string, userId: number, expiresAt: number): void {
    this.db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").run(Date.now());
    this.db.prepare("INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(hashToken(token), userId, expiresAt);
  }

  getSessionUser(token: string, now: number): PortalUser | undefined {
    return this.db.prepare(
      `SELECT users.id, users.email, users.status
       FROM user_sessions JOIN users ON users.id = user_sessions.user_id
       WHERE user_sessions.token_hash = ? AND user_sessions.expires_at > ? AND users.status = 'active'`,
    ).get(hashToken(token), now) as PortalUser | undefined;
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(hashToken(token));
  }

  getWallet(userId: number): { balance_fen: number } {
    const wallet = this.db.prepare("SELECT balance_fen FROM wallets WHERE user_id = ?").get(userId) as
      { balance_fen: number } | undefined;
    if (!wallet) throw new Error("Wallet is missing for user");
    return wallet;
  }

  listLedger(userId: number, limit = 50) {
    return this.db.prepare(
      `SELECT amount_fen, balance_after_fen, entry_type, reference, memo, created_at
       FROM wallet_ledger WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(userId, limit);
  }

  getSellPrice(product: string, plan: string, country: string): number | undefined {
    const row = this.db.prepare(
      `SELECT price_fen FROM price_catalog
       WHERE product = ? AND plan = ? AND country IN (?, 'AUTO') AND enabled = 1
       ORDER BY CASE WHEN country = ? THEN 0 ELSE 1 END LIMIT 1`,
    ).get(product, plan, country, country) as { price_fen: number } | undefined;
    return row?.price_fen;
  }

  createTopup(id: string, userId: number, amountFen: number, paymentType: string, idempotencyKey: string): string {
    const transaction = this.db.transaction(() => {
      const requestHash = hashRequest({ amountFen, paymentType });
      const existing = this.db.prepare(
        `SELECT operation, request_hash, resource_id FROM portal_idempotency
         WHERE user_id = ? AND idempotency_key = ?`,
      ).get(userId, idempotencyKey) as
        { operation: string; request_hash: string; resource_id: string } | undefined;
      if (existing) {
        if (existing.operation !== "topup" || existing.request_hash !== requestHash) {
          throw new PlatformError("idempotency_conflict", "幂等键已用于不同请求");
        }
        return existing.resource_id;
      }
      this.db.prepare(
        "INSERT INTO topup_orders (id, user_id, amount_fen, payment_type) VALUES (?, ?, ?, ?)",
      ).run(id, userId, amountFen, paymentType);
      this.db.prepare(
        `INSERT INTO portal_idempotency (user_id, idempotency_key, operation, request_hash, resource_id)
         VALUES (?, ?, 'topup', ?, ?)`,
      ).run(userId, idempotencyKey, requestHash, id);
      return id;
    });
    return transaction();
  }

  getTopup(id: string) {
    return this.db.prepare(
      `SELECT id, user_id, amount_fen, status, payment_type, gateway_trade_no, created_at, paid_at
       FROM topup_orders WHERE id = ?`,
    ).get(id) as {
      id: string;
      user_id: number;
      amount_fen: number;
      status: string;
      payment_type: string;
      gateway_trade_no: string | null;
      created_at: string;
      paid_at: string | null;
    } | undefined;
  }

  creditTopup(id: string, gatewayTradeNo: string): boolean {
    const transaction = this.db.transaction(() => {
      const order = this.db.prepare(
        "SELECT user_id, amount_fen, status FROM topup_orders WHERE id = ?",
      ).get(id) as { user_id: number; amount_fen: number; status: string } | undefined;
      if (!order || order.status !== "pending") return false;
      const wallet = this.getWallet(order.user_id);
      const balance = checkedAdd(wallet.balance_fen, order.amount_fen);
      this.db.prepare(
        `UPDATE wallets SET balance_fen = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ?`,
      ).run(balance, order.user_id);
      this.db.prepare(
        `INSERT INTO wallet_ledger
         (user_id, amount_fen, balance_after_fen, entry_type, reference, idempotency_key, memo)
         VALUES (?, ?, ?, 'topup', ?, ?, '在线充值')`,
      ).run(order.user_id, order.amount_fen, balance, id, `topup:${id}`);
      this.db.prepare(
        `UPDATE topup_orders SET status = 'paid', gateway_trade_no = ?,
         paid_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND status = 'pending'`,
      ).run(gatewayTradeNo, id);
      return true;
    });
    return transaction();
  }

  listTopups(userId?: number) {
    if (userId === undefined) {
      return this.db.prepare(
        `SELECT topup_orders.id, users.email, topup_orders.amount_fen, topup_orders.status,
          topup_orders.payment_type, topup_orders.gateway_trade_no, topup_orders.created_at, topup_orders.paid_at
         FROM topup_orders JOIN users ON users.id = topup_orders.user_id
         ORDER BY topup_orders.created_at DESC LIMIT 200`,
      ).all();
    }
    return this.db.prepare(
      `SELECT id, amount_fen, status, payment_type, created_at, paid_at
       FROM topup_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).all(userId);
  }

  listPrices(enabledOnly = false): PriceEntry[] {
    const filter = enabledOnly ? "WHERE enabled = 1" : "";
    return this.db.prepare(
      `SELECT id, product, plan, country, price_fen, enabled FROM price_catalog ${filter}
       ORDER BY product, plan, country`,
    ).all() as PriceEntry[];
  }

  upsertPrice(product: string, plan: string, country: string, priceFen: number, enabled: boolean): void {
    this.db.prepare(
      `INSERT INTO price_catalog (product, plan, country, price_fen, enabled)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(product, plan, country) DO UPDATE SET
         price_fen = excluded.price_fen, enabled = excluded.enabled,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(product, plan, country, priceFen, enabled ? 1 : 0);
  }

  deletePrice(id: number): boolean {
    return this.db.prepare("DELETE FROM price_catalog WHERE id = ?").run(id).changes > 0;
  }

  saveQuote(quote: CustomerQuote): void {
    this.db.prepare(
      `INSERT INTO customer_quotes
       (quote_id, user_id, product, plan, country, price_fen, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(quote_id) DO NOTHING`,
    ).run(
      quote.quote_id, quote.user_id, quote.product, quote.plan, quote.country,
      quote.price_fen, quote.expires_at,
    );
  }

  getQuote(quoteId: string, userId: number): CustomerQuote | undefined {
    return this.db.prepare(
      `SELECT quote_id, user_id, product, plan, country, price_fen, expires_at, used_at
       FROM customer_quotes WHERE quote_id = ? AND user_id = ?`,
    ).get(quoteId, userId) as CustomerQuote | undefined;
  }

  createCustomerOrder(
    id: string,
    quoteId: string,
    userId: number,
    reference: string | null,
    idempotencyKey: string,
  ): { quote: CustomerQuote; id: string } {
    const transaction = this.db.transaction(() => {
      const requestHash = hashRequest({ quoteId, reference });
      const existingRequest = this.db.prepare(
        `SELECT operation, request_hash, resource_id FROM portal_idempotency
         WHERE user_id = ? AND idempotency_key = ?`,
      ).get(userId, idempotencyKey) as
        { operation: string; request_hash: string; resource_id: string } | undefined;
      if (existingRequest) {
        if (existingRequest.operation !== "order" || existingRequest.request_hash !== requestHash) {
          throw new PlatformError("idempotency_conflict", "幂等键已用于不同请求");
        }
        const quote = this.getQuote(quoteId, userId);
        const order = this.getCustomerOrder(existingRequest.resource_id, userId);
        if (!quote || !order) throw new PlatformError("order_not_found", "订单不存在");
        return { quote, id: existingRequest.resource_id };
      }
      const quote = this.getQuote(quoteId, userId);
      if (!quote || quote.used_at || Date.parse(quote.expires_at) <= Date.now()) {
        throw new PlatformError("quote_expired", "报价不存在、已使用或已过期");
      }
      const wallet = this.getWallet(userId);
      if (wallet.balance_fen < quote.price_fen) {
        throw new PlatformError("insufficient_balance", "余额不足，请先充值");
      }
      const balance = wallet.balance_fen - quote.price_fen;
      this.db.prepare(
        `UPDATE wallets SET balance_fen = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ?`,
      ).run(balance, userId);
      this.db.prepare(
        `INSERT INTO wallet_ledger
         (user_id, amount_fen, balance_after_fen, entry_type, reference, idempotency_key, memo)
         VALUES (?, ?, ?, 'order_charge', ?, ?, ?)`,
      ).run(userId, -quote.price_fen, balance, id, `order:${id}:charge`, `直充订单 ${id}`);
      this.db.prepare(
        `INSERT INTO customer_orders
         (id, user_id, quote_id, product, plan, country, price_fen, reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, quoteId, quote.product, quote.plan, quote.country, quote.price_fen, reference);
      this.db.prepare(
        `UPDATE customer_quotes SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE quote_id = ? AND used_at IS NULL`,
      ).run(quoteId);
      this.db.prepare(
        `INSERT INTO portal_idempotency (user_id, idempotency_key, operation, request_hash, resource_id)
         VALUES (?, ?, 'order', ?, ?)`,
      ).run(userId, idempotencyKey, requestHash, id);
      return { quote, id };
    });
    return transaction();
  }

  attachUpstreamOrder(id: string, upstreamOrderId: string, status: string): void {
    this.db.prepare(
      `UPDATE customer_orders SET upstream_order_id = ?, status = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
    ).run(upstreamOrderId, status, id);
  }

  refundUnsubmittedOrder(id: string, message: string): void {
    const transaction = this.db.transaction(() => {
      const order = this.db.prepare(
        "SELECT user_id, price_fen, charge_status FROM customer_orders WHERE id = ?",
      ).get(id) as { user_id: number; price_fen: number; charge_status: string } | undefined;
      if (!order || order.charge_status !== "charged") return;
      const wallet = this.getWallet(order.user_id);
      const balance = checkedAdd(wallet.balance_fen, order.price_fen);
      this.db.prepare(
        `UPDATE wallets SET balance_fen = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ?`,
      ).run(balance, order.user_id);
      this.db.prepare(
        `INSERT INTO wallet_ledger
         (user_id, amount_fen, balance_after_fen, entry_type, reference, idempotency_key, memo)
         VALUES (?, ?, ?, 'order_refund', ?, ?, ?)`,
      ).run(order.user_id, order.price_fen, balance, id, `order:${id}:refund`, `直充提交失败退款 ${id}`);
      this.db.prepare(
        `UPDATE customer_orders SET status = 'failed', charge_status = 'refunded', error_message = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      ).run(message.slice(0, 500), id);
    });
    transaction();
  }

  getCustomerOrder(id: string, userId?: number) {
    const userCondition = userId === undefined ? "" : "AND user_id = ?";
    const params = userId === undefined ? [id] : [id, userId];
    return this.db.prepare(
      `SELECT id, user_id, quote_id, upstream_order_id, product, plan, country, price_fen,
        status, charge_status, reference, error_message, created_at
       FROM customer_orders WHERE id = ? ${userCondition}`,
    ).get(...params) as {
      id: string;
      user_id: number;
      quote_id: string;
      upstream_order_id: string | null;
      product: string;
      plan: string;
      country: string;
      price_fen: number;
      status: string;
      charge_status: string;
      reference: string | null;
      error_message: string | null;
      created_at: string;
    } | undefined;
  }

  markOrderForReview(id: string, message: string): void {
    this.db.prepare(
      `UPDATE customer_orders SET status = 'needs_review', error_message = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND charge_status = 'charged' AND status NOT IN ('completed', 'failed', 'cancelled', 'canceled')`,
    ).run(message.slice(0, 500), id);
  }

  settleOrderFromWebhook(upstreamOrderId: string, status: string, errorMessage?: string): boolean {
    const transaction = this.db.transaction(() => {
      const order = this.db.prepare(
        "SELECT id, user_id, price_fen, charge_status FROM customer_orders WHERE upstream_order_id = ?",
      ).get(upstreamOrderId) as {
        id: string; user_id: number; price_fen: number; charge_status: string;
      } | undefined;
      if (!order) return false;
      const normalizedStatus = status.toLowerCase();
      const succeeded = ["completed", "succeeded", "success", "paid"].includes(normalizedStatus);
      const failed = ["failed", "cancelled", "canceled", "refunded"].includes(normalizedStatus);
      if (!succeeded && !failed) {
        if (order.charge_status !== "charged") return true;
        this.db.prepare(
          `UPDATE customer_orders SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        ).run(status, order.id);
        return true;
      }
      if ((succeeded && order.charge_status === "refunded") ||
          (failed && order.charge_status === "settled")) {
        this.db.prepare(
          `UPDATE customer_orders SET status = 'needs_review', error_message = 'Conflicting terminal order updates',
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        ).run(order.id);
        return true;
      }
      if (failed && order.charge_status === "charged") {
        const wallet = this.getWallet(order.user_id);
        const balance = checkedAdd(wallet.balance_fen, order.price_fen);
        this.db.prepare(
          `UPDATE wallets SET balance_fen = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE user_id = ?`,
        ).run(balance, order.user_id);
        this.db.prepare(
          `INSERT INTO wallet_ledger
           (user_id, amount_fen, balance_after_fen, entry_type, reference, idempotency_key, memo)
           VALUES (?, ?, ?, 'order_refund', ?, ?, ?)`,
        ).run(order.user_id, order.price_fen, balance, order.id, `order:${order.id}:refund`, `直充失败退款 ${order.id}`);
        this.db.prepare("UPDATE customer_orders SET charge_status = 'refunded' WHERE id = ?").run(order.id);
      } else if (succeeded && order.charge_status === "charged") {
        this.db.prepare("UPDATE customer_orders SET charge_status = 'settled' WHERE id = ?").run(order.id);
      }
      this.db.prepare(
        `UPDATE customer_orders SET status = ?, error_message = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      ).run(status, failed ? (errorMessage ?? "上游订单失败") : null, order.id);
      return true;
    });
    return transaction();
  }

  resolveCustomerOrder(id: string, action: "refund" | "settle", memo: string): void {
    const transaction = this.db.transaction(() => {
      const order = this.db.prepare(
        `SELECT user_id, price_fen, status, charge_status
         FROM customer_orders WHERE id = ?`,
      ).get(id) as { user_id: number; price_fen: number; status: string; charge_status: string } | undefined;
      if (!order) throw new PlatformError("order_not_found", "订单不存在");
      if (order.status !== "needs_review" || order.charge_status !== "charged") {
        throw new PlatformError("order_not_reviewable", "只有待核验且未结算的订单可人工处理");
      }
      if (action === "refund") {
        const wallet = this.getWallet(order.user_id);
        const balance = checkedAdd(wallet.balance_fen, order.price_fen);
        this.db.prepare(
          `UPDATE wallets SET balance_fen = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE user_id = ?`,
        ).run(balance, order.user_id);
        this.db.prepare(
          `INSERT INTO wallet_ledger
           (user_id, amount_fen, balance_after_fen, entry_type, reference, idempotency_key, memo)
           VALUES (?, ?, ?, 'order_refund', ?, ?, ?)`,
        ).run(order.user_id, order.price_fen, balance, id, `order:${id}:refund`, `人工退款：${memo.slice(0, 160)}`);
        this.db.prepare(
          `UPDATE customer_orders SET status = 'failed', charge_status = 'refunded', error_message = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        ).run(`人工退款：${memo.slice(0, 300)}`, id);
      } else {
        this.db.prepare(
          `UPDATE customer_orders SET status = 'completed', charge_status = 'settled', error_message = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
        ).run(`人工确认成功：${memo.slice(0, 300)}`, id);
      }
    });
    transaction();
  }

  listCustomerOrders(userId?: number) {
    if (userId === undefined) {
      return this.db.prepare(
        `SELECT customer_orders.id, users.email, customer_orders.product, customer_orders.plan,
          customer_orders.country, customer_orders.price_fen, customer_orders.status,
          customer_orders.charge_status, customer_orders.upstream_order_id, customer_orders.error_message,
          customer_orders.created_at
         FROM customer_orders JOIN users ON users.id = customer_orders.user_id
         ORDER BY customer_orders.created_at DESC LIMIT 200`,
      ).all();
    }
    return this.db.prepare(
      `SELECT id, product, plan, country, price_fen, status, charge_status,
          upstream_order_id, error_message, created_at
       FROM customer_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).all(userId);
  }

  createCdkPurchase(
    id: string,
    userId: number,
    plan: string,
    country: string,
    count: number,
    expiresDays: number,
    fundingCapCents: number,
    unitPriceFen: number,
    idempotencyKey: string,
  ): string {
    const transaction = this.db.transaction(() => {
      const requestHash = hashRequest({ plan, country, count, expiresDays, fundingCapCents });
      const existing = this.db.prepare(
        `SELECT operation, request_hash, resource_id FROM portal_idempotency
         WHERE user_id = ? AND idempotency_key = ?`,
      ).get(userId, idempotencyKey) as
        { operation: string; request_hash: string; resource_id: string } | undefined;
      if (existing) {
        if (existing.operation !== "cdk" || existing.request_hash !== requestHash) {
          throw new PlatformError("idempotency_conflict", "幂等键已用于不同请求");
        }
        return existing.resource_id;
      }
      const totalPriceFen = unitPriceFen * count;
      if (!Number.isSafeInteger(totalPriceFen)) {
        throw new PlatformError("invalid_amount", "订单金额超出范围");
      }
      const wallet = this.getWallet(userId);
      if (wallet.balance_fen < totalPriceFen) {
        throw new PlatformError("insufficient_balance", "余额不足，请先充值");
      }
      const balance = wallet.balance_fen - totalPriceFen;
      this.db.prepare(
        `UPDATE wallets SET balance_fen = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ?`,
      ).run(balance, userId);
      this.db.prepare(
        `INSERT INTO wallet_ledger
         (user_id, amount_fen, balance_after_fen, entry_type, reference, idempotency_key, memo)
         VALUES (?, ?, ?, 'cdk_charge', ?, ?, ?)`,
      ).run(userId, -totalPriceFen, balance, id, `cdk:${id}:charge`, `CDK 购买 ${count} 张`);
      this.db.prepare(
        `INSERT INTO cdk_purchases
         (id, user_id, plan, country, count, expires_days, funding_cap_cents, unit_price_fen, total_price_fen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, userId, plan, country, count, expiresDays, fundingCapCents, unitPriceFen, totalPriceFen);
      this.db.prepare(
        `INSERT INTO portal_idempotency (user_id, idempotency_key, operation, request_hash, resource_id)
         VALUES (?, ?, 'cdk', ?, ?)`,
      ).run(userId, idempotencyKey, requestHash, id);
      return id;
    });
    return transaction();
  }

  getCdkPurchase(id: string) {
    return this.db.prepare(
      `SELECT id, user_id, plan, country, count, expires_days, funding_cap_cents,
        unit_price_fen, total_price_fen, status, charge_status, error_message, created_at
       FROM cdk_purchases WHERE id = ?`,
    ).get(id) as {
      id: string;
      user_id: number;
      plan: string;
      country: string;
      count: number;
      expires_days: number;
      funding_cap_cents: number;
      unit_price_fen: number;
      total_price_fen: number;
      status: string;
      charge_status: string;
      error_message: string | null;
      created_at: string;
    } | undefined;
  }

  finishCdkPurchase(id: string, batchId: string, codes: Array<{ code: string; status?: string; expiresAt?: string }>): void {
    const transaction = this.db.transaction(() => {
      const purchase = this.db.prepare("SELECT status, charge_status FROM cdk_purchases WHERE id = ?").get(id) as
        { status: string; charge_status: string } | undefined;
      if (!purchase || purchase.charge_status !== "charged" || !["creating", "needs_review"].includes(purchase.status)) return;
      for (const item of codes) {
        this.db.prepare(
          `INSERT INTO user_cdk_codes (user_id, purchase_id, code, status, expires_at)
           SELECT user_id, ?, ?, ?, ? FROM cdk_purchases WHERE id = ?`,
        ).run(id, item.code, item.status ?? "unused", item.expiresAt ?? null, id);
      }
      this.db.prepare(
        `UPDATE cdk_purchases SET upstream_batch_id = ?, status = 'completed', charge_status = 'settled'
         WHERE id = ?`,
      ).run(batchId, id);
    });
    transaction();
  }

  refundCdkPurchase(id: string, message: string): void {
    const transaction = this.db.transaction(() => {
      const purchase = this.db.prepare(
        "SELECT user_id, total_price_fen, charge_status FROM cdk_purchases WHERE id = ?",
      ).get(id) as { user_id: number; total_price_fen: number; charge_status: string } | undefined;
      if (!purchase || purchase.charge_status !== "charged") return;
      const wallet = this.getWallet(purchase.user_id);
      const balance = checkedAdd(wallet.balance_fen, purchase.total_price_fen);
      this.db.prepare(
        `UPDATE wallets SET balance_fen = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ?`,
      ).run(balance, purchase.user_id);
      this.db.prepare(
        `INSERT INTO wallet_ledger
         (user_id, amount_fen, balance_after_fen, entry_type, reference, idempotency_key, memo)
         VALUES (?, ?, ?, 'cdk_refund', ?, ?, ?)`,
      ).run(
        purchase.user_id, purchase.total_price_fen, balance, id, `cdk:${id}:refund`, `CDK 购买失败退款 ${id}`,
      );
      this.db.prepare(
        `UPDATE cdk_purchases SET status = 'failed', charge_status = 'refunded', error_message = ?
         WHERE id = ?`,
      ).run(message.slice(0, 500), id);
    });
    transaction();
  }

  resolveCdkPurchase(id: string, action: "refund" | "settle", memo: string): void {
    const transaction = this.db.transaction(() => {
      const purchase = this.db.prepare(
        `SELECT user_id, total_price_fen, count, status, charge_status
         FROM cdk_purchases WHERE id = ?`,
      ).get(id) as {
        user_id: number; total_price_fen: number; count: number; status: string; charge_status: string;
      } | undefined;
      if (!purchase) throw new PlatformError("purchase_not_found", "CDK 购买订单不存在");
      if (purchase.status !== "needs_review" || purchase.charge_status !== "charged") {
        throw new PlatformError("purchase_not_reviewable", "只有待核验且未结算的购买可人工处理");
      }
      if (action === "settle") {
        const codeCount = this.db.prepare(
          "SELECT COUNT(*) AS count FROM user_cdk_codes WHERE purchase_id = ?",
        ).get(id) as { count: number };
        if (codeCount.count !== purchase.count) {
          throw new PlatformError("codes_incomplete", "卡密数量不匹配，不能确认结算");
        }
        this.db.prepare(
          `UPDATE cdk_purchases SET status = 'completed', charge_status = 'settled',
           error_message = ? WHERE id = ?`,
        ).run(`人工确认成功：${memo.slice(0, 300)}`, id);
        return;
      }
      const wallet = this.getWallet(purchase.user_id);
      const balance = checkedAdd(wallet.balance_fen, purchase.total_price_fen);
      this.db.prepare(
        `UPDATE wallets SET balance_fen = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ?`,
      ).run(balance, purchase.user_id);
      this.db.prepare(
        `INSERT INTO wallet_ledger
         (user_id, amount_fen, balance_after_fen, entry_type, reference, idempotency_key, memo)
         VALUES (?, ?, ?, 'cdk_refund', ?, ?, ?)`,
      ).run(
        purchase.user_id, purchase.total_price_fen, balance, id, `cdk:${id}:refund`, `人工退款：${memo.slice(0, 160)}`,
      );
      this.db.prepare(
        `UPDATE cdk_purchases SET status = 'failed', charge_status = 'refunded', error_message = ?
         WHERE id = ?`,
      ).run(`人工退款：${memo.slice(0, 300)}`, id);
    });
    transaction();
  }

  markCdkPurchaseForReview(id: string, message: string): void {
    this.db.prepare(
      `UPDATE cdk_purchases SET status = 'needs_review', error_message = ?
       WHERE id = ? AND charge_status = 'charged' AND status NOT IN ('completed', 'failed')`,
    )
      .run(message.slice(0, 500), id);
  }

  listCdkPurchases(userId?: number) {
    if (userId === undefined) {
      return this.db.prepare(
        `SELECT cdk_purchases.id, users.email, cdk_purchases.plan, cdk_purchases.country,
          cdk_purchases.count, cdk_purchases.total_price_fen, cdk_purchases.status,
          cdk_purchases.error_message, cdk_purchases.created_at
         FROM cdk_purchases JOIN users ON users.id = cdk_purchases.user_id
         ORDER BY cdk_purchases.created_at DESC LIMIT 200`,
      ).all();
    }
    return this.db.prepare(
      `SELECT id, plan, country, count, total_price_fen, status, error_message, created_at
       FROM cdk_purchases WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).all(userId);
  }

  listCdkCodes(userId: number) {
    return this.db.prepare(
      `SELECT id, purchase_id, code, status, expires_at, created_at
       FROM user_cdk_codes WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`,
    ).all(userId);
  }

  listCdkCodesForPurchase(purchaseId: string, userId: number) {
    return this.db.prepare(
      `SELECT user_cdk_codes.id, user_cdk_codes.purchase_id, user_cdk_codes.code,
        user_cdk_codes.status, user_cdk_codes.expires_at, user_cdk_codes.created_at
       FROM user_cdk_codes JOIN cdk_purchases ON cdk_purchases.id = user_cdk_codes.purchase_id
       WHERE user_cdk_codes.purchase_id = ? AND cdk_purchases.user_id = ?
       ORDER BY user_cdk_codes.id`,
    ).all(purchaseId, userId);
  }

  listUsers() {
    return this.db.prepare(
      `SELECT users.id, users.email, users.status, users.created_at, wallets.balance_fen
       FROM users JOIN wallets ON wallets.user_id = users.id ORDER BY users.created_at DESC LIMIT 500`,
    ).all();
  }

  setUserStatus(userId: number, status: "active" | "disabled"): boolean {
    const transaction = this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId).changes > 0;
      if (changed && status === "disabled") {
        this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(userId);
      }
      return changed;
    });
    return transaction();
  }

  adjustWallet(userId: number, amountFen: number, reference: string, memo: string): boolean {
    const transaction = this.db.transaction(() => {
      const wallet = this.db.prepare("SELECT balance_fen FROM wallets WHERE user_id = ?").get(userId) as
        { balance_fen: number } | undefined;
      if (!wallet) throw new PlatformError("user_not_found", "用户不存在");
      const balance = checkedAdd(wallet.balance_fen, amountFen);
      if (balance < 0) throw new PlatformError("insufficient_balance", "调整后余额不能小于零");
      this.db.prepare(
        `UPDATE wallets SET balance_fen = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE user_id = ?`,
      ).run(balance, userId);
      this.db.prepare(
        `INSERT INTO wallet_ledger
         (user_id, amount_fen, balance_after_fen, entry_type, reference, idempotency_key, memo)
         VALUES (?, ?, ?, 'admin_adjustment', ?, ?, ?)`,
      ).run(userId, amountFen, balance, reference, `admin:${reference}`, memo.slice(0, 200));
      return true;
    });
    return transaction();
  }
}

export class PlatformError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PlatformError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new PlatformError("balance_limit", "余额超出可安全记账的范围");
  }
  return result;
}
