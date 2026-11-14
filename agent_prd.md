# Botein — PRD v3.1
## Agent 自动化 MVP 研发规格

**文档状态：** 待产品、研发、数据与业务负责人评审  
**目标版本：** MVP 0.2  
**修订日期：** 2026-11-12  
**首发行业：** 日化 OEM/ODM  
**首发产品：** 洗衣凝珠；洗碗块延期到后续版本  
**首发市场：** 在美国销售洗衣凝珠的品牌，不限总部国家  
**产品形态：** 多租户 Web SaaS 工作台 + 目标市场研究 Agent  
**销售执行：** Agent 负责研究、排序和草稿生成；业务员负责审核、复制、人工发送和记录结果  
**核心闭环：** 目标市场输入 → Agent 研究任务 → 证据验证 → 工厂匹配 → 可审核商机包 → 人工触达 → 销售结果

### 文档约定

- **[KNOWN]**：已确认的产品决策。
- **[INFERRED]**：本版建议，需在试点中验证。
- **[COMMON]**：通用工程要求。
- 目标阈值、样本量和周期均属于试点假设，未验证前不得对外宣传为既定能力。

---

# 1. 产品定位与目标

## 1.1 产品用途

Botein 是面向日化 OEM/ODM 工厂的海外品牌开发工作台。业务员输入一个目标市场和产品条件后，Agent 自动发现或筛选目标品牌，整理公开证据，判断品牌与工厂能力的匹配程度，寻找可用联系人，并生成带证据引用的英文开发信草稿。

业务员最终得到的是一组**可执行、可追溯、可审核的商机包**，而不是一段没有来源的推荐文字。

## 1.2 MVP 要验证的假设

- **H1：** 目标市场研究 Agent 能发现比人工搜索更值得优先处理的品牌。
- **H2：** 证据和工厂能力匹配能减少明显不相关的开发对象。
- **H3：** 业务员能在一个工作台中完成审核、人工触达和结果记录。
- **H4：[INFERRED]** 商机包中的证据、匹配原因和下一步建议足以支持业务员快速决策。

## 1.3 成功标准

首个试点结束时，必须能从一次研究任务跑通以下路径：

```text
配置工厂能力
→ 选择目标市场，继承工厂品类
→ Agent 发现新品牌并交付证据、匹配原因、联系人候选和未审核草稿
→ 业务员审核商机、确认联系人
→ 编辑并批准草稿；缺失资料可补充后重生成
→ 人工发送
→ 记录回复、会议、样品或报价
→ 查看基础漏斗
```

试点需要记录以下指标，具体目标值由产品和业务负责人在试点前确认：

| 假设 | 指标 | 口径要求 |
|---|---|---|
| H1 | 候选机会合格率 | 同一候选队列中首次审核合格数 / 首次已审核数；具体口径见第 15 节 |
| H1 | 研究任务有效产出率 | 同一创建期任务中有至少一条可审核结果的任务数 / 已结束任务数；零结果、失败和部分完成均计入，用户取消单列 |
| H2 | 无效开发率 | 触达后被判定为不相关的机会 / 已触达机会 |
| H2 | 审核耗时中位数/P90 | 试点人工计时；统计实际审阅时间，排除页面闲置 |
| H3 | 合格线索触达率 | 同一候选队列中首次合格且已有人工触达的机会数 / 首次合格机会数；观察截止日一致 |
| H3 | 周活跃业务员 | 每周完成至少一次审核或活动记录的成员数 |
| H4 | 事实支持率 | 抽样人工核对：由有效证据或已验证工厂能力支持的事实性 Claim / 全部事实性 Claim；只有引用 ID 不算支持 |

试点采用相同市场、品类和等额人员时间，比较人工研究与 Agent 辅助研究；使用相近且不重叠的品牌集合，按同一标准审核。报告每小时合格线索数、每条合格线索的外部服务成本和人工审核时间，记录样本量；小样本结果只作试点依据。实验目标值、观察截止日和负责人必须在试点开始前确定。

质量护栏：跨租户数据泄露、重复活动、无事实支持的已批准 Claim 均以 0 为目标。

---

# 2. MVP 范围

## 2.1 P0 功能

| ID | 功能 | 交付物 |
|---|---|---|
| F-01 | 工作空间与成员权限 | 登录、组织、Owner/Member、租户隔离 |
| F-02 | 工厂能力档案 | 品类、OEM/ODM、市场、MOQ、产能、交期、已验证资质 |
| F-03 | 目标市场研究任务 | 市场输入、任务状态、进度、取消、重试、结果 |
| F-04 | 品牌与产品发现 | 至少一条从空品牌池发现新品牌的已验证路径；人工品牌池 + CSV 兜底、去重和归一化 |
| F-05 | 证据与信号分析 | 来源、原文、证据质量、事件分类、AI 分析结果 |
| F-06 | 工厂匹配与商机包 | 硬约束、匹配原因、优先级、缺失信息 |
| F-07 | Opportunity Inbox | 候选列表、详情、审核、分配、重评估 |
| F-08 | 联系人管理 | 来源、验证状态、角色相关性、抑制状态 |
| F-09 | AI 邮件草稿 | 事实引用、Claim 校验、版本、人工审核 |
| F-10 | 人工销售执行 | 复制事件、人工发送记录、回复、会议、样品、报价、跟进 |
| F-11 | 基础漏斗 | 证据、候选、合格、触达、回复、会议、样品、报价 |
| F-12 | 系统基础能力 | 审计、幂等、重试、错误追踪、数据导出、租户隔离 |

## 2.2 明确不做

- 自动发送邮件、自动回复或自动邮件序列。
- 未经验证的全网爬取。
- 未经来源授权的大规模 Amazon/TikTok 评论采集。
- 海关提单监控。
- 自动识别真实 OEM 供应商。
- 无证据的供应商切换概率预测。
- Gmail/Outlook 双向同步。
- CRM 双向集成。
- 企业级 SSO、复杂计费和高级 RBAC。
- 同时支持大量行业和品类。

新增 P0 功能必须说明替换掉哪一项现有工作量，并由产品负责人确认。

## 2.3 P1 候选

- 更多已验证来源适配器和定时研究任务。
- 定时监控新品、扩品和产品问题；单次研究中的事件发现属于 P0。
- 研究结果的定时增量更新和复杂品牌身份合并；准确命中已有品牌及机会时的跨任务复用属于 P0。
- 洗碗块及美国以外的市场。
- 邮箱连接、发送结果同步和回复分类。
- 积累人工审核结果后评估是否引入数值评分。
- 更复杂的团队权限、配额和计费。

---

# 3. 用户与核心任务

## 3.1 角色

| 角色 | 权限 |
|---|---|
| Owner | 管理组织、成员、工厂档案和全部业务数据 |
| Member | 创建研究任务、查看和审核商机、管理联系人、草稿和活动 |
| System Worker | 在租户授权范围内执行研究、分析、匹配和草稿任务；无人工业务权限 |

MVP 不单独开发 Manager、Analyst、Admin 等角色。

## 3.2 核心用户故事

> 作为外贸业务员，我输入“美国 + 洗衣凝珠 + 独立品牌”，系统帮我找到值得联系的品牌，说明为什么匹配，给出证据和联系人，并生成一封可审核的英文开发信。

## 3.3 研究任务输入

首次使用由 Owner 配置工厂能力。之后业务员只需选择目标市场即可创建任务；产品品类从已激活档案继承，其他条件使用默认值。首版 API 的最小输入为：

```json
{
  "market": "US"
}
```

服务端补齐并保存以下输入快照；用户可以调整受支持的可选条件：

```json
{
  "market": "US",
  "product_categories": ["LAUNDRY_PODS"],
  "account_types": ["INDEPENDENT_BRAND", "ECOMMERCE_BRAND"],
  "quantity": 20,
  "min_evidence_quality": "MEDIUM",
  "contact_preferences": ["PRODUCT", "PROCUREMENT", "QUALITY"],
  "language": "en",
  "source_mode": "DISCOVERY"
}
```

字段规则：

