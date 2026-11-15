# Botein

> 产品正式名称：**Botein**。本版由 SignalSniper 更名而来。

LANCCO / 多租户海外品牌智能开发工作台，产品规格见 [agent_prd.md](agent_prd.md)。支持本地 SQLite（`node:sqlite`）与 PostgreSQL 实时运行时（零第三方驱动依赖的纯 JS PG v3 协议客户端）双模式运行。

## 启动

需要 Node.js 22.13+（已在 22.23.2 验证），无第三方 JavaScript 运行时依赖、无前端构建步骤。

```bash
npm start
```

默认监听 **http://127.0.0.1:3187**（可通过 `HOST` / `PORT` / `.env` 配置）。首次设置可创建负责人账号，或开放多组织注册、成员邀请加入。修改代码时使用 `npm run dev`；若 `.env` 不存在，会先从 `.env.example` 生成本地配置（`.env` 已被 Git 忽略）。

自动发现需要本地搜索与模型：先运行 `docker compose up -d` 启动 SearXNG，并配置模型网关环境变量；详见“模型与搜索接入”。如需独立后台队列与定时监控进程，可运行 `npm run worker`。

默认 SQLite 数据库位于 `data/botein.sqlite`，启动时会自动完成 schema 迁移（当前 schema 版本 v17）。如需使用 PostgreSQL 实时运行时：

```bash
DB_DRIVER=postgres DATABASE_URL=postgres://user:pass@localhost:5432/botein npm start
# 从现有 SQLite 全量迁移到 PostgreSQL：
DB_DRIVER=postgres DATABASE_URL=postgres://user:pass@localhost:5432/botein npm run pg-migrate -- --from-sqlite ./data/botein.sqlite
```

## 多租户认证、RBAC 与安全部署

会话 Cookie 使用 `botein_session`：

- 支持本地负责人首次初始化（`POST /api/v1/auth/setup`）、多工作区注册（`POST /api/v1/auth/organizations/register`，受 `ALLOW_MULTI_ORG_REGISTER` 控制）、工作区成员邀请（`OWNER` / `MEMBER` RBAC 隔离）、成员启用/停用、密码重置令牌流程以及双因素认证（TOTP MFA）。
- 密码使用 Node scrypt（N=32768，r=8，p=1）和随机盐；Cookie 为随机 32 字节值，数据库只保存 SHA-256 会话摘要。Cookie 使用 `HttpOnly`、`SameSite=Strict`、`Path=/`，在 HTTPS 或反向代理（`TRUST_PROXY=1` + `X-Forwarded-Proto: https`）下自动附加 `Secure`。
- 支持按环境变量配置 `HOST` / `PORT`、`PUBLIC_BASE_URL` / `TRUSTED_HOSTS`、`CORS_ALLOWED_ORIGINS`、持久化限流表（`rate_limit_events`）与信封加密（`KMS_MASTER_KEY` / `CONNECTOR_ENCRYPTION_KEY`）。
- 支持有效会话管理（`GET /api/v1/auth/sessions`、`POST /revoke`、`POST /revoke-others`）及独立凭据版本号撤销。

## 已实现核心能力

- **账号与团队权限**：多工作区隔离、`OWNER` / `MEMBER` 权限隔离、成员邀请、TOTP 双因素认证与受控密码找回/重置。
- **工厂多规格档案**：支持多包装/配方阶梯生产条款（`production_terms`）、合规资质认证管理（`certifications` 及有效期检查）、禁用市场（`prohibited_markets`）、版本乐观锁与逐字段核验记录。
- **规则化硬约束匹配（Fit Engine）**：逐项检查品类、市场、起订量/单位/包装及认证匹配情况（`PASS / CONFLICT / UNKNOWN`），输出可解释匹配明细。
- **品牌池与产品 SKU**：手工录入、编辑、名称/域名搜索、同域名身份冲突待核对流程、多维 SKU 管理与变更历史。
- **证据与来源治理**：记录 `source_id`、`source_kind`、`availability_status`（可达性监测）与观察时间；支持安全解压（gzip/deflate/br）、多 IP 回退与可选 Headless Chrome DOM 渲染（`HEADLESS_RENDER=1`）；支持保留政策清除原文。
- **端到端研究工作流（Discovery & Pool）**：`DISCOVERY` 自动串联查询搜索、落地页聚合、SKU 识别、信号分析、规则预匹配、官网联系人发现与引用级草稿生成；支持 `embedded` / `external`（`npm run worker`）双执行模式、预算控制、租户并发锁、崩溃恢复与增量监控调度（`scheduled_monitors`）。
- **外部连接器与可观测性**：加密存储外接 B2B 联系人 / 电商 / 通知（邮件/Webhook）连接器配置（`connector_configs`）；落地 `ai_runs` 遥测看板统计 P50/P95 延迟、Token 用量、估算成本与引用校验拒绝率。
- **可配置市场与品类**：通过 `SUPPORTED_PRODUCT_CATEGORIES` 与 `SUPPORTED_MARKETS` 支持多品类与多区域扩展（详阅 [.env.example](.env.example)）。
- **销售执行、漏斗与工作台**：可追溯 Claim 划词引用草稿与跟进序列模板（`FIRST_TOUCH` / `SAMPLE_FOLLOWUP` / `MOQ_QUOTE`）、机会详情上/下一条快速审阅、受控禁联解除、UTF-8 表格安全导入导出，以及基于 SQLite 或 PostgreSQL 的双引擎持久化与备份校验。

