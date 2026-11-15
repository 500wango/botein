/**
 * Domain catalog & environment-driven configuration for markets, product categories,
 * source kinds, discovery query templates, and model token pricing.
 */

export const PRODUCT_CATEGORIES = {
  LAUNDRY_PODS: { label: '洗衣凝珠', english: 'laundry pods', terms: ['"laundry pods"', '"laundry detergent pods"'] },
  DISHWASHER_TABLETS: { label: '洗碗块', english: 'dishwasher tablets', terms: ['"dishwasher tablets"', '"dishwasher pods"'] },
  SCENT_BOOSTERS: { label: '留香珠', english: 'scent booster beads', terms: ['"scent booster beads"', '"laundry scent beads"'] },
  OTHER: { label: '其他品类', english: 'other household care', terms: ['"detergent"'] },
  UNKNOWN: { label: '品类待确认', english: 'unknown', terms: [] },
};

export const MARKET_CATALOG = {
  US: { label: '美国 United States', countryCode: 'US', terms: ['USA', 'US', 'United States'] },
  CA: { label: '加拿大 Canada', countryCode: 'CA', terms: ['Canada', 'CA'] },
  UK: { label: '英国 United Kingdom', countryCode: 'UK', terms: ['UK', 'United Kingdom'] },
  EU: { label: '欧盟 European Union', countryCode: 'EU', terms: ['Europe', 'EU'] },
};

export const UNIT_CATALOG = ['POD', 'BAG', 'BOX', 'CARTON'];

export const SOURCE_KINDS = [
  'FIRST_PARTY_BRAND',
  'FIRST_PARTY_PUBLIC',
  'THIRD_PARTY_RETAIL',
  'THIRD_PARTY_REVIEW',
  'SEARCH_SNIPPET',
  'UNKNOWN',
];

export const AVAILABILITY_STATUSES = ['AVAILABLE', 'UNAVAILABLE', 'EXPIRED', 'UNKNOWN'];

function parseConfiguredList(raw, validKeys, fallback) {
  if (!raw || !raw.trim()) return [...fallback];
  const parsed = raw.split(',').map(item => item.trim().toUpperCase()).filter(item => validKeys.includes(item));
  return parsed.length ? [...new Set(parsed)] : [...fallback];
}

export function getEnabledScope() {
  const markets = parseConfiguredList(process.env.SUPPORTED_MARKETS, Object.keys(MARKET_CATALOG), ['US']);
  const categories = parseConfiguredList(
    process.env.SUPPORTED_PRODUCT_CATEGORIES,
    Object.keys(PRODUCT_CATEGORIES).filter(key => !['OTHER', 'UNKNOWN'].includes(key)),
    ['LAUNDRY_PODS'],
  );
  return {
    markets,
    categories,
    product_categories: categories,
    marketOptions: markets.map(code => ({ code, ...MARKET_CATALOG[code] })),
    categoryOptions: Object.entries(PRODUCT_CATEGORIES).map(([code, meta]) => ({
      code,
      label: meta.label,
      in_scope: categories.includes(code),
    })),
    units: UNIT_CATALOG,
    sourceKinds: SOURCE_KINDS,
  };
}

export function buildDiscoveryQueries({ market = 'US', product_categories = ['LAUNDRY_PODS'], account_types = ['INDEPENDENT_BRAND', 'ECOMMERCE_BRAND'] } = {}) {
  const marketMeta = MARKET_CATALOG[market] ?? MARKET_CATALOG.US;
  const queries = [];
  for (const category of product_categories) {
    const catMeta = PRODUCT_CATEGORIES[category] ?? PRODUCT_CATEGORIES.LAUNDRY_PODS;
    const primary = catMeta.terms[0] ?? `"${catMeta.english}"`;
    const secondary = catMeta.terms[1] ?? primary;
    if (account_types.includes('INDEPENDENT_BRAND')) {
      queries.push(`${primary} brand ${marketMeta.terms[0]}`);
      queries.push(`${primary} "our brand" ${marketMeta.terms[0]}`);
    }
    if (account_types.includes('ECOMMERCE_BRAND')) {
      queries.push(`${secondary} online store ${marketMeta.terms[0]}`);
      queries.push(`${primary} D2C brand ${marketMeta.terms[1] ?? marketMeta.terms[0]}`);
    }
    if (!queries.length) {
      queries.push(`${primary} brand ${marketMeta.terms[0]}`);
      queries.push(`${secondary} ${marketMeta.terms[0]}`);
    }
  }
  return [...new Set(queries)];
}

export function getModelPricing() {
  const inputPer1M = Number(process.env.MODEL_INPUT_COST_PER_1M ?? 3.0);
  const outputPer1M = Number(process.env.MODEL_OUTPUT_COST_PER_1M ?? 15.0);
  return {
    inputPer1M: Number.isFinite(inputPer1M) && inputPer1M >= 0 ? inputPer1M : 3.0,
    outputPer1M: Number.isFinite(outputPer1M) && outputPer1M >= 0 ? outputPer1M : 15.0,
  };
}

export function calculateModelCost(usage = {}) {
  if (typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return Number(usage.cost.toFixed(6));
  }
  const inputTokens = Number(usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.output_tokens ?? 0) || 0;
  if (inputTokens <= 0 && outputTokens <= 0) return 0;
  const { inputPer1M, outputPer1M } = getModelPricing();
  const usd = (inputTokens * inputPer1M + outputTokens * outputPer1M) / 1_000_000;
  return Number(usd.toFixed(6));
}