- `market`：目标销售市场，首版仅接受 `US`。总部国家另存为 `headquarters_country`，未知可以为空。
- 美国销售证据：品牌美国站或面向美国的零售商当前在售页面，能对应品牌和洗衣凝珠产品；仅有美国总部、美元价格、全球配送或进入美国计划不足以确认。
- `product_categories`：首版固定为 `["LAUNDRY_PODS"]`；显式提交其他品类返回 `422 UNSUPPORTED_CATEGORY`，其他市场返回 `422 UNSUPPORTED_MARKET`。后续多品类时才显示品类选择。
- `account_types`：可选，默认上述两类，至少命中一类；品牌须有自有品牌洗衣凝珠产品，排除仅转售其他品牌的商家。`INDEPENDENT_BRAND` 表示以自身品牌运营的客户，不暗示其股权独立；`ECOMMERCE_BRAND` 表示有可核验线上销售渠道，两者可重叠。分类理由须有来源。
- `quantity`：返回的去重机会数量上限，默认 20，首版为 1–50 的整数；不足时如实返回，不凑数。
- `min_evidence_quality`：可选 `MEDIUM` / `HIGH`，默认 `MEDIUM`；用于“优先审核”的证据门槛。低于门槛的相关结果归入“待补资料”，不伪装成达标结果。
- `contact_preferences`：职能优先顺序，不保证找到个人联系人；公开的相关职能邮箱可以作为候选。
- `language`：首版仅接受 `en`，用于生成草稿；研究工作台固定中文，保留原文引用。
- `source_mode`：默认 `DISCOVERY`，从启用来源发现新品牌，也复用已有记录；`POOL` 仅分析本租户人工品牌池，是显式选择的兜底模式。自动发现来源不可用时显示原因，由用户决定是否另建 `POOL` 任务，系统不静默降级。

创建前要求工厂档案为 `ACTIVE`、支持洗衣凝珠且允许承接美国市场，否则返回 `422` 和具体缺失项。`DISCOVERY` 没有可用发现路径时返回 `503 SOURCE_UNAVAILABLE`，不启动空转任务。快照保存解析后的输入、工厂版本、来源和执行限额，运行中不覆盖。

---

# 4. Agent 研究流程

## 4.1 端到端流程

```text
解析任务输入
  ↓
选择允许使用的数据源
  ↓
发现品牌与产品
  ↓
规范化、去重和范围过滤
  ↓
获取并保存原始证据
  ↓
验证来源和证据质量
  ↓
识别产品/市场事件
  ↓
应用工厂硬约束
  ↓
计算可解释排序
  ↓
寻找并核验联系人
  ↓
生成带 Claim 引用的邮件草稿
  ↓
生成商机包并进入人工审核
```

Agent 只使用已启用且通过使用方式核验的来源。P0 至少接通一条“按市场和品类检索 → 打开来源 → 核对品牌、产品和销售市场”的发现路径；搜索摘要只作发现线索，核验依赖原始页面或允许使用的数据记录。原始证据须留存可引用内容。

运行单个顺序工作流即可，不要求多 Agent、通用工作流框架或自主扩展工具。研究阶段可以为未审核候选生成 `DRAFT`；人工审核只决定商机资格和草稿批准，不阻塞研究任务结束。`NOT_FIT` 不生成开发信；缺少联系人或可靠事实时保留结果并注明缺失原因。

`POOL` 任务和降级原因必须明确展示，不能用人工导入结果证明自动发现能力，也不承诺全网或实时覆盖。

## 4.2 任务状态、预算与结束条件

执行状态 `status` 与步骤 `current_step` 分开：

```text
QUEUED → RUNNING → COMPLETED / PARTIAL / FAILED
QUEUED / RUNNING → CANCELLED
```

`current_step` 取值为 `DISCOVERING / ENRICHING / ANALYZING / MATCHING / CONTACT_ENRICHING / DRAFTING`，结束后为空。逐候选处理可重复经过这些步骤；进度报告真实计数，不假造固定百分比。

- `COMPLETED`：完成既定研究范围或达到数量上限，已交付候选的必要研究步骤执行完毕，无未恢复的执行故障；允许零结果或少于期望数量。
- `PARTIAL`：预算或时间耗尽，或有未恢复故障导致研究步骤未完成；可包含零条结果，保留已完成内容和失败项。
- `FAILED`：执行故障使整条路径不可用，且没有可用结果。正常研究得到零结果不属于失败。
- `CANCELLED`：用户取消，不再调度新调用；尽力终止进行中的请求。迟到返回不得新增业务结果或覆盖终态，实际已发生费用仍记录。
- 联系人查询成功但没有发现联系人，属于业务信息缺失；接口报错、超时属于执行故障。前者记录 `CONTACT_NOT_FOUND`，可跳过草稿并正常完成，后者按实际影响进入 `PARTIAL` 或 `FAILED`。
- `stop_reason` 至少区分 `TARGET_REACHED / SOURCE_SCOPE_EXHAUSTED / BUDGET_EXHAUSTED / TIME_LIMIT / DEPENDENCY_FAILURE / USER_CANCELLED`；可另附多个失败原因。
- 达到数量上限后停止扩大发现范围，继续处理已选候选；预算到期则停止新调用。来源范围耗尽仅表示已配置路径和本次查询范围，不表示搜索了整个互联网。
- 研究结束后，待审核数量由机会资格状态派生。业务员审核一半、拒绝全部或从未审核均不改变任务执行终态。

[INFERRED] 首轮执行限额建议：每任务最多 50 次搜索请求、200 次页面请求、30 分钟运行时间、5 USD 外部服务预算，每步最多重试 2 次，租户同时运行 1 个任务。部署时配置为有限正值并在启动前展示；具体数值须由首个来源的成本与延迟测量校准，不属于对外性能承诺。

所有搜索、抓取、模型、联系人服务及重试均计入任务累计限额。调用前预留该次最大可计费额度，余额不足不发起；费用未结算时不释放预留额度。运行时间从首次进入 `RUNNING` 计，包含等待和重试退避；累计预算不会因重试重置。

任务记录：输入快照、当前步骤、已发现/处理/跳过/失败数量、新建/复用机会数、资料缺失数、成本与预算使用量、来源与模型/Prompt/规则版本、创建人、时间和停止原因。

重试只允许 `PARTIAL` / `FAILED` 且仍有执行预算的任务，经显式操作回到 `QUEUED`；一次重试生成递增 `attempt`，只补失败或未完成步骤，成功结果和人工审核不覆盖。旧 attempt 的迟到回写被忽略。预算耗尽或已取消时，用户可显式创建新任务，继续复用已有业务对象，不自动续费或无限重试。

## 4.3 自动化与人工确认边界

Agent 可以自动执行：

- 品牌和产品候选发现。
- 来源和原文整理。
- 证据分类与摘要。
- 工厂能力匹配。
- 优先级排序。
- 联系人候选整理。
- 开发信草稿生成。

必须由业务员确认：

- 是否把候选标记为合格机会。
- 是否接受联系人及其验证状态。
- 是否批准邮件草稿。
- 是否已在外部邮箱实际发送。
- 回复、会议、样品、报价和成交结果。

系统不把复制草稿、AI 推断或任务完成自动视为已触达。

---

# 5. 结果定义：可执行商机包

## 5.1 结果列表

研究任务完成后，系统按优先级返回目标数量以内的商机包，并显示：

- 品牌名称和官网。
- 国家、品牌类型和产品品类。
- 触发事件。
- 证据质量和来源数量。
- 工厂匹配状态、待确认项和分档原因。
- 联系人可用性。
- 优先级。
- 研究任务和更新时间。
- 当前审核状态。

## 5.2 商机包详情

每个商机包必须展示以下栏目，允许缺失数据并给出原因：

1. 品牌概览。
2. 产品和 SKU（无法确认 SKU 时只能关联品牌）。
3. 事件时间线。
4. 原始证据、来源 URL、原文摘录和观察时间。
5. AI 识别的事实、假设、未知信息和不确定性。
6. 工厂硬约束检查和逐项匹配原因。
7. 联系人候选、来源和验证状态；未找到时显示 `CONTACT_NOT_FOUND`。
8. 未审核英文草稿及 Claim 引用；跳过时显示 `NO_CONTACT / INSUFFICIENT_FACTS / SUPPRESSED`，执行失败单独显示错误。
9. 下一步建议。
10. 审核、版本、任务和审计历史。

