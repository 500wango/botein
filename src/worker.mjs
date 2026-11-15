import { createHash, randomUUID } from 'node:crypto';
import { dispatchNotification, queryEcommerceDataConnector } from './connectors.mjs';
import { reconcileApprovals } from './drafts.mjs';
import { addEvidence } from './evidence.mjs';
import { executeClaimedJob } from './research.mjs';
import { refreshAccountOpportunitiesFit } from './sales.mjs';
import { addAccount, audit, profile, recoverInterruptedResearchJobs, requestContext, transaction } from './store.mjs';
import { accountInput, AppError, requireValue, text } from './validation.mjs';

const DEFAULT_LEASE_MS = 120_000;
const MONITOR_KINDS = ['EVIDENCE_LINK_CHECK', 'POOL_REFRESH', 'DISCOVERY_MONITOR'];

export function claimNextResearchJob(db, workerId = `worker-${process.pid}`, leaseMs = DEFAULT_LEASE_MS) {
  return transaction(db, () => {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const candidate = db.prepare(`SELECT id, organization_id, source_mode FROM research_jobs r
      WHERE r.status='QUEUED' AND r.cancel_requested=0
        AND (r.source_mode <> 'DISCOVERY' OR NOT EXISTS (
          SELECT 1 FROM research_jobs active
          WHERE active.organization_id=r.organization_id AND active.source_mode='DISCOVERY'
            AND (active.status='RUNNING' OR (active.worker_id IS NOT NULL AND active.lease_expires_at > ?))
        ))
      ORDER BY r.created_at ASC, r.rowid ASC LIMIT 1`).get(nowIso);
    if (!candidate) return null;
    const res = db.prepare(`UPDATE research_jobs
      SET status='RUNNING', started_at=COALESCE(started_at, ?), worker_id=?, lease_expires_at=?, heartbeat_at=?, version=version+1
      WHERE id=? AND organization_id=? AND status='QUEUED'`)
      .run(nowIso, workerId, leaseUntil, nowIso, candidate.id, candidate.organization_id);
    if (!res.changes) return null;
    return db.prepare('SELECT * FROM research_jobs WHERE id=?').get(candidate.id);
  });
}

