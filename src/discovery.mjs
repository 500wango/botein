import { addAccount, transaction } from './store.mjs';
import { accountInput, AppError } from './validation.mjs';
import { addEvidence } from './evidence.mjs';

const PROMPT_VERSION = 'discovery-v1';
const BLOCKED_DOMAINS = [
  'amazon.com', 'amazon.co.uk', 'walmart.com', 'target.com', 'ebay.com', 'etsy.com',
  'thespruce.com', 'wirecutter.com', 'nytimes.com', 'reddit.com', 'youtube.com',
  'facebook.com', 'instagram.com', 'linkedin.com', 'tiktok.com', 'pinterest.com',
  'x.com', 'twitter.com', 'trustpilot.com', 'sitejabber.com', 'bbb.org', 'forbes.com',
  'businessinsider.com', 'cnet.com', 'goodhousekeeping.com', 'realsimple.com',
  'consumerreports.org', 'wikipedia.org', 'medium.com', 'substack.com', 'shopify.com',
  'alibaba.com', 'made-in-china.com', 'globalsources.com', 'indiamart.com',
  'thomasnet.com', 'crunchbase.com', 'glassdoor.com', 'indeed.com', 'producthunt.com',
  'g2.com', 'capterra.com', 'quora.com', 'stackexchange.com', 'yelp.com',
  'bestbuy.com', 'costco.com', 'kohls.com', 'macys.com', 'homedepot.com', 'lowes.com',
  'wayfair.com', 'chewy.com', 'instacart.com', 'kroger.com', 'walgreens.com', 'cvs.com',
  'riteaid.com', 'dollartree.com', 'familydollar.com', 'tjmaxx.com', 'marshalls.com',
  'rossstores.com', 'bedbathandbeyond.com',
];

const SYSTEM = 'You are a careful B2B research analyst. Use only the supplied text. Never invent brands, products, or sales claims. Return strict JSON only.';

function queriesFor(input) {
  return [
    '"laundry pods" brand',
    '"laundry detergent pods" independent brand',
    '"laundry pods" company USA',
    '"laundry pods" "our brand"',
  ];
}