“下一步建议”只能使用以下可验证动作，例如“补充两条同类证据”“核验 MOQ”“确认采购负责人”，不得直接声称品牌正在寻找供应商。

## 5.3 优先级

MVP 使用规则分档，不计算加权总分、采购潜力分或采购概率：

| 分档 | 规则 |
|---|---|
| 优先审核 `PRIORITY_REVIEW` | 品牌身份、品类、美国在售有核验证据；无已知硬冲突；至少一条达到任务证据门槛的具体开发依据与已验证工厂能力相关 |
| 待补资料 `NEEDS_INFORMATION` | 候选相关且无已知硬冲突，但品牌身份、销售市场、证据或开发依据未达到上述条件 |
| 不匹配 `NOT_FIT` | 存在已知品类、市场或可比较的订单条件冲突，列入排除记录，不计入返回数量 |

开发依据可以是当前产品与工厂能力相关的事实、新品事件或产品反馈，不要求一定存在负面评论，也不代表已确认采购意向。采购量、具体 SKU 或联系人未知本身不阻断“优先审核”，但缺口必须显示。

每个结果选取一条主要开发依据并保留其引用；组内按这条依据的证据质量（HIGH、MEDIUM、LOW、UNVERIFIED）、已知发布时间降序、联系人是否有可用渠道排序，最后以稳定 ID 排序。发布时间未知排在已知时间之后，观察时间只标为采集时间，不把旧内容包装成新事件。联系人补充完成后更新组内顺序，每个结果保留分档原因和规则版本。

---

# 6. 领域模型与数据边界

## 6.1 术语定义

- **Account**：一个品牌记录，品牌所属公司作为可选属性；同一域名下多个品牌需要人工消歧。
- **Product**：品牌正在销售或公开展示的产品，可包含 SKU 信息。
- **Evidence**：带来源和时间的原始材料或人工粘贴文本。
- **Event**：分析中归纳的产品、市场或品牌事实，不单建事件表；类型、事实和证据引用保存在 Signal Assessment 中。
- **Signal Assessment**：对指定证据版本集合的结构化分析，包含事件类型、事实、假设和不确定性；新分析追加记录。
- **Opportunity**：同一租户内按品牌与品类维护的开发对象，多个产品和事件可共同支持，同一对象跨研究任务复用。
- **Qualified Opportunity**：业务员认为值得首次联系的机会，有品类和市场证据且无已知硬冲突；不代表已确认采购意向、采购量或订单承接条件。
- **Research Job**：一次目标市场研究任务及其结果集合。

## 6.2 核心实体

```text
organizations
users
memberships
factory_profiles
factory_profile_versions
research_jobs
research_job_results
accounts
account_identity_reviews
account_products
sources
evidence
signal_assessments
opportunities
opportunity_evidence
opportunity_history
contacts
contact_suppressions
drafts
draft_versions
draft_claims
sales_activities
follow_up_tasks
ai_runs
audit_logs
```

MVP 不创建 `source_events` / `events` 两套对象，也不单建任务运行表；`research_jobs` 保存当前 attempt，历史步骤与尝试写入现有审计日志。

- Account 拥有 Product、Evidence 和按品类唯一的 Opportunity；Evidence 的 `product_id` 可为空。
- Signal Assessment 引用一个或多个 Evidence 版本；Opportunity 通过 `opportunity_evidence` 关联证据并保存匹配评估历史。
- `research_job_results` 以 `(organization_id, research_job_id, opportunity_id)` 唯一，保存本次分析、工厂版本、排序原因、草稿版本以及新建/复用标记。任务结果快照不被后续任务覆盖，页面同时展示当前审核状态及过期提示。
- 所有租户业务实体和关联行归属 Organization；来源内容也按租户保存，MVP 不做跨租户内容共享。写入时检查关联 ID 的租户一致性，而不只检查外层对象。
- 一个机会只有一个当前负责人。不同任务命中同一品牌品类时，不覆盖已有负责人、审核或销售记录。

## 6.3 去重规则

- `normalized_domain` 不能直接作为 Account 的唯一键，因为同一域名可能承载多个品牌。
- 同一租户内相同规范化域名进入“已存在或待消歧”流程。
- 同名不同域名不得自动合并。
- 同一来源存在稳定 `external_id` 时，以 `(organization_id, source_id, external_id)` 去重。
- 无稳定 ID 的来源使用来源专用指纹：规范化 URL、发布时间、作者标识和内容哈希等。
- 幂等键处理同一请求重放；不同任务命中同一 Account 时仍执行第 10.2 节的业务去重。
- 同一租户内规范化域名和规范化品牌名同时精确匹配时复用 Account；存在多条命中或身份歧义时转人工消歧，确认前不创建可触达的第二个机会。
- CSV 单次最多 500 行、UTF-8（支持 BOM）；返回逐行成功/跳过/待消歧/失败原因。品牌列至少包含 `brand_name,website,headquarters_country`（总部国家允许空）；证据列至少包含可解析的品牌标识、`source_url,raw_text,observed_at`。域名去重与手工录入共用规则；重复文件不会重复创建品牌。

---

# 7. 工厂能力档案

## 7.1 字段

| 字段 | 类型 | 规则 |
|---|---|---|
| factory_name | string | 必填 |
| supported_products | enum[] | 首版仅 `LAUNDRY_PODS` |
| service_type | enum[] | `OEM` / `ODM` |
| target_markets | string[] | ISO 国家代码 |
| production_terms | object[] | 按品类和包装条件记录 MOQ、月产能、计量单位和交期，数值未知可为空 |
| certifications | object[] | 名称、编号、有效期、证明文件、验证状态 |
| packaging_capabilities | string[] | 可选 |
| technical_capabilities | string[] | 可选 |
| prohibited_markets | string[] | 可选 |
| profile_status | enum | `DRAFT` / `ACTIVE` |
| version | integer | 每次发布递增 |

每条 `production_terms` 包含 `product_category`、`packaging_spec`、`unit`（`POD / BAG / BOX / CARTON`）、`moq_quantity`、`monthly_capacity_quantity`、`lead_time_days`。已填写的数值为正整数；有 MOQ 或产能时必须有单位与适用包装条件。证据支持的单位换算可以使用，未知包装或缺少换算依据时不比较数值，标为待确认。

## 7.2 规则

- 缺少产品类型或目标市场时不能激活档案。
- 未知 MOQ 不等于 MOQ 为零。
- 未验证或过期资质不能用于对外 Claim。
- 档案更新生成新版本，不覆盖历史任务快照。运行中仍使用旧版本的任务交付时标记版本过期，并用当前版本重新检查硬约束后才允许批准草稿。
- 产品、市场、已知订单条件或已引用能力变化时，将受影响的合格机会标记为 `REASSESSMENT_REQUIRED`；草稿审核失效按第 11.3 节处理。
- 重新评估异步执行，并保留旧评估结果。

---

# 8. 来源与证据

## 8.1 正式支持的来源路径

P0 支持三种路径：

1. 已验证公开来源适配器。
2. 人工录入公开页面或评论。
3. 品牌和证据 CSV 导入。

来源适配器启用前必须有：使用方式核验、授权或允许使用记录、支持的市场与品类、限流策略、原始内容留存方式、失败重试和停用机制。仅能分析已提供 URL 的适配器不等于具备品牌发现能力；首个发现来源须满足第 19 节 Gate A。

## 8.2 Evidence 字段

- `account_id`
- `product_id`（可为空）
- `source_id` / `source_type`
- `source_url`
- `raw_text`
- `published_at`（可为空）
- `observed_at`
- `verification_status`（`UNVERIFIED / VERIFIED / INVALIDATED`）
- `availability_status`（`AVAILABLE / UNAVAILABLE / UNKNOWN`）
- `checked_at` / `verified_by` / `verification_method` / `invalidation_reason`
- `entered_by`
- `content_hash`
- `version`

