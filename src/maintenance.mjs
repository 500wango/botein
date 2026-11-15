import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openPostgresStore } from './pg-store.mjs';

const COUNTED_TABLES = [
  'organizations', 'accounts', 'account_products', 'evidence', 'opportunities', 'contacts',
  'sales_activities', 'follow_up_tasks', 'research_jobs', 'research_job_results', 'sources', 'audit_logs',
];

function isPostgresUrl(value) {
  return typeof value === 'string' && /^postgres(?:ql)?:\/\//i.test(value.trim());
}

function readEdgeSlice(filePath, start, length) {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function verifyPostgresBackup(target, databaseUrl = '') {
  const bytes = statSync(target).size;
  if (bytes === 0) return { path: target, engine: 'postgres', bytes: 0, integrity: 'empty', counts: {} };
  const head = readEdgeSlice(target, 0, Math.min(bytes, 4096));
  const tailStart = Math.max(0, bytes - 4096);
  const tail = readEdgeSlice(target, tailStart, bytes - tailStart);
  const hasHeader = /PostgreSQL database dump/i.test(head) || /\bCREATE TABLE\b|\bSET\s+/i.test(head);
  const hasFooter = /PostgreSQL database dump complete/i.test(tail);
  const counts = {};
  if (isPostgresUrl(databaseUrl)) {
    const db = openPostgresStore(databaseUrl.trim());
    try {
      const present = new Set(db.prepare("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'").all().map(row => row.name));
      for (const table of COUNTED_TABLES) {
        if (present.has(table)) counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      }
    } finally {
      db.close();
    }
  }
  return {
    path: target,
    engine: 'postgres',
    bytes,
    integrity: hasHeader && hasFooter ? 'ok' : 'incomplete',
    counts,
  };
}

export function verifyBackup(path, { databaseUrl = '' } = {}) {
  const target = resolve(path);
  if (!existsSync(target)) throw new Error(`备份文件不存在：${target}`);
  if (/\.sql$/i.test(target)) return verifyPostgresBackup(target, databaseUrl);
  const db = new DatabaseSync(target);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const counts = {};
    for (const table of COUNTED_TABLES) {
      if (present.has(table)) counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    }
    return { path: target, engine: 'sqlite', bytes: statSync(target).size, integrity, counts };
  } finally { db.close(); }
}

// VACUUM INTO takes a consistent snapshot without writing to the source SQLite database;
// pg_dump produces a consistent snapshot for PostgreSQL deployments.
export function backupDatabase(sourcePath, destinationPath) {
  const destination = resolve(destinationPath);
  if (existsSync(destination)) throw new Error(`备份目标已存在，请选择新的文件名：${destination}`);
  if (isPostgresUrl(sourcePath)) {
    mkdirSync(dirname(destination), { recursive: true });
    try {
      execFileSync('pg_dump', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '-f', destination, sourcePath.trim()], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('未找到 pg_dump 命令，请安装 postgresql-client 后重试。');
      const detail = String(error.stderr || error.message || '').trim();
      throw new Error(`PostgreSQL 备份失败：${detail || 'pg_dump 返回错误'}`);
    }
    return { destination, ...verifyPostgresBackup(destination, sourcePath.trim()) };
  }
  const source = resolve(sourcePath);
  if (source === destination) throw new Error('备份目标不能与源数据库相同。');
  if (!existsSync(source)) throw new Error(`源数据库不存在：${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  const db = new DatabaseSync(source);
  try {
    const escaped = destination.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally { db.close(); }
  return { destination, ...verifyBackup(destination) };
}