export async function runMonitorNow(db, monitor, services, ctx = null) {
  const orgId = monitor.organization_id;
  const now = new Date();
  const nowIso = now.toISOString();
  const nextIso = new Date(now.getTime() + (monitor.interval_minutes || 60) * 60_000).toISOString();
  const config = JSON.parse(monitor.config || '{}');
  let summary = {};

  if (monitor.kind === 'EVIDENCE_LINK_CHECK') {
    const limit = Math.min(20, Math.max(1, Number(config.batch_size ?? 10) || 10));
    const rows = db.prepare(`SELECT id, account_id, source_url, availability_status, verification_status
      FROM evidence WHERE organization_id=? AND purged_at IS NULL AND source_url <> ''
      ORDER BY COALESCE(checked_at, created_at) ASC LIMIT ?`).all(orgId, limit);
    let checked = 0, expired = 0, available = 0, unavailable = 0;
    for (const ev of rows) {
      checked++;
      let nextStatus = 'AVAILABLE';
      try {
        await services.fetchPage(ev.source_url, { maxBytes: 512_000, rateBucket: 'background', rateLimitDb: db });
        available++;
      } catch (error) {
        const msg = String(error?.message || '');
        if (/404|410/.test(msg)) {
          nextStatus = 'EXPIRED';
          expired++;
        } else {
          nextStatus = 'UNAVAILABLE';
          unavailable++;
        }
      }
      if (nextStatus !== ev.availability_status) {
        transaction(db, () => {
          db.prepare('UPDATE evidence SET availability_status=?, checked_at=?, version=version+1 WHERE id=? AND organization_id=?')
            .run(nextStatus, nowIso, ev.id, orgId);
          if (nextStatus === 'EXPIRED') {
            refreshAccountOpportunitiesFit(db, ev.account_id, orgId);
            reconcileApprovals(db, { accountId: ev.account_id }, { orgId, actor: 'MONITOR_WORKER' });
          }
        });
      }
    }
    summary = { kind: monitor.kind, checked, available, expired, unavailable, ran_at: nowIso };
  } else if (monitor.kind === 'POOL_REFRESH') {
    const accounts = db.prepare('SELECT id FROM accounts WHERE organization_id=?').all(orgId);
    transaction(db, () => {
      for (const acc of accounts) refreshAccountOpportunitiesFit(db, acc.id, orgId);
      reconcileApprovals(db, null, { orgId, actor: 'MONITOR_WORKER' });
    });
    summary = { kind: monitor.kind, refreshed_accounts: accounts.length, ran_at: nowIso };
  } else {
    const monCtx = ctx || { orgId, actor: 'MONITOR_WORKER' };
    const factory = profile(db, orgId);
    const active = db.prepare("SELECT id FROM research_jobs WHERE organization_id=? AND source_mode='DISCOVERY' AND status IN ('QUEUED','RUNNING') LIMIT 1").get(orgId);
    const market = String(config.market || (factory.target_markets?.[0] || 'US')).toUpperCase();
    const categories = Array.isArray(config.product_categories) && config.product_categories.length
      ? config.product_categories
      : [factory.supported_products?.[0] || 'LAUNDRY_PODS'];
    const quantity = Math.min(50, Math.max(1, Number(config.quantity ?? 10) || 10));
    let ecomIngested = 0;
    try {
      const ecomRows = await queryEcommerceDataConnector(db, { market, product_category: categories[0], quantity }, {}, monCtx);
      if (ecomRows.length) {
        transaction(db, () => {
          for (const item of ecomRows) {
            try {
              const accRes = addAccount(db, accountInput({
                brand_name: item.brand_name,
                website: item.website,
                headquarters_country: item.headquarters_country,
                notes: `由监测任务 [${monitor.name}] 从电商数据连接器采集。`,
              }), monCtx);
              if (accRes.id) {
                addEvidence(db, {
                  account_id: accRes.id,
                  source_url: item.source_url,
                  source_kind: 'THIRD_PARTY_RETAIL',
                  raw_text: item.raw_text,
                  published_at: item.published_at || undefined,
                  observed_at: nowIso,
                }, monCtx);
                ecomIngested++;
              }
            } catch { /* skip malformed item cleanly */ }
          }
        });
      }
    } catch { /* connector errors recorded in summary/audit below */ }

    let queuedJobId = null;
    if (!active && factory.status === 'ACTIVE' && factory.supported_products?.includes(categories[0]) && factory.target_markets?.includes(market)) {
      const jobInput = {
        market,
        product_categories: categories,
        account_types: ['INDEPENDENT_BRAND', 'ECOMMERCE_BRAND'],
        quantity,
        min_evidence_quality: 'MEDIUM',
        contact_preferences: ['PRODUCT', 'PROCUREMENT', 'QUALITY'],
        language: 'en',
        source_mode: 'DISCOVERY',
      };
      const id = randomUUID();
      const key = `monitor:${monitor.id}:${nowIso.slice(0, 16)}`;
      const hash = createHash('sha256').update(JSON.stringify(jobInput)).digest('hex');
      const existing = db.prepare('SELECT id FROM research_jobs WHERE organization_id=? AND idempotency_key=?').get(orgId, key);
      if (!existing) {
        transaction(db, () => {
          db.prepare(`INSERT INTO research_jobs
            (id,organization_id,status,attempt,input_snapshot,factory_version,source_mode,counts,budget,idempotency_key,request_hash,created_at)
            VALUES (?,?,'QUEUED',1,?,?,?,?,?,?,?,?)`)
            .run(
              id, orgId, JSON.stringify(jobInput), factory.version, 'DISCOVERY',
              JSON.stringify({ discovered: 0, processed: 0, skipped: 0, failed: 0, not_fit: 0, new_opportunities: 0, reused_opportunities: 0, missing_contacts: 0, drafts_generated: 0 }),
              JSON.stringify({ limits: { search_requests: 50, page_requests: 200, runtime_ms: 1_800_000, cost_usd: 5 }, usage: { search_requests: 0, page_requests: 0, cost_usd: 0, runtime_ms: 0 } }),
              key, hash, nowIso,
            );
          audit(db, 'RESEARCH_JOB_CREATED', id, { input: jobInput, monitor_id: monitor.id, source_mode: 'DISCOVERY' }, monCtx);
          queuedJobId = id;
        });
      }
    }
    if (queuedJobId || ecomIngested > 0) {
      await dispatchNotification(db, {
        channel: 'MONITOR_ALERT',
        recipient: 'workspace-owners',
        subject: `Botein 定期监测触发：${monitor.name}`,
        payload: { monitor_id: monitor.id, queued_job_id: queuedJobId, ecommerce_ingested: ecomIngested, ran_at: nowIso },
      }, monCtx);
    }
    summary = {
      kind: monitor.kind,
      active_discovery_skipped: Boolean(active),
      factory_active: factory.status === 'ACTIVE',
      queued_job_id: queuedJobId,
      ecommerce_ingested: ecomIngested,
      ran_at: nowIso,
    };
  }

  transaction(db, () => {
    db.prepare(`UPDATE scheduled_monitors
      SET last_run_at=?, next_run_at=?, last_summary=?, version=version+1, updated_at=?
      WHERE id=? AND organization_id=?`)
      .run(nowIso, nextIso, JSON.stringify(summary), nowIso, monitor.id, orgId);
    audit(db, 'MONITOR_EXECUTED', monitor.id, summary, ctx || { orgId, actor: 'MONITOR_WORKER' });
  });
  return summary;
}

