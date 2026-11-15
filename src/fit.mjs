import { MARKET_CATALOG, PRODUCT_CATEGORIES } from './catalog.mjs';
import { ORG, profile } from './store.mjs';

function parseJson(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function marketLabel(code) {
  return MARKET_CATALOG[code]?.label ?? code;
}

function categoryLabel(code) {
  return PRODUCT_CATEGORIES[code]?.label ?? code;
}

function checkProductionTerm(term, products, oppCategory) {
  const category = term.product_category || oppCategory || '';
  if (category && products.length > 0 && !products.some((p) => p.product_category === category)) {
    return { applicable: false };
  }
  const hasAnyMoq = term.min_moq != null || term.max_moq != null;
  if (!hasAnyMoq && !term.unit && !term.packaging_spec) {
    return { applicable: true, status: 'UNKNOWN', detail: `${categoryLabel(category)} 尚未配置具体 MOQ 与包装条件。` };
  }
  return {
    applicable: true,
    status: 'PASS',
    detail: `已配置 ${categoryLabel(category)} 生产条件（MOQ ${term.min_moq ?? '未限'}${term.max_moq != null ? `-${term.max_moq}` : '+'} ${term.unit || ''}）。`.trim(),
  };
}

/**
 * Deterministically evaluates factory-account fit using factory capabilities,
 * supported markets/categories, prohibited markets, production terms, and base evidence.
 */
export function evaluateOpportunityFit(db, opportunity, orgId = ORG) {
  const resolvedOrgId = typeof orgId === 'string' ? orgId : (orgId?.orgId || ORG);
  const factory = profile(db, resolvedOrgId);
  const account = db.prepare(`
    SELECT id, brand_name, headquarters_country
    FROM accounts
    WHERE organization_id = ? AND id = ?
  `).get(resolvedOrgId, opportunity.account_id);
  const products = db.prepare(`
    SELECT id, product_category, product_name, marketplace, status
    FROM account_products
    WHERE organization_id = ? AND account_id = ? AND COALESCE(status, 'ACTIVE') = 'ACTIVE'
    ORDER BY updated_at DESC, id DESC
  `).all(resolvedOrgId, opportunity.account_id);
  const evidence = db.prepare(`
    SELECT id, product_id, verification_status, availability_status
    FROM evidence
    WHERE organization_id = ? AND account_id = ?
  `).all(resolvedOrgId, opportunity.account_id);

  const checks = [];
  const supportedProducts = new Set(parseJson(factory?.supported_products, []));
  const targetMarkets = new Set(parseJson(factory?.target_markets, []));
  const prohibitedMarkets = new Set(parseJson(factory?.prohibited_markets, []));
  const factoryTerms = parseJson(factory?.production_terms, []);
  const certifications = parseJson(factory?.certifications, []);

  // 1. Category check (uses active products first, or opportunity product_category)
  const effectiveCategories = products.length > 0
    ? [...new Set(products.map((p) => p.product_category).filter(Boolean))]
    : (opportunity.product_category ? [opportunity.product_category] : []);

  if (products.length === 0 && !opportunity.product_category) {
    checks.push({
      code: 'CATEGORY',
      label: '品类匹配',
      status: 'UNKNOWN',
      detail: '尚未建立有效在研产品（account_products），暂无法确认客户品类与工厂能力是否一致。',
    });
  } else {
    const matched = effectiveCategories.filter((cat) => supportedProducts.has(cat));
    if (matched.length === 0) {
      checks.push({
        code: 'CATEGORY',
        label: '品类匹配',
        status: 'CONFLICT',
        detail: `客户品类 (${effectiveCategories.map(categoryLabel).join('、')}) 不在工厂支持范围 (${[...supportedProducts].map(categoryLabel).join('、') || '未配置'}) 内。`,
      });
    } else if (products.length === 0) {
      checks.push({
        code: 'CATEGORY',
        label: '品类匹配',
        status: 'UNKNOWN',
        detail: `商机默认品类 (${categoryLabel(opportunity.product_category)}) 属于工厂能力，但尚未登记具体在研产品。`,
      });
    } else {
      checks.push({
        code: 'CATEGORY',
        label: '品类匹配',
        status: 'PASS',
        detail: `命中工厂支持品类：${matched.map(categoryLabel).join('、')}。`,
      });
    }
  }

  // 2. Market & prohibited market checks
  const accountMarkets = [...new Set([
    ...(account?.headquarters_country ? [account.headquarters_country.toUpperCase()] : []),
    ...products.map((p) => (p.marketplace || '').toUpperCase()).filter((m) => /^[A-Z]{2}$/.test(m)),
  ].filter(Boolean))];

  const prohibitedHit = accountMarkets.find((m) => prohibitedMarkets.has(m));
  if (prohibitedHit) {
    checks.push({
      code: 'PROHIBITED_MARKETS',
      label: '禁入/合规市场',
      status: 'CONFLICT',
      detail: `客户所属/销售市场包含工厂禁入市场：${marketLabel(prohibitedHit)}。`,
    });
  } else {
    checks.push({
      code: 'PROHIBITED_MARKETS',
      label: '禁入/合规市场',
      status: 'PASS',
      detail: prohibitedMarkets.size ? '未命中工厂禁入市场限制。' : '未设置禁入市场限制。',
    });
  }

  if (accountMarkets.length === 0) {
    checks.push({
      code: 'TARGET_MARKET',
      label: '目标市场匹配',
      status: 'UNKNOWN',
      detail: '客户尚未标注所属国家或目标市场。',
    });
  } else if (accountMarkets.some((m) => targetMarkets.has(m))) {
    checks.push({
      code: 'TARGET_MARKET',
      label: '目标市场匹配',
      status: 'PASS',
      detail: `目标市场匹配：${accountMarkets.filter((m) => targetMarkets.has(m)).map(marketLabel).join('、')}。`,
    });
  } else {
    checks.push({
      code: 'TARGET_MARKET',
      label: '目标市场匹配',
      status: 'CONFLICT',
      detail: `客户市场 (${accountMarkets.map(marketLabel).join('、')}) 与工厂目标市场 (${[...targetMarkets].map(marketLabel).join('、') || '未配置'}) 不一致。`,
    });
  }

  // 3. Production terms / MOQ & packaging check
  const activeTermResults = factoryTerms
    .map((term) => checkProductionTerm(term, products, opportunity.product_category))
    .filter((r) => r.applicable);
  const legacyTermComplete = factory?.moq_quantity != null && Boolean(factory?.unit) && Boolean(factory?.packaging_spec);
  if (activeTermResults.some((r) => r.status === 'CONFLICT')) {
    const firstConflict = activeTermResults.find((r) => r.status === 'CONFLICT');
    checks.push({ code: 'PRODUCTION_TERMS', label: 'MOQ 与包装条件', status: 'CONFLICT', detail: firstConflict.detail });
  } else if (activeTermResults.some((r) => r.status === 'PASS') || legacyTermComplete) {
    checks.push({
      code: 'PRODUCTION_TERMS',
      label: 'MOQ 与包装条件',
      status: 'PASS',
      detail: activeTermResults.find((r) => r.status === 'PASS')?.detail || `已配置工厂 MOQ (${factory.moq_quantity} ${factory.unit}) 与包装规格。`,
    });
  } else {
    checks.push({
      code: 'PRODUCTION_TERMS',
      label: 'MOQ 与包装条件',
      status: 'UNKNOWN',
      detail: '工厂画像尚未填写完整的 MOQ、计量单位与包装条件，需人工复核。',
    });
  }

  // 4. Certifications informational & expiry check
  const todayStr = new Date().toISOString().slice(0, 10);
  const soonStr = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const normalizedCerts = certifications.map((c) => (typeof c === 'string'
    ? { name: c, cert_no: '', issuer: '', expires_at: '', attachment_url: '' }
    : {
      name: String(c?.name || ''),
      cert_no: String(c?.cert_no || ''),
      issuer: String(c?.issuer || ''),
      expires_at: String(c?.expires_at || ''),
      attachment_url: String(c?.attachment_url || ''),
    })).filter((c) => c.name);
  const expiredCerts = normalizedCerts.filter((c) => c.expires_at && c.expires_at < todayStr);
  const expiringSoonCerts = normalizedCerts.filter((c) => c.expires_at && c.expires_at >= todayStr && c.expires_at <= soonStr);
  const certSummary = normalizedCerts.map((c) => (c.cert_no ? `${c.name}(${c.cert_no})` : c.name)).join('、');
  if (expiredCerts.length > 0) {
    checks.push({
      code: 'CERTIFICATIONS',
      label: '资质认证储备',
      status: 'CONFLICT',
      detail: `存在已过期认证：${expiredCerts.map((c) => `${c.name}[${c.expires_at}]`).join('、')}，请更新或续期后再外发。`,
    });
  } else if (expiringSoonCerts.length > 0) {
    checks.push({
      code: 'CERTIFICATIONS',
      label: '资质认证储备',
      status: 'PASS',
      detail: `工厂已登记认证：${certSummary}（注意即将到期：${expiringSoonCerts.map((c) => `${c.name}[${c.expires_at}]`).join('、')}）。`,
    });
  } else {
    checks.push({
      code: 'CERTIFICATIONS',
      label: '资质认证储备',
      status: normalizedCerts.length > 0 ? 'PASS' : 'UNKNOWN',
      detail: normalizedCerts.length > 0
        ? `工厂已登记认证：${certSummary}。`
        : '工厂尚未登记出口/合规认证（如 EPA/ISO/SDS），外发前建议补充核对。',
    });
  }

  // 5. Verified evidence foundation check
  const activeVerified = evidence.filter((e) => e.verification_status === 'VERIFIED' && (e.availability_status || 'AVAILABLE') !== 'EXPIRED');
  if (activeVerified.length === 0) {
    checks.push({
      code: 'BASE_EVIDENCE',
      label: '核验证据基础',
      status: 'UNKNOWN',
      detail: '尚无已核验且有效的销售信号证据。',
    });
  } else {
    checks.push({
      code: 'BASE_EVIDENCE',
      label: '核验证据基础',
      status: 'PASS',
      detail: `已有 ${activeVerified.length} 条已核验有效证据支持判断。`,
    });
  }

  const hasConflict = checks.some((c) => c.status === 'CONFLICT');
  const coreUnknown = checks.some((c) => c.status === 'UNKNOWN' && c.code !== 'CERTIFICATIONS');
  const fit_status = hasConflict ? 'NOT_FIT' : (coreUnknown ? 'NEEDS_REVIEW' : 'ELIGIBLE');
  return { fit_status, fit_checks: checks };
}
