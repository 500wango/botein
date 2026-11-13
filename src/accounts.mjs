import { ORG, audit, transaction, insertAccount, normalizeBrandName } from './store.mjs';
import { AppError, requireValue, text, accountInput } from './validation.mjs';
import { reassessQualified } from './sales.mjs';
import { reconcileApprovals } from './drafts.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';

function account(db, id) {
  const row = db.prepare('SELECT * FROM accounts WHERE organization_id=? AND id=?').get(ORG, id);
  requireValue(row, '品牌不存在。', undefined, 404, 'NOT_FOUND'); return row;
}
function checkVersion(row, body) {
  requireValue(body.expected_version === row.version, '记录已变化，请重新打开后核对。', undefined, 409, 'VERSION_CONFLICT');
}
function identityReview(db, id) {
  const row = db.prepare('SELECT * FROM account_identity_reviews WHERE organization_id=? AND id=?').get(ORG, id);
  requireValue(row, '身份核对记录不存在。', undefined, 404, 'NOT_FOUND');
  return { ...row, candidate: JSON.parse(row.candidate) };
}
export function accountsApi(db, path, method, body, query) {
  let match;
  if (path === '/account-identity-reviews' && method === 'GET') {
    const { limit, cursor } = pageParams(query);
    const base = 'SELECT id, created_at FROM account_identity_reviews WHERE organization_id=?';
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY created_at DESC, id DESC LIMIT ?`).all(ORG, limit + 1)
      : db.prepare(`${base} AND ${olderThan('created_at', 'id')} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(ORG, cursor[0], cursor[0], cursor[1], limit + 1);
    const page = pageRows(rows, limit, row => [row.created_at, row.id]);
    const items = page.items.map(({ id }) => {
      const row = identityReview(db, id);
      return { ...row,
        matches: db.prepare('SELECT id,brand_name,website,headquarters_country,notes,version FROM accounts WHERE organization_id=? AND normalized_domain=? ORDER BY created_at,id').all(ORG, row.normalized_domain),
        history: db.prepare("SELECT action,details,created_at FROM audit_logs WHERE organization_id=? AND object_id=? AND action LIKE 'ACCOUNT_IDENTITY_%' ORDER BY created_at DESC,rowid DESC").all(ORG, id).map(h => ({ ...h, details: JSON.parse(h.details) })),
      };
    });
    const total = db.prepare('SELECT count(*) AS n FROM account_identity_reviews WHERE organization_id=?').get(ORG).n;
    const pendingTotal = db.prepare("SELECT count(*) AS n FROM account_identity_reviews WHERE organization_id=? AND status='PENDING'").get(ORG).n;
    return { status: 200, body: { items, next_cursor: page.next_cursor, total, pending_total: pendingTotal } };
  }
  if ((match = path.match(/^\/account-identity-reviews\/([^/]+)\/resolve$/)) && method === 'POST') {
    return transaction(db, () => {
      const row = identityReview(db, match[1]); checkVersion(row, body);
      const reason = text(body.reason, 'reason', 1500);
      requireValue(['DISTINCT', 'REUSE', 'REJECT', 'REOPEN'].includes(body.action), '请选择核对结论。', 'action');
      if (body.action === 'REOPEN') {
        requireValue(row.status !== 'PENDING', '该记录已在待核对列表。', undefined, 409, 'INVALID_TRANSITION');
        db.prepare("UPDATE account_identity_reviews SET status='PENDING',version=version+1,reason=?,resolved_at=NULL WHERE organization_id=? AND id=?").run(reason, ORG, row.id);
        audit(db, 'ACCOUNT_IDENTITY_REOPENED', row.id, { reason, previous_status: row.status });
        return { status: 200, body: identityReview(db, row.id) };
      }
      requireValue(row.status === 'PENDING', '此记录已处理，请刷新查看结果。', undefined, 409, 'INVALID_TRANSITION');
      let resolvedId = null, resolvedVersion = null;
      if (body.action !== 'REJECT') requireValue(body.confirmed === true, '请核对官网及品牌归属后确认。', 'confirmed');
      if (body.action === 'DISTINCT') {
        const exact = db.prepare('SELECT id FROM accounts WHERE organization_id=? AND normalized_domain=? AND normalized_name=?').get(ORG, row.normalized_domain, row.normalized_name);
        requireValue(!exact, '已存在同名同域品牌，请选择复用现有记录。', undefined, 409, 'ACCOUNT_EXISTS');
        resolvedId = insertAccount(db, row.candidate); resolvedVersion = 1;
      } else if (body.action === 'REUSE') {
        const target = account(db, text(body.target_account_id, 'target_account_id', 100));
        requireValue(target.normalized_domain === row.normalized_domain, '只能选择当前同域名品牌；跨域品牌合并暂未开放。', 'target_account_id');
        requireValue(target.version === body.target_expected_version, '目标品牌资料已更新，请重新核对。', undefined, 409, 'VERSION_CONFLICT');
        resolvedId = target.id; resolvedVersion = target.version;
      }
      const status = body.action === 'REUSE' ? 'REUSED' : body.action === 'REJECT' ? 'REJECTED' : 'DISTINCT';
      db.prepare('UPDATE account_identity_reviews SET status=?,version=version+1,resolved_account_id=?,resolved_account_version=?,reason=?,resolved_at=? WHERE id=? AND organization_id=?')
        .run(status, resolvedId, resolvedVersion, reason, new Date().toISOString(), row.id, ORG);
      audit(db, 'ACCOUNT_IDENTITY_RESOLVED', row.id, { action: body.action, reason, resolved_account_id: resolvedId, resolved_account_version: resolvedVersion, candidate: row.candidate });
      return { status: 200, body: identityReview(db, row.id) };
    });
  }
  if ((match = path.match(/^\/accounts\/([^/]+)$/))) {
    if (method === 'GET') {
      const row = account(db, match[1]);
      return { status: 200, body: { ...row, history: db.prepare("SELECT action,details,created_at FROM audit_logs WHERE organization_id=? AND object_id=? AND action IN ('ACCOUNT_CREATED','ACCOUNT_UPDATED') ORDER BY created_at DESC,rowid DESC").all(ORG, row.id).map(h => ({ ...h, details: JSON.parse(h.details) })) } };
    }
    if (method === 'PATCH') return transaction(db, () => {
      const current = account(db, match[1]); checkVersion(current, body);
      const data = accountInput(body), normalized = normalizeBrandName(data.brand_name);
      const exact = db.prepare('SELECT id FROM accounts WHERE organization_id=? AND normalized_domain=? AND normalized_name=? AND id<>?').get(ORG, data.normalized_domain, normalized, current.id);
      requireValue(!exact, '目标名称与域名已属于另一个品牌，不能直接覆盖或合并。', 'website', 409, 'ACCOUNT_IDENTITY_CONFLICT');
      const changed = Object.keys(data).filter(key => data[key] !== current[key]);
      if (!changed.length) return { status: 200, body: { ...current, unchanged: true } };
      const reason = text(body.reason, 'reason', 1500);
      const identityChanged = changed.some(key => ['brand_name', 'website', 'normalized_domain'].includes(key));
      if (identityChanged) {
        const peers = db.prepare('SELECT id FROM accounts WHERE organization_id=? AND normalized_domain=? AND id<>?').all(ORG, data.normalized_domain, current.id);
        requireValue(!peers.length || body.shared_domain_confirmed === true, '该域名下已有其他品牌，请确认这是独立品牌后保存。', 'shared_domain_confirmed');
      }
      db.prepare('UPDATE accounts SET brand_name=?,normalized_name=?,website=?,normalized_domain=?,headquarters_country=?,notes=?,version=version+1 WHERE id=? AND organization_id=?')
        .run(data.brand_name, normalized, data.website, data.normalized_domain, data.headquarters_country, data.notes, current.id, ORG);
      if (identityChanged) {
        for (const evidence of db.prepare('SELECT id,version,verification_status FROM evidence WHERE organization_id=? AND account_id=?').all(ORG, current.id)) {
          db.prepare("UPDATE evidence SET verification_status=CASE WHEN verification_status='INVALIDATED' THEN 'INVALIDATED' ELSE 'UNVERIFIED' END,version=version+1,checked_at=NULL,verification_note=? WHERE id=? AND organization_id=?")
            .run(`品牌身份资料变更：${reason}`, evidence.id, ORG);
          audit(db, 'EVIDENCE_ACCOUNT_CHANGED', evidence.id, { reason, previous_version: evidence.version, previous_status: evidence.verification_status });
          reassessQualified(db, `品牌身份资料变更：${reason}`, evidence.id);
        }
        db.prepare("UPDATE contacts SET verification_status='STALE',version=version+1,checked_at=NULL WHERE organization_id=? AND account_id=?").run(ORG, current.id);
        reconcileApprovals(db);
      }
      audit(db, 'ACCOUNT_UPDATED', current.id, { before: current, after: { ...data, version: current.version + 1 }, changed, reason, identity_reassessment: identityChanged });
      return { status: 200, body: account(db, current.id) };
    });
  }
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
