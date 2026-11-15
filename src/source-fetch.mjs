import { BlockList, isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import { checkAndRecordRateLimit } from './store.mjs';
import { AppError } from './validation.mjs';

const execFileAsync = promisify(execFile);

const MAX_BYTES = 512 * 1024;
const MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8_000;
const MAX_TEXT = 20_000;
const WINDOW_MS = 15 * 60_000;
const MAX_PREVIEW_FETCHES = 30;
const MAX_BACKGROUND_FETCHES = 120;

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(network, prefix, 'ipv6');

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©',
  reg: '®', trade: '™', deg: '°', euro: '€', pound: '£',
  yen: '¥', cent: '¢', times: '×', divide: '÷', plusmn: '±',
  laquo: '«', raquo: '»',
};

export function isBlockedAddress(value) {
  if (typeof value !== 'string') return true;
  const address = value.split('%')[0];
  const family = isIP(address);
  if (!family) return true;
  if (family === 6) {
    const mapped = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mapped) {
      const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
      return isBlockedAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    if (/^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(address)) return isBlockedAddress(address.slice(7));
  }
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function sourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError(422, 'INVALID_URL', '请填写完整的 http 或 https 来源网址。', 'url'); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
    !host.includes('.') || isIP(host) || host.startsWith('[') || host.endsWith('.') ||
    /\.(localhost|local|internal|test|invalid|example)$/.test(host)) {
    throw new AppError(422, 'SOURCE_URL_REJECTED', '来源须为不含账号密码和自定义端口的公开网站域名。', 'url');
  }
  url.hash = '';
  return url;
}

function metaContent(html, attribute, name) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!new RegExp(`\\b${attribute}\\s*=\\s*["']${name}["']`, 'i').test(tag)) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (content) return content;
  }
  return '';
}

export function extractPageMeta(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const emails = new Set();
  for (const match of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) {
    try {
      const email = decodeURIComponent(match[1]).trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) emails.add(email);
    } catch { /* ignore malformed mailto values */ }
    if (emails.size >= 10) break;
  }
  return {
    title: htmlToText(title).text.slice(0, 300),
    site_name: htmlToText(metaContent(html, 'property', 'og:site_name')).text.slice(0, 200),
    description: htmlToText(metaContent(html, 'name', 'description')).text.slice(0, 500),
    emails: [...emails],
  };
}

export function htmlToText(input) {
  const text = String(input)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
      try {
        const point = /^#x/i.test(code) ? parseInt(code.slice(2), 16)
          : /^#/.test(code) ? parseInt(code.slice(1), 10) : null;
        if (point !== null) {
          if (Number.isInteger(point) && point > 0 && point <= 0x10FFFF) return String.fromCodePoint(point);
          return match;
        }
      } catch { return match; }
      return NAMED_ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
}

const previewAttempts = [];
const backgroundAttempts = [];
function allowFetch(bucket = 'preview') {
  const store = bucket === 'background' ? backgroundAttempts : previewAttempts;
  const max = bucket === 'background' ? MAX_BACKGROUND_FETCHES : MAX_PREVIEW_FETCHES;
  const now = Date.now();
  while (store.length && now - store[0] > WINDOW_MS) store.shift();
  if (store.length >= max) throw new AppError(429, 'SOURCE_RATE_LIMITED', '读取来源过于频繁，请稍后再试。');
  store.push(now);
}

export async function resolvePublicRecords(hostname) {
  let records;
  try { records = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new AppError(422, 'SOURCE_UNRESOLVED', '无法解析来源域名。', 'url'); }
  if (!records.length) throw new AppError(422, 'SOURCE_UNRESOLVED', '无法解析来源域名。', 'url');
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new AppError(422, 'SOURCE_BLOCKED', '来源解析到本机、内网或保留地址，已拒绝访问。', 'url');
    }
  }
  const unique = [];
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.address)) continue;
    seen.add(record.address);
    unique.push(record);
  }
  unique.sort((a, b) => (isIP(a.address) === 4 ? 0 : 1) - (isIP(b.address) === 4 ? 0 : 1));
  return unique;
}

