import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openPostgresStore } from './pg-store.mjs';
import { exportPostgresDdl, getStorageConfig } from './storage.mjs';
import { requireValue, text } from './validation.mjs';

export const ORG = 'local-lancco';
export function requestContext(ctx) {
  return {
    orgId: ctx?.orgId || ORG,
    actor: ctx?.actor || 'LOCAL_OWNER',
    userId: ctx?.userId || null,
    role: ctx?.role || 'OWNER',
  };
}
export function actorUsername(actor) {
  if (!actor || actor === 'LOCAL_OWNER') return '';
  return String(actor).replace(/^(?:OWNER|MEMBER):/, '');
}
export function resolveAssignee(db, orgId, rawAssignee, defaultAssignee = '') {
  if (rawAssignee === undefined) return defaultAssignee;
  if (rawAssignee === null || rawAssignee === '') return '';
  const assignee = text(rawAssignee, 'assigned_to', 64);
  if (assignee === 'LOCAL_OWNER') return '';
  const isOwner = db.prepare('SELECT id FROM local_owners WHERE organization_id=? AND username=?').get(orgId, assignee);
  const isMember = db.prepare("SELECT id FROM workspace_members WHERE organization_id=? AND username=? AND status='ACTIVE'").get(orgId, assignee);
  requireValue(Boolean(isOwner || isMember), '指派对象不存在或已停用。', 'assigned_to');
  return assignee;
}
export const seedProfile = {
  factory_name: 'LANCCO (FOSHAN) BIOTECHNOLOGY', website: 'https://lancco.com/',
  supported_products: ['LAUNDRY_PODS'], service_type: ['OEM', 'ODM'], target_markets: [],
  moq_quantity: null, unit: '', packaging_spec: '', lead_time_days: null,
  production_terms: [], certifications: [], prohibited_markets: [],
  notes: '官网描述洗衣凝珠配方开发、包装定制和出口支持。美国市场承接能力、MOQ 及资质尚待负责人确认。',
};
export const sourceNotes = [
  { title: '工厂官网', url: 'https://lancco.com/', detail: '洗衣凝珠 OEM / ODM、配方开发、包装定制；月产能表述为 20M+ units，计量及适用范围待确认。' },
  { title: 'OEM / ODM 服务', url: 'https://lancco.com/en/oem-odm', detail: '试单 50,000 units、25–30 天；单位、配方和包装条件待确认。' },
  { title: 'LunaSquare 四腔产品', url: 'https://lancco.com/en/products/LunaSquare', detail: '现成配方 20,000 Pieces，定制配方 50,000 Pieces；20–30 天。仅为该产品页面声明。' },
];