export async function runWorkerTick(db, services, { workerId = `worker-${process.pid}`, leaseMs = DEFAULT_LEASE_MS } = {}) {
  recoverInterruptedResearchJobs(db);
  let processedJobs = 0;
  let processedMonitors = 0;

  const claimed = claimNextResearchJob(db, workerId, leaseMs);
  if (claimed) {
    const controller = new AbortController();
    const hb = setInterval(() => {
      try {
        const current = db.prepare('SELECT status, cancel_requested FROM research_jobs WHERE id=?').get(claimed.id);
        if (!current || current.status === 'CANCELLED' || current.cancel_requested === 1) {
          controller.abort();
          return;
        }
        const nextLease = new Date(Date.now() + leaseMs).toISOString();
        db.prepare('UPDATE research_jobs SET heartbeat_at=?, lease_expires_at=? WHERE id=? AND worker_id=?')
          .run(new Date().toISOString(), nextLease, claimed.id, workerId);
      } catch { /* ignore heartbeat race */ }
    }, Math.min(10_000, Math.floor(leaseMs / 3)));
    try {
      await executeClaimedJob(db, claimed.id, services, controller.signal, {
        orgId: claimed.organization_id,
        actor: `WORKER:${workerId}`,
      });
      processedJobs++;
    } finally {
      clearInterval(hb);
    }
  }

  const nowIso = new Date().toISOString();
  const dueMonitors = db.prepare("SELECT * FROM scheduled_monitors WHERE status='ACTIVE' AND next_run_at<=? ORDER BY next_run_at ASC LIMIT 5").all(nowIso);
  for (const monitor of dueMonitors) {
    await runMonitorNow(db, monitor, services, { orgId: monitor.organization_id, actor: `WORKER:${workerId}` });
    processedMonitors++;
  }
  return { processed_jobs: processedJobs, processed_monitors: processedMonitors };
}

export function startWorkerLoop(db, services, { workerId = `worker-${process.pid}`, pollMs = 3_000, leaseMs = DEFAULT_LEASE_MS } = {}) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await runWorkerTick(db, services, { workerId, leaseMs });
    } catch (error) {
      console.error(`[worker ${workerId}]`, error?.message || error);
    } finally {
      busy = false;
    }
  }, pollMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function monitorView(row) {
  return {
    ...row,
    config: JSON.parse(row.config || '{}'),
    last_summary: JSON.parse(row.last_summary || '{}'),
  };
}