function blocked(host) {
  return BLOCKED_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`)) ||
    /\.(gov|edu|mil)$/i.test(host);
}

const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const clip = (value, max) => String(value ?? '').slice(0, max);

function pageBlock(entry) {
  const metadata = entry.page.metadata ?? {};
  return [
    `DOMAIN: ${entry.host}`,
    `SEARCH TITLE: ${clip(entry.result.title, 200)}`,
    `SEARCH SNIPPET: ${clip(entry.result.content, 500)}`,
    `PAGE TITLE: ${clip(metadata.title, 200)}`,
    `SITE NAME: ${clip(metadata.site_name, 160)}`,
    `PAGE DESCRIPTION: ${clip(metadata.description, 400)}`,
    `PAGE EXCERPT: ${clip(entry.page.text, 700)}`,
  ].join('\n');
}

function promptFor(pages) {
  return `A Chinese OEM/ODM factory manufactures laundry pods and wants to find independent brands selling laundry pods in the United States.
For each domain below, decide whether it is the brand's own website and whether the supplied text explicitly shows laundry pod products or US availability.

Return ONLY a JSON object:
{"candidates":[{"domain":"example.com","brand_name":"...","is_brand":true,"product_signal":"YES|NO|UNKNOWN","us_signal":"YES|NO|UNKNOWN","reason":"short reason","evidence_excerpt":"verbatim excerpt from the supplied text"}]}

Rules:
- Use only the supplied text. Do not invent brands, products, prices, or US availability.
- evidence_excerpt must be copied verbatim from that domain's supplied text.
- product_signal is YES only when the text explicitly mentions laundry pods or detergent pods.
- us_signal is YES only when the text explicitly mentions US sale, shipping, or availability; otherwise UNKNOWN. Use NO only for explicit non-US-only statements.
- Exclude retailers, marketplaces, review sites, publishers, directories, social media, and the factory's own website by setting is_brand false.
- If uncertain, set is_brand false or product_signal UNKNOWN. Do not guess.
- Only include domains present in the input.

INPUT:
${pages.map(pageBlock).join('\n\n---\n\n')}`;
}

function evidenceText(entry, excerpt) {
  const metadata = entry.page.metadata ?? {};
  return [
    '自动发现候选（未经人工核验）',
    `搜索标题：${clip(entry.result.title, 300)}`,
    `搜索摘要：${clip(entry.result.content, 1000)}`,
    `页面标题：${clip(metadata.title, 300)}`,
    `站点名称：${clip(metadata.site_name, 200)}`,
    `页面描述：${clip(metadata.description, 500)}`,
    `页面摘录：${clip(entry.page.text, 1200)}`,
    `模型摘录：${clip(excerpt, 500)}`,
  ].join('\n').slice(0, 20000);
}

export async function discover({ db, input, services, shouldStop = () => false, onStep = () => {} }) {
  const { searchWeb, fetchPage, completeJson, searchBase } = services;
  const queries = queriesFor(input);
  const failures = [];
  const searchResults = [];
  let searchRequests = 0, pageRequests = 0, costUsd = 0, skipped = 0;

  for (const query of queries) {
    if (shouldStop()) throw new AppError(409, 'JOB_CANCELLED', '研究任务已取消。');
    searchRequests++;
    try { searchResults.push(...await searchWeb(query, { limit: 10 })); }
    catch (error) { failures.push({ step: 'SEARCH', reason: `${query}: ${error.message}` }); }
  }
  if (!searchResults.length) {
    if (failures.length) throw new AppError(503, 'SEARCH_UNAVAILABLE', '搜索未返回可用结果。');
    return { candidates: [], failures, queries, counts: { discovered: 0, processed: 0, skipped: 0, failed: 0, search_requests: searchRequests, page_requests: 0, cost_usd: 0 }, details: { queries, model: null, prompt_version: PROMPT_VERSION, search_base: searchBase ?? null } };
  }

  const domains = new Map();
  for (const result of searchResults) {
    try {
      const url = new URL(result.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.port) { skipped++; continue; }
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if (!host.includes('.') || blocked(host) || domains.has(host)) { if (!domains.has(host)) skipped++; continue; }
      domains.set(host, { host, origin: `https://${host}/`, result });
    } catch { skipped++; }
  }

  onStep('ENRICHING');
  const entries = [];
  for (const entry of [...domains.values()].slice(0, Math.min(Math.max(input.quantity, 1), 12))) {
    if (shouldStop()) throw new AppError(409, 'JOB_CANCELLED', '研究任务已取消。');
    pageRequests++;
    try { entries.push({ ...entry, page: await fetchPage(entry.origin, { maxBytes: 2_000_000 }) }); }
    catch (error) { failures.push({ step: 'FETCH', reason: `${entry.host}: ${error.message}` }); }
  }
  if (!entries.length) {
    if (failures.length) throw new AppError(502, 'DISCOVERY_FETCH_FAILED', '没有可读取的候选品牌页面。');
    return { candidates: [], failures, queries, counts: { discovered: domains.size, processed: 0, skipped, failed: 0, search_requests: searchRequests, page_requests: pageRequests, cost_usd: 0 }, details: { queries, model: null, prompt_version: PROMPT_VERSION, search_base: searchBase ?? null } };
  }

  if (shouldStop()) throw new AppError(409, 'JOB_CANCELLED', '研究任务已取消。');
  onStep('ANALYZING');
  const modelResult = await completeJson({ system: SYSTEM, prompt: promptFor(entries), maxTokens: 2500, temperature: 0.1 });
  if (process.env.DEBUG_DISCOVERY === '1') console.error('[discovery] model output', JSON.stringify(modelResult.data));
  costUsd = Number(modelResult.usage?.cost ?? 0) || 0;
  if (!Array.isArray(modelResult.data?.candidates)) throw new AppError(502, 'MODEL_INVALID_OUTPUT', '模型没有返回候选列表。');

  const byDomain = new Map(entries.map(entry => [entry.host, entry]));
  const seen = new Set(), candidates = [];
  for (const item of modelResult.data.candidates.slice(0, entries.length)) {
    if (shouldStop()) throw new AppError(409, 'JOB_CANCELLED', '研究任务已取消。');
    const domain = String(item?.domain ?? '').toLowerCase().replace(/^www\./, '');
    const entry = byDomain.get(domain);
    if (!entry || seen.has(domain)) continue;
    const productSignal = String(item.product_signal ?? '').toUpperCase();
    const usSignal = String(item.us_signal ?? '').toUpperCase();
    if (!(item.is_brand === true || item.is_brand === 'true') || productSignal !== 'YES' || usSignal === 'NO') { skipped++; continue; }
    const metadata = entry.page.metadata ?? {};
    const supplied = normalize([entry.result.title, entry.result.content, metadata.title, metadata.site_name, metadata.description, entry.page.text].join(' '));
    const excerpt = normalize(item.evidence_excerpt);
    const verifiedExcerpt = excerpt.length >= 8 && supplied.includes(excerpt) ? String(item.evidence_excerpt).trim() : clip(entry.result.content || metadata.description || metadata.title, 500);
    // Do not accept a model-invented brand name; it must appear in the supplied text.
    const modelBrand = String(item.brand_name ?? '').trim();
    const fallbackBrand = clip(String(metadata.site_name || metadata.title || entry.host).split(/[|–—]/)[0].trim(), 100) || entry.host;
    const brandName = modelBrand && supplied.includes(normalize(modelBrand)) ? clip(modelBrand, 100) : fallbackBrand;
    let accountId = null;
    try {
      accountId = transaction(db, () => {
        const account = addAccount(db, accountInput({
          brand_name: brandName,
          website: entry.origin,
          notes: '自动发现候选；品牌身份、产品与美国在售情况需人工核验。',
        }));
        if (account.status === 'NEEDS_REVIEW') return { review: account };
        addEvidence(db, {
          account_id: account.id,
          source_url: entry.origin,
          raw_text: evidenceText(entry, verifiedExcerpt),
        });
        return { id: account.id };
      });
    } catch (error) {
      failures.push({ step: 'ACCOUNT', reason: `${domain}: ${error.message}` });
      continue;
    }
    if (accountId.review) { failures.push({ step: 'IDENTITY', reason: `${domain}: 同域名身份待人工核对` }); continue; }
    seen.add(domain);
    candidates.push({ account_id: accountId.id, brand_name: brandName, website: entry.origin, evidence_excerpt: verifiedExcerpt });
  }

  return {
    candidates, failures, queries,
    counts: {
      discovered: domains.size, processed: candidates.length, skipped, failed: failures.length,
      search_requests: searchRequests, page_requests: pageRequests, cost_usd: costUsd,
    },
    details: { queries, model: modelResult.model, prompt_version: PROMPT_VERSION, search_base: searchBase ?? null },
  };
}
