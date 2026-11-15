import { createHash, randomUUID } from 'node:crypto';
import { analyzeEvidence } from './analysis.mjs';
import { getEnabledScope, PRODUCT_CATEGORIES } from './catalog.mjs';
import { discoverContacts } from './contact-discovery.mjs';
import { discover } from './discovery.mjs';
import { generateDraft } from './drafts.mjs';
import { computeEvidenceQuality } from './evidence.mjs';
import { evaluateOpportunityFit } from './fit.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';
import { audit, ORG, profile, requestContext, transaction } from './store.mjs';
import { AppError, requireValue, text } from './validation.mjs';

const ACCOUNT_TYPES = ['INDEPENDENT_BRAND', 'ECOMMERCE_BRAND'];
const CONTACT_PREFERENCES = ['PRODUCT', 'PROCUREMENT', 'QUALITY'];
const TIER_ORDER = { PRIORITY_REVIEW: 0, NEEDS_INFORMATION: 1, NOT_FIT: 2 };
const SEVEN_DAYS = 7 * 86400000;

const activeControllers = new Map();

const defaultBudget = (overrides = null) => {
  const base = { search_requests: 50, page_requests: 200, runtime_ms: 1_800_000, cost_usd: 5 };
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    const intLimit = (key, max) => {
      if (overrides[key] === undefined) return base[key];
      const n = Number(overrides[key]);
      requireValue(Number.isInteger(n) && n >= 1 && n <= max, `${key} 预算必须为 1–${max} 的整数。`, `budget.${key}`);
      return n;
    };
    base.search_requests = intLimit('search_requests', 200);
    base.page_requests = intLimit('page_requests', 1000);
    base.runtime_ms = intLimit('runtime_ms', 3_600_000);
    if (overrides.cost_usd !== undefined) {
      const c = Number(overrides.cost_usd);
      requireValue(Number.isFinite(c) && c > 0 && c <= 100, 'cost_usd 预算必须为 (0, 100] 的数值。', 'budget.cost_usd');
      base.cost_usd = Number(c.toFixed(4));
    }
  }
  return {
    limits: base,
    usage: { search_requests: 0, page_requests: 0, runtime_ms: 0, cost_usd: 0 },
  };
};

function researchInput(body) {
  const scope = getEnabledScope();
  const isDefaultScope = scope.markets.length === 1 && scope.markets[0] === 'US'
    && scope.product_categories.length === 1 && scope.product_categories[0] === 'LAUNDRY_PODS';

  requireValue(
    typeof body.market === 'string' && scope.markets.includes(body.market),
    isDefaultScope ? '首版仅支持美国市场。' : '所选目标市场尚未在当前工作空间开通。',
    'market',
    422,
    'UNSUPPORTED_MARKET',
  );
  const categories = body.product_categories ?? [scope.product_categories[0]];
  requireValue(
    Array.isArray(categories) && categories.length > 0 && categories.every(x => scope.product_categories.includes(x)),
    isDefaultScope ? '首版仅支持洗衣凝珠品类。' : '所选产品品类尚未在当前工作空间开通。',
    'product_categories',
    422,
    'UNSUPPORTED_CATEGORY',
  );
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
    market: body.market, product_categories: [...new Set(categories)], account_types: [...new Set(types)], quantity,
    min_evidence_quality: quality, contact_preferences: [...new Set(preferences)], language: 'en', source_mode: mode,
  };
}

function factoryReadiness(db, input = { market: 'US', product_categories: ['LAUNDRY_PODS'] }, orgId = ORG) {
  const factory = profile(db, orgId);
  requireValue(factory.status === 'ACTIVE', '请先确认并启用工厂档案。', undefined, 422, 'FACTORY_NOT_ACTIVE');
  const targetCategories = input?.product_categories ?? ['LAUNDRY_PODS'];
  const targetMarket = input?.market ?? 'US';
  for (const cat of targetCategories) {
    requireValue(
      factory.supported_products.includes(cat),
      cat === 'LAUNDRY_PODS' ? '工厂档案未确认洗衣凝珠承接能力。' : `工厂档案未确认 ${PRODUCT_CATEGORIES[cat]?.label || cat} 承接能力。`,
      'supported_products',
      422,
      'FACTORY_NOT_ACTIVE',
    );
  }
  requireValue(
    factory.target_markets.includes(targetMarket),
    targetMarket === 'US' ? '工厂档案尚未确认美国市场承接能力。' : `工厂档案尚未确认 ${targetMarket} 市场承接能力。`,
    'target_markets',
    422,
    'FACTORY_NOT_ACTIVE',
  );
  return factory;
}

function jobRow(db, id, orgId = ORG) {
  const row = db.prepare('SELECT * FROM research_jobs WHERE organization_id=? AND id=?').get(orgId, id);
  requireValue(row, '研究任务不存在。', undefined, 404, 'NOT_FOUND');
  return row;
}

function jobView(row) {
  return {
    id: row.id, status: row.status, current_step: row.current_step, attempt: row.attempt,
    stop_reason: row.stop_reason, input: JSON.parse(row.input_snapshot), factory_version: row.factory_version,
    source_mode: row.source_mode, counts: JSON.parse(row.counts), budget: JSON.parse(row.budget),
    details: JSON.parse(row.details ?? '{}'),
    created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at, version: row.version,
  };
}

function contactSnapshot(db, accountId, orgId = ORG) {
  const rows = db.prepare(`SELECT c.verification_status, s.email AS suppressed FROM contacts c
    LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
    WHERE c.organization_id=? AND c.account_id=?`).all(orgId, accountId);
  const usable = rows.filter(row => row.verification_status === 'VERIFIED' && !row.suppressed).length;
  return {
    total: rows.length, usable,
    status: rows.length === 0 ? 'CONTACT_NOT_FOUND' : usable ? 'AVAILABLE' : 'NO_VERIFIED_CHANNEL',
  };
}

