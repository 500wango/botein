import { calculateModelCost } from './catalog.mjs';
import { AppError } from './validation.mjs';

export function modelConfig() {
  const base = (process.env.MODEL_BASE_URL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
  const key = process.env.MODEL_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || '';
  const name = process.env.MODEL_NAME || process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '';
  return { base, key, authToken, name, configured: Boolean(base && (key || authToken) && name) };
}

function messagesUrl(base) {
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

export function escapePromptText(value) {
  return String(value ?? '').replace(/<\/(untrusted_[^>\s]+)>/gi, '</_$1>');
}

/**
 * Extracts the first complete top-level JSON object from model output while ignoring
 * braces inside JSON strings or markdown wrappers.
 */
export function extractJsonObject(raw) {
  const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      if (start !== -1) inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          return JSON.parse(text.slice(start, i + 1));
        }
      }
    }
  }
  throw new AppError(502, 'MODEL_INVALID_JSON', '模型没有返回有效的 JSON 对象。');
}

export async function completeText({ system, prompt, maxTokens = 2000, temperature = 0.2, signal }) {
  if (signal?.aborted) throw new AppError(499, 'RESEARCH_CANCELLED', '模型调用已取消。');
  const config = modelConfig();
  if (!config.configured) throw new AppError(503, 'MODEL_NOT_CONNECTED', '模型网关尚未配置。');
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (config.key) headers['x-api-key'] = config.key;
  else headers.authorization = `Bearer ${config.authToken}`;
  const reqSignal = signal ? AbortSignal.any([AbortSignal.timeout(90_000), signal]) : AbortSignal.timeout(90_000);
  let response;
  try {
    response = await fetch(messagesUrl(config.base), {
      method: 'POST', headers,
      body: JSON.stringify({
        model: config.name, max_tokens: maxTokens, temperature,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: reqSignal,
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) {
      throw new AppError(499, 'RESEARCH_CANCELLED', '模型调用已取消。');
    }
    throw new AppError(502, 'MODEL_REQUEST_FAILED', '模型请求失败或超时。');
  }
  if (!response.ok) throw new AppError(502, 'MODEL_REQUEST_FAILED', `模型网关返回 ${response.status}。`);
  let data;
  try { data = await response.json(); } catch { throw new AppError(502, 'MODEL_INVALID_RESPONSE', '模型返回了无效 JSON。'); }
  const text = (data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (!text) throw new AppError(502, 'MODEL_EMPTY_RESPONSE', '模型没有返回文本内容。');
  const model = data.model ?? config.name;
  const usage = data.usage ?? {};
  const cost = calculateModelCost(usage, model);
  return {
    text,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cost_usd: usage.cost_usd ?? cost,
    },
    model,
  };
}

export async function completeJson(options) {
  const result = await completeText(options);
  let data;
  try { data = extractJsonObject(result.text); }
  catch { throw new AppError(502, 'MODEL_INVALID_JSON', '模型返回的 JSON 无法解析。'); }
  return { ...result, data };
}