原始文本与 AI 摘要分开存储，引用的证据版本不可原地改写。`VERIFIED` 表示出处、原文和品牌/产品归属已通过核对，不保证作者陈述或产品问题本身属实。核验可来自来源适配器或人工确认，记录方法、操作者与时间。

仅粘贴文本或有 URL 但未核对内容时为 `UNVERIFIED`。发现归属错误、原文被篡改或证据被证伪时标为 `INVALIDATED` 并说明原因。页面暂时打不开仅改变 `availability_status`；已有合法留存且核验过的引用可继续支持历史事实，不自动判为假证据。涉及“当前在售”等时效性 Claim 在批准或复制时须有绑定到该引用版本的核验记录且距当前不超过 7 天；超期需重新核验。7 天是待试点校准的初始规则。

内容删除请求或来源要求清除时，按适用保留政策删除内容并保留不含原文的审计信息，撤销依赖该内容的批准。

## 8.3 来源访问安全

如果服务端主动访问来源 URL，必须执行：

- 只允许 `http`/`https`。
- 阻断回环、内网、链路本地和云元数据地址。
- DNS 解析后的 IPv4/IPv6 地址重新校验。
- 跟随重定向时每一跳重新校验。
- 限制超时、响应大小和内容类型。
- 记录请求 ID、来源、采集时间和失败原因。
- 失败重试使用退避；连续失败的适配器自动停用。

保存人工提供的 URL 不等于系统必须访问该 URL。

---

# 9. 信号分析与 AI 约束

## 9.1 事件分类

```text
CLUMPING
LEAKAGE
DISSOLUTION_FAILURE
RESIDUE
ODOR_CHANGE
PACKAGING_DAMAGE
PRODUCT_LAUNCH
PRODUCT_EXPANSION
OTHER
UNKNOWN
```

## 9.2 分析输出 Schema

```json
{
  "event_type": "CLUMPING",
  "observed_facts": [
    {
      "text": "A review reports pods sticking together",
      "references": [
        {
          "evidence_id": "uuid-evidence",
          "version": 1,
          "quote": "Pods stuck together in the package."
        }
      ],
      "evidence_quality": "MEDIUM",
      "quality_reason": "Traceable third-party review; supports one reported experience only"
    }
  ],
  "business_hypotheses": [
    {
      "type": "POTENTIAL_PRODUCT_IMPROVEMENT_NEED",
      "confidence_label": "LOW",
      "reason": "A complaint alone does not establish buying intent"
    }
  ],
  "intent_signal": "UNKNOWN",
  "missing_information": ["Historical complaint baseline", "Procurement plan"],
  "uncertainty": "HIGH",
  "model_version": "MODEL_VERSION",
  "prompt_version": "PROMPT_VERSION"
}
```

枚举：

```text
evidence_quality: HIGH / MEDIUM / LOW / UNVERIFIED
uncertainty: LOW / MEDIUM / HIGH
intent_signal: DIRECT / INDIRECT / UNKNOWN
claim.validation_status: SUPPORTED / UNSUPPORTED / NEEDS_REVIEW
```

证据质量由规则判定并记录原因，模型只提出建议；按每条待支持事实分别判断：

| 等级 | 判定条件 |
|---|---|
| HIGH | 已核对的第一方原始记录，对应品牌/产品与该事实，具有明确时间或当前状态的核验时间；只支持该记录直接说明的事实 |
| MEDIUM | 已核对的可追溯第三方原始记录，归属与原文明确；或第一方记录存在非关键时间缺口。单条评论可达此级，但只支持“有一条反馈” |
| LOW | 出处存在，但归属、时间或上下文有影响结论的缺口；仅作补充线索 |
| UNVERIFIED | 未核对出处与原文，含搜索摘要、无可核验来源的粘贴文本 |

无效证据不参与分档。重复转载或同一评论的多次抓取不增加独立证据数量；多条 LOW 不自动合成为 HIGH。品牌品类、市场和开发依据各自需要支持，不能用一条高质量证据覆盖其他事实的缺口。

## 9.3 硬性约束

- 单条差评只能记录一次观察事实，不能表述为高频投诉。
- 没有时间序列时不能声明问题正在增加。
- 不得从差评直接推断原代工厂存在质量缺陷。
- 不得从产品事件直接推断采购意图。
- 无法确认时使用 `UNKNOWN`。
- 模型失败或 Schema 无效时不能自动创建优先审核机会。
- 原始证据只作为不可信数据输入，不能作为系统指令。
- AI 输出必须通过 JSON Schema 和业务规则校验；第 9.2 节 JSON 是输出示例，研发应据此约束必填字段、类型、枚举和证据引用。
- 系统确定性检查引用是否存在、同租户、版本是否有效、原文片段是否对应，以及工厂字段是否已验证；模型辅助检查语义支持和遗漏 Claim，最终由人工审核。存在引用 ID 不等于事实被支持。
- `SUPPORTED` 只表示该 Claim 在限定表述下有支持；扩大范围、因果或频率的陈述标为 `UNSUPPORTED` 或 `NEEDS_REVIEW`。人工编辑的全文同样提取并检查事实性 Claim。

## 9.4 模型评估

试点前建立人工标注集，至少覆盖：明确产品问题、模糊评论、单条负面反馈、重复反馈、新品发布、无关品牌、能力不匹配、无来源文本、提示注入、虚构认证和无法判断情况。

验收时记录：

- 事件分类准确率或宏平均 F1。
- `UNKNOWN` 的误判率。
- unsupported Claim 阻断召回率。
- 单条差评错误升级为高频问题的比例。
- 模型或 Prompt 版本变更前后的回归结果。

样本量和阈值由产品、数据和研发负责人在试点前确认；“200 条”仅作为初始建议，不是固定承诺。

---

# 10. 工厂匹配与机会审核

## 10.1 硬约束与合格线索

| 条件 | 匹配状态与审核规则 |
|---|---|
| 产品品类或目标市场明确不支持 | `NOT_FIT`，阻断合格审核 |
| 单位、包装、周期可比较且 MOQ/产能存在明确冲突 | `NOT_FIT`，阻断合格审核 |
| 品牌身份、目标品类或美国在售证据缺失 | `NEEDS_REVIEW`，须补齐这些基础证据后才可合格 |
| 基础证据已满足，但采购量、具体 SKU、MOQ 换算或交期需求未知 | `NEEDS_REVIEW`，允许人工确认“值得首次联系”并记录待核验项后合格 |
| 基础证据满足，已参与匹配的条件没有冲突或未决项 | `ELIGIBLE`，仍需人工审核 |

每个检查项保存 `PASS / CONFLICT / UNKNOWN`、理由和证据引用。未知采购量不填零、不视为已匹配，也不要求业务员为了首次联系补造需求。`QUALIFIED` 是线索审核结论，与 `fit_status` 分开；允许 `QUALIFIED + NEEDS_REVIEW`，页面始终保留 MOQ 等待确认项。

## 10.2 机会创建和复用

- 同一租户内每个已确认品牌、品类维护一条 Opportunity，以 `(organization_id, account_id, product_category)` 唯一。工厂在 MVP 中每租户一份能力档案，不按产品、事件、市场或任务拆出重复开发对象。
- 品类未确认的发现记录先保留在任务发现记录中，不创建品类未知的机会；无法确认具体 SKU 时仍可创建品类已确认的品牌级机会，`product_id` 可空且不参与去重。
- 同品牌的不同产品、漏液反馈和新品事件只追加证据与分析；不同任务通过 `research_job_results` 引用同一机会，保留各次研究快照。
- 新证据不覆盖旧评估、已批准草稿、负责人或销售记录。发现基础事实冲突时触发重评估；复用结果明确显示“已有机会”。
- `REJECTED` / `ARCHIVED` 或销售阶段 `WON` / `LOST` 的对象仍复用，列入任务的已有终态记录，不自动恢复、不生成新触达草稿，也不计入候选返回数量。
- Owner 可填写原因后重新开启拒绝/归档的资格状态；销售终态在 MVP 不自动重开。身份歧义须先人工消歧，复杂跨域名品牌合并延期。

## 10.3 资格状态

```text
NEW
→ REVIEWING
→ QUALIFIED
```

分支：

