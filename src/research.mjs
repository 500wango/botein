import { createHash, randomUUID } from 'node:crypto';
import { ORG, audit, profile, transaction } from './store.mjs';
import { AppError, requireValue, text } from './validation.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';

const ACCOUNT_TYPES = ['INDEPENDENT_BRAND', 'ECOMMERCE_BRAND'];
const CONTACT_PREFERENCES = ['PRODUCT', 'PROCUREMENT', 'QUALITY'];
const TIER_ORDER = { PRIORITY_REVIEW: 0, NEEDS_INFORMATION: 1, NOT_FIT: 2 };
const SEVEN_DAYS = 7 * 86400000;

// Fixed local execution limits. POOL analysis does not call external services,
// so usage is recorded but stays at zero; DISCOVERY has no adapter yet.
const defaultBudget = () => ({
  limits: { search_requests: 50, page_requests: 200, runtime_ms: 1_800_000, cost_usd: 5 },
  usage: { search_requests: 0, page_requests: 0, runtime_ms: 0, cost_usd: 0 },
});

function researchInput(body) {
  requireValue(body.market === 'US', '首版仅支持美国市场。', 'market', 422, 'UNSUPPORTED_MARKET');
  const categories = body.product_categories ?? ['LAUNDRY_PODS'];
  requireValue(Array.isArray(categories) && categories.length > 0 && categories.every(x => x === 'LAUNDRY_PODS'),
    '首版仅支持洗衣凝珠品类。', 'product_categories', 422, 'UNSUPPORTED_CATEGORY');
  const quantity = body.quantity ?? 20;
  requireValue(Number.isInteger(quantity) && quantity >= 1 && quantity <= 50, '结果上限为 1–50 的整数。', 'quantity');
  const quality = body.min_evidence_quality ?? 'MEDIUM';
  requireValue(['MEDIUM', 'HIGH'].includes(quality), '请选择 MEDIUM 或 HIGH 证据门槛。', 'min_evidence_quality');
  const types = body.account_types ?? ACCOUNT_TYPES;
  requireValue(Array.isArray(types) && types.length > 0 && types.every(x => ACCOUNT_TYPES.includes(x)),
    '请选择有效的品牌类型。', 'account_types');
  const preferences = body.contact_preferences ?? CONTACT_PREFERENCES;
  requireValue(Array.isArray(preferences) && preferences.every(x => CONTACT_PREFERENCES.includes(x)),
    '请选择有效的联系人职能。', 'contact_preferences');
  const language = body.language ?? 'en';
  requireValue(language === 'en', '首版草稿语言为英文。', 'language');
  const mode = body.source_mode ?? 'DISCOVERY';
  requireValue(['DISCOVERY', 'POOL'].includes(mode), '请选择有效来源模式。', 'source_mode');
  return {
    market: 'US', product_categories: ['LAUNDRY_PODS'], account_types: [...new Set(types)], quantity,
    min_evidence_quality: quality, contact_preferences: [...new Set(preferences)], language: 'en', source_mode: mode,
  };
}

function factoryReadiness(db) {
  const factory = profile(db);
  requireValue(factory.status === 'ACTIVE', '请先确认并启用工厂档案。', undefined, 422, 'FACTORY_NOT_ACTIVE');
  requireValue(factory.supported_products.includes('LAUNDRY_PODS'), '工厂档案未确认洗衣凝珠承接能力。', 'supported_products', 422, 'FACTORY_NOT_ACTIVE');
  requireValue(factory.target_markets.includes('US'), '工厂档案尚未确认美国市场承接能力。', 'target_markets', 422, 'FACTORY_NOT_ACTIVE');
  return factory;
}

function jobRow(db, id) {
  const row = db.prepare('SELECT * FROM research_jobs WHERE organization_id=? AND id=?').get(ORG, id);
  requireValue(row, '研究任务不存在。', undefined, 404, 'NOT_FOUND');
  return row;
}

