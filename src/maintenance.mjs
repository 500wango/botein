import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const COUNTED_TABLES = [
  'organizations', 'accounts', 'account_products', 'evidence', 'opportunities', 'contacts',
  'sales_activities', 'follow_up_tasks', 'research_jobs', 'research_job_results', 'sources', 'audit_logs',
];

export function verifyBackup(path) {
  const target = resolve(path);
  if (!existsSync(target)) throw new Error(`备份文件不存在：${target}`);
  const db = new DatabaseSync(target);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const counts = {};
    for (const table of COUNTED_TABLES) {
      if (present.has(table)) counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    }
    return { path: target, bytes: statSync(target).size, integrity, counts };
  } finally { db.close(); }
}

// VACUUM INTO takes a consistent snapshot without writing to the source database.
export function backupDatabase(sourcePath, destinationPath) {
  const source = resolve(sourcePath), destination = resolve(destinationPath);
  if (source === destination) throw new Error('备份目标不能与源数据库相同。');
  if (existsSync(destination)) throw new Error(`备份目标已存在，请选择新的文件名：${destination}`);
  if (!existsSync(source)) throw new Error(`源数据库不存在：${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  const db = new DatabaseSync(source);
  try {
    const escaped = destination.replaceAll("'", "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally { db.close(); }
  return { destination, ...verifyBackup(destination) };
}
