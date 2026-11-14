import { AppError } from './validation.mjs';

const DEFAULT_BASE = 'http://127.0.0.1:8888';
let statusCache = { at: 0, value: null };

export function searchConfig() {
  return { base: (process.env.SEARCH_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '') };
}

export async function searchWeb(query, { limit = 10 } = {}) {
  const { base } = searchConfig();
  const url = new URL(`${base}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'en');
  url.searchParams.set('safesearch', '0');
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
  } catch {
    throw new AppError(503, 'SEARCH_UNAVAILABLE', '本地搜索服务不可用，请确认 SearXNG 已启动。');
  }
  if (!response.ok) throw new AppError(503, 'SEARCH_UNAVAILABLE', `本地搜索服务返回 ${response.status}。`);
  let data;
  try { data = await response.json(); }
  catch { throw new AppError(503, 'SEARCH_UNAVAILABLE', '本地搜索服务返回了无效 JSON。'); }
  const seen = new Set(), items = [];
  for (const result of data.results ?? []) {
    if (typeof result.url !== 'string' || !/^https?:\/\//i.test(result.url)) continue;
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    items.push({
      title: String(result.title ?? ''), url: result.url, content: String(result.content ?? ''),
      engines: Array.isArray(result.engines) ? result.engines : [],
    });
    if (items.length >= limit) break;
  }
  return items;
}

export async function searchStatus() {
  const now = Date.now();
  if (statusCache.value && now - statusCache.at < 30_000) return statusCache.value;
  const { base } = searchConfig();
  let value;
  try {
    const response = await fetch(base, { signal: AbortSignal.timeout(3_000) });
    value = { configured: true, reachable: response.status < 500, base };
  } catch { value = { configured: true, reachable: false, base }; }
  statusCache = { at: now, value };
  return value;
}