function jobView(row) {
  return {
    id: row.id, status: row.status, current_step: row.current_step, attempt: row.attempt,
    stop_reason: row.stop_reason, input: JSON.parse(row.input_snapshot), factory_version: row.factory_version,
    source_mode: row.source_mode, counts: JSON.parse(row.counts), budget: JSON.parse(row.budget),
    created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at, version: row.version,
  };
}

function contactSnapshot(db, accountId) {
  const rows = db.prepare(`SELECT c.verification_status, s.email AS suppressed FROM contacts c
    LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
    WHERE c.organization_id=? AND c.account_id=?`).all(ORG, accountId);
  const usable = rows.filter(row => row.verification_status === 'VERIFIED' && !row.suppressed).length;
  return {
    total: rows.length, usable,
    status: rows.length === 0 ? 'CONTACT_NOT_FOUND' : usable ? 'AVAILABLE' : 'NO_VERIFIED_CHANNEL',
  };
}

// Deterministic pool analysis. Every judgement below only uses records the user
// already saved and verified; no semantic model or external lookup is involved.
function analyseAccount(db, account, input) {
  const products = db.prepare("SELECT product_category FROM account_products WHERE organization_id=? AND account_id=? AND status='ACTIVE'").all(ORG, account.id);
  const hasPods = products.some(product => product.product_category === 'LAUNDRY_PODS');
  const knownOther = [...new Set(products.filter(product => !['LAUNDRY_PODS', 'UNKNOWN'].includes(product.product_category)).map(product => product.product_category))];
  const onlyKnownOther = products.length > 0 && !hasPods && products.every(product => product.product_category !== 'UNKNOWN');

  const evidence = db.prepare('SELECT id,verification_status,published_at FROM evidence WHERE organization_id=? AND account_id=? ORDER BY observed_at DESC, id').all(ORG, account.id);
  const verified = evidence.filter(item => item.verification_status === 'VERIFIED');
  const latestPublished = verified.map(item => item.published_at).filter(Boolean).sort().at(-1) ?? null;
  const opportunity = db.prepare("SELECT id,qualification_status,sales_stage FROM opportunities WHERE organization_id=? AND account_id=? AND product_category='LAUNDRY_PODS'").get(ORG, account.id);
  const references = opportunity ? db.prepare(`SELECT oe.role,e.verification_status,e.checked_at FROM opportunity_evidence oe
    JOIN evidence e ON e.id=oe.evidence_id AND e.organization_id=oe.organization_id
    WHERE oe.organization_id=? AND oe.opportunity_id=?`).all(ORG, opportunity.id) : [];
  const roleVerified = role => references.some(reference => reference.role === role && reference.verification_status === 'VERIFIED');
  const marketReference = references.find(reference => reference.role === 'MARKET');
  const marketFresh = Boolean(marketReference && marketReference.verification_status === 'VERIFIED' &&
    marketReference.checked_at && Date.now() - Date.parse(marketReference.checked_at) <= SEVEN_DAYS);
  const qualified = opportunity?.qualification_status === 'QUALIFIED';

  // Quality is rule-derived, not model-derived. A manually verified first-party
  // flag is not recorded yet, so the honest ceiling is MEDIUM.
  const quality = verified.length ? 'MEDIUM' : 'UNVERIFIED';
  const meetsThreshold = input.min_evidence_quality === 'MEDIUM' && verified.length > 0;
  const missing = [];
  if (!hasPods) missing.push('洗衣凝珠品类产品资料');
  if (!opportunity) missing.push('已人工审核的商机记录');
  else if (!qualified) missing.push(`商机当前为 ${opportunity.qualification_status}，需人工审核合格`);
  if (!roleVerified('PRODUCT')) missing.push('已核验的品牌 / 产品证据');
  if (!marketFresh) missing.push(marketReference ? '美国在售证据已超过 7 天或已失效，需重新核验' : '已人工确认的美国在售证据');
  if (!roleVerified('REASON')) missing.push('已核验的开发理由证据');
  if (!meetsThreshold) missing.push(input.min_evidence_quality === 'HIGH'
    ? '达到 HIGH 门槛的来源类型记录（当前规则只能判定 MEDIUM）'
    : '已核验的开发依据证据');

  let tier, reason;
  if (onlyKnownOther) {
    tier = 'NOT_FIT';
    reason = `现有产品品类为 ${knownOther.join('、') || '其他已知品类'}，与首发洗衣凝珠范围冲突，列入排除记录。`;
  } else if (missing.length) {
    tier = 'NEEDS_INFORMATION';
    reason = `候选相关但资料不足，缺少：${missing.join('；')}。`;
  } else {
    tier = 'PRIORITY_REVIEW';
    reason = '品牌品类、美国在售与开发依据均有已人工核验记录；采购量、MOQ 与联系人条件仍待确认。';
  }

  const contact = contactSnapshot(db, account.id);
  const nextActions = [];
  if (tier === 'NOT_FIT') nextActions.push('已列入排除记录，无需跟进。');
  else {
    if (!qualified) nextActions.push(opportunity ? '重新审核商机资格并确认待核验项。' : '将品牌加入商机并人工审核资格。');
    if (!hasPods) nextActions.push('补充洗衣凝珠品类产品资料。');
    if (!marketFresh) nextActions.push('补充并核验 7 天内的美国在售证据。');
    if (!roleVerified('REASON')) nextActions.push('补充并核验开发理由证据。');
    if (input.min_evidence_quality === 'HIGH' && !meetsThreshold) nextActions.push('记录第一方来源属性后再使用 HIGH 门槛。');
    if (!nextActions.length) nextActions.push('确认采购量、MOQ、包装与交期条件。');
    if (contact.usable === 0) nextActions.push('补充并核验联系人渠道。');
  }

  return {
    account_id: account.id, brand_name: account.brand_name, website: account.website,
    has_pods: hasPods, opportunity_id: opportunity?.id ?? null, tier, reason,
    missing: tier === 'NOT_FIT' ? [] : missing,
    evidence: {
      total: evidence.length, verified: verified.length, quality, latest_published_at: latestPublished,
      meets_threshold: meetsThreshold,
      quality_reason: verified.length
        ? '已人工核对来源与原文的原始记录，按当前规则最高判为 MEDIUM。'
        : '没有已核验证据，不能支持优先审核。',
    },
    contact, next_actions: nextActions,
  };
}