## 使用边界说明

- `DISCOVERY` 自动发现仅面向公开网页与登记合规来源，不读取登录后页面、付费墙或绕过访问控制。
- AI 分析、联系人发现与 AI 草稿生成仅作辅助候选；合规发送仍保持**人工核对事实引用、人工最终批准及人工确认外部活动记录**的核心防幻觉边界。
- 品牌 CSV 导入最多支持单文件 500 条记录与同域名待复核隔离：

```csv
brand_name,website,headquarters_country,notes
Example Brand,https://example.com,,待核对产品和美国在售情况
```

## 联系人编辑与历史快照

- `GET /api/v1/contacts` 为本组织联系人目录；`GET/PATCH /api/v1/contacts/{id}` 查看/编辑和历史，`GET /api/v1/contact-suppressions` 只读查看禁止联系记录。
- 仅允许编辑姓名、职位、来源，必须提供版本与原因，变更后 STALE 并撤销相关草稿批准。邮箱和品牌归属固定，换邮箱或品牌需要新建联系人，旧渠道及禁止联系仍保留。当前不提供解除抑制操作。
- 新活动保存 `AT_RECORDING` 联系人快照；新草稿版本保存 `AT_DRAFT_CREATION` 快照。修改联系人不改变已有活动、旧草稿显示的姓名/邮箱。补录历史活动的快照是**录入时**资料，不自动证明实际发送时身份。
- v6 升级为旧活动/草稿补充 `MIGRATED_CURRENT_RECORD`，来自升级时的联系人资料，页面明确提示它不是历史核验。没有历史证据时不回填一个假定的当时姓名。
- 编辑联系人后，即便重新核验，也需编辑并产生新草稿版本，重新核对称呼和正文后审批。普通重新核验只改变核验版本而未改变身份内容时，可对同一内容重新审批，旧批准不会自动恢复。

## 品牌编辑和同域名身份核对

- 在品牌池点击品牌名称编辑，提交 `expected_version` 和原因。名称或官网变化视为身份变化，相关证据重回 UNVERIFIED（INVALIDATED 不恢复）、联系人变为 STALE、合格商机待重评、草稿批准失效；产品、原文与销售历史保留。只改备注/总部国家不触发核验撤销。
- 同名同域精确命中复用品牌；同域不同名产生持久化候选（手工 API 返回 202，CSV 行返回 NEEDS_REVIEW），按组织/规范化域名/品牌名去重。重复导入不覆盖第一次待核对的候选内容。新候选可以改正后重新录入，旧候选明确排除。
- 核对结论包括 DISTINCT（确认独立，新增品牌）、REUSE（确认是已有同域品牌，建立复用关系）、REJECT（排除此候选）。新增/复用须人工确认及说明；复用还校验目标版本，避免旧窗口确认已变化的身份。已有品牌字段、产品与历史不会被迁移或合并。
- 已处理候选可 REOPEN 返回待核对，历史不删除。排除记录再次导入仍跳过；复用关系随目标品牌版本绑定，目标资料修改后重新导入会要求再次核对，当前为保守版本判断。
- 品牌编辑不能撞上另一个同名同域记录；编辑后与其他品牌共域名时，要求显式确认独立性。跨域品牌合并、批量迁移和删除不属于当前功能。
- 接口：`GET/PATCH /api/v1/accounts/{id}`；`GET /api/v1/account-identity-reviews`；`POST /api/v1/account-identity-reviews/{id}/resolve`。固定本地负责人操作，不表示已具备生产 RBAC。

## 证据导入与业务资料导出

证据页提供空白模板和导入入口。先录入品牌，从品牌或产品导出文件获得准确 ID，不根据模糊品牌名猜测归属。必需表头：`account_id,source_url,raw_text,observed_at`；可选 `product_id,published_at`。

