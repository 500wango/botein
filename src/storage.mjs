import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 18;

export function getStorageConfig(env = process.env) {
  const configuredDriver = String(env.DB_DRIVER || 'sqlite').trim().toLowerCase() === 'postgres' ? 'postgres' : 'sqlite';
  const databaseUrl = String(env.DATABASE_URL || '').trim();
  const postgresUrlValid = /^postgres(?:ql)?:\/\/[^\s]+$/i.test(databaseUrl);
  const activeRuntime = configuredDriver === 'postgres' && postgresUrlValid ? 'postgres' : 'sqlite';
  return {
    driver: activeRuntime,
    active_runtime: activeRuntime,
    configured_driver: configuredDriver,
    postgres_configured: postgresUrlValid,
    schema_version: SCHEMA_VERSION,
  };
}

/**
 * Emits idempotent PostgreSQL DDL corresponding to Botein schema v17.
 */
export function exportPostgresDdl() {
  return `
CREATE OR REPLACE FUNCTION json_extract(data text, path text) RETURNS text AS $$
  SELECT CASE
    WHEN data IS NULL OR data = '' THEN NULL
    ELSE (data::jsonb #>> string_to_array(regexp_replace(path, '^\\$\\.?', ''), '.'))
  END;
$$ LANGUAGE SQL IMMUTABLE;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug) WHERE slug <> '';

CREATE TABLE IF NOT EXISTS factory_profiles (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS factory_profile_versions (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY(organization_id, version)
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  brand_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  website TEXT NOT NULL,
  normalized_domain TEXT NOT NULL,
  headquarters_country TEXT NOT NULL,
  notes TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, normalized_domain, normalized_name)
);

CREATE TABLE IF NOT EXISTS account_identity_reviews (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  normalized_domain TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  candidate TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  version INTEGER NOT NULL DEFAULT 1,
  resolved_account_id TEXT REFERENCES accounts(id),
  resolved_account_version INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(organization_id, normalized_domain, normalized_name)
);

CREATE TABLE IF NOT EXISTS account_products (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_name TEXT NOT NULL,
  product_category TEXT NOT NULL,
  product_url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  external_sku TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  packaging_type TEXT NOT NULL,
  notes TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, account_id, normalized_url)
);
CREATE UNIQUE INDEX IF NOT EXISTS product_sku_identity ON account_products(organization_id, account_id, marketplace, external_sku) WHERE external_sku <> '';

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  base_domains TEXT NOT NULL DEFAULT '[]',
  markets TEXT NOT NULL DEFAULT '["US"]',
  product_categories TEXT NOT NULL DEFAULT '["LAUNDRY_PODS"]',
  rate_limit_per_15m INTEGER NOT NULL DEFAULT 20,
  usage_note TEXT NOT NULL DEFAULT '',
  retention_note TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, name)
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source_url TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  published_at TEXT,
  observed_at TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  version INTEGER NOT NULL DEFAULT 1,
  checked_at TEXT,
  verification_note TEXT NOT NULL DEFAULT '',
  product_id TEXT REFERENCES account_products(id),
  product_version INTEGER,
  purged_at TEXT,
  purge_reason TEXT NOT NULL DEFAULT '',
  source_id TEXT REFERENCES sources(id),
  source_kind TEXT NOT NULL DEFAULT 'UNKNOWN',
  availability_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  UNIQUE(organization_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_category TEXT NOT NULL DEFAULT 'LAUNDRY_PODS',
  qualification_status TEXT NOT NULL DEFAULT 'NEW',
  sales_stage TEXT NOT NULL DEFAULT 'NOT_STARTED',
  fit_status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
  fit_checks TEXT NOT NULL DEFAULT '[]',
  assigned_to TEXT NOT NULL DEFAULT '',
  cohort_assignee TEXT NOT NULL DEFAULT '',
  estimated_order_quantity INTEGER,
  reason TEXT NOT NULL,
  pending_info TEXT NOT NULL DEFAULT '',
  factory_version INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, account_id, product_category)
);

CREATE TABLE IF NOT EXISTS opportunity_evidence (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  role TEXT NOT NULL,
  evidence_version INTEGER NOT NULL,
  PRIMARY KEY(opportunity_id, role)
);

CREATE TABLE IF NOT EXISTS opportunity_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  full_name TEXT NOT NULL,
  job_title TEXT NOT NULL,
  email TEXT NOT NULL,
  source_url TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  department TEXT NOT NULL DEFAULT '',
  linkedin_url TEXT NOT NULL DEFAULT '',
  role_relevance TEXT NOT NULL DEFAULT 'UNKNOWN',
  version INTEGER NOT NULL DEFAULT 1,
  checked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, account_id, email)
);

CREATE TABLE IF NOT EXISTS contact_suppressions (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(organization_id, email)
);

CREATE TABLE IF NOT EXISTS factory_field_checks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  profile_version INTEGER NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  reason TEXT NOT NULL,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  current_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  number INTEGER NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  claims TEXT NOT NULL,
  status TEXT NOT NULL,
  approval_snapshot TEXT,
  contact_snapshot TEXT,
  created_by TEXT NOT NULL DEFAULT 'MANUAL',
  created_at TEXT NOT NULL,
  UNIQUE(draft_id, number)
);

CREATE TABLE IF NOT EXISTS draft_reviews (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  draft_version_id TEXT NOT NULL REFERENCES draft_versions(id),
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_activities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  contact_id TEXT REFERENCES contacts(id),
  draft_version_id TEXT REFERENCES draft_versions(id),
  contact_snapshot TEXT,
  activity_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  notes TEXT NOT NULL,
  reply_sentiment TEXT NOT NULL,
  amount_cents BIGINT,
  currency TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  void_reason TEXT,
  UNIQUE(organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS follow_up_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id),
  title TEXT NOT NULL,
  notes TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN', 'DONE', 'CANCELLED')),
  assigned_to TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(organization_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS research_jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  status TEXT NOT NULL,
  current_step TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  stop_reason TEXT,
  input_snapshot TEXT NOT NULL,
  factory_version INTEGER NOT NULL,
  source_mode TEXT NOT NULL,
  counts TEXT NOT NULL,
  budget TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL DEFAULT '',
  request_hash TEXT NOT NULL DEFAULT '',
  worker_id TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS research_job_idempotency ON research_jobs(organization_id, idempotency_key) WHERE idempotency_key <> '';

CREATE TABLE IF NOT EXISTS research_job_results (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  research_job_id TEXT NOT NULL REFERENCES research_jobs(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  opportunity_id TEXT REFERENCES opportunities(id),
  tier TEXT NOT NULL,
  reason TEXT NOT NULL,
  missing_info TEXT NOT NULL DEFAULT '[]',
  evidence_snapshot TEXT NOT NULL DEFAULT '{}',
  contact_snapshot TEXT NOT NULL DEFAULT '{}',
  next_actions TEXT NOT NULL DEFAULT '[]',
  factory_version INTEGER NOT NULL,
  is_new INTEGER NOT NULL DEFAULT 0,
  draft_status TEXT NOT NULL DEFAULT 'NOT_GENERATED',
  fit_status TEXT NOT NULL DEFAULT 'NEEDS_REVIEW',
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY(research_job_id, account_id)
);

CREATE TABLE IF NOT EXISTS research_job_failures (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  research_job_id TEXT NOT NULL REFERENCES research_jobs(id),
  account_id TEXT,
  step TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signal_assessments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  evidence_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  observed_facts TEXT NOT NULL,
  business_hypotheses TEXT NOT NULL,
  intent_signal TEXT NOT NULL,
  uncertainty TEXT NOT NULL,
  evidence_quality TEXT NOT NULL,
  quality_reason TEXT NOT NULL,
  missing_information TEXT NOT NULL,
  model_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  research_job_id TEXT,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS local_owners (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL UNIQUE REFERENCES organizations(id),
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret_enc TEXT NOT NULL DEFAULT '',
  mfa_last_used_step INTEGER NOT NULL DEFAULT -1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES local_owners(id),
  public_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK(role IN ('OWNER', 'MEMBER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'DISABLED')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1,
  mfa_enabled INTEGER NOT NULL DEFAULT 0,
  mfa_secret_enc TEXT NOT NULL DEFAULT '',
  mfa_last_used_step INTEGER NOT NULL DEFAULT -1,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, username)
);

CREATE TABLE IF NOT EXISTS member_sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES workspace_members(id),
  public_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK(role IN ('OWNER', 'MEMBER')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_type TEXT NOT NULL CHECK(principal_type IN ('OWNER', 'MEMBER')),
  principal_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_lookup ON rate_limit_events(bucket, subject_key, created_at);

CREATE TABLE IF NOT EXISTS scheduled_monitors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('EVIDENCE_LINK_CHECK', 'POOL_REFRESH', 'DISCOVERY_MONITOR')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'PAUSED')),
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  config TEXT NOT NULL DEFAULT '{}',
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  last_summary TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL,
  endpoint_url TEXT NOT NULL DEFAULT '',
  api_key_enc TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  options TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, kind)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  action TEXT NOT NULL,
  object_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS signal_assessment_evidence ON signal_assessments(organization_id, evidence_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evidence_org_acc_created ON evidence(organization_id, account_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_evidence_org_prod ON evidence(organization_id, product_id);
CREATE INDEX IF NOT EXISTS idx_opp_org_updated ON opportunities(organization_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_opp_org_status_updated ON opportunities(organization_id, qualification_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_org_status_due ON follow_up_tasks(organization_id, status, due_at ASC);
CREATE INDEX IF NOT EXISTS idx_drafts_org_opp ON drafts(organization_id, opportunity_id);
CREATE INDEX IF NOT EXISTS idx_audit_org_obj_created ON audit_logs(organization_id, object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_failures_job ON research_job_failures(organization_id, research_job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_failures_job_attempt ON research_job_failures(organization_id, research_job_id, attempt, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_runs_org_created ON ai_runs(organization_id, created_at DESC);

ALTER TABLE local_owners ADD COLUMN IF NOT EXISTS mfa_last_used_step INTEGER NOT NULL DEFAULT -1;
ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS mfa_last_used_step INTEGER NOT NULL DEFAULT -1;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS cohort_assignee TEXT NOT NULL DEFAULT '';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS estimated_order_quantity INTEGER;
ALTER TABLE research_job_results ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE research_job_failures ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE opportunity_history ADD COLUMN IF NOT EXISTS rowid BIGINT GENERATED BY DEFAULT AS IDENTITY;
ALTER TABLE draft_reviews ADD COLUMN IF NOT EXISTS rowid BIGINT GENERATED BY DEFAULT AS IDENTITY;
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS rowid BIGINT GENERATED BY DEFAULT AS IDENTITY;
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS rowid BIGINT GENERATED BY DEFAULT AS IDENTITY;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS rowid BIGINT GENERATED BY DEFAULT AS IDENTITY;
`.trim();
}