function candidateOrder(a, b) {
  if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
  if (b.evidence.verified !== a.evidence.verified) return b.evidence.verified - a.evidence.verified;
  const left = a.evidence.latest_published_at ? Date.parse(a.evidence.latest_published_at) : -Infinity;
  const right = b.evidence.latest_published_at ? Date.parse(b.evidence.latest_published_at) : -Infinity;
  if (left !== right) return right - left;
  if (b.contact.usable !== a.contact.usable) return b.contact.usable - a.contact.usable;
  return a.account_id.localeCompare(b.account_id);
}

function createOpportunity(db, jobId, accountId) {
  const existing = db.prepare("SELECT id FROM opportunities WHERE organization_id=? AND account_id=? AND product_category='LAUNDRY_PODS'").get(ORG, accountId);
  if (existing) return { id: existing.id, created: false };
  const id = randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO opportunities (id,organization_id,account_id,reason,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, ORG, accountId, '研究任务从品牌池整理，等待人工审核证据与匹配条件。', now, now);
  db.prepare('INSERT INTO opportunity_history VALUES (?,?,?,?,?,?,?)').run(randomUUID(), ORG, id,
    'CREATED_FROM_RESEARCH', '研究任务整理候选，未自动合格。', JSON.stringify({ actor: 'LOCAL_OWNER', research_job_id: jobId }), now);
  audit(db, 'OPPORTUNITY_CREATED_FROM_RESEARCH', id, { research_job_id: jobId });
  return { id, created: true };
}

