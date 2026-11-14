import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { AppError } from './validation.mjs';

const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8_000;
const MAX_TEXT = 20_000;
const WINDOW_MS = 15 * 60_000;
const MAX_FETCHES = 30;

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
  return {
    title: htmlToText(title).text.slice(0, 300),
    site_name: htmlToText(metaContent(html, 'property', 'og:site_name')).text.slice(0, 200),
    description: htmlToText(metaContent(html, 'name', 'description')).text.slice(0, 500),
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
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      return named[code.toLowerCase()] ?? match;
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT };
}

const attempts = [];
function allowFetch() {
  const now = Date.now();
  while (attempts.length && now - attempts[0] > WINDOW_MS) attempts.shift();
  if (attempts.length >= MAX_FETCHES) throw new AppError(429, 'SOURCE_RATE_LIMITED', '读取来源过于频繁，请稍后再试。');
  attempts.push(now);
}

async function resolvePublic(hostname) {
  let records;
  try { records = await lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new AppError(422, 'SOURCE_UNRESOLVED', '无法解析来源域名。', 'url'); }
  if (!records.length) throw new AppError(422, 'SOURCE_UNRESOLVED', '无法解析来源域名。', 'url');
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new AppError(422, 'SOURCE_BLOCKED', '来源解析到本机、内网或保留地址，已拒绝访问。', 'url');
    }
  }
  return records[0];
}

function requestOnce(url, address) {
  const family = isIP(address) === 6 ? 6 : 4;
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol, hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`, method: 'GET',
      headers: {
        'User-Agent': 'BoteinLocal/0.1 (local workspace; user-initiated page read)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'Accept-Encoding': 'identity',
      },
      // Pin the DNS answer that was just validated, so a second lookup cannot
      // rebind the connection to a private address.
      lookup: (hostname, options, callback) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, response => resolve(response));
    request.setTimeout(TIMEOUT_MS, () => request.destroy(new AppError(504, 'SOURCE_TIMEOUT', '读取来源超时。', 'url')));
    request.on('error', error => reject(error instanceof AppError ? error : new AppError(502, 'SOURCE_FETCH_FAILED', '无法读取来源页面。', 'url')));
    request.end();
  });
}

async function readBody(response, maxBytes) {
  const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding !== 'identity') {
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
  return { type, buffer: Buffer.concat(chunks), size };
}

export async function fetchPublicPage(input, { maxBytes = MAX_BYTES } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new AppError(422, 'INVALID_URL', '请填写来源网址。', 'url');
  let current = sourceUrl(input.trim());
  allowFetch();
  const chain = [];
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const { address } = await resolvePublic(current.hostname);
      const response = await requestOnce(current, address);
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
      const html = body.buffer.toString('utf8');
      const extracted = htmlToText(html);
      return {
        requested_url: input.trim(), final_url: current.href, status_code: response.statusCode,
        content_type: body.type, byte_length: body.size, redirect_count: chain.length,
        redirect_chain: chain, fetched_at: new Date().toISOString(), text: extracted.text,
        truncated: extracted.truncated, extraction: 'SIMPLE_TAG_STRIP', metadata: extractPageMeta(html),
      };
    }
    throw new AppError(422, 'SOURCE_REDIRECT_LIMIT', '来源重定向次数过多，未继续读取。', 'url');
  } catch (error) {
    throw error instanceof AppError ? error : new AppError(502, 'SOURCE_FETCH_FAILED', '无法读取来源页面。', 'url');
  }
}