export function connectorUrl(value, { allowPrivate = process.env.ALLOW_PRIVATE_CONNECTORS === '1', field = 'endpoint_url' } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new AppError(422, 'INVALID_URL', '请填写完整的 http 或 https 接口地址。', field); }
  const host = url.hostname.toLowerCase();
  const rawHost = host.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host || host.endsWith('.')) {
    throw new AppError(422, 'CONNECTOR_URL_REJECTED', '外部连接器地址必须为有效的 http/https 地址且不能包含账号密码。', field);
  }
  if (!allowPrivate) {
    if (host === 'localhost' || /\.(localhost|local|internal)$/i.test(host)) {
      throw new AppError(422, 'CONNECTOR_URL_BLOCKED', '外部连接器地址不能指向本机或内网域名。', field);
    }
    if (isIP(rawHost) && isBlockedAddress(rawHost)) {
      throw new AppError(422, 'CONNECTOR_URL_BLOCKED', '外部连接器地址不能指向本机、内网或保留 IP。', field);
    }
  }
  url.hash = '';
  return url;
}

export async function safeExternalFetch(inputUrl, {
  method = 'POST',
  headers = {},
  body = undefined,
  signal,
  timeoutMs = 15_000,
  maxBytes = 1024 * 1024,
  allowPrivate = process.env.ALLOW_PRIVATE_CONNECTORS === '1',
} = {}) {
  const url = connectorUrl(inputUrl, { allowPrivate, field: 'endpoint_url' });
  let records = null;
  if (!allowPrivate) {
    records = await resolvePublicRecords(url.hostname);
  } else {
    const rawHost = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(rawHost)) {
      records = [{ address: rawHost, family: isIP(rawHost) }];
    } else {
      try {
        records = await lookup(url.hostname, { all: true, verbatim: true });
      } catch {
        throw new AppError(422, 'SOURCE_UNRESOLVED', '无法解析目标域名。', 'url');
      }
      if (!records.length) throw new AppError(422, 'SOURCE_UNRESOLVED', '无法解析目标域名。', 'url');
    }
  }
  const transport = url.protocol === 'https:' ? https : http;
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : (body ? JSON.stringify(body) : null);
  let lastError = null;
  for (const record of records) {
    try {
      const family = isIP(record.address) === 6 ? 6 : 4;
      return await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new AppError(499, 'REQUEST_ABORTED', '外部请求已取消。'));
          return;
        }
        const request = transport.request({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method,
          signal,
          headers,
          lookup: (hostname, options, callback) => {
            if (options?.all) callback(null, [{ address: record.address, family }]);
            else callback(null, record.address, family);
          },
        }, async response => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume();
            reject(new AppError(502, 'CONNECTOR_REDIRECT_BLOCKED', '外部连接器不允许跨跳重定向。'));
            return;
          }
          try {
            const chunks = [];
            let size = 0;
            for await (const chunk of response) {
              size += chunk.length;
              if (size > maxBytes) {
                response.destroy();
                reject(new AppError(502, 'CONNECTOR_RESPONSE_TOO_LARGE', '外部接口响应体积超出限制。'));
                return;
              }
              chunks.push(chunk);
            }
            const rawText = Buffer.concat(chunks).toString('utf8');
            resolve({
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode,
              headers: response.headers,
              text: async () => rawText,
              json: async () => JSON.parse(rawText || '{}'),
            });
          } catch (err) {
            reject(err);
          }
        });
        request.setTimeout(timeoutMs, () => request.destroy(new AppError(504, 'CONNECTOR_TIMEOUT', '外部连接器请求超时。')));
        request.on('error', err => reject(err instanceof AppError ? err : new AppError(502, 'CONNECTOR_ERROR', err.message || '外部连接器请求失败。')));
        if (payload !== null) request.write(payload);
        request.end();
      });
    } catch (error) {
      if (error?.code === 'REQUEST_ABORTED' || error?.code === 'CONNECTOR_REDIRECT_BLOCKED' || error?.code === 'CONNECTOR_RESPONSE_TOO_LARGE') throw error;
      lastError = error;
    }
  }
  throw lastError || new AppError(502, 'CONNECTOR_ERROR', '外部连接器请求失败。');
}