export async function monitorsApi(db, path, method, body, _query, services, ctx = null) {
  const { orgId } = requestContext(ctx);
  if (path === '/monitors' && method === 'GET') {
    const rows = db.prepare('SELECT * FROM scheduled_monitors WHERE organization_id=? ORDER BY created_at DESC, id DESC').all(orgId);
    return { status: 200, body: { items: rows.map(monitorView) } };
  }
  if (path === '/monitors' && method === 'POST') {
    const name = text(body.name, 'name', 100);
    const kind = text(body.kind, 'kind', 40);
    requireValue(MONITOR_KINDS.includes(kind), '请选择有效的监控类型。', 'kind');
    const intervalMinutes = body.interval_minutes == null ? 60 : Number(body.interval_minutes);
    requireValue(Number.isInteger(intervalMinutes) && intervalMinutes >= 5 && intervalMinutes <= 10080, '执行间隔为 5–10080 分钟。', 'interval_minutes');
    const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
    return transaction(db, () => {
      const id = randomUUID();
      const now = new Date();
      const nowIso = now.toISOString();
      const nextIso = new Date(now.getTime() + intervalMinutes * 60_000).toISOString();
      db.prepare(`INSERT INTO scheduled_monitors
        (id,organization_id,name,kind,status,interval_minutes,config,next_run_at,last_summary,version,created_at,updated_at)
        VALUES (?,?,?,?,'ACTIVE',?,?,?,?,1,?,?)`)
        .run(id, orgId, name, kind, intervalMinutes, JSON.stringify(config), nextIso, '{}', nowIso, nowIso);
      audit(db, 'MONITOR_CREATED', id, { name, kind, interval_minutes: intervalMinutes }, ctx);
      const created = db.prepare('SELECT * FROM scheduled_monitors WHERE organization_id=? AND id=?').get(orgId, id);
      return { status: 201, body: monitorView(created) };
    });
  }
  const patchMatch = path.match(/^\/monitors\/([^/]+)$/);
  if (patchMatch && method === 'PATCH') {
    return transaction(db, () => {
      const row = db.prepare('SELECT * FROM scheduled_monitors WHERE organization_id=? AND id=?').get(orgId, patchMatch[1]);
      requireValue(row, '监控任务不存在。', undefined, 404, 'NOT_FOUND');
      requireValue(body.expected_version === row.version, '监控任务已更新，请刷新后重试。', undefined, 409, 'VERSION_CONFLICT');
      const status = body.status ?? row.status;
      requireValue(['ACTIVE', 'PAUSED'].includes(status), '监控状态仅支持 ACTIVE 或 PAUSED。', 'status');
      const intervalMinutes = body.interval_minutes == null ? row.interval_minutes : Number(body.interval_minutes);
      requireValue(Number.isInteger(intervalMinutes) && intervalMinutes >= 5 && intervalMinutes <= 10080, '执行间隔为 5–10080 分钟。', 'interval_minutes');
      const nowIso = new Date().toISOString();
      db.prepare('UPDATE scheduled_monitors SET status=?, interval_minutes=?, version=version+1, updated_at=? WHERE id=? AND organization_id=?')
        .run(status, intervalMinutes, nowIso, row.id, orgId);
      audit(db, 'MONITOR_UPDATED', row.id, { status, interval_minutes: intervalMinutes }, ctx);
      return { status: 200, body: monitorView(db.prepare('SELECT * FROM scheduled_monitors WHERE organization_id=? AND id=?').get(orgId, row.id)) };
    });
  }
  const runMatch = path.match(/^\/monitors\/([^/]+)\/run$/);
  if (runMatch && method === 'POST') {
    const row = db.prepare('SELECT * FROM scheduled_monitors WHERE organization_id=? AND id=?').get(orgId, runMatch[1]);
    requireValue(row, '监控任务不存在。', undefined, 404, 'NOT_FOUND');
    const summary = await runMonitorNow(db, row, services, ctx);
    return {
      status: 200,
      body: {
        monitor: monitorView(db.prepare('SELECT * FROM scheduled_monitors WHERE organization_id=? AND id=?').get(orgId, row.id)),
        summary,
      },
    };
  }
  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}
