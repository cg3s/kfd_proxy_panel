# 卡付达 API 完整集成开发计划

## 1. 目标与边界

基于 [卡付达开放 API 文档](https://kafuda.com/docs/api) 建设共享单商户服务端网关和多用户销售平台：Express 服务端保管唯一的 Kafuda API Key，并为本站用户提供邮箱注册、人民币钱包、易支付充值、按后台固定价购买直充订单和 CDK。每个用户拥有独立登录会话、余额账本、订单和卡密；用户端不直接访问共享 Kafuda 商户账户。数据库使用 SQLite，默认文件位于项目目录 `db/kafuda.sqlite`，可通过 `DATABASE_PATH` 调整。

此服务**调用** `https://kafuda.com`，不实现或修改卡付达平台本身。API Key、回调地址和签名密钥等控制台专属配置仍需在 Kafuda 网页控制台完成。根路径 `/` 和 `/shop` 均进入用户中心，原有运维控制台位于 `/admin`。充值采用常见易支付 V1 `submit.php`、MD5 签名和服务端异步通知；不同服务商若修改了字段或签名算法，需按该实例文档适配。

## 2. 功能范围与接口清单

### 2.1 通用调用能力

- 固定上游地址为 `https://kafuda.com`，认证头由服务端注入；不得接受客户端传入/覆盖上游 API Key。
- 透传 Kafuda 的成功/错误 HTTP 状态码、JSON 或 CSV 响应及限流/幂等相关响应头。
- 保留查询参数；限制代理路径和 HTTP 方法为文档列出的接口。
- 写操作校验 `Idempotency-Key`：长度 1–80，只允许字母、数字及 `._:-`。预检/报价例外；超时重试必须复用原键。
- 保持金额最小单位和 UTC ISO 8601 时间原样传递；不在网关中进行金额换算。
- 上游请求超时、网络不可用时返回明确的 504/502 错误；不自动重试写操作。

### 2.2 账户、充值、卡片

| 模块 | 实现接口 |
|---|---|
| 账户及流水 | `GET /account`、`GET /ledger` |
| 平台充值 | `GET /topups/instructions`、`POST /topups`、`GET /topups` |
| 卡产品及卡列表 | `GET /card-products`、`GET /cards`、`GET /cards/counts`、`POST /cards` |
| 单卡查询与账务 | `GET /cards/{id}`、`POST /cards/{id}/sync`、`GET /cards/{id}/statement`、`GET /cards/{id}/transactions`、`GET /card-transactions` |
| 敏感卡数据 | `GET /cards/{id}/sensitive`；要求上游密钥具备 `cards:sensitive` scope，且 Kafuda IP 白名单包含部署出口 IP |
| 卡管理和资金操作 | `POST /cards/{id}/recharge`、`POST /cards/{id}/refund`、`POST /cards/{id}/freeze`、`POST /cards/{id}/unfreeze`、`DELETE /cards/{id}`、`PUT /cards/{id}/auto-topup`、`POST /cards/{id}/remark`、`POST /cards/bulk` |

### 2.3 ChatGPT、Claude、Grok 及订单

| 模块 | 实现接口 |
|---|---|
| ChatGPT 目录及报价 | `GET /gpt/catalog`、`POST /gpt/check`、`POST /gpt/quotes` |
| 直充产品 | `GET /direct/products`、`GET /direct/{product}/catalog`、`POST /direct/check` |
| 下单及订单管理 | `POST /gpt/orders`、`GET /gpt/orders`、`GET /gpt/orders/{id}`、`POST /gpt/orders/{id}/refresh`、`POST /gpt/orders/{id}/cancel`、`GET /gpt/orders/stats` |

Session 凭据只在请求期间转发，不记录到应用日志或数据库。订单操作采用异步状态语义：调用方应根据回调或订单查询处理 `processing`、`completed`、`failed`、`cancelled` 和 `needs_review`，不得对不确定结果重复创建订单。

### 2.4 CDK

- 发码与管理：`GET /cdk/price`、`POST /cdk/batches`、`GET /cdk/batches`、`GET /cdk/batches/{id}/export`、`GET /cdk/codes`、`GET /cdk/summary`、`POST /cdk/codes/disable`、`POST /cdk/codes/enable`、`GET /cdk/settings`、`PUT /cdk/settings`。
- 代客兑换：`POST /cdk/redeem/preview`、`POST /cdk/redeem/check`、`POST /cdk/redeem/redeem`、`GET /cdk/redeem/status`。
- 下游兑换调用方必须遵循 preview → check → 用户确认 → redeem → status 流程；Session 和完整兑换码均不得写日志。
- 本地服务不开放无需认证的公开兑换代理。若将来要允许浏览器跨域兑换，需另行设计域名白名单、买家 IP 限流和防滥用机制。

### 2.5 Webhook

- 接收 `POST /webhooks/kafuda`，基于**原始请求体**校验 `X-VCard-Signature` 的 HMAC-SHA256；使用常量时间比较并拒绝时间戳偏差超过 5 分钟的请求。
- 支持文档列出的订单、CDK、卡片、充值及余额事件；按事件 `id` 在 SQLite 唯一约束去重，重复投递仍返回 2xx。
- 将已验签事件写入 `webhook_events` 收件箱表。写库失败返回 5xx，允许 Kafuda 按策略重试。
- 事件业务处理器及业务系统订单状态映射作为下一阶段扩展；此阶段保证可靠接收和持久化。

### 2.6 网页管理端与用户中心

- React + Vite 单页应用，由现有 Express 服务在构建后提供静态资源；开发模式分别运行 API（3000）和网页（5173），Vite 代理 API 请求。
- `/admin` 运维端包括账户总览、账户/充值、虚拟卡、直充订单、CDK 批次、Webhook 收件箱、高级 API 请求器（覆盖 49 个 Kafuda API 路由）及多用户运营页；运营可查看用户、启停账号、进行有审计记录的余额调整，并从对应产品套餐下拉列表配置固定售价，对价格项执行上架、下架或删除。
- `/` 和 `/shop` 用户端包括注册/邮箱验证/登录、CNY 充值、直充检查与下单、CDK 购买、订单/钱包流水和所属卡密查看。用户只能访问自己的充值、账本、订单和 CDK 数据，Session 只在本次检查请求内存活。
- 使用 `DASHBOARD_PASSWORD` 登录，服务端签发 8 小时 HttpOnly、SameSite=Strict 会话 Cookie；密码错误按来源 IP 限流。浏览器不接触 Kafuda API Key、网关 Bearer Token 或 Webhook Secret。
- 用户使用独立的邮箱/密码和服务端存储的随机会话；用户写操作使用幂等键。卡密只返回给购买用户及运维端，不进入 URL/localStorage。
- 敏感卡数据需额外显示权限/IP 白名单提醒。Webhook 页面仅展示最近 100 条已验签事件。

## 3. 安全、可靠性与数据规范

1. `KAFUDA_API_KEY`、`GATEWAY_API_TOKEN`、`KAFUDA_WEBHOOK_SECRET`、`DASHBOARD_PASSWORD` 和数据库路径仅从环境变量读取；禁止提交密钥。
2. 所有 `/api/v1/*` 路由要求有效的本地 Bearer Token 或已认证的 HttpOnly 网页会话。局域网部署必须在可信网络使用；建议 HTTPS 反向代理并设置 `COOKIE_SECURE=true`。仅可信本机/隔离网络开发可用 HTTP 和 `COOKIE_SECURE=false`。
3. 代理只允许文档接口，不可由调用者指定上游 URL，避免开放代理/SSRF。
4. 只记录路径、状态码和超时等运维信息；不记录 Authorization、Webhook 签名、Session、完整卡号/CVV、兑换码或请求体。
5. 请求体限制：API JSON 1 MiB，Webhook 256 KiB；上游连接超时 60 秒。
6. 金额以整数最小单位处理；禁止浮点运算；上游错误体保持原样返回，便于调用方按 `error.code` 分支。
7. 监控数据库文件可用性、上游超时/错误、Webhook 验签失败及重复投递；`webhook_events` 应制定保留与清理策略。
8. 用户钱包和售价使用整数人民币分；支付异步通知必须校验 MD5 签名、商户号、支付状态、本站订单号、支付方式和精确金额，且使用事务/唯一幂等键入账。浏览器支付返回页不参与入账。
9. 直充和 CDK 先在 SQLite 事务中扣款，再以本站订单 ID 作为 Kafuda 幂等键调用共享商户账户；明确失败才退款，不确定结果保留扣款并标记 `needs_review`，允许用相同幂等键重试/核对。
10. 注册验证码为 6 位、10 分钟有效、最多 5 次验证；SMTP 配置缺失时注册邮件发送明确失败。用户会话只存 SHA-256 摘要，Cookie 为 HttpOnly、SameSite=Strict，并按配置启用 Secure。

## 4. 开发阶段与交付

| 阶段 | 主要工作 | 完成标准 |
|---|---|---|
| 1. 工程基线 | TypeScript、Express、配置校验、SQLite（`db/kafuda.sqlite`）、迁移脚本、健康检查 | 可构建启动；缺少密钥配置时明确失败 |
| 2. 认证及代理核心 | 本地鉴权、固定上游、路由白名单、查询参数/请求体透传、幂等键验证、错误和限流头透传 | 未授权访问被拒；文档路径可转发；未知路由被拒 |
| 3. 全量 API 覆盖 | 按第 2 节账户/充值、卡片、直充/订单、CDK 接口矩阵接入 | 49 个文档方法/路径全部可匹配；上下游响应保持兼容 |
| 4. Webhook 收件箱 | 原始体验签、防重放、事件结构校验、SQLite 唯一键去重和可靠应答 | 正确事件入库；错误签名拒绝；重复事件不重复入库 |
| 5. 网页管理端 | React + Vite、运维密码登录、客户中心、数据概览、API 可视化请求器、Webhook 收件箱 | 运维与客户页面可访问；登录限流；写操作按需幂等；密钥不暴露给浏览器 |
| 6. 多用户及账务 | 邮箱验证、独立用户会话、钱包/账本、固定价快照、充值订单、用户订单及 CDK 归属 | 隔离测试通过；余额扣款/退款事务化；用户无法访问他人数据 |
| 7. 易支付联调 | 标准 V1 收银台 URL、MD5 验签、商户/金额/状态校验、回调幂等入账 | 错签、错金额和重复回调不入错账；服务商沙箱支付回调通过 |
| 8. 验证及上线 | 单元/集成测试、SMTP/支付配置、密钥和 IP 白名单、HTTPS/回调重试演练 | 构建和测试通过；沙箱/低风险账户端到端验收通过 |

## 5. 测试与验收清单

- 构建、单测通过；路由清单覆盖 49 个文档方法/路径。
- 未授权/错误本地 Token 返回 401；未登记路由返回 404；超长/非法幂等键在本地被拒。
- 正常 JSON、上游业务错误、限流响应头及 CDK CSV 导出均可透传。
- Webhook 原始体签名正确时写库；改动任意字节、签名缺失、时间戳过期或结构错误时拒绝。
- 同一 Webhook `id` 重放仅存一条记录，返回成功以停止无意义重试。
- 同一易支付回调重复到达只入账一次；金额、商户号、支付方式或签名不匹配时不入账。
- 用户不能读取其他用户的报价、充值、订单、钱包流水或 CDK；失败退款和重复上游事件均不得造成二次入账。
- Session/API Key/回调密钥/卡号/CVV/CDK 完整码不出现在日志中。
- 未登录网页不能调用代理及 Webhook 列表；登录使用 HttpOnly、SameSite=Strict Cookie；错误密码触发限流。
- 浏览器写请求弹出确认；用户取消时上游不应收到请求。
- React 前端构建产物由 Express 提供，开发环境的 Vite 代理可连接本地 API。
- 生产配置中确认 API Key 具备所需最小 scope；敏感卡接口配置 IP 白名单；设置 HTTPS 回调 URL。

## 6. 需在联调前由运营方提供

- 卡付达 API Key（按最小权限创建；如需读取完整卡号，配置 `cards:sensitive` 和出口 IP 白名单）。
- Webhook 签名密钥及部署后的公网 HTTPS 回调地址。
- 数据文件路径、部署方式、HTTPS/网络边界和日志保留周期。
- 用于验收的低风险测试账号、虚拟卡及 CDK；先验证只读/预检，再验证资金写操作。

## 7. 本次实现状态

当前实现包含 49 个文档接口的白名单转发、单一共享 Kafuda 商户上游、独立客户邮箱注册/会话、整数分钱包账本、常见易支付 V1 收款通知验签及幂等入账、固定售价、用户直充/CDK 购买、用户数据隔离、失败退款/待核验状态，以及运维控制台和 `/shop` 用户网页。执行 `npm install` 后运行 `npm test`、`npm run build`；`npm run db:migrate` 会在 `db/kafuda.sqlite` 初始化全部迁移，服务启动时也会自动应用幂等迁移。

### 本地运行

1. 在 `.env` 配置原有 Kafuda/运维密钥；邮件注册另需 `SMTP_HOST`、`SMTP_PORT`、`SMTP_FROM`（需要认证时设置 `SMTP_USER`、`SMTP_PASSWORD`）。局域网调试设 `HOST=0.0.0.0`、`COOKIE_SECURE=false`。
2. 真实充值需配置易支付实例的 `EPAY_BASE_URL`、`EPAY_PID`、`EPAY_KEY`、`EPAY_TYPE` 及公网 `PUBLIC_BASE_URL`。通知地址是 `${PUBLIC_BASE_URL}/payments/epay/notify`；如果支付服务商提供沙箱，应将沙箱接口地址及商户凭据配置在本地环境变量中。不要把密钥填入网页或提交到版本库。
3. 需要允许用户购买 CDK 时，设置 `CDK_FUNDING_CAP_CENTS` 为 Kafuda 批次请求使用的上游资金上限；需由运营按 Kafuda 成本确定，并保证固定售价覆盖相关成本。
4. 执行 `npm run db:migrate`，然后执行 `npm run dev`。本机用户入口为 `http://localhost:5173` 或 `http://localhost:5173/shop`，运维后台为 `http://localhost:5173/admin`。Vite 代理会将用户、支付和管理 API 请求转发至 Express（3000 端口）。
5. 生产构建使用 `npm run build` 和 `npm start`，网页由 Express 提供。反向代理需转发 `/payments/epay/notify` 和 `/webhooks/kafuda`；公网部署使用 HTTPS 并设置 `COOKIE_SECURE=true`。

真实 Kafuda 联调仍需配置有效密钥和控制台回调。HTTP 会以明文传输登录密码，仅在可信本机/隔离网络使用；局域网正式使用请部署 HTTPS 反向代理并设置 `COOKIE_SECURE=true`。

多用户账务和 Epay 回调目前通过本地自动化测试验证；未使用真实易支付商户、SMTP 服务或 Kafuda 商户账户做端到端交易。上线前应先用服务商沙箱验证签名字段、回调方式及 Kafuda 低风险订单流程。