function saveResult(db, jobId, candidate, opportunityId, isNew, factoryVersion) {
  db.prepare(`INSERT INTO research_job_results
    (organization_id,research_job_id,account_id,opportunity_id,tier,reason,missing_info,evidence_snapshot,contact_snapshot,next_actions,factory_version,is_new,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(research_job_id,account_id) DO UPDATE SET
      opportunity_id=COALESCE(research_job_results.opportunity_id,excluded.opportunity_id),
      tier=excluded.tier, reason=excluded.reason, missing_info=excluded.missing_info,
      evidence_snapshot=excluded.evidence_snapshot, contact_snapshot=excluded.contact_snapshot,
      next_actions=excluded.next_actions, factory_version=excluded.factory_version`)
    .run(ORG, jobId, candidate.account_id, opportunityId, candidate.tier, candidate.reason,
      JSON.stringify(candidate.missing), JSON.stringify(candidate.evidence), JSON.stringify(candidate.contact),
      JSON.stringify(candidate.next_actions), factoryVersion, isNew ? 1 : 0, new Date().toISOString());
}

function failJob(db, id, error) {
  const row = db.prepare('SELECT * FROM research_jobs WHERE organization_id=? AND id=?').get(ORG, id);
  if (!row || ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(row.status)) return;
  const counts = JSON.parse(row.counts);
  counts.failed = Math.max(1, counts.failed ?? 0);
  db.prepare(`UPDATE research_jobs SET status='FAILED',current_step=NULL,stop_reason='DEPENDENCY_FAILURE',counts=?,
    finished_at=?,version=version+1 WHERE id=? AND organization_id=?`)
    .run(JSON.stringify(counts), new Date().toISOString(), id, ORG);
  audit(db, 'RESEARCH_JOB_FAILED', id, { reason: error instanceof AppError ? error.code : 'INTERNAL_ERROR' });
}

function step(db, id, value) {
  db.prepare('UPDATE research_jobs SET current_step=?,version=version+1 WHERE id=? AND organization_id=?').run(value, id, ORG);
}

function runPool(db, id, input) {
  return transaction(db, () => {
    const started = Date.now(), now = new Date().toISOString();
    db.prepare("UPDATE research_jobs SET status='RUNNING',current_step='DISCOVERING',started_at=COALESCE(started_at,?),version=version+1 WHERE id=? AND organization_id=?")
      .run(now, id, ORG);
    const factory = factoryReadiness(db);
    const accounts = db.prepare('SELECT * FROM accounts WHERE organization_id=? ORDER BY created_at, id').all(ORG);
    step(db, id, 'ANALYZING');
    const candidates = accounts.map(account => analyseAccount(db, account, input));
    const eligible = candidates.filter(candidate => candidate.tier !== 'NOT_FIT').sort(candidateOrder);
    const selected = eligible.slice(0, input.quantity);
    const notFit = candidates.filter(candidate => candidate.tier === 'NOT_FIT');
    const counts = {
      discovered: accounts.length, processed: 0, skipped: eligible.length - selected.length, failed: 0,
      not_fit: notFit.length, new_opportunities: 0, reused_opportunities: 0,
      missing_contacts: 0, drafts_generated: 0,
    };
    step(db, id, 'CONTACT_ENRICHING');
    for (const candidate of selected) {
      let opportunityId = candidate.opportunity_id, isNew = false;
      if (candidate.has_pods) {
        const result = createOpportunity(db, id, candidate.account_id);
        opportunityId = result.id; isNew = result.created;
        if (result.created) counts.new_opportunities++; else counts.reused_opportunities++;
      }
      if (candidate.contact.total === 0) counts.missing_contacts++;
      saveResult(db, id, candidate, opportunityId, isNew, factory.version);
      counts.processed++;
    }
    for (const candidate of notFit) {
      saveResult(db, id, candidate, null, false, factory.version);
      counts.processed++;
    }
    const reachedTarget = eligible.length > selected.length;
    const budget = JSON.parse(jobRow(db, id).budget);
    budget.usage.runtime_ms = Date.now() - started;
    db.prepare(`UPDATE research_jobs SET status='COMPLETED',current_step=NULL,stop_reason=?,counts=?,budget=?,
      finished_at=?,version=version+1 WHERE id=? AND organization_id=?`)
      .run(reachedTarget ? 'TARGET_REACHED' : 'SOURCE_SCOPE_EXHAUSTED', JSON.stringify(counts), JSON.stringify(budget),
        new Date().toISOString(), id, ORG);
    audit(db, 'RESEARCH_JOB_COMPLETED', id, { source_mode: 'POOL', counts });
    return jobView(jobRow(db, id));
  });
}