```text
NEW / REVIEWING → NEEDS_EVIDENCE
NEEDS_EVIDENCE → REVIEWING（缺失基础证据已补齐）
REVIEWING → REJECTED
NEW / REVIEWING / NEEDS_EVIDENCE / QUALIFIED / REASSESSMENT_REQUIRED → ARCHIVED
QUALIFIED → REASSESSMENT_REQUIRED
REASSESSMENT_REQUIRED → REVIEWING（新评估已完成）
REJECTED / ARCHIVED → REVIEWING（Owner 明确重开并填写原因）
```

规则：

- `QUALIFIED` 须满足第 10.1 节的基础证据、无已知硬冲突和待确认项确认要求；至少一条与工厂能力相关的事实支持开发理由。
- `REJECTED` 必须填写原因。
- `NEEDS_EVIDENCE` 必须列出缺失项。
- 归档、拒绝和重评估必须记录操作者、时间和原因。
- 并发审核使用 `expected_version`，冲突返回 `409`。
- 已合格机会的关键证据失效后进入 `REASSESSMENT_REQUIRED`，历史审核和销售阶段不删除；其他资格状态保留并显示缺口。草稿按第 11.3 节撤销可用批准。

---

# 11. 联系人与 AI 邮件草稿

## 11.1 联系人

字段：

- `full_name`
- `account_id`
- `job_title`
- `department`
- `email`
- `linkedin_url`
- `source_url`
- `source_checked_at`
- `verification_status`
- `role_relevance`
- `suppression_status`

规则：

- 邮箱格式正确不等于邮箱有效。
- 联系人来源必须记录。
- `UNVERIFIED` 不能显示为已验证。
- 来源失效或联系人离职时标记 `STALE`。
- Agent 自动发现联系人或相关职能邮箱，记录 `verification_status`（`UNVERIFIED / VERIFIED / STALE`）；`VERIFIED` 要有公开身份/职能关联和渠道来源的核对记录，不代表投递一定成功。
- 联系人未知时允许人工补录后重新生成；个人姓名未知但有真实的相关职能邮箱时，使用通用称呼，不捏造个人身份。
- `SUPPRESSED` 联系人不生成新触达草稿，已有草稿按第 11.3 节处理。抑制记录按组织及规范化联系渠道生效，重复导入不绕过抑制。
- 组织级抑制记录优先于单个草稿状态。
- MVP 不强制接入付费联系人 API。

## 11.2 草稿输入与输出

输入可来自尚未审核但无已知硬冲突的候选机会，须有目标品牌、带来源的联系人候选、已核验证据、已验证工厂能力和开发理由。Agent 生成 `DRAFT` 不要求商机先为 `QUALIFIED`，也不赋予发送资格。

没有联系人则记录 `NO_CONTACT`，事实不足则记录 `INSUFFICIENT_FACTS`，保留商机并跳过生成；这类业务缺失不算模型故障。联系人候选尚未人工确认时可以生成待审草稿，批准前须完成联系人核对。

输出：

```json
{
  "subject": "...",
  "body": "...",
  "claim_references": [
    {
      "claim_id": "claim-1",
      "claim_text": "...",
      "references": [
        {
          "kind": "EVIDENCE",
          "evidence_id": "uuid-evidence",
          "version": 1,
          "quote": "原始引用片段"
        }
      ],
      "validation_status": "NEEDS_REVIEW"
    }
  ],
  "warnings": [],
  "generation_status": "DRAFT"
}
```

规则：

- 默认英文，建议 80–130 词。
- 不得编造认证、配方参数、客户案例或采购意向。
- 不得把推断写成确定事实。
- 每条事实性 Claim 必须有证据或工厂档案引用。`references` 另支持 `{"kind":"FACTORY_CAPABILITY","profile_version":3,"field_path":"production_terms[0].moq_quantity"}`；引用字段必须已核验。档案激活不等于所有能力已经核验，记录字段核验人和时间。
- 示例中的 Claim、引用和状态属于模型建议，服务端执行引用校验，再由业务员确认语义支持；问候、请求会议等非事实性内容不强制添加证据。
- 工厂能力核验由 Owner 完成；模型不得自行把档案字段升级为已验证。引用旧档案版本时同时检查该能力是否已被当前档案撤回或修改。
- Claim 引用不存在、证据失效或能力未验证时，草稿进入 `BLOCKED` 或 `IN_REVIEW`。
- 只有 `QUALIFIED` 机会、人工确认的 `VERIFIED` 非抑制联系人、所有事实性 Claim 为 `SUPPORTED` 且依赖仍有效的版本才能进入 `APPROVED`。Owner/Member 可审核自己的草稿，逐版本记录审核人及时间；MVP 不强制双人审批。
- 审核后编辑必须创建新版本并使旧审核失效。
- 复制事件不等于发送事件。

草稿状态：

```text
GENERATING → DRAFT → IN_REVIEW → APPROVED
```

异常状态：

```text
GENERATION_FAILED / BLOCKED / REJECTED / SUPERSEDED
```

## 11.3 批准绑定与失效

批准绑定 `draft_version_id`、资格审核版本、联系人 ID/版本、引用的证据版本和工厂档案版本。批准历史不可覆盖，当前可用性单独校验：

- 编辑草稿：旧版本变为 `SUPERSEDED`，新版本进入 `IN_REVIEW`，不得继承批准。
- 证据被证伪/清除、引用能力被撤回或认证过期、联系人被抑制：受影响的已批准草稿进入 `BLOCKED`，保留原审核记录。
- 商机进入重评估/归档/拒绝，联系人变为 `STALE` 或相关能力更新：受影响草稿进入 `IN_REVIEW`，重新核验后才可批准；无关字段更新不触发全量撤销。
- 可重审的阻断项修复后通过 `BLOCKED → IN_REVIEW → APPROVED` 恢复；模型生成失败通过显式重试重新生成，不复用旧批准。
- 每次获取“复制已审核内容”时，服务端重新核对当前资格、抑制、有效期及依赖状态，只返回当前有效的已批准版本。后台重评估尚未完成或旧页面缓存不得绕过这次检查。
- 系统控制的是已审核复制操作；不宣称能撤回外部邮箱中已复制或已发送的内容。已发送活动保留当时的草稿版本，后续失效不删除历史。

---

# 12. 人工销售执行

## 12.1 发送记录

流程：

1. 打开已审核草稿。
2. 复制主题或正文。
3. 在外部邮箱人工发送。
4. 返回系统点击“记录已发送”。
5. 填写联系人、发送时间、渠道和备注。
6. 系统创建 `EMAIL_SENT` 活动。

规则：

- 复制不改变销售阶段。
- 系统不得声称验证了外部发送行为。
- 重复提交使用 `Idempotency-Key` 防止重复活动。
- 发送时间可以补录，保留 `occurred_at`、`created_at`、操作者及实际使用的 `draft_version_id`（外部自行撰写可为空）；如补录已失效草稿的历史发送，只记录事实并显示警告，不恢复批准。

## 12.2 活动类型

```text
EMAIL_SENT
REPLY_RECEIVED
MEETING_SCHEDULED
SAMPLE_REQUESTED
SAMPLE_SENT
QUOTATION_SENT
FOLLOW_UP
DEAL_WON
DEAL_LOST
```

每条活动记录 `occurred_at`、`created_at`、操作者和发生时负责人。回复增加 `reply_sentiment`（`POSITIVE / NEUTRAL / NEGATIVE / UNKNOWN`）：正向指明确愿意继续讨论、索要资料、样品或报价，不包含自动回复、退订和礼貌性拒绝。成交金额未知可空，填写金额时须同时填写币种。

## 12.3 销售阶段

```text
NOT_STARTED
→ CONTACTED
→ REPLIED
→ MEETING
→ SAMPLE
→ QUOTATION
→ WON
```

任一非终态可以进入 `LOST`。