- `account_id` 必须属于当前工作空间；`product_id` 可空，否则须属于该品牌且未归档。`source_url` 内容可空，原文必填。
- `observed_at` 必填 UTC ISO 时间，例如 `2026-11-12T08:00:00Z`，不接受未来时间。`published_at` 未知可空，否则使用 `YYYY-MM-DD`。手工录入不传观察时间时仍记录当前时间。
- 每文件最多 500 条数据记录及 500,000 UTF-8 字节，支持 BOM、引号转义、引号内换行。结果行号为逻辑记录序号（包含表头），不是带多行原文的物理文件行号。
- `POST /api/v1/evidence/imports` 同步返回新增/跳过/失败及逐行原因。新证据始终 UNVERIFIED，额外核验状态字段忽略；重复证据保留现有核验/失效状态和原观察时间。归属冲突不创建第二条证据，应在原记录上修订。
- 成功行和业务失败行可共存；结构无效文件不写入，意外数据库错误回滚整次导入。页面刷新失败不丢失已显示的导入结果。当前不保存独立异步导入任务，也无 GET 导入任务接口；关闭页面后可重新导入得到去重结果。

`GET /api/v1/exports/{accounts|products|evidence|opportunities}` 返回带 UTF-8 BOM 的 CSV 附件，所有查询限定当前组织；全量导出不继承页面筛选，包括归档和失效状态，空集合也返回表头。不导出密钥、联系人清单、草稿或审计明细；不上传任何内容。

CSV 每个字段加引号并转义内部引号，公式前缀（含前导空白/控制字符）增加单引号作为文本。数据库原文不变。它是供表格复核的安全化导出，不是逐字备份；重新导入可能保留文本前缀，需核对原文，勿当作无损往返格式。每次导出请求记录类型和行数，不宣称文件已保存到用户磁盘。正式备份仍使用 SQLite backup。

## 品牌产品与证据归属

- 产品原始 URL 完整保存（含查询和片段），规范化 URL 仅用于同品牌去重；不删除查询参数，不从 SKU 猜测产品归属。相同品牌的同链接或同平台 SKU 冲突返回 409，资料完全相同才复用。SKU 大小写保留，所属平台做小写及空白规范化。
- SKU 和平台都可未知；填写 SKU 时要求平台。不同品牌的相同编号各自保存，API 拒绝跨品牌关联产品。现有产品不能直接转移品牌。
- ACTIVE 只是资料列表状态，不表示在售；洗碗块、其他或未知品类可作为范围外资料留存，不会扩展首发市场/品类。范围外或归档产品的证据不能用于审核洗衣凝珠机会。
- 新证据允许不填 product_id；一份原文不能因选择不同产品而重复计入。已有同来源/原文/发布时间但归属不同，需通过现有证据修订关联，保留原文与审计。
- 核心资料（名称、品类、链接、SKU、平台、包装、归档状态）变化或证据归属修订后，关联证据回到 UNVERIFIED，被证伪的 INVALIDATED 状态不恢复；相关合格机会待重评，已批准草稿阻断。仅修改内部备注不影响核验。
- 证据保存关联时产品版本，重新核验时记录当前版本；产品变更前后内容保留于审计。归档不删除产品、证据或销售活动，不能继续新增关联；恢复产品资料不自动恢复任何批准。

## 人工草稿与批准边界