function requestOnce(url, address, signal) {
  const family = isIP(address) === 6 ? 6 : 4;
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError(499, 'RESEARCH_CANCELLED', '抓取任务已取消。', 'url'));
      return;
    }
    const request = transport.request({
      protocol: url.protocol, hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`, method: 'GET',
      signal,
      headers: {
        'User-Agent': 'BoteinLocal/0.1 (local workspace; user-initiated page read)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br, identity',
      },
      // Pin the DNS answer that was just validated, so a second lookup cannot
      // rebind the connection to a private address.
      lookup: (hostname, options, callback) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, response => resolve(response));
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new AppError(504, 'SOURCE_TIMEOUT', '读取来源超时。', 'url')));
    request.on('error', error => {
      if (error?.name === 'AbortError' || signal?.aborted) {
        reject(new AppError(499, 'RESEARCH_CANCELLED', '抓取任务已取消。', 'url'));
        return;
      }
      reject(error instanceof AppError ? error : new AppError(502, 'SOURCE_FETCH_FAILED', '无法读取来源页面。', 'url'));
    });
    request.end();
  });
}

async function requestWithFallback(url, records, signal) {
  let lastError = null;
  for (const record of records) {
    try {
      return await requestOnce(url, record.address, signal);
    } catch (error) {
      if (error?.code === 'RESEARCH_CANCELLED') throw error;
      lastError = error;
    }
  }
  throw lastError || new AppError(502, 'SOURCE_FETCH_FAILED', '无法读取来源页面。', 'url');
}

function decompressBody(buffer, encoding, maxBytes) {
  const normalized = String(encoding || 'identity').split(',')[0].trim().toLowerCase();
  if (!normalized || normalized === 'identity') return buffer;
  const maxOutputLength = Math.max(maxBytes * 2, MAX_DECOMPRESSED_BYTES);
  try {
    if (normalized === 'gzip' || normalized === 'x-gzip') return gunzipSync(buffer, { maxOutputLength });
    if (normalized === 'deflate') return inflateSync(buffer, { maxOutputLength });
    if (normalized === 'br') return brotliDecompressSync(buffer, { maxOutputLength });
  } catch {
    throw new AppError(413, 'SOURCE_TOO_LARGE', '来源页面解压失败或超过允许大小限制。', 'url');
  }
  throw new AppError(415, 'SOURCE_ENCODING_UNSUPPORTED', '来源使用了不支持的压缩编码。', 'url');
}

async function readBody(response, maxBytes) {
  const encoding = String(response.headers['content-encoding'] || 'identity').split(',')[0].trim().toLowerCase();
  if (!['identity', 'gzip', 'x-gzip', 'deflate', 'br'].includes(encoding)) {
    response.resume();
    throw new AppError(415, 'SOURCE_ENCODING_UNSUPPORTED', '来源使用了不支持的压缩编码。', 'url');
  }
  const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!['text/html', 'application/xhtml+xml', 'text/plain'].includes(type)) {
    response.resume();
    throw new AppError(415, 'SOURCE_TYPE_UNSUPPORTED', '来源不是可读取的网页或纯文本。', 'url');
  }
  const declared = Number(response.headers['content-length'] || 0);
  if (declared > maxBytes) {
    response.resume();
    throw new AppError(413, 'SOURCE_TOO_LARGE', `来源页面超过 ${Math.round(maxBytes / 1024)} KB，未读取。`, 'url');
  }
  const chunks = []; let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > maxBytes) {
      response.destroy();
      throw new AppError(413, 'SOURCE_TOO_LARGE', `来源页面超过 ${Math.round(maxBytes / 1024)} KB，未读取。`, 'url');
    }
    chunks.push(chunk);
  }
  const rawBuffer = Buffer.concat(chunks);
  const decodedBuffer = decompressBody(rawBuffer, encoding, maxBytes);
  return { type, buffer: decodedBuffer, size: rawBuffer.length };
}

function isLikelySpaShell(html, extractedText) {
  return String(extractedText || '').length < 140
    && /<(?:div|main|section)[^>]+(?:id|data-reactroot|ng-app)[=\s"']*(?:root|app|__next|__nuxt)?/i.test(String(html || ''));
}

export async function renderSpaWithChrome(targetUrl, pinnedAddress, { chromeBin = process.env.CHROME_BIN || 'google-chrome', signal } = {}) {
  const host = targetUrl.hostname;
  const mappedAddress = isIP(pinnedAddress) === 6 ? `[${pinnedAddress}]` : pinnedAddress;
  const { stdout } = await execFileAsync(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-extensions',
    '--dump-dom',
    `--host-resolver-rules=MAP ${host} ${mappedAddress}, MAP * ~NOTFOUND`,
    targetUrl.href,
  ], { timeout: TIMEOUT_MS, maxBuffer: MAX_DECOMPRESSED_BYTES, signal });
  return String(stdout || '');
}

export async function fetchPublicPage(input, {
  maxBytes = MAX_BYTES, signal, bypassGlobalRateLimit = false, rateBucket = 'preview',
  rateLimitDb = null, headlessFallback = process.env.HEADLESS_RENDER === '1', spaRenderer = renderSpaWithChrome,
} = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new AppError(422, 'INVALID_URL', '请填写来源网址。', 'url');
  if (signal?.aborted) throw new AppError(499, 'RESEARCH_CANCELLED', '抓取任务已取消。', 'url');
  let current = sourceUrl(input.trim());
  if (!bypassGlobalRateLimit) {
    if (rateLimitDb) {
      const limit = rateBucket === 'background' ? MAX_BACKGROUND_FETCHES : MAX_PREVIEW_FETCHES;
      if (!checkAndRecordRateLimit(rateLimitDb, `fetch:${rateBucket}`, 'global', limit, WINDOW_MS).allowed) {
        throw new AppError(429, 'SOURCE_RATE_LIMITED', `每 15 分钟最多读取 ${limit} 个公开页面，请稍后再试。`, 'url');
      }
    } else {
      allowFetch(rateBucket);
    }
  }
  const chain = [];
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const records = await resolvePublicRecords(current.hostname);
      const response = await requestWithFallback(current, records, signal);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location;
        response.resume();
        if (!location) throw new AppError(502, 'SOURCE_REDIRECT_INVALID', '来源返回了缺少目标地址的重定向。', 'url');
        chain.push(current.href);
        current = sourceUrl(new URL(location, current).href);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw new AppError(502, 'SOURCE_HTTP_ERROR', `来源页面返回 ${response.statusCode}。`, 'url');
      }
      const body = await readBody(response, maxBytes);
      let html = body.buffer.toString('utf8');
      let extracted = htmlToText(html);
      let extraction = 'SIMPLE_TAG_STRIP';
      if (headlessFallback && isLikelySpaShell(html, extracted.text)) {
        try {
          const renderedHtml = await spaRenderer(current, records[0].address, { signal });
          const renderedExtracted = htmlToText(renderedHtml);
          if (renderedExtracted.text.length > extracted.text.length) {
            html = renderedHtml;
            extracted = renderedExtracted;
            extraction = 'HEADLESS_CHROME_DOM';
          }
        } catch { /* fall back gracefully to static HTML */ }
      }
      return {
        requested_url: input.trim(), final_url: current.href, status_code: response.statusCode,
        content_type: body.type, byte_length: body.size, redirect_count: chain.length,
        redirect_chain: chain, fetched_at: new Date().toISOString(), text: extracted.text,
        truncated: extracted.truncated, extraction, metadata: extractPageMeta(html),
      };
    }
    throw new AppError(422, 'SOURCE_REDIRECT_LIMIT', '来源重定向次数过多，未继续读取。', 'url');
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(502, 'SOURCE_FETCH_FAILED', '无法读取来源页面。', 'url');
  }
}
