import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  ORG,
  audit,
  checkAndRecordRateLimit,
  ensureOrganization,
  recordRateLimitFailure,
  transaction,
} from './store.mjs';
import { sealSecret, unsealSecret, base32Encode, verifyTotp } from './kms.mjs';
import { dispatchNotification } from './connectors.mjs';
import { AppError, requireValue, text } from './validation.mjs';

const derive = promisify(scrypt);
const cookieName = 'botein_session';
const lifetime = 12 * 60 * 60 * 1000;
const DUMMY_HASH = '0'.repeat(128);
const digest = value => createHash('sha256').update(value).digest('hex');
const hashPassword = async (password, salt) => (await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');

function password(value, field) {
  requireValue(typeof value === 'string' && value.length >= 8 && Buffer.byteLength(value, 'utf8') <= 256,
    '密码至少 8 个字符，UTF-8 长度不超过 256 字节。支持粘贴和密码管理器。', field);
  return value; // Deliberately preserve spaces and Unicode; never trim a password.
}

function cookieToken(req) {
  const pairs = (req.headers.cookie || '').split(';').map(part => part.trim().split('='));
  const tokens = pairs.filter(pair => pair[0] === cookieName);
  return tokens.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(tokens[0][1] || '') ? tokens[0][1] : null;
}

export function isHttpsRequest(req) {
  if (req?.socket?.encrypted) return true;
  if (process.env.TRUST_PROXY === '1') {
    const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
  }
  return false;
}

function sessionCookie(req, res, token) {
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime / 1000}${secure}`);
}

function clearCookie(req, res) {
  const secure = isHttpsRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

export function createAuth(db) {
  let busy = 0;
  const defaultOwner = () => db.prepare('SELECT * FROM local_owners WHERE organization_id=?').get(ORG);
  const orgBySlugOrId = key => {
    const k = String(key || '').trim();
    if (!k) return null;
    return db.prepare('SELECT * FROM organizations WHERE id=? OR slug=?').get(k, k) || null;
  };
  const ownerForOrg = orgId => db.prepare('SELECT * FROM local_owners WHERE organization_id=?').get(orgId);
  const clientKey = req => `ip:${req?.socket?.remoteAddress || '127.0.0.1'}`;

  function session(req) {
    const token = cookieToken(req);
    if (!token) return null;
    const tokenHash = digest(token);
    const now = new Date().toISOString();
    const ownerSess = db.prepare(`SELECT s.token_hash,s.public_id,s.created_at,s.expires_at,
      o.id,o.organization_id,o.username,o.display_name,o.email,o.mfa_enabled,o.credential_version,
      org.name AS org_name, org.slug AS org_slug
      FROM auth_sessions s
      JOIN local_owners o ON o.id=s.owner_id
      JOIN organizations org ON org.id=o.organization_id
      WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash, now);
    if (ownerSess) {
      return {
        ...ownerSess,
        role: 'OWNER',
        userType: 'OWNER',
        actor: `OWNER:${ownerSess.username}`,
      };
    }
    const memberSess = db.prepare(`SELECT s.token_hash,s.public_id,s.created_at,s.expires_at,
      m.id,m.organization_id,m.username,m.display_name,m.email,m.mfa_enabled,m.role,m.credential_version,
      org.name AS org_name, org.slug AS org_slug
      FROM member_sessions s
      JOIN workspace_members m ON m.id=s.member_id
      JOIN organizations org ON org.id=m.organization_id
      WHERE s.token_hash=? AND m.status='ACTIVE' AND s.expires_at>?`).get(tokenHash, now);
    if (memberSess) {
      return {
        ...memberSess,
        userType: 'MEMBER',
        actor: `${memberSess.role}:${memberSess.username}`,
      };
    }
    return null;
  }

  function ctxOf(current) {
    if (!current) return { orgId: ORG, actor: 'LOCAL_OWNER', userId: null, role: 'OWNER' };
    return {
      orgId: current.organization_id || ORG,
      actor: current.actor || `${current.role || 'OWNER'}:${current.username || 'owner'}`,
      userId: current.id || null,
      role: current.role || 'OWNER',
    };
  }

  function requireSession(req) {
    const current = session(req);
    requireValue(current, '请先登录，或重新登录已过期的会话。', undefined, 401, 'AUTH_REQUIRED');
    return current;
  }

  function requireOwner(req) {
    const current = requireSession(req);
    requireValue(current.role === 'OWNER', '仅工作区负责人（OWNER）可执行此操作。', undefined, 403, 'FORBIDDEN');
    return current;
  }

  function deletePreviousCookieSession(req) {
    const previous = cookieToken(req);
    if (!previous) return;
    const h = digest(previous);
    db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(h);
    db.prepare('DELETE FROM member_sessions WHERE token_hash=?').run(h);
  }

  function issue(principalId, userType, res, req) {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + lifetime).toISOString();
    db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(nowIso);
    db.prepare('DELETE FROM member_sessions WHERE expires_at<=?').run(nowIso);
    deletePreviousCookieSession(req);
    if (userType === 'MEMBER') {
      db.prepare('INSERT INTO member_sessions (token_hash,member_id,public_id,created_at,expires_at) VALUES (?,?,?,?,?)')
        .run(digest(token), principalId, randomUUID(), nowIso, expiresAt);
    } else {
      db.prepare('INSERT INTO auth_sessions (token_hash,owner_id,created_at,expires_at,public_id) VALUES (?,?,?,?,?)')
        .run(digest(token), principalId, nowIso, expiresAt, randomUUID());
    }
    sessionCookie(req, res, token);
    return { expires_at: expiresAt };
  }

  async function verifySecret(value, record) {
    requireValue(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 256, '账号或密码不正确。', undefined, 401, 'INVALID_CREDENTIALS');
    const computed = await hashPassword(value, record?.password_salt || 'unconfigured-local-owner');
    const targetHex = record?.password_hash || DUMMY_HASH;
    const valid = Boolean(record) && timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(targetHex, 'hex'));
    requireValue(valid, '账号或密码不正确。', undefined, 401, 'INVALID_CREDENTIALS');
  }

  async function expensive(req, action, { countFailure = false, bucket = 'auth_login' } = {}) {
    const key = clientKey(req);
    const rate = checkAndRecordRateLimit(db, bucket, key, 9, 15 * 60 * 1000, { record: false });
    requireValue(rate.allowed && busy < 2, '尝试次数过多，请稍后再试。登录尝试窗口为 15 分钟。', undefined, 429, 'AUTH_RATE_LIMIT');
    busy++;
    try {
      return await action();
    } catch (error) {
      if (countFailure && (error?.code === 'INVALID_CREDENTIALS' || error?.code === 'INVALID_MFA' || error?.status === 401)) {
        recordRateLimitFailure(db, bucket, key, 15 * 60 * 1000);
      }
      throw error;
    } finally {
      busy--;
    }
  }

  function resolvePrincipalForLogin(username, orgKey = '') {
    if (!username) return { principal: null, userType: 'OWNER', orgId: ORG };
    if (orgKey) {
      const org = orgBySlugOrId(orgKey);
      if (!org) return { principal: null, userType: 'OWNER', orgId: '' };
      const ow = ownerForOrg(org.id);
      if (ow && ow.username === username) return { principal: ow, userType: 'OWNER', orgId: org.id };
      const mb = db.prepare("SELECT * FROM workspace_members WHERE organization_id=? AND username=? AND status='ACTIVE'").get(org.id, username);
      if (mb) return { principal: mb, userType: 'MEMBER', orgId: org.id };
      return { principal: null, userType: 'OWNER', orgId: org.id };
    }
    const defaultOw = ownerForOrg(ORG);
    if (defaultOw && defaultOw.username === username) return { principal: defaultOw, userType: 'OWNER', orgId: ORG };
    const defaultMb = db.prepare("SELECT * FROM workspace_members WHERE organization_id=? AND username=? AND status='ACTIVE'").get(ORG, username);
    if (defaultMb) return { principal: defaultMb, userType: 'MEMBER', orgId: ORG };

    const owners = db.prepare('SELECT * FROM local_owners WHERE username=?').all(username);
    const members = db.prepare("SELECT * FROM workspace_members WHERE username=? AND status='ACTIVE'").all(username);
    const matches = [
      ...owners.map(o => ({ principal: o, userType: 'OWNER', orgId: o.organization_id })),
      ...members.map(m => ({ principal: m, userType: 'MEMBER', orgId: m.organization_id })),
    ];
    if (matches.length === 1) return matches[0];
    return { principal: null, userType: 'OWNER', orgId: ORG };
  }

  function principalRecord(current) {
    return current.userType === 'MEMBER'
      ? db.prepare('SELECT * FROM workspace_members WHERE id=? AND organization_id=?').get(current.id, current.organization_id)
      : db.prepare('SELECT * FROM local_owners WHERE id=? AND organization_id=?').get(current.id, current.organization_id);
  }

  async function handle(req, res, path, method, body) {
    if (path === '/sessions' && method === 'GET') {
      const current = requireSession(req);
      const generatedAt = new Date().toISOString();
      const sql = current.userType === 'MEMBER'
        ? 'SELECT public_id AS id,created_at,expires_at FROM member_sessions WHERE member_id=? AND expires_at>? ORDER BY created_at DESC,public_id'
        : 'SELECT public_id AS id,created_at,expires_at FROM auth_sessions WHERE owner_id=? AND expires_at>? ORDER BY created_at DESC,public_id';
      const items = db.prepare(sql).all(current.id, generatedAt).map(row => ({ ...row, current: row.id === current.public_id }));
      return { status: 200, body: { items, generated_at: generatedAt } };
    }
    if (path === '/sessions/revoke-others' && method === 'POST') {
      return transaction(db, () => {
        const current = requireSession(req);
        requireValue(body.confirmed === true, '请确认退出其他会话，本窗口保留登录。', 'confirmed');
        const table = current.userType === 'MEMBER' ? 'member_sessions' : 'auth_sessions';
        const col = current.userType === 'MEMBER' ? 'member_id' : 'owner_id';
        const rows = db.prepare(`SELECT public_id,expires_at FROM ${table} WHERE ${col}=? AND token_hash<>?`).all(current.id, current.token_hash);
        const now = new Date().toISOString();
        db.prepare(`DELETE FROM ${table} WHERE ${col}=? AND token_hash<>?`).run(current.id, current.token_hash);
        const count = rows.filter(row => row.expires_at > now).length;
        audit(db, 'OWNER_OTHER_SESSIONS_REVOKED', current.id, { count }, ctxOf(current));
        return { status: 200, body: { revoked_count: count, authenticated: true } };
      });
    }
    const revoke = path.match(/^\/sessions\/([^/]+)\/revoke$/);
    if (revoke && method === 'POST') {
      return transaction(db, () => {
        const current = requireSession(req);
        requireValue(body.confirmed === true, '请确认撤销指定登录。', 'confirmed');
        const table = current.userType === 'MEMBER' ? 'member_sessions' : 'auth_sessions';
        const col = current.userType === 'MEMBER' ? 'member_id' : 'owner_id';
        const target = db.prepare(`SELECT public_id FROM ${table} WHERE public_id=? AND ${col}=? AND expires_at>?`)
          .get(revoke[1], current.id, new Date().toISOString());
        requireValue(target, '该登录已失效或不可访问，请刷新列表。', undefined, 404, 'NOT_FOUND');
        db.prepare(`DELETE FROM ${table} WHERE public_id=? AND ${col}=?`).run(target.public_id, current.id);
        const isCurrent = target.public_id === current.public_id;
        audit(db, 'OWNER_SESSION_REVOKED', current.id, { session_id: target.public_id, current: isCurrent }, ctxOf(current));
        if (isCurrent) clearCookie(req, res);
        return { status: 200, body: { revoked: true, authenticated: !isCurrent } };
      });
    }
    if (path === '/status' && method === 'GET') {
      const current = session(req);
      return {
        status: 200,
        body: {
          setup_required: !defaultOwner(),
          multi_org_enabled: process.env.ALLOW_MULTI_ORG_REGISTER !== '0',
          authenticated: !!current,
          ...(current ? {
            organization: { id: current.organization_id, name: current.org_name, slug: current.org_slug || '' },
            user: {
              id: current.id,
              username: current.username,
              display_name: current.display_name,
              email: current.email || '',
              role: current.role,
              mfa_enabled: Boolean(current.mfa_enabled),
            },
            expires_at: current.expires_at,
          } : {}),
        },
      };
    }
    if (path === '/setup' && method === 'POST') {
      requireValue(!defaultOwner(), '负责人账号已创建，请登录。', undefined, 409, 'SETUP_COMPLETE');
      const username = text(body.username, 'username', 64).toLowerCase();
      const displayName = text(body.display_name, 'display_name', 100), secret = password(body.password, 'password');
      const email = body.email ? text(body.email, 'email', 160).toLowerCase() : '';
      return expensive(req, async () => {
        const salt = randomBytes(16).toString('hex'), hash = await hashPassword(secret, salt);
        return transaction(db, () => {
          requireValue(!defaultOwner(), '负责人账号已创建，请登录。', undefined, 409, 'SETUP_COMPLETE');
          const id = randomUUID();
          db.prepare('INSERT INTO local_owners (id,organization_id,username,display_name,password_hash,password_salt,created_at,email) VALUES (?,?,?,?,?,?,?,?)')
            .run(id, ORG, username, displayName, hash, salt, new Date().toISOString(), email);
          audit(db, 'OWNER_ACCOUNT_CREATED', id, {}, { orgId: ORG, actor: `OWNER:${username}` });
          return { status: 201, body: { authenticated: true, ...issue(id, 'OWNER', res, req) } };
        });
      });
    }
    if (path === '/organizations/register' && method === 'POST') {
      requireValue(process.env.ALLOW_MULTI_ORG_REGISTER !== '0', '当前部署已关闭公开工作区注册。', undefined, 403, 'FORBIDDEN');
      const orgName = text(body.org_name, 'org_name', 120);
      const orgSlug = text(body.org_slug, 'org_slug', 64).toLowerCase();
      requireValue(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]?$/.test(orgSlug), '工作区标识仅支持小写字母、数字和连字符（至少 2 个字符）。', 'org_slug');
      const username = text(body.username, 'username', 64).toLowerCase();
      requireValue(/^[a-z0-9._-]+$/.test(username), '用户名仅支持小写字母、数字、点、下划线与连字符。', 'username');
      const displayName = text(body.display_name, 'display_name', 100);
      const email = body.email ? text(body.email, 'email', 160).toLowerCase() : '';
      const secret = password(body.password, 'password');
      return expensive(req, async () => {
        const salt = randomBytes(16).toString('hex'), hash = await hashPassword(secret, salt);
        return transaction(db, () => {
          const dupOrg = db.prepare('SELECT id FROM organizations WHERE slug=? OR id=?').get(orgSlug, orgSlug);
          requireValue(!dupOrg, '工作区标识已被占用。', 'org_slug', 409, 'DUPLICATE_ORG');
          const orgId = `org_${randomUUID()}`;
          ensureOrganization(db, { id: orgId, name: orgName, slug: orgSlug });
          const ownerId = randomUUID();
          const now = new Date().toISOString();
          db.prepare('INSERT INTO local_owners (id,organization_id,username,display_name,password_hash,password_salt,created_at,email) VALUES (?,?,?,?,?,?,?,?)')
            .run(ownerId, orgId, username, displayName, hash, salt, now, email);
          audit(db, 'ORG_REGISTERED', orgId, { org_name: orgName, org_slug: orgSlug, owner: username }, { orgId, actor: `OWNER:${username}` });
          return {
            status: 201,
            body: {
              authenticated: true,
              organization: { id: orgId, name: orgName, slug: orgSlug },
              ...issue(ownerId, 'OWNER', res, req),
            },
          };
        });
      });
    }
    if (path === '/login' && method === 'POST') return expensive(req, async () => {
      const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
      const orgKey = typeof (body.org_slug ?? body.organization_id) === 'string' ? String(body.org_slug ?? body.organization_id).trim() : '';
      const { principal, userType, orgId } = resolvePrincipalForLogin(username, orgKey);
      await verifySecret(body.password, principal);
      requireValue(username && principal.username === username, '账号或密码不正确。', undefined, 401, 'INVALID_CREDENTIALS');
      if (principal.mfa_enabled) {
        const code = typeof body.totp_code === 'string' ? body.totp_code.trim() : '';
        requireValue(code.length > 0, '该账号已开启双因素认证，请输入 6 位动态验证码。', 'totp_code', 401, 'MFA_REQUIRED');
        const secretBase32 = unsealSecret(principal.mfa_secret_enc);
        requireValue(secretBase32 && verifyTotp(secretBase32, code), '双因素动态验证码无效或已过期。', 'totp_code', 401, 'INVALID_MFA');
      }
      return transaction(db, () => {
        const fresh = userType === 'OWNER'
          ? db.prepare('SELECT * FROM local_owners WHERE id=?').get(principal.id)
          : db.prepare("SELECT * FROM workspace_members WHERE id=? AND status='ACTIVE'").get(principal.id);
        requireValue(fresh?.credential_version === principal.credential_version, '登录凭据已变化，请重试。', undefined, 401, 'INVALID_CREDENTIALS');
        const actorRole = userType === 'OWNER' ? 'OWNER' : fresh.role;
        audit(db, 'OWNER_LOGGED_IN', principal.id, { user_type: userType, mfa: Boolean(fresh.mfa_enabled) }, { orgId, actor: `${actorRole}:${fresh.username}` });
        return { status: 200, body: { authenticated: true, organization_id: orgId, ...issue(principal.id, userType, res, req) } };
      });
    }, { countFailure: true, bucket: 'auth_login' });
    if (path === '/logout' && method === 'POST') {
      const current = session(req);
      if (current) transaction(db, () => {
        const table = current.userType === 'MEMBER' ? 'member_sessions' : 'auth_sessions';
        db.prepare(`DELETE FROM ${table} WHERE token_hash=?`).run(current.token_hash);
        audit(db, 'OWNER_LOGGED_OUT', current.id, {}, ctxOf(current));
      });
      clearCookie(req, res);
      return { status: 200, body: { authenticated: false } };
    }
    if (path === '/password' && method === 'POST') {
      const current = requireSession(req);
      const record = principalRecord(current);
      const secret = password(body.new_password, 'new_password');
      return expensive(req, async () => {
        await verifySecret(body.current_password, record);
        const salt = randomBytes(16).toString('hex'), hash = await hashPassword(secret, salt);
        return transaction(db, () => {
          const freshCurrent = requireSession(req);
          const freshRecord = principalRecord(freshCurrent);
          requireValue(freshRecord?.credential_version === record.credential_version, '密码已被修改，请重新登录。', undefined, 409, 'VERSION_CONFLICT');
          if (freshCurrent.userType === 'MEMBER') {
            db.prepare('UPDATE workspace_members SET password_hash=?,password_salt=?,credential_version=? WHERE id=?').run(hash, salt, record.credential_version + 1, freshCurrent.id);
            db.prepare('DELETE FROM member_sessions WHERE member_id=?').run(freshCurrent.id);
          } else {
            db.prepare('UPDATE local_owners SET password_hash=?,password_salt=?,credential_version=? WHERE id=?').run(hash, salt, record.credential_version + 1, freshCurrent.id);
            db.prepare('DELETE FROM auth_sessions WHERE owner_id=?').run(freshCurrent.id);
          }
          audit(db, 'OWNER_PASSWORD_CHANGED', freshCurrent.id, {}, ctxOf(freshCurrent));
          return { status: 200, body: { authenticated: true, ...issue(freshCurrent.id, freshCurrent.userType, res, req) } };
        });
      }, { countFailure: true, bucket: 'auth_login' });
    }
    if (path === '/mfa/setup' && method === 'POST') {
      const current = requireSession(req);
      const secretBase32 = base32Encode(randomBytes(20));
      const sealed = sealSecret(secretBase32);
      const table = current.userType === 'MEMBER' ? 'workspace_members' : 'local_owners';
      transaction(db, () => {
        db.prepare(`UPDATE ${table} SET mfa_secret_enc=? WHERE id=? AND organization_id=?`).run(sealed, current.id, current.organization_id);
        audit(db, 'MFA_SETUP_INITIATED', current.id, {}, ctxOf(current));
      });
      const label = encodeURIComponent(`Botein:${current.username}`);
      const issuer = encodeURIComponent(current.org_slug || 'Botein');
      return {
        status: 200,
        body: {
          secret: secretBase32,
          otpauth_uri: `otpauth://totp/${label}?secret=${secretBase32}&issuer=${issuer}&period=30`,
        },
      };
    }
    if (path === '/mfa/enable' && method === 'POST') {
      const current = requireSession(req);
      const record = principalRecord(current);
      requireValue(record?.mfa_secret_enc, '请先生成双因素认证密钥。', undefined, 409, 'MFA_NOT_INITIALIZED');
      const code = text(body.totp_code, 'totp_code', 16);
      const secretBase32 = unsealSecret(record.mfa_secret_enc);
      requireValue(secretBase32 && verifyTotp(secretBase32, code), '动态验证码无效，请核对时间或重新扫码。', 'totp_code', 422, 'INVALID_MFA');
      const table = current.userType === 'MEMBER' ? 'workspace_members' : 'local_owners';
      transaction(db, () => {
        db.prepare(`UPDATE ${table} SET mfa_enabled=1 WHERE id=? AND organization_id=?`).run(current.id, current.organization_id);
        audit(db, 'MFA_ENABLED', current.id, {}, ctxOf(current));
      });
      return { status: 200, body: { mfa_enabled: true } };
    }
    if (path === '/mfa/disable' && method === 'POST') {
      const current = requireSession(req);
      const record = principalRecord(current);
      return expensive(req, async () => {
        await verifySecret(body.current_password, record);
        if (record.mfa_enabled && record.mfa_secret_enc) {
          const code = text(body.totp_code, 'totp_code', 16);
          const secretBase32 = unsealSecret(record.mfa_secret_enc);
          requireValue(secretBase32 && verifyTotp(secretBase32, code), '动态验证码无效。', 'totp_code', 401, 'INVALID_MFA');
        }
        const table = current.userType === 'MEMBER' ? 'workspace_members' : 'local_owners';
        transaction(db, () => {
          db.prepare(`UPDATE ${table} SET mfa_enabled=0, mfa_secret_enc='' WHERE id=? AND organization_id=?`).run(current.id, current.organization_id);
          audit(db, 'MFA_DISABLED', current.id, {}, ctxOf(current));
        });
        return { status: 200, body: { mfa_enabled: false } };
      }, { countFailure: true, bucket: 'auth_login' });
    }
    if (path === '/password-reset/request' && method === 'POST') {
      const rate = checkAndRecordRateLimit(db, 'auth_reset', clientKey(req), 6, 15 * 60 * 1000, { record: true });
      requireValue(rate.allowed, '密码重置请求过于频繁，请稍后再试。', undefined, 429, 'AUTH_RATE_LIMIT');
      const username = text(body.username, 'username', 64).toLowerCase();
      const orgKey = typeof (body.org_slug ?? body.organization_id) === 'string' ? String(body.org_slug ?? body.organization_id).trim() : '';
      const resolved = resolvePrincipalForLogin(username, orgKey);
      if (resolved.principal) {
        const rawToken = randomBytes(24).toString('base64url');
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const now = new Date().toISOString();
        transaction(db, () => {
          db.prepare('INSERT INTO password_reset_tokens (id,organization_id,principal_type,principal_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)')
            .run(randomUUID(), resolved.orgId, resolved.userType, resolved.principal.id, digest(rawToken), expiresAt, now);
          audit(db, 'PASSWORD_RESET_REQUESTED', resolved.principal.id, { user_type: resolved.userType }, { orgId: resolved.orgId, actor: `SYSTEM:${username}` });
        });
        await dispatchNotification(db, {
          channel: 'EMAIL',
          recipient: resolved.principal.email || resolved.principal.username,
          subject: 'Botein 密码重置验证码',
          payload: {
            kind: 'PASSWORD_RESET',
            organization_id: resolved.orgId,
            username: resolved.principal.username,
            reset_token: rawToken,
            expires_at: expiresAt,
          },
        }, { orgId: resolved.orgId });
      }
      return { status: 202, body: { accepted: true, message: '如果账号存在且已配置通知渠道，重置凭据已发送。' } };
    }
    if (path === '/password-reset/confirm' && method === 'POST') {
      const token = text(body.token, 'token', 128);
      const secret = password(body.new_password, 'new_password');
      return expensive(req, async () => {
        const salt = randomBytes(16).toString('hex'), hash = await hashPassword(secret, salt);
        return transaction(db, () => {
          const row = db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash=? AND used_at IS NULL').get(digest(token));
          requireValue(row && row.expires_at > new Date().toISOString(), '密码重置凭据无效或已过期。', 'token', 400, 'INVALID_RESET_TOKEN');
          const now = new Date().toISOString();
          db.prepare('UPDATE password_reset_tokens SET used_at=? WHERE id=?').run(now, row.id);
          if (row.principal_type === 'MEMBER') {
            db.prepare('UPDATE workspace_members SET password_hash=?,password_salt=?,credential_version=credential_version+1 WHERE id=? AND organization_id=?')
              .run(hash, salt, row.principal_id, row.organization_id);
            db.prepare('DELETE FROM member_sessions WHERE member_id=?').run(row.principal_id);
          } else {
            db.prepare('UPDATE local_owners SET password_hash=?,password_salt=?,credential_version=credential_version+1 WHERE id=? AND organization_id=?')
              .run(hash, salt, row.principal_id, row.organization_id);
            db.prepare('DELETE FROM auth_sessions WHERE owner_id=?').run(row.principal_id);
          }
          audit(db, 'PASSWORD_RESET_CONFIRMED', row.principal_id, { user_type: row.principal_type }, { orgId: row.organization_id, actor: 'SYSTEM:RESET' });
          return { status: 200, body: { reset: true } };
        });
      });
    }
    if (path === '/invitations' && method === 'GET') {
      const current = requireOwner(req);
      const items = db.prepare(`SELECT id,email,username,display_name,role,status,invited_by,expires_at,accepted_at,created_at
        FROM member_invitations WHERE organization_id=? ORDER BY created_at DESC, id DESC`).all(current.organization_id);
      return { status: 200, body: { items } };
    }
    if (path === '/invitations' && method === 'POST') {
      const current = requireOwner(req);
      const username = text(body.username, 'username', 64).toLowerCase();
      requireValue(/^[a-z0-9._-]+$/.test(username), '用户名仅支持小写字母、数字、点、下划线与连字符。', 'username');
      const displayName = text(body.display_name, 'display_name', 100);
      const email = body.email ? text(body.email, 'email', 160).toLowerCase() : '';
      const role = text(body.role ?? 'MEMBER', 'role', 20);
      requireValue(['OWNER', 'MEMBER'].includes(role), '成员角色仅支持 OWNER 或 MEMBER。', 'role');
      const rawToken = randomBytes(24).toString('base64url');
      const id = randomUUID();
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      transaction(db, () => {
        const primary = ownerForOrg(current.organization_id);
        requireValue(!primary || primary.username !== username, '用户名已被工作区负责人占用。', 'username', 409, 'DUPLICATE_USERNAME');
        const dup = db.prepare('SELECT id FROM workspace_members WHERE organization_id=? AND username=?').get(current.organization_id, username);
        requireValue(!dup, '该成员用户名已存在。', 'username', 409, 'DUPLICATE_USERNAME');
        db.prepare(`INSERT INTO member_invitations
          (id,organization_id,email,username,display_name,role,token_hash,invited_by,status,expires_at,created_at)
          VALUES (?,?,?,?,?,?,?,?,'PENDING',?,?)`)
          .run(id, current.organization_id, email, username, displayName, role, digest(rawToken), current.actor, expiresAt, now);
        audit(db, 'MEMBER_INVITED', id, { username, role, email }, ctxOf(current));
      });
      await dispatchNotification(db, {
        channel: 'EMAIL',
        recipient: email || username,
        subject: `邀请加入 ${current.org_name || 'Botein'} 工作区`,
        payload: {
          kind: 'MEMBER_INVITATION',
          invitation_id: id,
          organization_id: current.organization_id,
          username,
          role,
          invite_token: rawToken,
          expires_at: expiresAt,
        },
      }, ctxOf(current));
      return {
        status: 201,
        body: { id, username, display_name: displayName, email, role, status: 'PENDING', expires_at: expiresAt, created_at: now, invite_token: rawToken },
      };
    }
    const inviteRevoke = path.match(/^\/invitations\/([^/]+)\/revoke$/);
    if (inviteRevoke && method === 'POST') {
      const current = requireOwner(req);
      return transaction(db, () => {
        const row = db.prepare('SELECT * FROM member_invitations WHERE id=? AND organization_id=?').get(inviteRevoke[1], current.organization_id);
        requireValue(row, '邀请记录不存在。', undefined, 404, 'NOT_FOUND');
        requireValue(row.status === 'PENDING', '仅可撤销待接受的邀请。', undefined, 409, 'INVALID_TRANSITION');
        db.prepare("UPDATE member_invitations SET status='REVOKED' WHERE id=? AND organization_id=?").run(row.id, current.organization_id);
        audit(db, 'MEMBER_INVITATION_REVOKED', row.id, { username: row.username }, ctxOf(current));
        return { status: 200, body: { id: row.id, status: 'REVOKED' } };
      });
    }
    if (path === '/invitations/accept' && method === 'POST') {
      const token = text(body.token, 'token', 128);
      const secret = password(body.password, 'password');
      const overrideDisplay = body.display_name ? text(body.display_name, 'display_name', 100) : null;
      return expensive(req, async () => {
        const salt = randomBytes(16).toString('hex'), hash = await hashPassword(secret, salt);
        return transaction(db, () => {
          const inv = db.prepare('SELECT * FROM member_invitations WHERE token_hash=?').get(digest(token));
          requireValue(inv && inv.status === 'PENDING' && inv.expires_at > new Date().toISOString(), '邀请链接无效或已过期。', 'token', 400, 'INVALID_INVITATION');
          const primary = ownerForOrg(inv.organization_id);
          requireValue(!primary || primary.username !== inv.username, '用户名已被工作区负责人占用。', 'username', 409, 'DUPLICATE_USERNAME');
          const dup = db.prepare('SELECT id FROM workspace_members WHERE organization_id=? AND username=?').get(inv.organization_id, inv.username);
          requireValue(!dup, '该成员用户名已存在。', 'username', 409, 'DUPLICATE_USERNAME');
          const memberId = randomUUID();
          const now = new Date().toISOString();
          db.prepare(`INSERT INTO workspace_members (id,organization_id,username,display_name,role,status,password_hash,password_salt,created_at,email)
            VALUES (?,?,?,?,?,'ACTIVE',?,?,?,?)`)
            .run(memberId, inv.organization_id, inv.username, overrideDisplay || inv.display_name, inv.role, hash, salt, now, inv.email || '');
          db.prepare("UPDATE member_invitations SET status='ACCEPTED', accepted_at=? WHERE id=?").run(now, inv.id);
          audit(db, 'MEMBER_INVITATION_ACCEPTED', memberId, { invitation_id: inv.id, username: inv.username }, { orgId: inv.organization_id, actor: `${inv.role}:${inv.username}` });
          return {
            status: 201,
            body: {
              authenticated: true,
              organization_id: inv.organization_id,
              member: { id: memberId, username: inv.username, display_name: overrideDisplay || inv.display_name, role: inv.role },
              ...issue(memberId, 'MEMBER', res, req),
            },
          };
        });
      });
    }
    if (path === '/members' && method === 'GET') {
      const current = requireOwner(req);
      const primary = ownerForOrg(current.organization_id);
      const members = db.prepare(`SELECT id, username, display_name, email, role, status, mfa_enabled, created_at
        FROM workspace_members WHERE organization_id=? ORDER BY created_at ASC, id ASC`).all(current.organization_id);
      const items = [
        ...(primary ? [{ id: primary.id, username: primary.username, display_name: primary.display_name, email: primary.email || '', role: 'OWNER', status: 'ACTIVE', mfa_enabled: Boolean(primary.mfa_enabled), is_primary: true, created_at: primary.created_at }] : []),
        ...members.map(m => ({ ...m, mfa_enabled: Boolean(m.mfa_enabled), is_primary: false })),
      ];
      return { status: 200, body: { items } };
    }
    if (path === '/members' && method === 'POST') {
      const current = requireOwner(req);
      const username = text(body.username, 'username', 64).toLowerCase();
      requireValue(/^[a-z0-9._-]+$/.test(username), '用户名仅支持小写字母、数字、点、下划线与连字符。', 'username');
      const displayName = text(body.display_name, 'display_name', 100);
      const email = body.email ? text(body.email, 'email', 160).toLowerCase() : '';
      const role = text(body.role ?? 'MEMBER', 'role', 20);
      requireValue(['OWNER', 'MEMBER'].includes(role), '成员角色仅支持 OWNER 或 MEMBER。', 'role');
      const secret = password(body.password, 'password');
      return expensive(req, async () => {
        const salt = randomBytes(16).toString('hex'), hash = await hashPassword(secret, salt);
        return transaction(db, () => {
          const primary = ownerForOrg(current.organization_id);
          requireValue(!primary || primary.username !== username, '用户名已被工作区负责人占用。', 'username', 409, 'DUPLICATE_USERNAME');
          const dup = db.prepare('SELECT id FROM workspace_members WHERE organization_id=? AND username=?').get(current.organization_id, username);
          requireValue(!dup, '该成员用户名已存在。', 'username', 409, 'DUPLICATE_USERNAME');
          const id = randomUUID();
          const now = new Date().toISOString();
          db.prepare(`INSERT INTO workspace_members (id,organization_id,username,display_name,role,status,password_hash,password_salt,created_at,email)
            VALUES (?,?,?,?,?,'ACTIVE',?,?,?,?)`).run(id, current.organization_id, username, displayName, role, hash, salt, now, email);
          audit(db, 'MEMBER_CREATED', id, { username, role }, ctxOf(current));
          return { status: 201, body: { id, username, display_name: displayName, email, role, status: 'ACTIVE', created_at: now } };
        });
      });
    }
    const memberMatch = path.match(/^\/members\/([^/]+)$/);
    if (memberMatch && method === 'PATCH') {
      const current = requireOwner(req);
      const memberId = memberMatch[1];
      return transaction(db, () => {
        const existing = db.prepare('SELECT * FROM workspace_members WHERE id=? AND organization_id=?').get(memberId, current.organization_id);
        requireValue(existing, '成员不存在（注意：初始负责人账号不可在此降权或停用）。', undefined, 404, 'NOT_FOUND');
        requireValue(memberId !== current.id, '不可在此停用或修改当前登录账号权限。', undefined, 422, 'INVALID_OPERATION');
        const nextRole = body.role === undefined ? existing.role : text(body.role, 'role', 20);
        requireValue(['OWNER', 'MEMBER'].includes(nextRole), '成员角色仅支持 OWNER 或 MEMBER。', 'role');
        const nextStatus = body.status === undefined ? existing.status : text(body.status, 'status', 20);
        requireValue(['ACTIVE', 'DISABLED'].includes(nextStatus), '成员状态仅支持 ACTIVE 或 DISABLED。', 'status');
        const nextDisplay = body.display_name === undefined ? existing.display_name : text(body.display_name, 'display_name', 100);
        db.prepare('UPDATE workspace_members SET role=?, status=?, display_name=?, credential_version=credential_version+1 WHERE id=? AND organization_id=?')
          .run(nextRole, nextStatus, nextDisplay, memberId, current.organization_id);
        if (nextStatus === 'DISABLED' || nextRole !== existing.role) {
          db.prepare('DELETE FROM member_sessions WHERE member_id=?').run(memberId);
        }
        audit(db, 'MEMBER_UPDATED', memberId, { role: nextRole, status: nextStatus }, ctxOf(current));
        const updated = db.prepare('SELECT id,username,display_name,email,role,status,created_at FROM workspace_members WHERE id=?').get(memberId);
        return { status: 200, body: updated };
      });
    }
    const resetMatch = path.match(/^\/members\/([^/]+)\/reset-password$/);
    if (resetMatch && method === 'POST') {
      const current = requireOwner(req);
      const memberId = resetMatch[1];
      const existing = db.prepare('SELECT * FROM workspace_members WHERE id=? AND organization_id=?').get(memberId, current.organization_id);
      requireValue(existing, '成员不存在。', undefined, 404, 'NOT_FOUND');
      const secret = password(body.new_password, 'new_password');
      return expensive(req, async () => {
        const salt = randomBytes(16).toString('hex'), hash = await hashPassword(secret, salt);
        return transaction(db, () => {
          db.prepare('UPDATE workspace_members SET password_hash=?,password_salt=?,credential_version=credential_version+1 WHERE id=? AND organization_id=?')
            .run(hash, salt, memberId, current.organization_id);
          db.prepare('DELETE FROM member_sessions WHERE member_id=?').run(memberId);
          audit(db, 'MEMBER_PASSWORD_RESET', memberId, {}, ctxOf(current));
          return { status: 200, body: { reset: true } };
        });
      });
    }
    throw new AppError(404, 'NOT_FOUND', '账号接口不存在。');
  }

  return { handle, requireSession, requireOwner, ctxOf, session };
}