- 在商机详情录入草稿，可先保存未审核候选的内容。审批必须满足商机 QUALIFIED、当前工厂 ACTIVE、联系人 VERIFIED 且未被抑制，并有有效的资格依据。
- `POST /api/v1/opportunities/{id}/drafts/generate` 可由模型生成候选草稿：需要当前工厂 ACTIVE、至少一条已核验证据、至少一个当前版本已核验字段，以及 VERIFIED 且未抑制的联系人（可指定 `contact_id`，否则自动选择）。模型只收到品牌、联系人姓名/职能、已核验证据和工厂字段，不接收联系人邮箱。
- 模型必须返回严格 JSON；服务端校验主题/正文、事实原句、证据归属/版本/原文片段、工厂字段版本/当前值。校验失败返回 422 且不创建草稿；通过后创建 `DRAFT` 版本，仍需人工审核和批准，复制不等于发送。审计记录模型、Prompt 版本和用量，不记录 Prompt 正文。
- 每条事实必须是主题或正文的原句。品牌事实绑定同品牌 Evidence ID/版本与原文片段；工厂事实绑定已核验字段记录和档案版本。含义是否受支持、是否遗漏事实、是否夸大，当前由人工确认，系统只做归属/版本/片段/状态/时效校验，不能据此宣称语义已自动验证。
- 没有事实陈述的纯问候/提问可留空引用，但批准仍需逐字确认没有遗漏。草稿建议使用英文；当前不接语言识别服务，也不以模型判断词数或语气。
- 工厂核验暂限结构化字段，`notes`、认证、性能、客户案例不列入可核验字段；系统尚未实现证书文件核验和到期调度。任何与当前字段不对应的承诺都不能因为一个字段引用而被视为受支持。
- 编辑生成新版本，旧版本 SUPERSEDED。证据失效/联系人抑制会使已批准版本 BLOCKED；工厂修改、资格状态或核验版本变化使批准回到 IN_REVIEW。当前采用保守的档案版本级失效，暂不区分无关字段变化。
- 美国在售资格依据及标为时效性的 Claim 超过 7 天需重新核验。时间过期在读取、审批和复制时检查；无需后台任务也能阻止过期复制，失效不会悄悄恢复批准。
- 每次复制必须提交当前草稿修订号和具体版本 ID；服务端重验后返回该版本主题/正文。浏览器复制权限被拒绝时显示错误，不记录发送；复制请求审计只说明内容请求，不证明剪贴板写入或外部投递。
- 记录外部实际发送时可选择当时的草稿版本（含已被替代/失效版本），须属于同商机及联系人。历史发送与内容不因以后失效而删除。旧页面、普通详情和版本历史仍可阅读原文，系统不承诺阻止用户手工选择文本或撤回外部已复制内容。

## 联系人自动发现

- `POST /api/v1/accounts/{id}/contacts/discover` 由用户显式触发，需要模型与本地搜索可用。
- 只用 4 条 `site:{品牌域名}` 查询搜索品牌官网公开页面，最多读取 5 个同域名页面；模型只收到这些页面的文本和 URL。
- 模型返回的邮箱必须满足：格式有效、来源 URL 属于已读取页面、邮箱出现在该页面文本或同页公开 `mailto:` 链接中。姓名/职能只有在页面文本中出现时才保留，否则使用通用称呼或留空。
- 成功联系人始终保存为 `UNVERIFIED`，保留公开来源 URL，不自动核验、不自动禁止联系、不发送任何消息。已存在邮箱复用原记录，不恢复抑制状态。
- 未找到邮箱时返回空列表并如实说明；搜索/模型不可用返回 503。审计记录查询次数、页面数、新增/复用/失败数和模型用量，不记录页面正文。

## AI 证据分析

- `POST /api/v1/evidence/{id}/analyze` 只在模型已配置且证据未清除、未失效时执行；结果写入 `signal_assessments`，绑定分析时的证据版本。
- 模型输出事件类型、可观察事实、业务假设、意图信号、不确定性、缺失信息和原文引用。服务端校验事件类型枚举、事实原句、引用片段必须逐字存在于证据原文；校验失败返回 422 且不保存。
- 证据质量由规则判定，不采用模型自评：`VERIFIED` 最高判为 `MEDIUM`，`UNVERIFIED` 记为 `UNVERIFIED`。单条差评不能被表述为高频问题，采购意向默认 `UNKNOWN`。
- `GET /api/v1/evidence/{id}/assessments` 返回历史分析；页面默认展示最新一条，旧分析折叠。分析结果不改变商机资格、草稿批准或销售阶段。
- 原文按保留政策清除时，分析中的事实、假设和缺失信息一并清空，只保留事件类型、质量、模型版本等元数据。

## 证据原文清除（保留政策）

- `POST /api/v1/evidence/{id}/purge` 需要 `expected_version`、原因和 `confirmed:true`。用于来源删除请求或保留政策要求的正文清除。
- 清除 `raw_text` 与核验备注，保留来源 URL、发布时间、观察时间、产品归属、版本、清除时间和原因；证据状态变为 `INVALIDATED`。清除不可恢复，不能重新核验、再次标记失效或再次清除。
- 引用该证据的合格商机转为 `REASSESSMENT_REQUIRED`，已批准草稿按依赖规则阻断；销售活动与历史记录保留。
- 草稿版本和审批历史中的直接引用片段替换为 `[原文已按保留政策清除]`；用户自己撰写的邮件正文保留，需按同一保留政策人工处理。
- 清除提交后执行 `VACUUM` 与 WAL checkpoint，减少正文在数据库文件中的残留；既有备份、操作系统缓存和事务日志副本不在本操作范围，备份保留策略需单独执行。
- 审计只记录清除原因、时间、版本和替换的引用数，不记录被清除的原文；CSV 导出中 `raw_text` 为空，并新增 `purged_at`、`purge_reason` 列。
- 相同原文再次导入会命中原记录并被拒绝恢复；如需重新保存，必须先确认来源允许继续保留该内容，并由负责人评估保留政策。

