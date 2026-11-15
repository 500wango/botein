import { resolve } from 'node:path';
import { verifyBackup } from '../src/maintenance.mjs';
import { getStorageConfig } from '../src/storage.mjs';

if (!process.argv[2]) {
  console.error('用法：npm run verify-backup -- <备份文件路径>');
  process.exitCode = 1;
} else {
  try {
    const storage = getStorageConfig();
    const databaseUrl = storage.active_runtime === 'postgres' ? String(process.env.DATABASE_URL || '').trim() : '';
    const result = verifyBackup(resolve(process.argv[2]), { databaseUrl });
    console.log(JSON.stringify(result, null, 2));
    if (result.integrity !== 'ok') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