function resultsView(db, id) {
  const job = jobRow(db, id);
  const items = db.prepare(`SELECT r.*, a.brand_name, a.website, o.qualification_status, o.sales_stage
    FROM research_job_results r
    JOIN accounts a ON a.id=r.account_id AND a.organization_id=r.organization_id
    LEFT JOIN opportunities o ON o.id=r.opportunity_id AND o.organization_id=r.organization_id
    WHERE r.organization_id=? AND r.research_job_id=?
    ORDER BY CASE r.tier WHEN 'PRIORITY_REVIEW' THEN 0 WHEN 'NEEDS_INFORMATION' THEN 1 ELSE 2 END,
      r.created_at, r.account_id`).all(ORG, id)
    .map(row => ({
      account_id: row.account_id, brand_name: row.brand_name, website: row.website,
      opportunity_id: row.opportunity_id, tier: row.tier, reason: row.reason,
      missing_information: JSON.parse(row.missing_info), next_actions: JSON.parse(row.next_actions),
      evidence: JSON.parse(row.evidence_snapshot), contact: JSON.parse(row.contact_snapshot),
      factory_version: row.factory_version,
      is_new: row.is_new === 1, created_at: row.created_at,
      current_qualification_status: row.qualification_status ?? null,
      current_sales_stage: row.sales_stage ?? null,
      draft_status: 'MODEL_NOT_CONNECTED',
    }));
  return {
    job: jobView(job), items,
    counts: { returned: items.filter(item => item.tier !== 'NOT_FIT').length, not_fit: items.filter(item => item.tier === 'NOT_FIT').length },
  };
}