## 研究来源登记与启用

- `sources` 记录来源名称、类型（`AUTO_DISCOVERY` / `USER_PROVIDED_URL`）、允许域名（最多 20 个）、市场（首版仅 `US`）、品类（首版仅 `LAUNDRY_PODS`）、每 15 分钟请求上限（1–120）、使用方式与授权记录、原始内容保留方式、状态和版本。
- `POST /api/v1/sources` 创建 `PENDING` 来源；名称按组织唯一，重复返回 409。域名不含协议、端口或路径，不接受 IP、本机或保留域名。
- `POST /api/v1/sources/{id}/activate` 需要 `terms_confirmed:true` 且使用授权记录与保留方式非空，状态变为 `ACTIVE`；`POST /{id}/disable` 需要原因，状态变为 `DISABLED`，可再次显式启用。
- `PATCH /api/v1/sources/{id}` 的 `name`、`kind`、`base_domains`、`markets`、`product_categories`、`rate_limit_per_15m` 属于核心字段；核心字段变化会把已启用来源退回 `PENDING` 并要求原因，仅修改备注不会撤销启用。所有变更、启用与停用写入审计。
- `GET /api/v1/sources` 返回来源列表和 readiness：`auto_discovery.active/ready`、`adapter: SEARXNG_MODEL`。来源登记用于受治理页面读取与授权记录；自动发现是否可运行由搜索与模型配置决定，而不是由来源登记状态决定。
- 来源记录连续失败次数、最后错误与时间；启用时清零。受治理页面读取连续失败 5 次会自动停用，需人工重新启用。

## 模型与搜索接入

