import { resolve } from 'node:path';
import { backupDatabase } from '../src/maintenance.mjs';
import { defaultDatabasePath } from '../src/paths.mjs';
import { getStorageConfig } from '../src/storage.mjs';

const storage = getStorageConfig();
const isPg = storage.active_runtime === 'postgres';
const source = isPg ? String(process.env.DATABASE_URL || '').trim() : defaultDatabasePath();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const ext = isPg ? 'sql' : 'sqlite';
const destination = resolve(process.argv[2] || `data/backups/botein-${stamp}.${ext}`);
try {
  const result = backupDatabase(source, destination);
  console.log(JSON.stringify(result, null, 2));
  if (result.integrity !== 'ok') process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