export function applyPostgresSchema(databaseUrl) {
  const conn = typeof databaseUrl === 'string' ? databaseUrl.trim() : '';
  if (!/^postgres(?:ql)?:\/\/[^\s]+$/i.test(conn)) {
    throw new Error('DATABASE_URL 必须以 postgres:// 或 postgresql:// 开头且不含空白字符。');
  }
  const ddl = exportPostgresDdl();
  const res = spawnSync('psql', [conn, '-v', 'ON_ERROR_STOP=1'], {
    input: ddl,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (res.status !== 0) {
    throw new Error(`PostgreSQL 迁移失败：${res.stderr || res.stdout || res.error?.message || 'psql error'}`);
  }
  return { applied: true, stdout: res.stdout };
}

const PG_MIGRATION_TABLES = [
  'organizations',
  'factory_profiles',
  'factory_profile_versions',
  'factory_field_checks',
  'local_owners',
  'workspace_members',
  'member_invitations',
  'auth_sessions',
  'member_sessions',
  'password_reset_tokens',
  'rate_limit_events',
  'sources',
  'accounts',
  'account_identity_reviews',
  'account_products',
  'evidence',
  'signal_assessments',
  'research_jobs',
  'research_job_results',
  'research_job_failures',
  'ai_runs',
  'opportunities',
  'opportunity_evidence',
  'opportunity_history',
  'contacts',
  'contact_history',
  'contact_suppressions',
  'drafts',
  'draft_versions',
  'draft_reviews',
  'sales_activities',
  'follow_up_tasks',
  'scheduled_monitors',
  'connector_configs',
  'outbound_notifications',
  'audit_logs',
];

function pgLiteral(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
  const str = String(val);
  return `'${str.replace(/'/g, "''")}'`;
}

const PG_ROWID_TABLES = [
  'opportunity_history',
  'draft_reviews',
  'research_jobs',
  'auth_sessions',
  'audit_logs',
];

/**
 * Exports all rows from an existing SQLite database into idempotent PostgreSQL
 * INSERT statements in foreign-key dependency order, resets identity sequences,
 * and applies them via a streamed SQL file so large exports do not overflow buffers.
 */
export function migrateSqliteToPostgres(sqlitePath, databaseUrl) {
  applyPostgresSchema(databaseUrl);
  const conn = typeof databaseUrl === 'string' ? databaseUrl.trim() : '';
  const src = new DatabaseSync(sqlitePath, { readOnly: true });
  const tempDir = mkdtempSync(join(tmpdir(), 'botein-pg-migrate-'));
  const sqlFile = join(tempDir, 'migrate.sql');
  let exportedRows = 0;
  try {
    writeFileSync(sqlFile, 'BEGIN;\n', 'utf8');
    const flushChunk = (lines) => {
      if (lines.length) {
        appendFileSync(sqlFile, `${lines.join('\n')}\n`, 'utf8');
        lines.length = 0;
      }
    };
    const existingTables = new Set(
      src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name),
    );
    const buffer = [];
    for (const table of PG_MIGRATION_TABLES) {
      if (!existingTables.has(table)) continue;
      for (const row of src.prepare(`SELECT * FROM "${table}"`).iterate()) {
        const cols = Object.keys(row).map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
        const vals = Object.values(row).map(pgLiteral).join(', ');
        buffer.push(`INSERT INTO "${table}" (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING;`);
        exportedRows++;
        if (buffer.length >= 500) flushChunk(buffer);
      }
    }
    for (const table of PG_ROWID_TABLES) {
      buffer.push(`SELECT setval(pg_get_serial_sequence('${table}', 'rowid'), COALESCE((SELECT MAX(rowid) FROM "${table}"), 1), EXISTS (SELECT 1 FROM "${table}"));`);
    }
    buffer.push('COMMIT;');
    flushChunk(buffer);

    const res = spawnSync('psql', [conn, '-v', 'ON_ERROR_STOP=1', '-f', sqlFile], {
      encoding: 'utf8',
      timeout: 300_000,
    });
    if (res.status !== 0) {
      throw new Error(`SQLite -> PostgreSQL 数据迁移失败：${res.stderr || res.stdout || res.error?.message || 'psql error'}`);
    }
    return { applied: true, migrated_rows: exportedRows, stdout: res.stdout };
  } finally {
    try { src.close(); } catch {}
    rmSync(tempDir, { recursive: true, force: true });
  }
}