- 免费搜索：`docker compose up -d` 启动本地 SearXNG（`127.0.0.1:8888`，JSON 输出，仅监听本机）。可用 `SEARCH_BASE_URL` 覆盖地址。`search/settings.yml` 中的 `secret_key` 仅用于本地开发实例，不要公开该端口。
- 模型：使用 Anthropic 兼容消息接口。优先读取 `MODEL_BASE_URL` / `MODEL_API_KEY` / `MODEL_NAME`，否则回退 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`（或 `ANTHROPIC_AUTH_TOKEN`）/ `ANTHROPIC_DEFAULT_SONNET_MODEL`。密钥只从环境读取，不写入代码、日志或数据库。模型用于候选筛选、英文草稿生成、证据信号分析和公开联系人提取，不用于自动合格、自动核验联系人或自动发送。
- `GET /workspace` 的 `integrations` 动态显示连接状态；模型未配置或 SearXNG 不可达时，`DISCOVERY` 返回 503，不创建任务。
- 发现流程：依据市场、产品品类与客户类型动态构建查询池 → 按预算（默认最多 50 次搜索、200 次页面读取、30 分钟、5 USD）筛选落地页并聚合抓取产品页/市场证据 → 提取产品 SKU 与 AI 信号分析 → 执行规则化工厂硬约束预匹配（`fit_checks`）→ 官网发现联系人 → 满足条件时自动生成待审英文 `DRAFT` 草稿。系统仍严格保持**人工核验与人工审批不可跳过**。
- 发现筛选只发送搜索标题/摘要、页面标题/描述/摘录；草稿生成只发送品牌、联系人姓名/职能、已核验证据和工厂字段，不发送联系人邮箱。搜索摘要和页面原文都作为不可信数据处理。`DEBUG_DISCOVERY=1` 可把模型原始候选输出到服务端日志，仅用于本地诊断。

## 研究任务与品牌池分档

- `POST /api/v1/research-jobs` 接受 `market`（来自 `SUPPORTED_MARKETS` 配置）、可选 `product_categories`（来自 `SUPPORTED_PRODUCT_CATEGORIES` 配置）、`account_types`、`quantity`（1–50，默认 20）、`min_evidence_quality`（`MEDIUM`/`HIGH`，默认 `MEDIUM`）、`contact_preferences`、`language`（仅 `en`）和 `source_mode`。不支持的区间返回 422，不静默截断。
- `source_mode=DISCOVERY` 是默认值，使用本地 SearXNG 搜索与模型筛选候选；搜索不可达或模型未配置时返回 `503 SEARCH_UNAVAILABLE` / `MODEL_NOT_CONNECTED`，不创建任务、不产生费用，也不静默降级为品牌池。`POOL` 是显式选择的兜底模式，只分析本工作空间已保存的品牌、产品、证据和人工审核记录。
- 创建成功后返回 `202` 与 `QUEUED`；支持 `embedded`（应用内局部轮询刷新）与 `external`（`npm run worker` 租约调度与定时监控）两种执行模式。支持取消排队/执行中的任务，服务异常重启时自动将遗留任务恢复为可重试终态。
- 分档是确定性规则，不使用模型：已有产品或工厂硬约束存在已知冲突时为 `NOT_FIT`（列入排除记录）；缺少品类、市场/在售证据或达到门槛的已核验证据时为 `NEEDS_INFORMATION`；三者齐备且无硬冲突的待审商机即可进入 `PRIORITY_REVIEW`（优先审核）。
- 证据质量由规则判定：经人工核验、未过期/未失效且记录为第一方官网/第一方公开记录（`FIRST_PARTY_BRAND`）及明确时间时允许升级至 `HIGH`；第三方来源与一般已核验记录最高为 `MEDIUM`；`min_evidence_quality=HIGH` 可真实筛选达标第一方证据。
- 研究按严格排序输出候选（证据质量 → 已知发布时间降序 → 可用联系人数 → ID）；已有商机复用且不覆盖人工资格、销售阶段、负责人或历史。联系人缺失记为 `CONTACT_NOT_FOUND`；模型未接入时记录原因，不阻塞任务完成。
- `GET /api/v1/research-jobs` 列出任务；`GET /api/v1/research-jobs/{id}`、`/results`、`/failures` 查看任务、结果快照（含实时最新草稿状态）和失败项。`POST /{id}/cancel` 与 `POST /{id}/retry` 累加并遵守累计预算，支持 `Idempotency-Key`。

## 来源页面读取与 SSRF 边界

- 证据录入页的“读取公开页面”必须由用户显式点击。服务端只读取一次，返回清理后的文本供人工核对，不自动抓取、不自动保存，也不把读取当作来源核验。
- 仅接受 `http`/`https`、无账号密码、无自定义端口、带点号的公开域名；直接拒绝 IP、`localhost`、回环、内网、链路本地、云元数据地址和保留域名后缀。
- DNS 解析后逐一校验全部候选 IP，支持在已校验 IPv4/IPv6 地址间回退连接，降低 IPv6 不可达及 DNS 重绑定风险；重定向最多 3 跳，每跳重新校验。
- 限制 8 秒超时，支持 `gzip` / `deflate` / `br` 安全解压（限制最大解压字节），接收 `text/html`、`application/xhtml+xml`、`text/plain` 并解码完整常见英文 HTML 实体；启用 `HEADLESS_RENDER=1` 时可对 SPA 壳页面执行无头浏览器 DOM 提取 fallback。每 15 分钟最多 30 次用户预览读取。
- `POST /api/v1/sources/preview` 返回最终 URL、状态码、类型、字节数、重定向链和文本；成功与失败都记录元数据审计，不记录页面正文。
- 证据录入可选择已启用来源并提交 `source_id`：目标域名必须落在该来源的 `base_domains` 内，并按来源的 `rate_limit_per_15m` 单独限速。成功读取会清零连续失败；上游读取连续失败 5 次（事务内原子递增）会把来源自动置为 `DISABLED`，记录最后错误与时间并写入审计。重新启用会清零失败计数。
- 未关联来源的读取仍受每服务进程 15 分钟 30 次的全局限制。自动停用只影响该来源的受治理读取，不删除已保存证据。

## 备份、恢复与审计

- **SQLite 模式**：`npm run backup` 使用 `VACUUM INTO` 生成一致性快照，默认写入 `data/backups/botein-<UTC 时间>.sqlite`，拒绝覆盖已有文件并自动执行 `PRAGMA integrity_check` 与主要表行数校验；恢复需停服替换数据库文件及 `-wal`/`-shm` 文件。
- **PostgreSQL 模式**：当 `.env` 或环境变量启用 `DB_DRIVER=postgres` 且配置 `DATABASE_URL` 时，`npm run backup` 自动调用 `pg_dump --clean --if-exists --no-owner --no-privileges` 生成 `.sql` 一致性备份，并校验转储完整性与核心表行数。
- `npm run verify-backup -- <文件>` 支持校验 `.sqlite` 与 `.sql` 两种备份；完整性不是 `ok` 时返回非零退出码。
- `GET /api/v1/audit-logs?limit=20&cursor=...` 按 `rowid` 倒序返回当前工作空间审计元数据，`limit` 为 1–100，详情不包含密码、Cookie 或页面正文。
- 接入状态页提供“加载最近记录”和“加载更多”。审计为只追加记录，不提供编辑或删除。

## 业务列表分页

- 以下列表支持 `limit`（1–100，默认 20）和 `cursor`：品牌、证据、商机、联系人、禁止联系、跟进待办、研究任务、来源、品牌身份核对、工厂字段核验、品牌产品。返回 `{ items, next_cursor }`，到末页时 `next_cursor` 为 `null`。
- 游标为不透明 base64url 值，基于 `(时间, ID)` 复合键，不使用 SQLite rowid；插入新记录不会让已取页重复或跳过。非法 limit/cursor 返回 422。
- 排序：品牌、证据、联系人、产品、研究任务、来源按创建时间倒序；商机按更新时间倒序；待办按截止时间升序；工厂字段核验按核验时间倒序。
- 品牌池：`GET /accounts?q=...` 按品牌名或规范化域名搜索，返回 `total` 作为匹配总数，`q` 中的 `%` 和 `_` 按字面量转义；页面使用服务端筛选与“加载更多”。`GET /accounts/options` 返回品牌 ID 与名称，供下拉选择与 CSV 导入参考。
- 商机：`GET /opportunities?status=...` 支持 `ALL / PENDING / QUALIFIED / REJECTED / ARCHIVED`，返回 `total`；页面使用服务端筛选与“加载更多”。`GET /opportunities/options` 提供跟进待办下拉所需的商机选项。
- 跟进待办：`GET /follow-up-tasks?status=...` 支持 `ALL / OPEN / OVERDUE / TODAY / DONE / CANCELLED`，返回 `total`。`OVERDUE` 按服务端当前时间筛选 `OPEN` 待办；`TODAY` 需要 `from`/`to` UTC 时间，页面把浏览器本地“今天”的起止转换为 UTC 后提交。页面使用服务端筛选与“加载更多”，首页“接下来要跟进”另行查询最早 3 条 `OPEN` 待办。
- 研究任务与研究来源返回 `total`，页面支持“加载更多”。`GET /sources/options` 只返回已启用来源，供证据录入的来源治理下拉使用，不受来源列表分页影响。
- 品牌身份核对返回 `total` 与 `pending_total`，页面支持“加载更多”。工厂字段核验返回 `total`，页面支持“加载更多”；`GET /factory-profile/checks/options` 返回当前档案版本的全部核验记录，供草稿事实引用选择，不受列表分页影响。
- 联系人与禁止联系：`GET /contacts?q=...` 按姓名、邮箱或品牌搜索，返回 `total`；`GET /contact-suppressions` 返回 `total`。联系人目录使用服务端搜索与“加载更多”，禁止联系记录也支持“加载更多”。
- 品牌产品：`GET /accounts/{id}/products` 返回 `total`，产品管理弹窗使用“加载更多”；`GET /accounts/{id}/products/options` 返回该品牌全部产品，供证据关联选择，不受分页影响。
- 证据列表使用“加载更多”。所有主要业务列表均已使用服务端分页；下拉和引用选择使用独立 options 接口或完整选项，服务端每次响应仍受 100 条上限约束。
- 商机详情内的证据/联系人/活动、草稿版本、研究结果等有界子列表不分页。

## 待办、提醒与统计口径

- 待办使用 UTC 时间存储，页面按浏览器时区输入和显示；“今天”按浏览器本地日期判断。截止时间可以在过去，会标为逾期；支持 `GET /api/v1/follow-up-tasks/reminders` 到期与逾期提醒汇总，完成/取消保存关闭时间并记录审计。
- 漏斗 `GET /api/v1/analytics/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD&as_of=ISO_UTC&market=...`：按商机创建时间选取队列并按截止点去重统计，首次结论与当前状态分离；支持按负责人（`by_assignee`）、品类、市场及研究任务（`by_research_job`）下钻分析。

## 验证

```bash
npm run check
npm test
npm run backup
npm run verify-backup -- <备份文件路径>
npm run pg-migrate -- --print
```

共四十八条原生自动化集成测试（[src/server.test.mjs](src/server.test.mjs)），除基础主路径与安全/分页测试外，另覆盖：
- 多组织租户隔离、成员邀请与 RBAC 权限隔离、密码重置、TOTP MFA、KMS 信封加密、数据库持久化限流与动态 CORS。
- 外部 Worker 租约调度、定时监控与通知外发（`worker_leases` / `scheduled_monitors` / `outbound_notifications`）。
- 商机收件箱多维筛选、AI 调用遥测（P50/P95、Token/成本与拒绝率）、外部连接器凭据加密，以及 PostgreSQL DDL / SQL 转译与 `.sql` 备份校验。

测试使用临时数据库，不修改 `data/`。浏览器验收请使用独立数据库或临时 PostgreSQL 库。

## 文件

```text
src/server.mjs             HTTP 服务、安全响应头与 REST API 路由
src/auth.mjs               多租户认证、RBAC、邀请、密码重置、TOTP MFA 与会话管理
src/store.mjs              存储入口、SQLite 初始化/v17 升级、PostgreSQL 自动路由与事务审计
src/storage.mjs            storage 配置、PostgreSQL v17 DDL 导出与 SQLite → PostgreSQL 数据迁移
src/pg-store.mjs           PostgreSQL 同步适配器与 SQLite 方言转译层
src/pg-worker.mjs          零第三方依赖 Node Worker PostgreSQL v3 协议客户端
src/catalog.mjs            环境变量驱动的产品品类与目标市场配置目录
src/fit.mjs                基于工厂条款与资质的确定性硬约束匹配引擎
src/connectors.mjs         加密存储的外部联系人/电商/邮件/Webhook 连接器
src/kms.mjs                AES-256-GCM 信封加密与 TOTP 工具
src/worker.mjs             独立后台任务租约执行与定时监控调度循环
src/sales.mjs              证据核验、商机、联系人与销售活动 API
src/tracking.mjs           跟进待办提醒与多维漏斗统计 API
src/research.mjs           研究任务、预算/崩溃恢复、分档排序与自动发现编排
src/source-fetch.mjs       SSRF 防护、多 IP 回退、安全解压与 Headless Chrome DOM 抓取
src/sources.mjs            研究来源登记、授权记录与失败熔断 API
src/audit.mjs              审计日志游标分页 API
src/pagination.mjs         业务列表复合游标、limit 校验与分页响应
src/paths.mjs              默认数据库路径与新/旧路径兼容
src/search.mjs             SearXNG 搜索客户端与连接状态
src/model.mjs              Anthropic 兼容模型客户端与平衡括号 JSON 解析
src/discovery.mjs          自动发现查询池、页面聚合、SKU 提取与全链路候选创建
src/analysis.mjs           AI 证据信号分析、严格引用校验与历史记录 API
src/contact-discovery.mjs  品牌官网公开联系人发现
src/drafts.mjs             字段核验、人工/AI 草稿版本、审批及复制校验 API
src/products.mjs           品牌产品/SKU、变更及证据归属 API
src/accounts.mjs           品牌编辑、身份核对和依赖状态处理
src/contacts.mjs           联系人编辑/历史、目录与受控禁联解除
src/evidence.mjs           来源属性与可达性（source_kind / availability_status）共用的证据规则
src/data-transfer.mjs      证据 CSV 导入与公式安全 CSV 导出
src/maintenance.mjs        SQLite VACUUM INTO 与 PostgreSQL pg_dump 一致性备份及校验
src/validation.mjs         输入验证及 CSV 解析
src/server.test.mjs        48 条集成与单元测试
scripts/backup.mjs         SQLite/PostgreSQL 备份命令
scripts/verify-backup.mjs  SQLite/PostgreSQL 备份校验命令
scripts/pg-migrate.mjs     PostgreSQL 建表与 SQLite 全量迁移脚本
scripts/worker.mjs         独立外部研究/监控 Worker 启动入口
scripts/ensure-env.mjs     开发启动前补齐本地 .env
docker-compose.yml         本地 SearXNG 服务
search/settings.yml        SearXNG 本地 JSON 搜索配置
public/index.html          单页控制台布局、表单与原生对话框
public/app.js              页面路由、局部刷新与各工作区控制器
public/auth.js             登录/注册/邀请/密码重置与 MFA 交互
public/drafts.js           划词引用草稿编辑器、跟进模板与字段核验交互
public/products.js         品牌产品编辑、变更历史与证据关联交互
public/accounts.js         品牌编辑及同域名身份核对交互
public/contacts.js         联系人编辑、目录与受控解除禁联交互
public/data-transfer.js    CSV 模板、UTF-8 严格导入反馈与导出
public/style.css           页面布局与响应式样式
```

UI 遵循用户的 `design.md`：Geist、克制层级、来源可追溯、系统深浅色。`public/assets/vercel-brand.css` 原样取自 https://vercel.com/geist/vercel-brand.css（2026-11-12），作为基础样式；页面品牌为 Botein，不表示 Vercel 官方出品。字体通过 Google Fonts 加载，离线时使用系统字体。应用不加载第三方脚本或分析服务。
