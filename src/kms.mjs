import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

const DEV_FALLBACK_SEED = 'botein-dev-kms-local-fallback-do-not-use-in-prod';

function deriveLocalKey() {
  const raw = process.env.KMS_MASTER_KEY || process.env.BOTEIN_KMS_KEY || DEV_FALLBACK_SEED;
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function kmsStatus() {
  const endpoint = process.env.KMS_HTTP_ENDPOINT ? process.env.KMS_HTTP_ENDPOINT.trim() : '';
  const hasMasterKey = Boolean(process.env.KMS_MASTER_KEY || process.env.BOTEIN_KMS_KEY);
  return {
    provider: endpoint ? 'http-kms' : 'local-aes256gcm',
    configured_master_key: hasMasterKey,
    endpoint_configured: Boolean(endpoint),
  };
}

/**
 * Envelope encrypts sensitive values (MFA secrets, external API keys) using AES-256-GCM.
 */
export function sealSecret(plaintext) {
  const value = String(plaintext ?? '');
  if (!value) return '';
  const key = deriveLocalKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function unsealSecret(payload) {
  const raw = String(payload ?? '');
  if (!raw) return '';
  if (!raw.startsWith('v1:')) return raw;
  const parts = raw.split(':');
  if (parts.length !== 4) throw new Error('无效的密文格式。');
  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveLocalKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

export async function sealSecretRemote(plaintext) {
  const endpoint = process.env.KMS_HTTP_ENDPOINT ? process.env.KMS_HTTP_ENDPOINT.trim() : '';
  if (!endpoint) return sealSecret(plaintext);
  const response = await fetch(`${endpoint.replace(/\/+$/, '')}/seal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plaintext }),
  });
  if (!response.ok) throw new Error(`KMS seal error (${response.status})`);
  const data = await response.json();
  return String(data.ciphertext || '');
}

export async function unsealSecretRemote(ciphertext) {
  const endpoint = process.env.KMS_HTTP_ENDPOINT ? process.env.KMS_HTTP_ENDPOINT.trim() : '';
  if (!endpoint || String(ciphertext || '').startsWith('v1:')) return unsealSecret(ciphertext);
  const response = await fetch(`${endpoint.replace(/\/+$/, '')}/unseal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ciphertext }),
  });
  if (!response.ok) throw new Error(`KMS unseal error (${response.status})`);
  const data = await response.json();
  return String(data.plaintext || '');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(str) {
  const clean = String(str ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generates an RFC 6238 6-digit TOTP code for verification and testing.
 */
export function generateTotp(secretBase32, timestampMs = Date.now(), stepSeconds = 30) {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secretBase32, token, timestampMs = Date.now(), window = 1) {
  const clean = String(token ?? '').trim();
  if (!/^\d{6}$/.test(clean)) return false;
  for (let delta = -window; delta <= window; delta++) {
    if (generateTotp(secretBase32, timestampMs + delta * 30_000) === clean) return true;
  }
  return false;
}
