import { randomUUID } from 'node:crypto';
import { ORG, profile, transaction, audit } from './store.mjs';
import { AppError, requireValue, text } from './validation.mjs';
import { olderThan, pageParams, pageRows } from './pagination.mjs';

export const capabilityFields = {
  supported_products: '支持产品', service_type: 'OEM / ODM 服务', moq_quantity: '起订量',
  unit: '计量单位', packaging_spec: '配方与包装条件', lead_time_days: '交期（天）',
};
function getOpportunity(db, id) {
  const item = db.prepare('SELECT * FROM opportunities WHERE id=? AND organization_id=?').get(id, ORG);
  requireValue(item, '商机不存在。', undefined, 404, 'NOT_FOUND'); return item;
}
function getContact(db, id, accountId) {
  const person = db.prepare(`SELECT c.*, s.reason AS suppression_reason FROM contacts c
    LEFT JOIN contact_suppressions s ON s.organization_id=c.organization_id AND s.email=c.email
    WHERE c.id=? AND c.organization_id=? AND c.account_id=?`).get(id, ORG, accountId);
  requireValue(person, '请选择本品牌联系人。', 'contact_id', 404, 'NOT_FOUND'); return person;
}
function currentDraft(db, id) {
  const item = db.prepare(`SELECT d.id, d.opportunity_id, d.version, d.current_version_id, v.number, v.contact_id,
    v.subject, v.body, v.claims, v.status, v.approval_snapshot, v.contact_snapshot, v.created_at
    FROM drafts d JOIN draft_versions v ON v.id=d.current_version_id AND v.organization_id=d.organization_id
    WHERE d.id=? AND d.organization_id=?`).get(id, ORG);
  requireValue(item, '草稿不存在。', undefined, 404, 'NOT_FOUND');
  return { ...item, contact_snapshot: item.contact_snapshot ? JSON.parse(item.contact_snapshot) : null, claims: JSON.parse(item.claims), approval_snapshot: item.approval_snapshot ? JSON.parse(item.approval_snapshot) : null };
}
function reviewLog(db, versionId, action, reason, snapshot = {}) {
  db.prepare('INSERT INTO draft_reviews VALUES (?,?,?,?,?,?,?)').run(randomUUID(), ORG, versionId, action, reason, JSON.stringify({ ...snapshot, actor: 'LOCAL_OWNER' }), new Date().toISOString());
  audit(db, `DRAFT_${action}`, versionId, { reason });
}
function checks(db, draft, approving = false) {
  const item = getOpportunity(db, draft.opportunity_id), factory = profile(db);
  const person = getContact(db, draft.contact_id, item.account_id);
  const warnings = []; let blocked = false;
  const add = (message, hard = false) => { warnings.push(message); blocked ||= hard; };
  if (person.suppression_reason) add('联系人已被禁止联系。', true);
  if (draft.contact_snapshot && ['full_name','job_title','email','source_url'].some(k => draft.contact_snapshot[k] !== person[k])) add('草稿录入时的联系人资料已变化，请编辑新版本并核对称呼与内容。');
  if (person.verification_status !== 'VERIFIED') add('联系人身份和渠道尚未核验或已失效。');
  if (item.qualification_status !== 'QUALIFIED') add('商机当前未通过资格审核。');
  if (['WON', 'LOST'].includes(item.sales_stage)) add('商机已成交或丢单，不批准新的开发信。');
  if (factory.status !== 'ACTIVE' || item.factory_version !== factory.version) add('工厂档案或商机匹配版本已变化，请重新核对。');
  const qualification = db.prepare("SELECT id FROM opportunity_history WHERE organization_id=? AND opportunity_id=? AND action='QUALIFY' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(ORG, item.id);
  const refs = db.prepare('SELECT oe.*, e.version AS live_version, e.verification_status, e.checked_at FROM opportunity_evidence oe JOIN evidence e ON e.id=oe.evidence_id AND e.organization_id=oe.organization_id WHERE oe.opportunity_id=? AND oe.organization_id=?').all(item.id, ORG);
  if (!refs.some(r => r.role === 'MARKET')) add('缺少商机的美国在售依据。');
  for (const ref of refs) {
    if (ref.verification_status !== 'VERIFIED') add('商机资格引用的证据已失效。', true);
    if (ref.role === 'MARKET' && (!ref.checked_at || Date.now() - Date.parse(ref.checked_at) > 7 * 86400000)) add('美国在售核验已超过 7 天，请重新核验并审核。');
  }
  const claims = draft.claims.map(claim => {
    let valid = true;
    if (claim.kind === 'EVIDENCE') {
      const e = db.prepare('SELECT * FROM evidence WHERE id=? AND organization_id=? AND account_id=?').get(claim.evidence_id, ORG, item.account_id);
      if (!e || e.verification_status !== 'VERIFIED') { valid = false; add('事实陈述引用的证据未核验或已失效。', true); }
      else {
        if (e.version !== claim.evidence_version) { valid = false; add('事实陈述引用的证据版本已变化，请编辑草稿并更新引用。'); }
        if (!e.raw_text.includes(claim.quote)) { valid = false; add('引用片段与保存的原文不一致。', true); }
        if (claim.time_sensitive && (!e.checked_at || Date.now() - Date.parse(e.checked_at) > 7 * 86400000)) { valid = false; add('时效性陈述的证据超过 7 天，请重新核验。'); }
      }
    } else {
      const check = db.prepare('SELECT * FROM factory_field_checks WHERE id=? AND organization_id=?').get(claim.check_id, ORG);
      if (!check || check.profile_version !== factory.version || check.value !== JSON.stringify(factory[check.field])) {
        valid = false; add('引用的工厂字段核验与当前档案不一致，请重新核验字段并更新草稿。');
      }
    }
    return { ...claim, validation_status: valid ? (approving || draft.status === 'APPROVED' ? 'SUPPORTED' : 'NEEDS_REVIEW') : 'UNSUPPORTED' };
  });
  const snapshot = {
    qualification_id: qualification?.id ?? null, contact_id: person.id, contact_version: person.version,
    factory_version: factory.version,
    qualification_evidence: refs.map(r => ({ id: r.evidence_id, role: r.role, version: r.live_version })).sort((a, b) => a.role.localeCompare(b.role)),
  };
  if (draft.status === 'APPROVED' && JSON.stringify(snapshot) !== JSON.stringify(draft.approval_snapshot)) add('批准时的联系人、工厂或资格依据版本已变化，需要重新审核。');
  return { warnings: [...new Set(warnings)], blocked, claims, snapshot, person };
}
function reconcileOne(db, draft) {
  const result = checks(db, draft);
  if (draft.status === 'APPROVED' && result.warnings.length) {
    const status = result.blocked ? 'BLOCKED' : 'IN_REVIEW';
    db.prepare('UPDATE draft_versions SET status=? WHERE id=? AND organization_id=?').run(status, draft.current_version_id, ORG);
    db.prepare('UPDATE drafts SET version=version+1 WHERE id=? AND organization_id=?').run(draft.id, ORG);
    reviewLog(db, draft.current_version_id, 'APPROVAL_INVALIDATED', result.warnings.join(' '), { status });
  }
  return result;
}
export const PURGED_QUOTE = '[原文已按保留政策清除]';

// Retention purge must also remove verbatim source excerpts kept in draft history.
// Draft-authored sentences are retained; only direct evidence quotes are redacted.
export function redactEvidenceQuotes(db, evidenceId) {
  let count = 0;
  const versions = db.prepare('SELECT id,claims FROM draft_versions WHERE organization_id=?').all(ORG);
  for (const row of versions) {
    const claims = JSON.parse(row.claims);
    let changed = false;
    for (const claim of claims) {
      if (claim.kind === 'EVIDENCE' && claim.evidence_id === evidenceId && claim.quote !== PURGED_QUOTE) {
        claim.quote = PURGED_QUOTE; changed = true; count++;
      }
    }
    if (changed) db.prepare('UPDATE draft_versions SET claims=? WHERE id=? AND organization_id=?').run(JSON.stringify(claims), row.id, ORG);
  }
  const reviews = db.prepare('SELECT id,snapshot FROM draft_reviews WHERE organization_id=?').all(ORG);
  for (const row of reviews) {
    const snapshot = JSON.parse(row.snapshot);
    let changed = false;
    if (Array.isArray(snapshot.claims)) {
      for (const claim of snapshot.claims) {
        if (claim.kind === 'EVIDENCE' && claim.evidence_id === evidenceId && claim.quote !== PURGED_QUOTE) {
          claim.quote = PURGED_QUOTE; changed = true; count++;
        }
      }
    }
    if (changed) db.prepare('UPDATE draft_reviews SET snapshot=? WHERE id=? AND organization_id=?').run(JSON.stringify(snapshot), row.id, ORG);
  }
  return count;
}

// Called inside the same write transaction as dependency changes; copy also revalidates elapsed time.
export function reconcileApprovals(db) {
  const rows = db.prepare("SELECT d.id FROM drafts d JOIN draft_versions v ON v.id=d.current_version_id WHERE d.organization_id=? AND v.status='APPROVED'").all(ORG);
  for (const row of rows) reconcileOne(db, currentDraft(db, row.id));
}
function draftDetail(db, id) {
  reconcileOne(db, currentDraft(db, id));
  const draft = currentDraft(db, id), validation = checks(db, draft);
  return { ...draft, claims: validation.claims, warnings: validation.warnings,
    versions: db.prepare('SELECT id,number,contact_id,subject,body,claims,status,contact_snapshot,created_at FROM draft_versions WHERE draft_id=? AND organization_id=? ORDER BY number DESC').all(id, ORG).map(v => ({ ...v, claims: JSON.parse(v.claims), contact_snapshot: v.contact_snapshot ? JSON.parse(v.contact_snapshot) : null })),
    reviews: db.prepare('SELECT r.action,r.reason,r.created_at,r.draft_version_id,r.snapshot FROM draft_reviews r JOIN draft_versions v ON v.id=r.draft_version_id AND v.organization_id=r.organization_id WHERE v.draft_id=? AND r.organization_id=? ORDER BY r.created_at DESC,r.rowid DESC').all(id, ORG).map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) })),
  };
}
function draftInput(db, body, opportunityId) {
  const item = getOpportunity(db, opportunityId);
  requireValue(!['REJECTED', 'ARCHIVED'].includes(item.qualification_status) && !['WON', 'LOST'].includes(item.sales_stage), '已拒绝、归档或销售终态商机不创建新开发信。');
  const contactId = text(body.contact_id, 'contact_id', 100), person = getContact(db, contactId, item.account_id);
  requireValue(!person.suppression_reason, '该联系渠道已禁止联系，不创建触达草稿。', 'contact_id');
  const subject = text(body.subject, 'subject', 200), message = text(body.body, 'body', 10000);
  requireValue(!/[\r\n]/.test(subject), '主题请使用单行文本。', 'subject');
  requireValue(Array.isArray(body.claims) && body.claims.length <= 30, '事实陈述最多 30 条。', 'claims');
  const claims = body.claims.map(c => {
    requireValue(c && typeof c === 'object', '事实陈述格式有误。', 'claims');
    const claimText = text(c.text, 'claims', 2000);
    requireValue(subject.includes(claimText) || message.includes(claimText), '事实陈述必须是主题或正文中的原句。', 'claims');
    if (c.kind === 'EVIDENCE') {
      const e = db.prepare('SELECT * FROM evidence WHERE id=? AND organization_id=? AND account_id=?').get(text(c.evidence_id, 'claims', 100), ORG, item.account_id);
      requireValue(e, '事实引用必须属于本品牌。', 'claims');
      const quote = text(c.quote, 'claims', 5000);
      requireValue(e.raw_text.includes(quote), '引用片段不在原文中。', 'claims');
      return { text: claimText, kind: 'EVIDENCE', evidence_id: e.id, evidence_version: e.version, quote, time_sensitive: c.time_sensitive === true };
    }
    requireValue(c.kind === 'FACTORY', '请选择证据或已核验工厂字段。', 'claims');
    const check = db.prepare('SELECT * FROM factory_field_checks WHERE id=? AND organization_id=?').get(text(c.check_id, 'claims', 100), ORG);
    const factory = profile(db);
    requireValue(check && check.profile_version === factory.version && factory.status === 'ACTIVE', '请选择当前启用档案的已核验字段。', 'claims');
    return { text: claimText, kind: 'FACTORY', check_id: check.id, field: check.field, profile_version: check.profile_version, value: JSON.parse(check.value) };
  });
  return { subject, body: message, contact_id: contactId, claims, contact_snapshot: { full_name: person.full_name, job_title: person.job_title, email: person.email, source_url: person.source_url, version: person.version, provenance: 'AT_DRAFT_CREATION' } };
}
export function draftsApi(db, path, method, body, query) {
  if (path === '/factory-profile/checks/options' && method === 'GET') {
    const factory = profile(db);
    return { status: 200, body: {
      fields: capabilityFields, profile_version: factory.version,
      items: db.prepare('SELECT * FROM factory_field_checks WHERE organization_id=? AND profile_version=? ORDER BY checked_at DESC, id DESC')
        .all(ORG, factory.version).map(row => ({ ...row, value: JSON.parse(row.value) })),
    } };
  }
  if (path === '/factory-profile/checks' && method === 'GET') {
    const factory = profile(db);
    const { limit, cursor } = pageParams(query);
    const total = db.prepare('SELECT count(*) AS n FROM factory_field_checks WHERE organization_id=? AND profile_version=?')
      .get(ORG, factory.version).n;
    const base = 'SELECT * FROM factory_field_checks WHERE organization_id=? AND profile_version=?';
    const rows = cursor === null
      ? db.prepare(`${base} ORDER BY checked_at DESC, id DESC LIMIT ?`).all(ORG, factory.version, limit + 1)
      : db.prepare(`${base} AND ${olderThan('checked_at', 'id')} ORDER BY checked_at DESC, id DESC LIMIT ?`)
        .all(ORG, factory.version, cursor[0], cursor[0], cursor[1], limit + 1);
    const page = pageRows(rows, limit, row => [row.checked_at, row.id]);
    return { status: 200, body: {
      fields: capabilityFields, profile_version: factory.version, next_cursor: page.next_cursor, total,
      items: page.items.map(row => ({ ...row, value: JSON.parse(row.value) })),
    } };
  }
  if (path === '/factory-profile/checks' && method === 'POST') {
    return transaction(db, () => {
      const factory = profile(db);
      requireValue(factory.version === body.expected_version, '工厂档案已变化，请刷新。', undefined, 409, 'VERSION_CONFLICT');
      requireValue(factory.status === 'ACTIVE', '请先启用基础档案。');
      requireValue(Object.hasOwn(capabilityFields, body.field), '该字段暂不支持作为已核验承诺。', 'field');
      const value = factory[body.field];
      requireValue(value !== null && value !== '' && (!Array.isArray(value) || value.length), '未知或空字段不应核验为事实。', 'field');
      requireValue(body.confirmed === true, '请由工厂负责人确认实际能力及适用条件。', 'confirmed');
      const reason = text(body.reason, 'reason', 1500), id = randomUUID();
      db.prepare('INSERT INTO factory_field_checks VALUES (?,?,?,?,?,?,?)').run(id, ORG, factory.version, body.field, JSON.stringify(value), reason, new Date().toISOString());
      audit(db, 'FACTORY_FIELD_VERIFIED', id, { field: body.field, profile_version: factory.version, value, reason });
      return { status: 201, body: { id } };
    });
  }
  let match;
  if ((match = path.match(/^\/opportunities\/([^/]+)\/drafts$/))) {
    const opportunityId = match[1]; getOpportunity(db, opportunityId);
    if (method === 'GET') return transaction(db, () => ({ status: 200, body: { items: db.prepare('SELECT id FROM drafts WHERE opportunity_id=? AND organization_id=? ORDER BY created_at DESC,id').all(opportunityId, ORG).map(r => draftDetail(db, r.id)) } }));
    if (method === 'POST') return transaction(db, () => {
      const input = draftInput(db, body, opportunityId), id = randomUUID(), versionId = randomUUID(), now = new Date().toISOString();
      db.prepare('INSERT INTO drafts VALUES (?,?,?,?,?,?)').run(id, ORG, opportunityId, versionId, 1, now);
      db.prepare('INSERT INTO draft_versions (id,organization_id,draft_id,number,contact_id,subject,body,claims,status,approval_snapshot,created_at,contact_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(versionId, ORG, id, 1, input.contact_id, input.subject, input.body, JSON.stringify(input.claims), 'DRAFT', null, now, JSON.stringify(input.contact_snapshot));
      audit(db, 'DRAFT_MANUALLY_CREATED', versionId);
      return { status: 201, body: draftDetail(db, id) };
    });
  }
  if ((match = path.match(/^\/drafts\/([^/]+)$/))) {
    if (method === 'GET') return transaction(db, () => ({ status: 200, body: draftDetail(db, match[1]) }));
    if (method === 'PATCH') return transaction(db, () => {
      const current = currentDraft(db, match[1]);
      requireValue(body.expected_version === current.version, '草稿已变化，请重新打开。', undefined, 409, 'VERSION_CONFLICT');
      const input = draftInput(db, body, current.opportunity_id), versionId = randomUUID();
      db.prepare("UPDATE draft_versions SET status='SUPERSEDED' WHERE id=? AND organization_id=?").run(current.current_version_id, ORG);
      db.prepare('INSERT INTO draft_versions (id,organization_id,draft_id,number,contact_id,subject,body,claims,status,approval_snapshot,created_at,contact_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(versionId, ORG, current.id, current.number + 1, input.contact_id, input.subject, input.body, JSON.stringify(input.claims), 'IN_REVIEW', null, new Date().toISOString(), JSON.stringify(input.contact_snapshot));
      db.prepare('UPDATE drafts SET current_version_id=?, version=version+1 WHERE id=? AND organization_id=?').run(versionId, current.id, ORG);
      reviewLog(db, current.current_version_id, 'SUPERSEDED', '编辑产生新版本，旧批准不继承。');
      return { status: 200, body: draftDetail(db, current.id) };
    });
  }
  if ((match = path.match(/^\/drafts\/([^/]+)\/(review|copy-events)$/)) && method === 'POST') {
    // Commit dependency invalidation even if the requested approval/copy is rejected afterwards.
    transaction(db, () => reconcileOne(db, currentDraft(db, match[1])));
    return transaction(db, () => {
      const draft = currentDraft(db, match[1]);
      requireValue(draft.version === body.expected_version && draft.current_version_id === body.draft_version_id, '草稿版本或批准状态已变化，请刷新后操作。', undefined, 409, 'VERSION_CONFLICT');
      const validation = checks(db, draft, true);
      if (match[2] === 'copy-events') {
        requireValue(draft.status === 'APPROVED' && validation.warnings.length === 0, '当前版本未批准或依据已失效，不能复制为已审核内容。', undefined, 409, 'DRAFT_NOT_APPROVED');
        requireValue(['subject', 'body'].includes(body.part), '请选择主题或正文。', 'part');
        audit(db, 'APPROVED_COPY_REQUESTED', draft.current_version_id, { part: body.part, draft_id: draft.id });
        return { status: 200, body: { draft_version_id: draft.current_version_id, content: draft[body.part], part: body.part } };
      }
      requireValue(['APPROVE', 'REJECT'].includes(body.action), '审核操作无效。', 'action');
      requireValue(draft.status !== 'APPROVED', '此版本已批准，编辑时会生成新的待审版本。', undefined, 409, 'INVALID_TRANSITION');
      const reason = text(body.reason, 'reason', 1500);
      if (body.action === 'APPROVE') {
        requireValue(body.full_text_confirmed === true && body.claims_confirmed === true, '请人工核对全文无遗漏事实，以及每条陈述均有充分支持。', 'full_text_confirmed');
        requireValue(validation.warnings.length === 0, validation.warnings.join(' '), undefined, 422, 'UNSUPPORTED_CLAIMS');
      }
      const status = body.action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      db.prepare('UPDATE draft_versions SET status=?,approval_snapshot=? WHERE id=? AND organization_id=?')
        .run(status, status === 'APPROVED' ? JSON.stringify(validation.snapshot) : draft.approval_snapshot ? JSON.stringify(draft.approval_snapshot) : null, draft.current_version_id, ORG);
      db.prepare('UPDATE drafts SET version=version+1 WHERE id=? AND organization_id=?').run(draft.id, ORG);
      reviewLog(db, draft.current_version_id, body.action, reason, { dependencies: validation.snapshot, claims: validation.claims, full_text_confirmed: body.full_text_confirmed === true, claims_confirmed: body.claims_confirmed === true });
      return { status: 200, body: draftDetail(db, draft.id) };
    });
  }
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