export function researchApi(db, path, method, body, query) {
  let match;

  if (path === '/research-jobs' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const total = db.prepare('SELECT count(*) AS n FROM research_jobs WHERE organization_id=?').get(ORG).n;
    const base = 'SELECT * FROM research_jobs WHERE organization_id=?';
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY created_at DESC, id DESC LIMIT ?`).all(ORG, limit + 1)
      : db.prepare(`${base} AND ${olderThan('created_at', 'id')} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(ORG, cursor[0], cursor[0], cursor[1], limit + 1);
    const page = pageRows(rows, limit, row => [row.created_at, row.id]);
    return {
      status: 200, body: {
        items: page.items.map(jobView), next_cursor: page.next_cursor, total,
        limitations: {
          discovery: '自动发现需要已启用的来源登记；执行适配器尚未接入，DISCOVERY 返回 503，不产生空转任务或费用。',
          model: '模型网关尚未接入，研究结果不包含 AI 分析、联系人发现或邮件草稿。',
          pool: 'POOL 仅分析本工作空间已保存的品牌、产品、证据和人工审核记录。',
        },
      },
    };
  }

  if (path === '/research-jobs' && method === 'POST') {
    const input = researchInput(body);
    const key = body.idempotency_key ? text(body.idempotency_key, 'idempotency_key', 128) : '';
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const created = transaction(db, () => {
      if (key) {
        const replay = db.prepare('SELECT * FROM research_jobs WHERE organization_id=? AND idempotency_key=?').get(ORG, key);
        if (replay) {
          requireValue(replay.request_hash === hash, '相同提交标识对应不同研究条件，请重新提交。', undefined, 409, 'IDEMPOTENCY_CONFLICT');
          return { replay: jobView(replay) };
        }
      }
      const factory = factoryReadiness(db);
      if (input.source_mode === 'DISCOVERY') {
        const activeSources = db.prepare("SELECT count(*) AS n FROM sources WHERE organization_id=? AND kind='AUTO_DISCOVERY' AND status='ACTIVE'").get(ORG).n;
        throw new AppError(503, 'SOURCE_UNAVAILABLE', activeSources > 0
          ? '已启用自动发现来源，但执行适配器尚未接入；本次未启动任务。'
          : '尚未启用自动发现来源；本次未启动任务，也未产生费用。可显式选择“仅分析品牌池”作为兜底。');
      }
      const id = randomUUID(), now = new Date().toISOString();
      const counts = {
        discovered: 0, processed: 0, skipped: 0, failed: 0, not_fit: 0,
        new_opportunities: 0, reused_opportunities: 0, missing_contacts: 0, drafts_generated: 0,
      };
      db.prepare(`INSERT INTO research_jobs
        (id,organization_id,status,attempt,input_snapshot,factory_version,source_mode,counts,budget,idempotency_key,request_hash,created_at)
        VALUES (?,?,'QUEUED',1,?,?,?,?,?,?,?,?)`)
        .run(id, ORG, JSON.stringify(input), factory.version, input.source_mode, JSON.stringify(counts),
          JSON.stringify(defaultBudget()), key, hash, now);
      audit(db, 'RESEARCH_JOB_CREATED', id, { input, factory_version: factory.version, source_mode: input.source_mode });
      return { id };
    });
    if (created.replay) return { status: 202, body: { ...created.replay, replayed: true } };
    try {
      return { status: 202, body: runPool(db, created.id, input) };
    } catch (error) {
      transaction(db, () => failJob(db, created.id, error));
      throw error;
    }
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)\/cancel$/)) && method === 'POST') {
    return transaction(db, () => {
      const row = jobRow(db, match[1]);
      if (['QUEUED', 'RUNNING'].includes(row.status)) {
        db.prepare(`UPDATE research_jobs SET status='CANCELLED',current_step=NULL,stop_reason='USER_CANCELLED',
          finished_at=?,version=version+1 WHERE id=? AND organization_id=?`).run(new Date().toISOString(), row.id, ORG);
        audit(db, 'RESEARCH_JOB_CANCELLED', row.id);
      }
      return { status: 200, body: jobView(jobRow(db, row.id)) };
    });
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)\/retry$/)) && method === 'POST') {
    const queued = transaction(db, () => {
      const row = jobRow(db, match[1]);
      requireValue(['PARTIAL', 'FAILED'].includes(row.status), '只有部分完成或失败的任务可以重试。', undefined, 409, 'INVALID_TRANSITION');
      db.prepare(`UPDATE research_jobs SET status='QUEUED',current_step=NULL,stop_reason=NULL,attempt=attempt+1,
        finished_at=NULL,version=version+1 WHERE id=? AND organization_id=?`).run(row.id, ORG);
      audit(db, 'RESEARCH_JOB_RETRY', row.id, { attempt: row.attempt + 1 });
      return jobRow(db, row.id);
    });
    try {
      return { status: 202, body: runPool(db, queued.id, JSON.parse(queued.input_snapshot)) };
    } catch (error) {
      transaction(db, () => failJob(db, queued.id, error));
      throw error;
    }
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)\/results$/)) && method === 'GET') {
    return { status: 200, body: resultsView(db, match[1]) };
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)\/failures$/)) && method === 'GET') {
    const row = jobRow(db, match[1]);
    return {
      status: 200, body: {
        items: db.prepare('SELECT id,account_id,step,reason,created_at FROM research_job_failures WHERE organization_id=? AND research_job_id=? ORDER BY created_at, id').all(ORG, row.id),
      },
    };
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)$/)) && method === 'GET') {
    return { status: 200, body: jobView(jobRow(db, match[1])) };
  }

  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