function highestEvidenceQuality(evidenceRows) {
  const verified = evidenceRows.filter(item => item.verification_status === 'VERIFIED');
  if (!verified.length) {
    return {
      quality: 'UNVERIFIED',
      reason: '没有已核验证据，不能支持优先审核。',
    };
  }
  const evaluated = verified.map(item => ({ item, eval: computeEvidenceQuality(item) }));
  const high = evaluated.find(entry => entry.eval.quality === 'HIGH');
  if (high) return high.eval;
  const medium = evaluated.find(entry => entry.eval.quality === 'MEDIUM');
  if (medium) return medium.eval;
  return evaluated[0].eval;
}

/**
 * Deterministic candidate evaluation: separates priority review readiness
 * (verified product + fresh market + verified reason + quality threshold)
 * from manual qualification gate.
 */
function analyseAccount(db, account, input, orgId = ORG) {
  const targetCategories = input.product_categories?.length ? input.product_categories : ['LAUNDRY_PODS'];
  const primaryCategory = targetCategories[0];
  const products = db.prepare("SELECT product_category FROM account_products WHERE organization_id=? AND account_id=? AND status='ACTIVE'").all(orgId, account.id);
  const hasTargetCategory = products.some(product => targetCategories.includes(product.product_category));
  const knownOther = [...new Set(products.filter(product => !targetCategories.includes(product.product_category) && product.product_category !== 'UNKNOWN').map(product => product.product_category))];
  const onlyKnownOther = products.length > 0 && !hasTargetCategory && products.every(product => product.product_category !== 'UNKNOWN');

  const evidence = db.prepare(`SELECT id,verification_status,published_at,checked_at,source_kind,availability_status
    FROM evidence WHERE organization_id=? AND account_id=? ORDER BY observed_at DESC, id`).all(orgId, account.id);
  const verified = evidence.filter(item => item.verification_status === 'VERIFIED');
  const latestPublished = verified.map(item => item.published_at).filter(Boolean).sort().at(-1) ?? null;

  const opportunity = db.prepare(`SELECT id,account_id,qualification_status,sales_stage,product_category
    FROM opportunities WHERE organization_id=? AND account_id=? AND product_category=?`).get(orgId, account.id, primaryCategory)
    || db.prepare(`SELECT id,account_id,qualification_status,sales_stage,product_category
      FROM opportunities WHERE organization_id=? AND account_id=? ORDER BY updated_at DESC LIMIT 1`).get(orgId, account.id);

  const references = opportunity ? db.prepare(`SELECT oe.role,e.verification_status,e.checked_at,e.availability_status FROM opportunity_evidence oe
    JOIN evidence e ON e.id=oe.evidence_id AND e.organization_id=oe.organization_id
    WHERE oe.organization_id=? AND oe.opportunity_id=?`).all(orgId, opportunity.id) : [];
  const hasExplicitRefs = references.length > 0;
  const roleVerified = role => references.some(reference => reference.role === role && reference.verification_status === 'VERIFIED');
  const marketReference = references.find(reference => reference.role === 'MARKET');
  const hasFreshVerifiedEvidence = verified.some(item =>
    (item.availability_status || 'AVAILABLE') !== 'EXPIRED'
    && item.checked_at
    && Date.now() - Date.parse(item.checked_at) <= SEVEN_DAYS);
  const marketFresh = hasExplicitRefs
    ? Boolean(marketReference && marketReference.verification_status === 'VERIFIED'
      && (marketReference.availability_status || 'AVAILABLE') !== 'EXPIRED'
      && marketReference.checked_at && Date.now() - Date.parse(marketReference.checked_at) <= SEVEN_DAYS)
    : hasFreshVerifiedEvidence;
  const productVerified = hasExplicitRefs ? roleVerified('PRODUCT') : verified.length > 0;
  const reasonVerified = hasExplicitRefs ? roleVerified('REASON') : verified.length > 0;
  const qualified = opportunity?.qualification_status === 'QUALIFIED';

  const qualityEval = highestEvidenceQuality(evidence);
  const quality = qualityEval.quality;
  const meetsThreshold = input.min_evidence_quality === 'MEDIUM'
    ? (quality === 'MEDIUM' || quality === 'HIGH')
    : quality === 'HIGH';

  const fit = evaluateOpportunityFit(db, opportunity || { account_id: account.id, product_category: primaryCategory }, orgId);
  const hasMarketOrComplianceConflict = fit.fit_checks.some(c =>
    ['CATEGORY', 'TARGET_MARKET', 'PROHIBITED_MARKETS', 'PRODUCTION_TERMS'].includes(c.code) && c.status === 'CONFLICT');

  const missing = [];
  if (!hasTargetCategory) missing.push(`${PRODUCT_CATEGORIES[primaryCategory]?.label || primaryCategory}品类产品资料`);
  if (!productVerified) missing.push('已核验的品牌 / 产品证据');
  if (!marketFresh) missing.push(marketReference ? '目标市场在售证据已超过 7 天或已失效，需重新核验' : '已人工确认的目标市场在售证据');
  if (!reasonVerified) missing.push('已核验的开发理由证据');
  if (!meetsThreshold) {
    missing.push(input.min_evidence_quality === 'HIGH'
      ? '达到 HIGH 门槛的第一方官方且含时间记录的已核验证据'
      : '已核验的开发依据证据');
  }

  let tier, reason;
  if (onlyKnownOther || hasMarketOrComplianceConflict) {
    tier = 'NOT_FIT';
    const conflictDetail = fit.fit_checks.find(c => c.status === 'CONFLICT')?.detail;
    reason = conflictDetail || `现有产品品类为 ${knownOther.join('、') || '其他已知品类'}，与当前承接范围冲突，列入排除记录。`;
  } else if (missing.length) {
    tier = 'NEEDS_INFORMATION';
    reason = `候选相关但资料不足，缺少：${missing.join('；')}。`;
  } else {
    tier = 'PRIORITY_REVIEW';
    reason = qualified
      ? '品类、目标市场在售与开发依据均已人工核验，且商机已审核合格，可推进联系人核验与草稿编写。'
      : '品类、目标市场在售与开发依据均已人工核验，达到优先审核标准；请完成商机人工审核与 MOQ/联系人确认。';
  }

  const contact = contactSnapshot(db, account.id, orgId);
  const nextActions = [];
  if (tier === 'NOT_FIT') {
    nextActions.push('已列入排除记录，无需跟进。');
  } else {
    if (!opportunity) nextActions.push('将品牌加入商机并人工审核资格。');
    else if (!qualified) nextActions.push('商机证据已齐备，请人工审核商机资格后开启草稿。');
    if (!hasTargetCategory) nextActions.push(`补充${PRODUCT_CATEGORIES[primaryCategory]?.label || primaryCategory}品类产品资料。`);
    if (!marketFresh) nextActions.push('补充并核验 7 天内的目标市场在售证据。');
    if (!reasonVerified) nextActions.push('补充并核验开发理由证据。');
    if (input.min_evidence_quality === 'HIGH' && !meetsThreshold) nextActions.push('记录第一方来源属性后再使用 HIGH 门槛。');
    if (fit.fit_status === 'NEEDS_REVIEW') nextActions.push('确认采购量、MOQ、包装与交期条件。');
    if (contact.usable === 0) nextActions.push('补充并核验联系人渠道。');
    if (!nextActions.length) nextActions.push('条件齐备，可生成外发开发信草稿。');
  }

  return {
    account_id: account.id, brand_name: account.brand_name, website: account.website,
    has_pods: hasTargetCategory, product_category: primaryCategory,
    opportunity_id: opportunity?.id ?? null, tier,
    fit_status: onlyKnownOther || hasMarketOrComplianceConflict ? 'NOT_FIT' : fit.fit_status,
    fit_checks: fit.fit_checks,
    reason,
    missing: tier === 'NOT_FIT' ? [] : missing,
    evidence: {
      total: evidence.length, verified: verified.length, quality, latest_published_at: latestPublished,
      meets_threshold: meetsThreshold,
      quality_reason: qualityEval.reason,
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

function createOpportunity(db, jobId, accountId, productCategory = 'LAUNDRY_PODS', ctx = null) {
  const { orgId, actor } = requestContext(ctx);
  const existing = db.prepare('SELECT id, qualification_status, product_category, account_id FROM opportunities WHERE organization_id=? AND account_id=? AND product_category=?')
    .get(orgId, accountId, productCategory);
  if (existing) {
    const fit = evaluateOpportunityFit(db, existing, orgId);
    db.prepare('UPDATE opportunities SET fit_status=?, fit_checks=?, updated_at=? WHERE id=? AND organization_id=?')
      .run(fit.fit_status, JSON.stringify(fit.fit_checks), new Date().toISOString(), existing.id, orgId);
    return { id: existing.id, created: false, fit_status: fit.fit_status };
  }
  const id = randomUUID(), now = new Date().toISOString();
  const fit = evaluateOpportunityFit(db, { account_id: accountId, product_category: productCategory }, orgId);
  db.prepare(`INSERT INTO opportunities
    (id,organization_id,account_id,product_category,fit_status,fit_checks,assigned_to,reason,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, orgId, accountId, productCategory, fit.fit_status, JSON.stringify(fit.fit_checks), '', '研究任务整理候选，等待人工审核证据与匹配条件。', now, now);
  db.prepare('INSERT INTO opportunity_history (id,organization_id,opportunity_id,action,reason,snapshot,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), orgId, id,
    'CREATED_FROM_RESEARCH', '研究任务整理候选，未自动合格。', JSON.stringify({ actor, research_job_id: jobId }), now);
  audit(db, 'OPPORTUNITY_CREATED_FROM_RESEARCH', id, { research_job_id: jobId }, ctx);
  return { id, created: true, fit_status: fit.fit_status };
}

function draftStatusForOpportunity(db, orgId, opportunityId) {
  if (!opportunityId) return 'NOT_GENERATED';
  const row = db.prepare(`SELECT dv.status
    FROM drafts d
    JOIN draft_versions dv ON dv.id = d.current_version_id AND dv.organization_id = d.organization_id
    WHERE d.organization_id = ? AND d.opportunity_id = ?
    ORDER BY d.created_at DESC LIMIT 1`).get(orgId, opportunityId);
  return row?.status ?? 'NOT_GENERATED';
}

function saveResult(db, jobId, candidate, opportunityId, isNew, factoryVersion, ctx = null) {
  const { orgId } = requestContext(ctx);
  const draftStatus = draftStatusForOpportunity(db, orgId, opportunityId);
  db.prepare(`INSERT INTO research_job_results
    (organization_id,research_job_id,account_id,opportunity_id,tier,reason,missing_info,evidence_snapshot,contact_snapshot,next_actions,factory_version,is_new,draft_status,fit_status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(research_job_id,account_id) DO UPDATE SET
      opportunity_id=COALESCE(research_job_results.opportunity_id,excluded.opportunity_id),
      tier=excluded.tier, reason=excluded.reason, missing_info=excluded.missing_info,
      evidence_snapshot=excluded.evidence_snapshot, contact_snapshot=excluded.contact_snapshot,
      next_actions=excluded.next_actions, factory_version=excluded.factory_version,
      draft_status=excluded.draft_status, fit_status=excluded.fit_status`)
    .run(orgId, jobId, candidate.account_id, opportunityId, candidate.tier, candidate.reason,
      JSON.stringify(candidate.missing), JSON.stringify(candidate.evidence), JSON.stringify(candidate.contact),
      JSON.stringify(candidate.next_actions), factoryVersion, isNew ? 1 : 0, draftStatus, candidate.fit_status || 'NEEDS_REVIEW',
      new Date().toISOString());
}

function mergeUsageIntoBudget(budgetJson, baseUsage, delta = {}) {
  const budget = JSON.parse(budgetJson || '{}');
  budget.limits = budget.limits ?? { search_requests: 50, page_requests: 200, runtime_ms: 1_800_000, cost_usd: 5 };
  budget.usage = {
    search_requests: (baseUsage?.search_requests ?? 0) + (delta.search_requests ?? 0),
    page_requests: (baseUsage?.page_requests ?? 0) + (delta.page_requests ?? 0),
    cost_usd: Number((((baseUsage?.cost_usd ?? 0) + (delta.cost_usd ?? 0))).toFixed(6)),
    runtime_ms: (baseUsage?.runtime_ms ?? 0) + Math.max(0, Math.round(delta.runtime_ms ?? 0)),
  };
  return budget;
}

function failJob(db, id, error, ctx = null, budgetOverride = null) {
  const { orgId } = requestContext(ctx);
  const row = db.prepare('SELECT * FROM research_jobs WHERE organization_id=? AND id=?').get(orgId, id);
  if (!row || ['COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(row.status)) return;
  const counts = JSON.parse(row.counts);
  counts.failed = Math.max(1, counts.failed ?? 0);
  const stopReason = error?.code === 'JOB_CANCELLED' || error?.code === 'RESEARCH_CANCELLED'
    ? 'USER_CANCELLED'
    : 'DEPENDENCY_FAILURE';
  const finalStatus = stopReason === 'USER_CANCELLED' ? 'CANCELLED' : 'FAILED';
  const nextBudget = budgetOverride ? JSON.stringify(budgetOverride) : row.budget;
  db.prepare(`UPDATE research_jobs SET status=?,current_step=NULL,stop_reason=?,counts=?,budget=?,
    worker_id=NULL,lease_expires_at=NULL,finished_at=?,version=version+1 WHERE id=? AND organization_id=?`)
    .run(finalStatus, stopReason, JSON.stringify(counts), nextBudget, new Date().toISOString(), id, orgId);
  audit(db, finalStatus === 'CANCELLED' ? 'RESEARCH_JOB_CANCELLED' : 'RESEARCH_JOB_FAILED', id, {
    reason: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
  }, ctx);
}

function step(db, id, value, orgId = ORG) {
  db.prepare("UPDATE research_jobs SET current_step=?,heartbeat_at=?,version=version+1 WHERE id=? AND organization_id=? AND status='RUNNING'")
    .run(value, new Date().toISOString(), id, orgId);
}

export function executeClaimedJob(db, id, services, signal, ctx = null) {
  const { orgId } = requestContext(ctx);
  const row = jobRow(db, id, orgId);
  const input = JSON.parse(row.input_snapshot);
  const run = input.source_mode === 'DISCOVERY' ? runDiscovery : runPool;
  return Promise.resolve(run(db, id, input, services, signal, ctx))
    .catch(error => {
      try {
        transaction(db, () => failJob(db, id, error, ctx));
      } catch (nested) { console.error(`[research ${id}]`, nested.message); }
    });
}

function scheduleJob(db, id, input, services, ctx = null) {
  if (String(process.env.RESEARCH_WORKER_MODE || 'embedded').toLowerCase() === 'external') {
    return;
  }
  const controller = new AbortController();
  activeControllers.set(id, controller);
  setImmediate(() => {
    const run = input.source_mode === 'DISCOVERY' ? runDiscovery : runPool;
    Promise.resolve(run(db, id, input, services, controller.signal, ctx))
      .catch(error => {
        try { transaction(db, () => failJob(db, id, error, ctx)); }
        catch (nested) { console.error(`[research ${id}]`, nested.message); }
      })
      .finally(() => {
        if (activeControllers.get(id) === controller) activeControllers.delete(id);
      });
  });
}

function runPool(db, id, input, _services, _signal, ctx = null) {
  const { orgId } = requestContext(ctx);
  return transaction(db, () => {
    const starting = jobRow(db, id, orgId);
    if (starting.status === 'CANCELLED') return jobView(starting);
    const started = Date.now(), now = new Date().toISOString();
    db.prepare("UPDATE research_jobs SET status='RUNNING',current_step='DISCOVERING',started_at=COALESCE(started_at,?),version=version+1 WHERE id=? AND organization_id=?")
      .run(now, id, orgId);
    const factory = factoryReadiness(db, input, orgId);
    const accounts = db.prepare('SELECT * FROM accounts WHERE organization_id=? ORDER BY created_at, id').all(orgId);
    step(db, id, 'ANALYZING', orgId);
    const candidates = accounts.map(account => analyseAccount(db, account, input, orgId));
    const eligible = candidates.filter(candidate => candidate.tier !== 'NOT_FIT').sort(candidateOrder);
    const selected = eligible.slice(0, input.quantity);
    const notFit = candidates.filter(candidate => candidate.tier === 'NOT_FIT');
    const counts = {
      discovered: accounts.length, processed: 0, skipped: eligible.length - selected.length, failed: 0,
      not_fit: notFit.length, new_opportunities: 0, reused_opportunities: 0,
      missing_contacts: 0, drafts_generated: 0,
    };
    step(db, id, 'CONTACT_ENRICHING', orgId);
    for (const candidate of selected) {
      let opportunityId = candidate.opportunity_id, isNew = false;
      if (candidate.has_pods) {
        const result = createOpportunity(db, id, candidate.account_id, candidate.product_category, ctx);
        opportunityId = result.id; isNew = result.created;
        if (result.created) counts.new_opportunities++; else counts.reused_opportunities++;
      }
      if (candidate.contact.total === 0) counts.missing_contacts++;
      saveResult(db, id, candidate, opportunityId, isNew, factory.version, ctx);
      counts.processed++;
    }
    for (const candidate of notFit) {
      saveResult(db, id, candidate, null, false, factory.version, ctx);
      counts.processed++;
    }
    const reachedTarget = eligible.length > selected.length;
    const budget = JSON.parse(jobRow(db, id, orgId).budget);
    budget.usage.runtime_ms += Date.now() - started;
    db.prepare(`UPDATE research_jobs SET status='COMPLETED',current_step=NULL,stop_reason=?,counts=?,budget=?,
      finished_at=?,version=version+1 WHERE id=? AND organization_id=?`)
      .run(reachedTarget ? 'TARGET_REACHED' : 'SOURCE_SCOPE_EXHAUSTED', JSON.stringify(counts), JSON.stringify(budget),
        new Date().toISOString(), id, orgId);
    audit(db, 'RESEARCH_JOB_COMPLETED', id, { source_mode: 'POOL', counts }, ctx);
    return jobView(jobRow(db, id, orgId));
  });
}

async function runDiscovery(db, id, input, services, signal, ctx = null) {
  const { orgId } = requestContext(ctx);
  const starting = jobRow(db, id, orgId);
  if (starting.status === 'CANCELLED' || starting.cancel_requested === 1 || signal?.aborted) return jobView(starting);
  const started = Date.now(), now = new Date().toISOString();
  const initialBudget = JSON.parse(starting.budget);
  db.prepare(`UPDATE research_jobs SET status='RUNNING',current_step='DISCOVERING',started_at=COALESCE(started_at,?),heartbeat_at=?,version=version+1
    WHERE id=? AND organization_id=?`).run(now, now, id, orgId);
  step(db, id, 'ENRICHING', orgId);
  let latestUsage = { search_requests: 0, page_requests: 0, cost_usd: 0, runtime_ms: 0 };
  let discovery;
  try {
    discovery = await discover({
      db, input, services, budget: initialBudget, research_job_id: id, signal, ctx,
      shouldStop: () => {
        const cur = jobRow(db, id, orgId);
        return signal?.aborted || cur.status === 'CANCELLED' || cur.cancel_requested === 1;
      },
      onStep: value => step(db, id, value, orgId),
      onUsage: delta => {
        latestUsage = delta;
        const merged = mergeUsageIntoBudget(starting.budget, initialBudget.usage, delta);
        db.prepare('UPDATE research_jobs SET budget=?,heartbeat_at=? WHERE id=? AND organization_id=?')
          .run(JSON.stringify(merged), new Date().toISOString(), id, orgId);
      },
    });
  } catch (error) {
    const partial = error?.partialUsage ?? latestUsage;
    const elapsed = Math.max(partial.runtime_ms ?? 0, Date.now() - started);
    const persistedBudget = mergeUsageIntoBudget(starting.budget, initialBudget.usage, { ...partial, runtime_ms: elapsed });
    const current = jobRow(db, id, orgId);
    if (current.status === 'CANCELLED' || current.cancel_requested === 1 || error?.code === 'JOB_CANCELLED' || error?.code === 'RESEARCH_CANCELLED') {
      db.prepare(`UPDATE research_jobs SET status='CANCELLED',current_step=NULL,stop_reason='USER_CANCELLED',
        budget=?,worker_id=NULL,lease_expires_at=NULL,finished_at=COALESCE(finished_at,?) WHERE id=? AND organization_id=?`)
        .run(JSON.stringify(persistedBudget), new Date().toISOString(), id, orgId);
      return jobView(jobRow(db, id, orgId));
    }
    transaction(db, () => {
      db.prepare('INSERT INTO research_job_failures VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), orgId, id, null, 'DISCOVERY', error.message, new Date().toISOString());
      failJob(db, id, error, ctx, persistedBudget);
    });
    throw error;
  }

  let extraSearch = 0, extraPages = 0, extraCost = 0;
  const enrichmentNotes = [];
  step(db, id, 'CONTACT_ENRICHING', orgId);

  const limits = initialBudget.limits ?? { search_requests: 50, page_requests: 200, cost_usd: 5, runtime_ms: 1_800_000 };
  const usedSearch = () => (initialBudget.usage.search_requests ?? 0) + (discovery.counts.search_requests ?? 0) + extraSearch;
  const usedPages = () => (initialBudget.usage.page_requests ?? 0) + (discovery.counts.page_requests ?? 0) + extraPages;
  const usedCost = () => (initialBudget.usage.cost_usd ?? 0) + (discovery.counts.cost_usd ?? 0) + extraCost;
  const remainingRuntime = () => Math.max(0, (limits.runtime_ms ?? 1_800_000) - (initialBudget.usage.runtime_ms ?? 0) - (Date.now() - started));

  for (const candidate of discovery.candidates) {
    const cur = jobRow(db, id, orgId);
    if (signal?.aborted || cur.status === 'CANCELLED' || cur.cancel_requested === 1 || remainingRuntime() <= 0) break;
    // Optional AI signal assessment on newly discovered unverified evidence
    if (candidate.evidence_id && services.modelConfig?.().configured && usedCost() < (limits.cost_usd ?? 5)) {
      const existingAssessment = db.prepare('SELECT id FROM signal_assessments WHERE organization_id=? AND evidence_id=?').get(orgId, candidate.evidence_id);
      if (!existingAssessment) {
        try {
          const assessed = await analyzeEvidence(db, candidate.evidence_id, services, { research_job_id: id, signal, ctx });
          extraCost += Number(assessed.usage?.cost_usd ?? 0) || 0;
        } catch (error) {
          if (error?.code === 'RESEARCH_CANCELLED') break;
          enrichmentNotes.push({ account_id: candidate.account_id, step: 'ANALYSIS', code: error?.code || 'SKIPPED', reason: error.message });
        }
      }
    }
    // Optional public contact discovery if account currently has no contacts and search/page budget permits
    const currentContacts = contactSnapshot(db, candidate.account_id, orgId);
    if (currentContacts.total === 0
      && usedSearch() + 4 <= (limits.search_requests ?? 50)
      && usedPages() + 5 <= (limits.page_requests ?? 200)
      && usedCost() < (limits.cost_usd ?? 5)
      && remainingRuntime() > 0) {
      try {
        const contactRes = await discoverContacts(db, candidate.account_id, services, { signal, research_job_id: id, ctx });
        extraSearch += contactRes.body?.counts?.search_requests ?? 0;
        extraPages += contactRes.body?.counts?.page_requests ?? 0;
        extraCost += Number(contactRes.body?.usage?.cost_usd ?? 0) || 0;
      } catch (error) {
        if (error?.code === 'RESEARCH_CANCELLED') break;
        extraSearch += 4;
        enrichmentNotes.push({ account_id: candidate.account_id, step: 'CONTACT', code: error?.code || 'SKIPPED', reason: error.message });
      }
    }
  }

  const matchedCandidates = transaction(db, () => {
    const current = jobRow(db, id, orgId);
    if (current.status === 'CANCELLED' || current.cancel_requested === 1) return null;
    const factory = profile(db, orgId);
    step(db, id, 'MATCHING', orgId);
    const createdOpps = [];
    for (const candidate of discovery.candidates) {
      const account = db.prepare('SELECT * FROM accounts WHERE id=? AND organization_id=?').get(candidate.account_id, orgId);
      if (!account) continue;
      const opp = createOpportunity(db, id, account.id, candidate.product_category || input.product_categories[0], ctx);
      const analysed = analyseAccount(db, account, input, orgId);
      saveResult(db, id, analysed, opp.id, opp.created, factory.version, ctx);
      createdOpps.push({ opp, analysed });
    }
    return createdOpps;
  });

  if (matchedCandidates === null) return jobView(jobRow(db, id, orgId));

  let draftsGenerated = 0;
  step(db, id, 'DRAFTING', orgId);
  for (const { opp, analysed } of matchedCandidates) {
    const cur = jobRow(db, id, orgId);
    if (signal?.aborted || cur.status === 'CANCELLED' || cur.cancel_requested === 1 || remainingRuntime() <= 0) break;
    if (analysed.tier === 'NOT_FIT') continue;
    if (!services.modelConfig?.().configured || usedCost() >= (limits.cost_usd ?? 5)) continue;
    const existingDraft = db.prepare('SELECT id FROM drafts WHERE organization_id=? AND opportunity_id=?').get(orgId, opp.id);
    if (existingDraft) continue;
    try {
      await generateDraft(db, opp.id, {}, services, { ...ctx, research_job_id: id }, { allowUnverifiedCandidate: true });
      draftsGenerated++;
    } catch (error) {
      if (error?.code === 'RESEARCH_CANCELLED') break;
      const code = error?.code === 'NO_VERIFIED_CONTACT'
        ? 'CONTACT_NOT_FOUND'
        : error?.code === 'NO_VERIFIED_EVIDENCE'
          ? 'INSUFFICIENT_FACTS'
          : (error?.code || 'SKIPPED');
      enrichmentNotes.push({ account_id: analysed.account_id, step: 'DRAFTING', code, reason: error.message });
    }
  }

  return transaction(db, () => {
    const current = jobRow(db, id, orgId);
    if (current.status === 'CANCELLED' || current.cancel_requested === 1) {
      const partialBudget = mergeUsageIntoBudget(current.budget, initialBudget.usage, {
        search_requests: (discovery.counts.search_requests ?? 0) + extraSearch,
        page_requests: (discovery.counts.page_requests ?? 0) + extraPages,
        cost_usd: (discovery.counts.cost_usd ?? 0) + extraCost,
        runtime_ms: Date.now() - started,
      });
      db.prepare(`UPDATE research_jobs SET budget=?,worker_id=NULL,lease_expires_at=NULL WHERE id=? AND organization_id=?`)
        .run(JSON.stringify(partialBudget), id, orgId);
      return jobView(jobRow(db, id, orgId));
    }
    const factory = profile(db, orgId);
    const stepSearch = (discovery.counts.search_requests ?? 0) + extraSearch;
    const stepPages = (discovery.counts.page_requests ?? 0) + extraPages;
    const stepCost = (discovery.counts.cost_usd ?? 0) + extraCost;
    const counts = {
      discovered: discovery.counts.discovered ?? 0, processed: 0,
      skipped: discovery.counts.skipped ?? 0, failed: discovery.failures.length,
      not_fit: 0, new_opportunities: 0, reused_opportunities: 0, missing_contacts: 0, drafts_generated: draftsGenerated,
      search_requests: stepSearch, page_requests: stepPages, cost_usd: stepCost,
    };
    for (const failure of discovery.failures) {
      db.prepare('INSERT INTO research_job_failures VALUES (?,?,?,?,?,?,?)')
        .run(randomUUID(), orgId, id, failure.account_id ?? null, failure.step, failure.reason, new Date().toISOString());
    }
    for (const { opp, analysed } of matchedCandidates) {
      if (opp.created) counts.new_opportunities++;
      else counts.reused_opportunities++;
      saveResult(db, id, analysed, opp.id, opp.created, factory.version, ctx);
      counts.processed++;
      if (analysed.tier === 'NOT_FIT') counts.not_fit++;
      if (analysed.contact.total === 0) counts.missing_contacts++;
    }
    const failed = discovery.failures.length > 0 && discovery.candidates.length === 0;
    const partial = discovery.failures.length > 0 && discovery.candidates.length > 0;
    const status = failed ? 'FAILED' : partial ? 'PARTIAL' : 'COMPLETED';
    const stop = discovery.stop_reason
      ? discovery.stop_reason
      : (failed || partial ? 'DEPENDENCY_FAILURE' : 'SOURCE_SCOPE_EXHAUSTED');

    const budget = mergeUsageIntoBudget(starting.budget, initialBudget.usage, {
      search_requests: stepSearch,
      page_requests: stepPages,
      cost_usd: stepCost,
      runtime_ms: Date.now() - started,
    });

    const details = {
      ...(discovery.details ?? {}),
      enrichment_notes: enrichmentNotes,
    };
    db.prepare(`UPDATE research_jobs SET status=?,current_step=NULL,stop_reason=?,counts=?,budget=?,details=?,
      worker_id=NULL,lease_expires_at=NULL,finished_at=?,version=version+1 WHERE id=? AND organization_id=?`)
      .run(status, stop, JSON.stringify(counts), JSON.stringify(budget), JSON.stringify(details),
        new Date().toISOString(), id, orgId);
    audit(db, failed ? 'RESEARCH_JOB_FAILED' : 'RESEARCH_JOB_COMPLETED', id, {
      source_mode: 'DISCOVERY', counts, details,
    }, ctx);
    return jobView(jobRow(db, id, orgId));
  });
}

function resultsView(db, id, orgId = ORG) {
  const job = jobRow(db, id, orgId);
  const rawItems = db.prepare(`SELECT r.*, a.brand_name, a.website, o.qualification_status, o.sales_stage,
      o.fit_status AS live_fit_status,
      (SELECT dv.status FROM drafts d JOIN draft_versions dv ON dv.id=d.current_version_id AND dv.organization_id=d.organization_id
       WHERE d.organization_id=r.organization_id AND d.opportunity_id=r.opportunity_id ORDER BY d.created_at DESC LIMIT 1) AS live_draft_status
    FROM research_job_results r
    JOIN accounts a ON a.id=r.account_id AND a.organization_id=r.organization_id
    LEFT JOIN opportunities o ON o.id=r.opportunity_id AND o.organization_id=r.organization_id
    WHERE r.organization_id=? AND r.research_job_id=?`).all(orgId, id)
    .map(row => ({
      account_id: row.account_id, brand_name: row.brand_name, website: row.website,
      opportunity_id: row.opportunity_id, tier: row.tier, reason: row.reason,
      missing_information: JSON.parse(row.missing_info), next_actions: JSON.parse(row.next_actions),
      evidence: JSON.parse(row.evidence_snapshot), contact: JSON.parse(row.contact_snapshot),
      factory_version: row.factory_version,
      is_new: row.is_new === 1, created_at: row.created_at,
      current_qualification_status: row.qualification_status ?? null,
      current_sales_stage: row.sales_stage ?? null,
      fit_status: row.live_fit_status ?? row.fit_status ?? 'NEEDS_REVIEW',
      draft_status: row.live_draft_status ?? row.draft_status ?? 'NOT_GENERATED',
    }));
  const items = rawItems.sort(candidateOrder);
  return {
    job: jobView(job), items,
    counts: { returned: items.filter(item => item.tier !== 'NOT_FIT').length, not_fit: items.filter(item => item.tier === 'NOT_FIT').length },
  };
}

function budgetExhausted(budget) {
  const limits = budget?.limits ?? {};
  const usage = budget?.usage ?? {};
  return (limits.search_requests != null && usage.search_requests >= limits.search_requests)
    || (limits.page_requests != null && usage.page_requests >= limits.page_requests)
    || (limits.runtime_ms != null && usage.runtime_ms >= limits.runtime_ms)
    || (limits.cost_usd != null && usage.cost_usd >= limits.cost_usd);
}

function assertNoActiveDiscovery(db, orgId) {
  const active = db.prepare(`SELECT id, status FROM research_jobs
    WHERE organization_id=? AND source_mode='DISCOVERY' AND status IN ('QUEUED', 'RUNNING') LIMIT 1`).get(orgId);
  requireValue(!active, '已有正在执行的自动发现任务，请等待完成或先取消后再试。', undefined, 409, 'DISCOVERY_ALREADY_RUNNING');
}

export async function researchApi(db, path, method, body, query, services, ctx = null) {
  const { orgId } = requestContext(ctx);
  let match;

  if (path === '/research-jobs' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const total = db.prepare('SELECT count(*) AS n FROM research_jobs WHERE organization_id=?').get(orgId).n;
    const base = 'SELECT * FROM research_jobs WHERE organization_id=?';
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY created_at DESC, id DESC LIMIT ?`).all(orgId, limit + 1)
      : db.prepare(`${base} AND ${olderThan('created_at', 'id')} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(orgId, cursor[0], cursor[0], cursor[1], limit + 1);
    const page = pageRows(rows, limit, row => [row.created_at, row.id]);
    return {
      status: 200, body: {
        items: page.items.map(jobView), next_cursor: page.next_cursor, total,
        limitations: {
          discovery: '自动发现通过本地 SearXNG 搜索公开网页，并由模型筛选候选；生成的品牌、产品、证据与商机均为未核验候选（NEW/UNVERIFIED）。',
          model: '模型用于候选筛选、证据信号分析、公开联系人提取和待审 AI 草稿。',
          pool: 'POOL 仅分析本工作空间已保存的品牌、产品、证据和人工审核记录。',
        },
      },
    };
  }

  if (path === '/research-jobs' && method === 'POST') {
    const input = researchInput(body);
    if (input.source_mode === 'DISCOVERY') {
      factoryReadiness(db, input, orgId);
      const status = await services.searchStatus();
      requireValue(status.reachable, '本地搜索服务不可用，请先启动 SearXNG。', undefined, 503, 'SEARCH_UNAVAILABLE');
      requireValue(services.modelConfig().configured, '模型网关尚未配置。', undefined, 503, 'MODEL_NOT_CONNECTED');
    }
    const key = body.idempotency_key ? text(body.idempotency_key, 'idempotency_key', 128) : '';
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const created = transaction(db, () => {
      if (key) {
        const replay = db.prepare('SELECT * FROM research_jobs WHERE organization_id=? AND idempotency_key=?').get(orgId, key);
        if (replay) {
          requireValue(replay.request_hash === hash, '相同提交标识对应不同研究条件，请重新提交。', undefined, 409, 'IDEMPOTENCY_CONFLICT');
          return { replay: jobView(replay) };
        }
      }
      if (input.source_mode === 'DISCOVERY') assertNoActiveDiscovery(db, orgId);
      const factory = factoryReadiness(db, input, orgId);
      const id = randomUUID(), now = new Date().toISOString();
      const counts = {
        discovered: 0, processed: 0, skipped: 0, failed: 0, not_fit: 0,
        new_opportunities: 0, reused_opportunities: 0, missing_contacts: 0, drafts_generated: 0,
      };
      db.prepare(`INSERT INTO research_jobs
        (id,organization_id,status,attempt,input_snapshot,factory_version,source_mode,counts,budget,idempotency_key,request_hash,created_at)
        VALUES (?,?,'QUEUED',1,?,?,?,?,?,?,?,?)`)
        .run(id, orgId, JSON.stringify(input), factory.version, input.source_mode, JSON.stringify(counts),
          JSON.stringify(defaultBudget(body.budget)), key, hash, now);
      audit(db, 'RESEARCH_JOB_CREATED', id, { input, factory_version: factory.version, source_mode: input.source_mode }, ctx);
      return { id };
    });
    if (created.replay) return { status: 202, body: { ...created.replay, replayed: true } };
    scheduleJob(db, created.id, input, services, ctx);
    return { status: 202, body: { ...jobView(jobRow(db, created.id, orgId)), queued: true } };
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)\/cancel$/)) && method === 'POST') {
    const out = transaction(db, () => {
      const row = jobRow(db, match[1], orgId);
      if (['QUEUED', 'RUNNING'].includes(row.status)) {
        db.prepare(`UPDATE research_jobs SET status='CANCELLED',current_step=NULL,stop_reason='USER_CANCELLED',
          cancel_requested=1,worker_id=NULL,lease_expires_at=NULL,finished_at=?,version=version+1 WHERE id=? AND organization_id=?`)
          .run(new Date().toISOString(), row.id, orgId);
        audit(db, 'RESEARCH_JOB_CANCELLED', row.id, {}, ctx);
      }
      return jobView(jobRow(db, row.id, orgId));
    });
    const controller = activeControllers.get(match[1]);
    if (controller) controller.abort();
    return { status: 200, body: out };
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)\/retry$/)) && method === 'POST') {
    const queued = transaction(db, () => {
      const row = jobRow(db, match[1], orgId);
      requireValue(['PARTIAL', 'FAILED'].includes(row.status), '只有部分完成或失败的任务可以重试。', undefined, 409, 'INVALID_TRANSITION');
      if (row.source_mode === 'DISCOVERY') assertNoActiveDiscovery(db, orgId);
      const budget = JSON.parse(row.budget || '{}');
      requireValue(!budgetExhausted(budget), '任务预算已耗尽，请新建研究任务。', undefined, 409, 'BUDGET_EXHAUSTED');
      db.prepare(`UPDATE research_jobs SET status='QUEUED',current_step=NULL,stop_reason=NULL,cancel_requested=0,
        worker_id=NULL,lease_expires_at=NULL,attempt=attempt+1,finished_at=NULL,version=version+1 WHERE id=? AND organization_id=?`)
        .run(row.id, orgId);
      audit(db, 'RESEARCH_JOB_RETRY', row.id, { attempt: row.attempt + 1 }, ctx);
      return jobRow(db, row.id, orgId);
    });
    scheduleJob(db, queued.id, JSON.parse(queued.input_snapshot), services, ctx);
    return { status: 202, body: { ...jobView(jobRow(db, queued.id, orgId)), queued: true } };
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)\/results$/)) && method === 'GET') {
    return { status: 200, body: resultsView(db, match[1], orgId) };
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)\/failures$/)) && method === 'GET') {
    const row = jobRow(db, match[1], orgId);
    return {
      status: 200, body: {
        items: db.prepare('SELECT id,account_id,step,reason,created_at FROM research_job_failures WHERE organization_id=? AND research_job_id=? ORDER BY created_at, id').all(orgId, row.id),
      },
    };
  }

  if ((match = path.match(/^\/research-jobs\/([^/]+)$/)) && method === 'GET') {
    return { status: 200, body: jobView(jobRow(db, match[1], orgId)) };
  }

  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
