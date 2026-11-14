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

export async function completeText({ system, prompt, maxTokens = 2000, temperature = 0.2 }) {
  const config = modelConfig();
  if (!config.configured) throw new AppError(503, 'MODEL_NOT_CONNECTED', '模型网关尚未配置。');
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (config.key) headers['x-api-key'] = config.key;
  else headers.authorization = `Bearer ${config.authToken}`;
  let response;
  try {
    response = await fetch(messagesUrl(config.base), {
      method: 'POST', headers,
      body: JSON.stringify({
        model: config.name, max_tokens: maxTokens, temperature,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch { throw new AppError(502, 'MODEL_REQUEST_FAILED', '模型请求失败或超时。'); }
  if (!response.ok) throw new AppError(502, 'MODEL_REQUEST_FAILED', `模型网关返回 ${response.status}。`);
  let data;
  try { data = await response.json(); } catch { throw new AppError(502, 'MODEL_INVALID_RESPONSE', '模型返回了无效 JSON。'); }
  const text = (data.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  if (!text) throw new AppError(502, 'MODEL_EMPTY_RESPONSE', '模型没有返回文本内容。');
  return { text, usage: data.usage ?? {}, model: data.model ?? config.name };
}

export async function completeJson(options) {
  const result = await completeText(options);
  const stripped = result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = stripped.indexOf('{'), end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AppError(502, 'MODEL_INVALID_JSON', '模型没有返回 JSON 对象。');
  let data;
  try { data = JSON.parse(stripped.slice(start, end + 1)); }
  catch { throw new AppError(502, 'MODEL_INVALID_JSON', '模型返回的 JSON 无法解析。'); }
  return { ...result, data };
}
