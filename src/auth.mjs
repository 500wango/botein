import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ORG, audit, transaction } from './store.mjs';
import { AppError, requireValue, text } from './validation.mjs';

const derive = promisify(scrypt);
const cookieName = 'botein_session';
const lifetime = 12 * 60 * 60 * 1000;
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
function sessionCookie(res, token) {
  // Local HTTP only. Public HTTPS deployment is not supported by this build.
  res.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime / 1000}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}
export function createAuth(db) {
  // Local-owner limit, not a distributed production rate limiter. Restart clears the window.
  let attempts = [], busy = 0;
  const owner = () => db.prepare('SELECT * FROM local_owners WHERE organization_id=?').get(ORG);
  function session(req) {
    const token = cookieToken(req); if (!token) return null;
    return db.prepare(`SELECT s.token_hash,s.public_id,s.created_at,s.expires_at,o.id,o.username,o.display_name,o.credential_version
      FROM auth_sessions s JOIN local_owners o ON o.id=s.owner_id
      WHERE s.token_hash=? AND o.organization_id=? AND s.expires_at>?`).get(digest(token), ORG, new Date().toISOString()) || null;
  }
  function requireSession(req) {
    const current = session(req);
    requireValue(current, '请先登录，或重新登录已过期的会话。', undefined, 401, 'AUTH_REQUIRED');
    return current;
  }
  function issue(ownerId, res, req) {
    const token = randomBytes(32).toString('base64url'), now = new Date();
    db.prepare('DELETE FROM auth_sessions WHERE expires_at<=?').run(now.toISOString());
    const previous = cookieToken(req);
    if (previous) db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(digest(previous));
    db.prepare('INSERT INTO auth_sessions (token_hash,owner_id,created_at,expires_at,public_id) VALUES (?,?,?,?,?)').run(digest(token), ownerId, now.toISOString(), new Date(now.getTime()+lifetime).toISOString(), randomUUID());
    sessionCookie(res, token);
    return { expires_at: new Date(now.getTime()+lifetime).toISOString() };
  }
  async function verifySecret(value, record) {
    requireValue(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 256, '账号或密码不正确。', undefined, 401, 'INVALID_CREDENTIALS');
    const computed = await hashPassword(value, record?.password_salt || 'unconfigured-local-owner');
    const valid = record && timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(record.password_hash, 'hex'));
    requireValue(valid, '账号或密码不正确。', undefined, 401, 'INVALID_CREDENTIALS');
  }
  async function expensive(action) {
    const now = Date.now(); attempts = attempts.filter(t => now-t < 15*60*1000);
    requireValue(attempts.length < 10 && busy < 2, '尝试次数过多，请稍后再试。登录尝试窗口为 15 分钟。', undefined, 429, 'AUTH_RATE_LIMIT');
    attempts.push(now); busy++;
    try { return await action(); } finally { busy--; }
  }
  async function handle(req, res, path, method, body) {
    if (path === '/sessions' && method === 'GET') {
      const current = requireSession(req);
      const generatedAt = new Date().toISOString();
      const items = db.prepare('SELECT public_id AS id,created_at,expires_at FROM auth_sessions WHERE owner_id=? AND expires_at>? ORDER BY created_at DESC,public_id')
        .all(current.id, generatedAt).map(row => ({ ...row, current: row.id === current.public_id }));
      return { status: 200, body: { items, generated_at: generatedAt } };
    }
    if (path === '/sessions/revoke-others' && method === 'POST') {
      return transaction(db, () => {
        const current = requireSession(req);
        requireValue(body.confirmed === true, '请确认退出其他会话，本窗口保留登录。', 'confirmed');
        const rows = db.prepare('SELECT public_id,expires_at FROM auth_sessions WHERE owner_id=? AND token_hash<>?').all(current.id, current.token_hash);
        const now = new Date().toISOString();
        db.prepare('DELETE FROM auth_sessions WHERE owner_id=? AND token_hash<>?').run(current.id, current.token_hash);
        const count = rows.filter(row => row.expires_at > now).length;
        audit(db, 'OWNER_OTHER_SESSIONS_REVOKED', current.id, { count });
        return { status: 200, body: { revoked_count: count, authenticated: true } };
      });
    }
    const revoke = path.match(/^\/sessions\/([^/]+)\/revoke$/);
    if (revoke && method === 'POST') {
      return transaction(db, () => {
        const current = requireSession(req);
        requireValue(body.confirmed === true, '请确认撤销指定登录。', 'confirmed');
        const target = db.prepare('SELECT public_id FROM auth_sessions WHERE public_id=? AND owner_id=? AND expires_at>?')
          .get(revoke[1], current.id, new Date().toISOString());
        requireValue(target, '该登录已失效或不可访问，请刷新列表。', undefined, 404, 'NOT_FOUND');
        db.prepare('DELETE FROM auth_sessions WHERE public_id=? AND owner_id=?').run(target.public_id, current.id);
        const isCurrent = target.public_id === current.public_id;
        audit(db, 'OWNER_SESSION_REVOKED', current.id, { session_id: target.public_id, current: isCurrent });
        if (isCurrent) clearCookie(res);
        return { status: 200, body: { revoked: true, authenticated: !isCurrent } };
      });
    }
    if (path === '/status' && method === 'GET') {
      const current = session(req);
      return { status: 200, body: { setup_required: !owner(), authenticated: !!current,
        ...(current ? { user: { username: current.username, display_name: current.display_name, role: 'OWNER' }, expires_at: current.expires_at } : {}) } };
    }
    if (path === '/setup' && method === 'POST') {
      requireValue(!owner(), '负责人账号已创建，请登录。', undefined, 409, 'SETUP_COMPLETE');
      const username = text(body.username, 'username', 64).toLowerCase();
      const displayName = text(body.display_name, 'display_name', 100), secret = password(body.password, 'password');
      return expensive(async () => {
        const salt = randomBytes(16).toString('hex'), hash = await hashPassword(secret, salt);
        return transaction(db, () => {
          requireValue(!owner(), '负责人账号已创建，请登录。', undefined, 409, 'SETUP_COMPLETE');
          const id = randomUUID();
          db.prepare('INSERT INTO local_owners (id,organization_id,username,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?,?)')
            .run(id, ORG, username, displayName, hash, salt, new Date().toISOString());
          audit(db, 'OWNER_ACCOUNT_CREATED', id); // No credentials in audit details.
          return { status: 201, body: { authenticated: true, ...issue(id, res, req) } };
        });
      });
    }
    if (path === '/login' && method === 'POST') return expensive(async () => {
      const record = owner();
      await verifySecret(body.password, record);
      requireValue(typeof body.username === 'string' && body.username.trim().toLowerCase() === record.username, '账号或密码不正确。', undefined, 401, 'INVALID_CREDENTIALS');
      return transaction(db, () => {
        requireValue(owner()?.credential_version === record.credential_version, '登录凭据已变化，请重试。', undefined, 401, 'INVALID_CREDENTIALS');
        audit(db, 'OWNER_LOGGED_IN', record.id);
        return { status: 200, body: { authenticated: true, ...issue(record.id, res, req) } };
      });
    });
    if (path === '/logout' && method === 'POST') {
      const current = session(req);
      if (current) transaction(db, () => {
        db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(current.token_hash);
        audit(db, 'OWNER_LOGGED_OUT', current.id);
      });
      clearCookie(res);
      return { status: 200, body: { authenticated: false } };
    }
    if (path === '/password' && method === 'POST') {
      const current = requireSession(req), record = owner();
      const secret = password(body.new_password, 'new_password');
      return expensive(async () => {
        await verifySecret(body.current_password, record);
        const salt = randomBytes(16).toString('hex'), hash = await hashPassword(secret, salt);
        return transaction(db, () => {
          requireSession(req);
          requireValue(owner().credential_version === record.credential_version, '密码已被修改，请重新登录。', undefined, 409, 'VERSION_CONFLICT');
          db.prepare('UPDATE local_owners SET password_hash=?,password_salt=?,credential_version=? WHERE id=?').run(hash, salt, record.credential_version + 1, current.id);
          db.prepare('DELETE FROM auth_sessions WHERE owner_id=?').run(current.id);
          audit(db, 'OWNER_PASSWORD_CHANGED', current.id);
          return { status: 200, body: { authenticated: true, ...issue(current.id, res, req) } };
        });
      });
    }
    throw new AppError(404, 'NOT_FOUND', '账号接口不存在。');
  }
  return { handle, requireSession };
}