- 未记录 `EMAIL_SENT` 不得进入 `CONTACTED`。
- 未记录 `REPLY_RECEIVED` 不得进入 `REPLIED`。
- 允许阶段跳跃，但必须有对应活动依据。
- `WON` 必须记录成交日期；金额未知时保存为空，不得伪造。
- `LOST` 必须填写原因。
- `EMAIL_SENT / REPLY_RECEIVED / MEETING_SCHEDULED / SAMPLE_REQUESTED或SAMPLE_SENT / QUOTATION_SENT / DEAL_WON` 分别支持对应阶段；`FOLLOW_UP` 不推进阶段，`DEAL_LOST` 进入 LOST。
- 普通活动只推进至更高的有依据阶段；补录更早的邮件或回复不会把当前 SAMPLE 降回 CONTACTED。终态后的历史补录不改变 WON/LOST，冲突的成交/丢单结论需 Owner 明确更正并填写原因。
- 误录活动采用作废并补记方式，保留原记录、原因和操作者；更正时按未作废活动重算阶段并追加历史。时间相同的普通活动取较高阶段，终态更正以 Owner 的显式操作为准。
- 阶段历史不可覆盖。
- `CONTACT_READY`、`DRAFT_READY` 作为页面派生提示，不作为独立销售阶段。

---

# 13. 页面与导航

## 13.1 页面路由

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` | Research Home | 创建研究任务，显示待审核任务和机会 |
| `/onboarding` | 工厂初始化 | 首次配置工厂能力 |
| `/settings/factory` | 工厂能力档案 | 编辑、发布和查看版本 |
| `/research-jobs/new` | 新建研究任务 | 选择目标市场，继承品类，展示可调整条件和执行限额 |
| `/research-jobs/:id` | 研究任务详情 | 查看进度、失败项和结果 |
| `/opportunities` | Opportunity Inbox | 审核候选机会 |
| `/opportunities/:id` | 商机详情 | 证据、匹配、联系人、草稿和活动 |
| `/accounts` | 品牌池 | 品牌和产品管理、CSV 导入 |
| `/evidence` | 证据管理 | 查询和补充证据 |
| `/contacts` | 联系人管理 | 联系人、来源和抑制状态 |
| `/analytics` | 基础漏斗 | 统计研究与销售结果 |
| `/settings/team` | 成员管理 | 邀请和停用成员 |

登录后优先进入 `/`，展示需要审核的研究结果和待办，不展示原始采集数量作为主要指标。

## 13.2 研究任务页面

必须显示：

- 任务输入快照。
- 执行状态、当前步骤、预算使用量和停止原因；审核进度单独展示。
- 已发现、已过滤、证据不足、匹配失败、联系人缺失和草稿失败数量。
- 可用结果数量。
- 部分完成原因。
- 重新运行、取消和查看失败项操作。

---

# 14. API 契约

## 14.1 通用约定

- Base URL：`/api/v1`
- 认证：Bearer Token。
- 租户由认证身份和服务端 Membership 解析，不能信任客户端传入的 `organization_id`。
- 数据格式：JSON，UTF-8。
- 分页：Cursor Pagination，默认 20，最大 100。
- 时间：ISO 8601 UTC。
- ID：UUID。
- 可修改对象带 `version`，状态变更带 `expected_version`。
- 创建和关键状态变更支持 `Idempotency-Key`。
- 对象不存在和跨租户不可访问统一返回 `404`，不泄露对象存在性。

统一错误结构：

```json
{
  "error": {
    "code": "INVALID_TRANSITION",
    "message": "Opportunity cannot be qualified",
    "details": {"current_status": "NEEDS_EVIDENCE"},
    "request_id": "req_example_001"
  }
}
```

幂等规则：

- Key 按租户、用户、接口和操作范围隔离。
- 相同 Key 与不同请求体返回 `409 IDEMPOTENCY_CONFLICT`。
- 已完成请求在 24 小时保留窗口内返回原结果，进行中的请求始终返回已有任务。窗口外仍依赖业务唯一约束防止重复机会；新研究可显式创建新任务。
- `retry` 同样支持幂等键和版本检查，增加 attempt，遵循第 4.2 节剩余预算。`cancel` 幂等，已结束任务保持原终态。
- 已审核复制请求即使使用相同幂等键，也须先重新检查当前授权与第 11.3 节的依赖有效性；幂等回放不得返回已失效的可用批准。
- 所有异步写回检查当前 attempt 与任务状态；租户停用或授权撤销后停止相关任务的后续访问和写入。

## 14.2 API 清单

### 组织与工厂

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/organizations` | 创建组织 |
| GET | `/organizations/current` | 当前组织 |
| GET | `/members` | 成员列表 |
| POST | `/members/invitations` | 邀请成员 |
| PATCH | `/members/{id}` | 修改角色或停用 |
| GET | `/factory-profile` | 获取当前档案 |
| PUT | `/factory-profile` | 保存草稿 |
| POST | `/factory-profile/activate` | 发布新版本 |