export function openStore(path, env = process.env) {
  const storageCfg = getStorageConfig(env);
  const directPgUrl = typeof path === 'string' && /^postgres(?:ql)?:\/\/[^\s]+$/i.test(path.trim()) ? path.trim() : null;
  const usePostgres = Boolean(directPgUrl) || (path !== ':memory:' && storageCfg.active_runtime === 'postgres');
  if (usePostgres) {
    const databaseUrl = directPgUrl || String(env.DATABASE_URL || '').trim();
    const db = openPostgresStore(databaseUrl);
    db.exec(exportPostgresDdl());
    ensureOrganization(db, { id: ORG, name: 'LANCCO 本地工作空间', slug: 'local-lancco' });
    recoverInterruptedResearchJobs(db);
    return db;
  }
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS factory_profiles (
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id), data TEXT NOT NULL,
      status TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS factory_profile_versions (
      organization_id TEXT NOT NULL REFERENCES organizations(id), version INTEGER NOT NULL,
      data TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY(organization_id, version));
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), brand_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL, website TEXT NOT NULL, normalized_domain TEXT NOT NULL,
      headquarters_country TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(organization_id, normalized_domain, normalized_name));
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id), source_url TEXT NOT NULL, raw_text TEXT NOT NULL,
      published_at TEXT, observed_at TEXT NOT NULL, verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
      created_at TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(organization_id, fingerprint));
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      action TEXT NOT NULL, object_id TEXT NOT NULL, created_at TEXT NOT NULL);`);
  transaction(db, () => {
    if (db.prepare('PRAGMA user_version').get().user_version < 1) {
      db.exec(`ALTER TABLE evidence ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE evidence ADD COLUMN checked_at TEXT;
        ALTER TABLE evidence ADD COLUMN verification_note TEXT NOT NULL DEFAULT '';
        ALTER TABLE audit_logs ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
        PRAGMA user_version = 1;`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
      account_id TEXT NOT NULL REFERENCES accounts(id), product_category TEXT NOT NULL DEFAULT 'LAUNDRY_PODS',
      qualification_status TEXT NOT NULL DEFAULT 'NEW', sales_stage TEXT NOT NULL DEFAULT 'NOT_STARTED',
      fit_status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW', reason TEXT NOT NULL, pending_info TEXT NOT NULL DEFAULT '',
      factory_version INTEGER, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(organization_id, account_id, product_category));
      CREATE TABLE IF NOT EXISTS opportunity_evidence (
        organization_id TEXT NOT NULL REFERENCES organizations(id), opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
        evidence_id TEXT NOT NULL REFERENCES evidence(id), role TEXT NOT NULL, evidence_version INTEGER NOT NULL,
        PRIMARY KEY(opportunity_id, role));
      CREATE TABLE IF NOT EXISTS opportunity_history (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id), action TEXT NOT NULL, reason TEXT NOT NULL,
        snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        account_id TEXT NOT NULL REFERENCES accounts(id), full_name TEXT NOT NULL, job_title TEXT NOT NULL,
        email TEXT NOT NULL, source_url TEXT NOT NULL, verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
        version INTEGER NOT NULL DEFAULT 1, checked_at TEXT, created_at TEXT NOT NULL,
        UNIQUE(organization_id, account_id, email));
      CREATE TABLE IF NOT EXISTS contact_suppressions (
        organization_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL,
        reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(organization_id, email));
      CREATE TABLE IF NOT EXISTS sales_activities (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id), contact_id TEXT REFERENCES contacts(id),
        activity_type TEXT NOT NULL, occurred_at TEXT NOT NULL, notes TEXT NOT NULL,
        reply_sentiment TEXT NOT NULL, amount_cents INTEGER, currency TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        voided_at TEXT, void_reason TEXT, UNIQUE(organization_id, idempotency_key));`);
    if (db.prepare('PRAGMA user_version').get().user_version < 2) {
      db.exec(`CREATE TABLE follow_up_tasks (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id), title TEXT NOT NULL, notes TEXT NOT NULL,
        due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','DONE','CANCELLED')),
        assigned_to TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        closed_at TEXT, UNIQUE(organization_id, idempotency_key));
        PRAGMA user_version = 2;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 3) {
      db.exec(`CREATE TABLE factory_field_checks (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        profile_version INTEGER NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL,
        reason TEXT NOT NULL, checked_at TEXT NOT NULL);
        CREATE TABLE drafts (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          opportunity_id TEXT NOT NULL REFERENCES opportunities(id), current_version_id TEXT,
          version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE draft_versions (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          draft_id TEXT NOT NULL REFERENCES drafts(id), number INTEGER NOT NULL,
          contact_id TEXT NOT NULL REFERENCES contacts(id), subject TEXT NOT NULL, body TEXT NOT NULL,
          claims TEXT NOT NULL, status TEXT NOT NULL, approval_snapshot TEXT,
          created_at TEXT NOT NULL, UNIQUE(draft_id,number));
        CREATE TABLE draft_reviews (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          draft_version_id TEXT NOT NULL REFERENCES draft_versions(id), action TEXT NOT NULL,
          reason TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
        ALTER TABLE sales_activities ADD COLUMN draft_version_id TEXT REFERENCES draft_versions(id);
        PRAGMA user_version = 3;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 4) {
      db.exec(`CREATE TABLE account_products (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        account_id TEXT NOT NULL REFERENCES accounts(id), product_name TEXT NOT NULL,
        product_category TEXT NOT NULL, product_url TEXT NOT NULL, normalized_url TEXT NOT NULL,
        external_sku TEXT NOT NULL, marketplace TEXT NOT NULL, packaging_type TEXT NOT NULL,
        notes TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ACTIVE', version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(organization_id,account_id,normalized_url));
        CREATE UNIQUE INDEX product_sku_identity ON account_products(organization_id,account_id,marketplace,external_sku)
          WHERE external_sku <> '';
        ALTER TABLE evidence ADD COLUMN product_id TEXT REFERENCES account_products(id);
        ALTER TABLE evidence ADD COLUMN product_version INTEGER;
        PRAGMA user_version = 4;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 5) {
      db.exec(`ALTER TABLE accounts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        CREATE TABLE account_identity_reviews (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          normalized_domain TEXT NOT NULL, normalized_name TEXT NOT NULL, candidate TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING', version INTEGER NOT NULL DEFAULT 1,
          resolved_account_id TEXT REFERENCES accounts(id), resolved_account_version INTEGER,
          reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, resolved_at TEXT,
          UNIQUE(organization_id,normalized_domain,normalized_name));
        PRAGMA user_version = 5;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 6) {
      db.exec(`ALTER TABLE sales_activities ADD COLUMN contact_snapshot TEXT;
        ALTER TABLE draft_versions ADD COLUMN contact_snapshot TEXT;`);
      for (const table of ['sales_activities', 'draft_versions']) {
        const rows = db.prepare(`SELECT r.id,c.full_name,c.job_title,c.email,c.source_url,c.version FROM ${table} r
          JOIN contacts c ON c.id=r.contact_id AND c.organization_id=r.organization_id`).all();
        const update = db.prepare(`UPDATE ${table} SET contact_snapshot=? WHERE id=?`);
        for (const row of rows) {
          const { id, ...data } = row;
          update.run(JSON.stringify({ ...data, provenance: 'MIGRATED_CURRENT_RECORD' }), id);
        }
      }
      db.exec('PRAGMA user_version = 6;');
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 7) {
      db.exec(`CREATE TABLE local_owners (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
        username TEXT NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL, credential_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        CREATE TABLE auth_sessions (
          token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES local_owners(id),
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
        PRAGMA user_version = 7;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 8) {
      db.exec('ALTER TABLE auth_sessions ADD COLUMN public_id TEXT;');
      const update = db.prepare('UPDATE auth_sessions SET public_id=? WHERE rowid=?');
      for (const row of db.prepare('SELECT rowid FROM auth_sessions').all()) update.run(randomUUID(), row.rowid);
      db.exec('CREATE UNIQUE INDEX session_public_id ON auth_sessions(public_id); PRAGMA user_version = 8;');
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 9) {
      db.exec(`CREATE TABLE research_jobs (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        status TEXT NOT NULL, current_step TEXT, attempt INTEGER NOT NULL DEFAULT 1, stop_reason TEXT,
        input_snapshot TEXT NOT NULL, factory_version INTEGER NOT NULL, source_mode TEXT NOT NULL,
        counts TEXT NOT NULL, budget TEXT NOT NULL, idempotency_key TEXT NOT NULL DEFAULT '',
        request_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
        version INTEGER NOT NULL DEFAULT 1);
        CREATE UNIQUE INDEX research_job_idempotency ON research_jobs(organization_id, idempotency_key)
          WHERE idempotency_key <> '';
        CREATE TABLE research_job_results (
          organization_id TEXT NOT NULL REFERENCES organizations(id),
          research_job_id TEXT NOT NULL REFERENCES research_jobs(id),
          account_id TEXT NOT NULL REFERENCES accounts(id),
          opportunity_id TEXT REFERENCES opportunities(id),
          tier TEXT NOT NULL, reason TEXT NOT NULL, missing_info TEXT NOT NULL DEFAULT '[]',
          evidence_snapshot TEXT NOT NULL DEFAULT '{}', contact_snapshot TEXT NOT NULL DEFAULT '{}',
          factory_version INTEGER NOT NULL, is_new INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          PRIMARY KEY(research_job_id, account_id));
        CREATE UNIQUE INDEX research_result_opportunity ON research_job_results(organization_id, research_job_id, opportunity_id)
          WHERE opportunity_id IS NOT NULL;
        CREATE TABLE research_job_failures (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          research_job_id TEXT NOT NULL REFERENCES research_jobs(id), account_id TEXT, step TEXT NOT NULL,
          reason TEXT NOT NULL, created_at TEXT NOT NULL);
        PRAGMA user_version = 9;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 10) {
      db.exec(`CREATE TABLE sources (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
        base_domains TEXT NOT NULL DEFAULT '[]', markets TEXT NOT NULL DEFAULT '["US"]',
        product_categories TEXT NOT NULL DEFAULT '["LAUNDRY_PODS"]', rate_limit_per_15m INTEGER NOT NULL DEFAULT 20,
        usage_note TEXT NOT NULL DEFAULT '', retention_note TEXT NOT NULL DEFAULT '',
        consecutive_failures INTEGER NOT NULL DEFAULT 0, last_error_at TEXT, last_error TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(organization_id, name));
        PRAGMA user_version = 10;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 11) {
      db.exec(`ALTER TABLE evidence ADD COLUMN purged_at TEXT;
        ALTER TABLE evidence ADD COLUMN purge_reason TEXT NOT NULL DEFAULT '';
        PRAGMA user_version = 11;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 12) {
      db.exec(`ALTER TABLE research_job_results ADD COLUMN next_actions TEXT NOT NULL DEFAULT '[]';
        PRAGMA user_version = 12;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 13) {
      db.exec(`ALTER TABLE research_jobs ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
        PRAGMA user_version = 13;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 14) {
      db.exec(`ALTER TABLE draft_versions ADD COLUMN created_by TEXT NOT NULL DEFAULT 'MANUAL';
        PRAGMA user_version = 14;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 15) {
      db.exec(`CREATE TABLE signal_assessments (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
        evidence_id TEXT NOT NULL REFERENCES evidence(id), evidence_version INTEGER NOT NULL,
        event_type TEXT NOT NULL, observed_facts TEXT NOT NULL, business_hypotheses TEXT NOT NULL,
        intent_signal TEXT NOT NULL, uncertainty TEXT NOT NULL, evidence_quality TEXT NOT NULL,
        quality_reason TEXT NOT NULL, missing_information TEXT NOT NULL,
        model_version TEXT NOT NULL, prompt_version TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX signal_assessment_evidence ON signal_assessments(organization_id,evidence_id,created_at);
        PRAGMA user_version = 15;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 16) {
      db.exec(`ALTER TABLE evidence ADD COLUMN source_id TEXT REFERENCES sources(id);
        ALTER TABLE evidence ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'UNKNOWN';
        ALTER TABLE evidence ADD COLUMN availability_status TEXT NOT NULL DEFAULT 'UNKNOWN';
        ALTER TABLE opportunities ADD COLUMN fit_checks TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE opportunities ADD COLUMN assigned_to TEXT NOT NULL DEFAULT '';
        ALTER TABLE contacts ADD COLUMN department TEXT NOT NULL DEFAULT '';
        ALTER TABLE contacts ADD COLUMN linkedin_url TEXT NOT NULL DEFAULT '';
        ALTER TABLE contacts ADD COLUMN role_relevance TEXT NOT NULL DEFAULT 'UNKNOWN';
        ALTER TABLE research_job_results ADD COLUMN draft_status TEXT NOT NULL DEFAULT 'NOT_GENERATED';
        ALTER TABLE research_job_results ADD COLUMN fit_status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW';
        CREATE TABLE IF NOT EXISTS workspace_members (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          username TEXT NOT NULL, display_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'MEMBER' CHECK(role IN ('OWNER', 'MEMBER')),
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
          password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
          credential_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
          UNIQUE(organization_id, username)
        );
        CREATE TABLE IF NOT EXISTS member_sessions (
          token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES workspace_members(id),
          public_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ai_runs (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          research_job_id TEXT, purpose TEXT NOT NULL, model TEXT NOT NULL,
          prompt_version TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
          error_code TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_org_acc_created ON evidence(organization_id, account_id, created_at DESC, id);
        CREATE INDEX IF NOT EXISTS idx_evidence_org_prod ON evidence(organization_id, product_id);
        CREATE INDEX IF NOT EXISTS idx_opp_org_updated ON opportunities(organization_id, updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_opp_org_status_updated ON opportunities(organization_id, qualification_status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tasks_org_status_due ON follow_up_tasks(organization_id, status, due_at ASC);
        CREATE INDEX IF NOT EXISTS idx_drafts_org_opp ON drafts(organization_id, opportunity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_org_obj_created ON audit_logs(organization_id, object_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_failures_job ON research_job_failures(organization_id, research_job_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_ai_runs_org_created ON ai_runs(organization_id, created_at DESC);
        PRAGMA user_version = 16;`);
    }
    if (db.prepare('PRAGMA user_version').get().user_version < 17) {
      db.exec(`ALTER TABLE organizations ADD COLUMN slug TEXT NOT NULL DEFAULT '';
        ALTER TABLE organizations ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug) WHERE slug <> '';
        ALTER TABLE local_owners ADD COLUMN email TEXT NOT NULL DEFAULT '';
        ALTER TABLE local_owners ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE local_owners ADD COLUMN mfa_secret_enc TEXT NOT NULL DEFAULT '';
        ALTER TABLE workspace_members ADD COLUMN email TEXT NOT NULL DEFAULT '';
        ALTER TABLE workspace_members ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE workspace_members ADD COLUMN mfa_secret_enc TEXT NOT NULL DEFAULT '';
        ALTER TABLE research_jobs ADD COLUMN worker_id TEXT;
        ALTER TABLE research_jobs ADD COLUMN lease_expires_at TEXT;
        ALTER TABLE research_jobs ADD COLUMN heartbeat_at TEXT;
        ALTER TABLE research_jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE IF NOT EXISTS member_invitations (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          email TEXT NOT NULL DEFAULT '', username TEXT NOT NULL, display_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'MEMBER' CHECK(role IN ('OWNER', 'MEMBER')),
          token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
          expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          principal_type TEXT NOT NULL CHECK(principal_type IN ('OWNER', 'MEMBER')),
          principal_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outbound_notifications (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT NOT NULL,
          payload TEXT NOT NULL, status TEXT NOT NULL, error_message TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rate_limit_events (
          id TEXT PRIMARY KEY, bucket TEXT NOT NULL, subject_key TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rate_limit_lookup ON rate_limit_events(bucket, subject_key, created_at);
        CREATE TABLE IF NOT EXISTS scheduled_monitors (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('EVIDENCE_LINK_CHECK', 'POOL_REFRESH', 'DISCOVERY_MONITOR')),
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'PAUSED')),
          interval_minutes INTEGER NOT NULL DEFAULT 60, config TEXT NOT NULL DEFAULT '{}',
          last_run_at TEXT, next_run_at TEXT NOT NULL, last_summary TEXT NOT NULL DEFAULT '{}',
          version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS connector_configs (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id),
          kind TEXT NOT NULL, endpoint_url TEXT NOT NULL DEFAULT '',
          api_key_enc TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
          options TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
          UNIQUE(organization_id, kind)
        );
        PRAGMA user_version = 17;`);
    }
  });
  ensureOrganization(db, { id: ORG, name: 'LANCCO 本地工作空间', slug: 'local-lancco' });
  recoverInterruptedResearchJobs(db);
  return db;
}

export function ensureOrganization(db, { id, name, slug = '' }) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .run(id, name, slug, now);
  db.prepare('INSERT INTO factory_profiles (organization_id, data, status, version, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .run(id, JSON.stringify(seedProfile), 'DRAFT', 1, now);
}

/**
 * Persistent sliding-window rate limiter shared across requests and external workers.
 */
export function checkAndRecordRateLimit(db, bucket, subjectKey, limit, windowMs, { record = true } = {}) {
  const now = Date.now();
  const cutoff = now - windowMs;
  db.prepare('DELETE FROM rate_limit_events WHERE bucket=? AND subject_key=? AND created_at<=?')
    .run(bucket, subjectKey, cutoff);
  const count = db.prepare('SELECT count(*) AS n FROM rate_limit_events WHERE bucket=? AND subject_key=? AND created_at>?')
    .get(bucket, subjectKey, cutoff).n;
  if (count >= limit) return { allowed: false, count, limit };
  if (record) {
    db.prepare('INSERT INTO rate_limit_events (id, bucket, subject_key, created_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), bucket, subjectKey, now);
    return { allowed: true, count: count + 1, limit };
  }
  return { allowed: true, count, limit };
}

export function recordRateLimitFailure(db, bucket, subjectKey, windowMs) {
  const now = Date.now();
  db.prepare('DELETE FROM rate_limit_events WHERE bucket=? AND subject_key=? AND created_at<=?')
    .run(bucket, subjectKey, now - windowMs);
  db.prepare('INSERT INTO rate_limit_events (id, bucket, subject_key, created_at) VALUES (?, ?, ?, ?)')
    .run(randomUUID(), bucket, subjectKey, now);
}
/**
 * Marks any orphaned QUEUED/RUNNING research jobs (unleased or expired lease)
 * as FAILED (SERVER_RESTARTED) so users can inspect partial progress or retry.
 */
export function recoverInterruptedResearchJobs(db) {
  const now = new Date().toISOString();
  const workerMode = String(process.env.RESEARCH_WORKER_MODE || 'embedded').toLowerCase();
  const stale = workerMode === 'external'
    ? db.prepare("SELECT id, organization_id FROM research_jobs WHERE status='RUNNING' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?").all(now)
    : db.prepare("SELECT id, organization_id FROM research_jobs WHERE status IN ('QUEUED', 'RUNNING') AND (worker_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)").all(now);
  if (!stale.length) return 0;
  return transaction(db, () => {
    const update = db.prepare(`UPDATE research_jobs
      SET status='FAILED', current_step=NULL, stop_reason='SERVER_RESTARTED', finished_at=?, worker_id=NULL, lease_expires_at=NULL, version=version+1
      WHERE id=? AND status IN ('QUEUED', 'RUNNING')`);
    for (const row of stale) {
      update.run(now, row.id);
      db.prepare('INSERT INTO audit_logs (id,organization_id,action,object_id,created_at,details) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), row.organization_id, 'RESEARCH_JOB_INTERRUPTED', row.id, now, JSON.stringify({ reason: 'SERVER_RESTARTED', actor: 'SYSTEM' }));
    }
    return stale.length;
  });
}
export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function audit(db, action, objectId, details = {}, ctx = null) {
  const { orgId, actor } = requestContext(ctx);
  db.prepare('INSERT INTO audit_logs (id,organization_id,action,object_id,created_at,details) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), orgId, action, objectId, new Date().toISOString(), JSON.stringify({ ...details, actor }));
}
export function recordAiRun(db, run, ctx = null) {
  const { orgId } = requestContext(ctx);
  db.prepare(`INSERT INTO ai_runs
    (id,organization_id,research_job_id,purpose,model,prompt_version,input_tokens,output_tokens,cost_usd,duration_ms,status,error_code,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      randomUUID(), orgId, run.research_job_id ?? null, run.purpose,
      String(run.model || 'unknown'), String(run.prompt_version || 'v1'),
      Number(run.input_tokens ?? 0) || 0, Number(run.output_tokens ?? 0) || 0,
      Number(run.cost_usd ?? 0) || 0, Math.max(0, Math.round(Number(run.duration_ms ?? 0) || 0)),
      run.status || 'SUCCEEDED', String(run.error_code ?? ''), new Date().toISOString(),
    );
}
export function profile(db, orgId = ORG) {
  const row = db.prepare('SELECT * FROM factory_profiles WHERE organization_id = ?').get(orgId);
  return {
    production_terms: [], certifications: [], prohibited_markets: [],
    ...JSON.parse(row.data), status: row.status, version: row.version, updated_at: row.updated_at,
  };
}
export function normalizeBrandName(value) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}
export function insertAccount(db, data, ctx = null) {
  const { orgId } = requestContext(ctx);
  const id = randomUUID();
  db.prepare('INSERT INTO accounts (id,organization_id,brand_name,normalized_name,website,normalized_domain,headquarters_country,notes,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, data.brand_name, normalizeBrandName(data.brand_name), data.website, data.normalized_domain, data.headquarters_country, data.notes, new Date().toISOString());
  audit(db, 'ACCOUNT_CREATED', id, {}, ctx);
  return id;
}
export function addAccount(db, data, ctx = null) {
  const { orgId } = requestContext(ctx);
  const normalized = normalizeBrandName(data.brand_name);
  const existing = db.prepare('SELECT id, normalized_name FROM accounts WHERE organization_id = ? AND normalized_domain = ?').all(orgId, data.normalized_domain);
  const same = existing.find(row => row.normalized_name === normalized);
  if (same) return { status: 'SKIPPED', id: same.id, reason: '同一域名与品牌已存在，已复用。' };
  const review = db.prepare('SELECT * FROM account_identity_reviews WHERE organization_id=? AND normalized_domain=? AND normalized_name=?').get(orgId, data.normalized_domain, normalized);
  if (review?.status === 'REJECTED') return { status: 'SKIPPED', review_id: review.id, reason: '此候选已人工排除，可在身份核对记录中重新开启。' };
  if (review?.status === 'REUSED') {
    const target = db.prepare('SELECT id,version,normalized_domain FROM accounts WHERE id=? AND organization_id=?').get(review.resolved_account_id, orgId);
    if (target?.version === review.resolved_account_version && target.normalized_domain === data.normalized_domain) {
      return { status: 'SKIPPED', id: target.id, review_id: review.id, reason: '已按人工确认的品牌身份复用，未覆盖既有资料。' };
    }
  }
  if (existing.length || review) {
    const id = review?.id || randomUUID();
    if (!review) {
      db.prepare('INSERT INTO account_identity_reviews (id,organization_id,normalized_domain,normalized_name,candidate,created_at) VALUES (?,?,?,?,?,?)')
        .run(id, orgId, data.normalized_domain, normalized, JSON.stringify(data), new Date().toISOString());
      audit(db, 'ACCOUNT_IDENTITY_PENDING', id, { candidate: data }, ctx);
    } else if (review.status !== 'PENDING') {
      db.prepare("UPDATE account_identity_reviews SET status='PENDING',version=version+1,reason='原身份依据已变化，请重新核对。',resolved_at=NULL WHERE id=? AND organization_id=?").run(id, orgId);
      audit(db, 'ACCOUNT_IDENTITY_REOPENED', id, { reason: '原身份依据已变化。' }, ctx);
    }
    return { status: 'NEEDS_REVIEW', review_id: id, reason: '已保存到身份核对列表，尚未创建新品牌；重复导入不会覆盖待核资料。' };
  }
  return { status: 'CREATED', id: insertAccount(db, data, ctx) };
}