### 研究任务

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/research-jobs` | 创建目标市场研究任务 |
| GET | `/research-jobs` | 查询任务 |
| GET | `/research-jobs/{id}` | 查询 status、current_step、attempt、stop_reason、预算、缺口和待审核数量 |
| POST | `/research-jobs/{id}/cancel` | 取消任务 |
| POST | `/research-jobs/{id}/retry` | 重试失败步骤 |
| GET | `/research-jobs/{id}/results` | 获取本次结果快照及当前资格/失效提示，新建与复用分别计数 |
| GET | `/research-jobs/{id}/failures` | 获取失败项 |

### 品牌、产品和证据

| Method | Endpoint | 说明 |
|---|---|---|
| GET | `/accounts` | 品牌列表 |
| POST | `/accounts` | 新增品牌 |
| PATCH | `/accounts/{id}` | 更新品牌 |
| POST | `/accounts/imports` | CSV 导入 |
| GET | `/accounts/imports/{job_id}` | 查询导入结果 |
| POST | `/accounts/{id}/products` | 新增产品 |
| GET | `/accounts/{id}/products` | 产品列表 |
| POST | `/evidence` | 新增证据 |
| POST | `/evidence/imports` | 按第 6.3 节导入证据 CSV |
| GET | `/evidence/imports/{job_id}` | 查询逐行导入结果 |
| GET | `/evidence` | 查询证据 |
| GET | `/evidence/{id}` | 证据详情 |
| POST | `/evidence/{id}/analyze` | 启动分析 |
| POST | `/evidence/{id}/verify` | 人工核对来源或重新验证，保留核验记录 |
| POST | `/evidence/{id}/invalidate` | 标记失效 |

### 商机、联系人和草稿

| Method | Endpoint | 说明 |
|---|---|---|
| GET | `/opportunities` | 查询商机 |
| GET | `/opportunities/{id}` | 商机详情 |
| POST | `/opportunities/{id}/transitions` | 资格状态变更 |
| POST | `/opportunities/{id}/assignments` | 分配负责人 |
| POST | `/opportunities/{id}/reassess` | 重新评估 |
| GET | `/opportunities/{id}/history` | 机会历史 |
| GET | `/contacts` | 查询联系人与验证/抑制状态 |
| POST | `/contacts` | 创建联系人 |
| PATCH | `/contacts/{id}` | 修改联系人 |
| POST | `/contacts/{id}/suppress` | 抑制联系人 |
| POST | `/opportunities/{id}/drafts` | 生成草稿 |
| GET | `/drafts/{id}` | 草稿详情 |
| PATCH | `/drafts/{id}` | 创建新版本 |
| POST | `/drafts/{id}/review` | 审核草稿 |
| POST | `/drafts/{id}/copy-events` | 重新校验批准及依赖，返回已批准版本内容并记录复制请求；不证明外部发送 |

### 活动与统计

| Method | Endpoint | 说明 |
|---|---|---|
| POST | `/opportunities/{id}/activities` | 记录活动 |
| GET | `/opportunities/{id}/activities` | 活动列表 |
| POST | `/opportunities/{id}/activities/{activity_id}/void` | Owner 作废误录活动，保留原因并重算阶段 |
| POST | `/follow-up-tasks` | 创建跟进任务 |
| GET | `/follow-up-tasks` | 获取当前租户待办 |
| PATCH | `/follow-up-tasks/{id}` | 更新跟进任务 |
| GET | `/analytics/funnel` | 获取漏斗指标 |

## 14.3 创建研究任务示例

`POST /api/v1/research-jobs`

```json
{
  "market": "US",
  "product_categories": ["LAUNDRY_PODS"],
  "account_types": ["INDEPENDENT_BRAND", "ECOMMERCE_BRAND"],
  "quantity": 20,
  "min_evidence_quality": "MEDIUM",
  "contact_preferences": ["PRODUCT", "PROCUREMENT"],
  "language": "en"
}
```

成功：`202`

```json
{
  "job_id": "uuid-job",
  "status": "QUEUED",
  "current_step": null,
  "attempt": 1,
  "factory_profile_version": 3,
  "request_id": "req_example_001"
}
```

---

# 15. 数据看板

## 15.1 P0 指标

漏斗先选择“机会首次创建于所选时间段”的候选队列，再观察截至 `as_of` 的销售结果；同一机会在每个阶段最多计一次，允许业务跳级，因此不强制各阶段层层递减。任务和证据数量单独作为运营指标，不作为销售转化分母。

| 指标 | 定义 |
|---|---|
| Research Jobs | 按创建时间统计任务数，按最新执行终态分组；重试不计为新任务，取消单列 |
| Evidence Count | 按首次观察时间统计去重证据；VERIFIED、UNVERIFIED、INVALIDATED 分列，不把重复抓取算新增 |
| Candidate Opportunities | 所选创建期的去重机会数，包含后续被拒绝/归档对象；任务内待消歧和品类未确认记录不计入 |
| Qualified Opportunities | 队列中首次最终资格结论为 QUALIFIED 的机会数；首次最终结论取首次 QUALIFIED 或 REJECTED，重评估不重复计数 |
| Qualification Rate | 首次最终结论为 QUALIFIED 的机会数 / 已有首次最终结论的机会数；待补证据及未审归档不进入分母 |
| Contacted Opportunities | 队列中有未作废 EMAIL_SENT 的去重机会数 |
| Positive Replies | 队列中有未作废、人工标为 POSITIVE 的 REPLY_RECEIVED 的去重机会数 |
| Meetings | 队列中有未作废 MEETING_SCHEDULED 的去重机会数 |
| Sample Requests | 队列中有未作废 SAMPLE_REQUESTED 的去重机会数 |
| Quotations | 队列中有未作废 QUOTATION_SENT 的去重机会数 |

当前合格机会数、当前待重评数作为工作台状态统计，明确与上述首次审核转化指标区分。首次拒绝后重开合格不回写首次合格率，当前状态中可见。

所有统计强制租户过滤。按任务过滤时取任务结果关联的机会集合，跨任务汇总先按机会 ID 去重，任务之间不可直接相加，也不把多次发现宣称为多次新增客户。漏斗负责人固定为首次最终审核时负责人，尚未审核则用创建时负责人；后续转派不改写该归属。品类按机会记录过滤。

销售证据使用 `occurred_at ≤ as_of` 的未作废活动，记录创建时间用于审计。补录或更正允许历史结果重算，报表显示统计截止日和生成时间；不承诺历史报表数值永不变化。所有比率分母为零显示 `N/A`。事件发生次数仅在活动明细中展示，不混入去重机会漏斗。

---

# 16. 非功能需求

| 维度 | P0 要求 |
|---|---|
| 安全 | 所有租户接口执行服务端授权；跨租户访问不泄露存在性 |
| 凭据 | API 密钥加密存储，不写入日志或模型输入；业务数据仅向选定供应商传送当前任务必要字段，并落实数据保留约定 |
| 审计 | 任务、来源、状态变更、审核、导出、复制和活动均记录 |
| 可用性 | 研究任务可取消、可重试、可查看失败项；至少一次投递、幂等消费 |
| 性能 | 常规列表 p95 小于 1 秒，不含 AI 和研究任务 |
| AI 延迟 | 异步执行，前端显示任务状态和失败原因 |
| 数据导出 | 仅导出当前租户有权限的数据；CSV 导出防止公式注入 |
| 数据保留 | 按来源授权和租户策略配置；失效来源可追溯 |
| 可观测性 | request ID、job ID、模型成本、耗时、错误率和来源失败率 |
| 备份 | 定期备份并验证恢复流程 |

---

# 17. QA 验收重点

## 17.1 研究任务

| 场景 | 预期 |
|---|---|
| 空品牌池中仅提交 US | 继承洗衣凝珠品类，从真实来源发现新品牌并保存产品及美国在售证据；返回任务 ID |
| 提交首发以外市场或品类 | 返回第 3.3 节定义的 422，不静默扩范围 |
| 工厂档案未激活 | 禁止创建研究任务，并说明缺失项 |
| 同请求重放及不同任务重复发现 | 同幂等键返回已有任务；不同任务引用同一品牌品类机会，负责人及审核不覆盖 |
| 来源适配器失败 | 任务进入 `PARTIAL` 或 `FAILED`，显示失败原因 |
| 任务取消或旧 attempt 迟到返回 | 不调度新请求，不覆盖终态或写入新业务结果，已保存结果保留 |
| 任务使用旧工厂档案 | 结果显示创建时的档案版本 |
| 请求 quantity 超过 50 | 创建时返回 422，不静默截断 |
| 来源正常但结果少于目标或为零 | 如实返回 COMPLETED 和 SOURCE_SCOPE_EXHAUSTED，不编造结果 |
| 预算/时间耗尽 | 停止新调用并返回 PARTIAL，保留已完成结果和停止原因，重试不重置预算 |
| 研究完成但无人审核，或联系人查无结果 | 不等待人工审核；联系人缺失单列，正常查无结果不判为工具故障 |

## 17.2 证据与 AI

| 场景 | 预期 |
|---|---|
| 单条差评 | 识别事件，但不声明高频问题或采购意向 |
| 无来源文本 | 标记 `UNVERIFIED`，不进入优先审核 |
| 原文包含提示注入 | 作为数据处理，不执行其中指令 |
| 模型返回非法 JSON | 任务失败或进入人工重试，不生成优先审核机会 |
| 虚构认证 | Claim 为 `UNSUPPORTED`，草稿不能批准 |
| 证据被证伪或引用认证过期 | 受影响合格机会进入重评估，已批准草稿阻断；旧页面的已审核复制请求仍被拦截 |
| 引用 ID 存在但原文不支持陈述 | Claim 不通过；不能仅凭引用存在批准草稿 |
| 来源暂时打不开且已有核验留存 | 标记 UNAVAILABLE，历史事实不自动失效；超出有效期的“当前在售”陈述须重新核验 |

## 17.3 匹配、审核和销售

| 场景 | 预期 |
|---|---|
| 品类不匹配 | `NOT_FIT`，不进入优先审核 |
| MOQ/采购量未知但基础证据满足 | `NEEDS_REVIEW`；人工确认待核验项后可 QUALIFIED，仍不声称已匹配 |
| MOQ 单位或包装条件不同且无换算依据 | 不作数值比较，保留待确认项 |
| 未审核候选具备联系人与可靠事实 | 自动生成 DRAFT；机会及联系人尚未确认时不批准 |
| 缺失证据已补齐 | NEEDS_EVIDENCE 可恢复 REVIEWING，不必另建机会 |
| 缺少证据审核合格 | 状态变更被拒绝 |
| 两人同时审核 | 版本冲突方收到 `409` |
| 审核后修改草稿 | 新版本回到 `IN_REVIEW` |
| 复制草稿 | 记录复制事件，不创建 `EMAIL_SENT` |
| 人工确认发送 | 创建一次 `EMAIL_SENT`，销售阶段变为 `CONTACTED` |
| 重复提交活动 | 不产生重复活动 |
| 联系人被抑制 | 新草稿阻断，已有批准失效，重新导入相同渠道仍受抑制 |
| 成交金额未知 | 保存空金额，不伪造数值 |
| 漏斗分母为零 | 显示 `N/A` |
| 同一机会多次回复/报价或跨任务复用 | 漏斗每阶段按机会去重，不累计为多个客户 |
| SAMPLE 阶段补录早期邮件 | 保留历史邮件，当前阶段不降回 CONTACTED |
| 停用成员访问 | 后续读取和写入均被拒绝 |

---

# 18. 研发交付计划

## Slice 1：可运行数据闭环

- 组织、成员和租户授权。
- 工厂档案及版本。
- 品牌 CSV 导入、产品和手工证据。
- 证据查询和基础审计。

**退出条件：** 可从品牌导入追溯到原始证据。

## Slice 2：研究任务与商机

- `research_jobs` 状态和进度。
- 第一条已验证自动发现路径，人工品牌池作为可用兜底。
- 事件分类、证据质量和硬约束匹配。
- Opportunity Inbox 和人工审核。

**退出条件：** 在空品牌池中仅输入美国市场，继承首发品类后发现新品牌，返回带产品和美国在售证据的候选；重复任务准确复用已有机会。

## Slice 3：联系人和可信草稿

- 联系人来源、验证和抑制。
- 草稿生成、Claim 校验、版本和审核。
- 复制事件。

**退出条件：** 未审核候选可自动生成 DRAFT；商机与联系人确认后可批准，依赖失效后旧批准与已审核复制操作立即失效。

## Slice 4：销售闭环与试点

- 活动和销售阶段。
- 跟进任务。
- 基础漏斗。
- 核心回归和真实业务员试点。

**退出条件：** 完成“目标市场 → 商机 → 人工发送 → 销售结果”的端到端路径。

## Slice 5：自动化增强（P1）

- 更多来源适配器。
- 定时研究和增量更新。
- 邮箱同步。
- 排序校准和更多团队能力。

---

# 19. 发布门禁

## Gate A：数据来源

- 至少一条真实自动发现路径有使用方式和授权核验记录，证明能从市场/品类条件检索新品牌，而非仅分析人工给定 URL。
- 使用空品牌池进行验收：只输入 `US`，继承洗衣凝珠能力，发现此前不存在的真实品牌，并保存品牌、产品、美国在售的原始证据。该路径须先在当前来源环境验证至少存在一个可发现结果；零结果场景另行验收，不用伪造结果替代。
- 人工品牌池和 CSV 可验收兜底，但单独通过兜底不满足自动化发布门禁。
- 原始证据、来源 URL、采集时间和失败原因可追溯。
- 没有未经验证的实时覆盖承诺。

## Gate B：Agent 与 AI

- 研究任务状态可追踪、可取消、可重试；正常零结果、数量不足、预算耗尽、工具失败和迟到回写分别通过验收。
- 输出通过 Schema 和业务规则校验。
- 事实性 Claim 可追溯到证据或工厂档案。
- 单条差评、采购意向和供应商责任不会被过度推断。
- 已完成人工标注集评估和版本回归。
- 记录模型成本、失败率和耗时。

## Gate C：业务闭环

- 至少一名真实业务员完成完整路径。
- 合格机会定义为值得首次联系，无已知硬冲突；采购量未知可带待核验项审核合格，拒绝原因一致。
- 能记录人工发送与销售结果。
- 能查看基础漏斗，并解释每个指标口径。
- 能识别不相关线索及原因；已完成与人工研究的同口径试点对照，记录样本量、成本和审核时间。

## Gate D：安全与工程

- 跨租户访问、状态机、幂等和并发测试通过。
- 来源访问具备 SSRF 防护和限流。
- 联系人抑制生效。
- 凭据不进入日志、Prompt 或记忆库。
- 数据备份和恢复经过验证。
- 关键错误具备 request ID、job ID 和告警信息。

任一关键 Gate 未通过，不得对外宣称正式生产就绪。

---

# 20. 冻结前决策表

| 决策 | 当前建议 | 责任人 |
|---|---|---|
| 首个试点工厂 | 已确认使用用户提供的 LANCCO 官网 https://lancco.com 作为工厂资料起点；美国承接能力及具体参数待核验 | 产品/业务 |
| 首发范围 | 已定：US + LAUNDRY_PODS；其他市场/品类输入返回明确错误 | 产品/研发 |
| 首批结果量 | 默认返回 20 个，按试点反馈调整 | 产品/业务 |
| 首个来源 | 本地开发版已接入自建 SearXNG 作为发现搜索，并配合公开页面读取；正式试点的来源授权、限速、保留规则和付费联系人库仍待确认 | 数据/研发 |
| 执行限额 | 校准第 4.2 节的请求、时间与费用限额，配置调用前预算预留；不承诺固定返回延迟 | 产品/研发 |
| 候选机会合格标准 | 已定：基础证据满足 + 无已知硬冲突 + 人工确认开发理由及待核验项 | 产品/业务 |
| AI 模型供应商 | 本地开发版已验证 Anthropic 兼容消息接口并接入本机中转网关；模型标识由环境配置，JSON 输出由服务端校验。正式供应商、费用、数据保留和模型评估仍待确认 | AI/研发 |
| 联系人数据使用 | 明确来源、保留期限、抑制和导出规则 | 产品/合规 |
| 试点周期 | 由业务负责人确认，至少覆盖一轮人工触达和跟进 | 产品/业务 |
| 试点成功阈值 | 试点开始前填写 H1–H4 目标、人工基线、观察截止日、样本量和判定规则 | 产品/数据 |

未决项按责任角色指派具体负责人：来源、模型与执行预算在相关开发契约冻结前落实，联系人保留规则在导入真实联系人前落实，试点目标在试点开始前落实。评审记录须填具体负责人、日期和验证证据；当前 PRD 不将这些外部依赖标记为已解决。

## 20.1 已提供的工厂资料与接入条件

2026-11-12 读取用户提供的官网及其链接页面。以下为官网声明，可预填工厂草稿；网站内容核对不等于内部能力验证或证书核验：

| 来源 | 可提取资料 | 使用边界 |
|---|---|---|
| [首页](https://lancco.com) | LANCCO (FOSHAN) BIOTECHNOLOGY；洗衣凝珠 OEM/ODM、配方开发、包装定制和出口支持；月产能标为 20M+ units | 月产能计量口径和适用产品待确认；全球出口表述不自动证明美国承接能力 |
| [OEM/ODM](https://lancco.com/en/oem-odm) | 袋、桶、盒等包装；试单 50,000 units / 25–30 天，常规 200,000 / 28–35 天，批量 500,000+ / 35–45 天 | units 的计量单位及配方、包装前提待确认，不作为统一 MOQ/交期 |
| [LunaSquare 四腔产品](https://lancco.com/en/products/LunaSquare) | 20–25g；现成配方 MOQ 20,000 Pieces、定制配方 50,000 Pieces；交期 20–30 天；供应量 500,000 Pieces/周 | 仅适用于该产品页面的条件，不外推至全部品类；不能与工厂月产能直接相互替代 |

官网出现的认证、抗菌、包装安全及性能表述，在 Owner 核对有效证明与适用范围前不作为已验证 Claim。初期模型输入仅使用公开资料及用户明确认可的工厂能力；未公开业务资料的传输规则另行确认。

网关模型调用与搜索服务是两项独立能力。本地开发版已分别接入本机 Anthropic 兼容消息接口和自建 SearXNG：模型标识由环境配置，结构化 JSON 由服务端校验；搜索只读取公开页面，不绕过登录或付费墙。本地开发版也已验证模型生成英文草稿的引用校验流程，生成的草稿只创建 `DRAFT`，仍需人工审批和复制前重验；证据信号分析同样经服务端引用校验后保存，且不改变商机资格。密钥只通过运行环境配置，不写入 PRD、日志或记忆。正式试点的搜索供应商、月度预算、部署位置和数据保留规则仍未确定，当前未开通付费搜索服务。

## 最终交付定义

MVP 完成的标准不是页面数量，而是以下闭环稳定可运行：

```text
业务员仅选择受支持的目标市场，继承已配置工厂品类
→ Agent 自动发现品牌并交付证据、匹配、联系人候选与未审核草稿（缺失项如实列明）
→ 研究任务结束，业务员审核匹配和证据
→ 确认或补充联系人
→ 编辑并批准英文草稿，必要时补资料后重生成
→ 业务员人工发送
→ 系统记录销售结果
→ 看板显示真实转化
```

Agent 可以自动研究和准备结果，但在 MVP 中不自动发送邮件、不自动确认采购意向、不自动把未经审核的对象标记为合格商机。
