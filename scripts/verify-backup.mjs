import { resolve } from 'node:path';
import { verifyBackup } from '../src/maintenance.mjs';

if (!process.argv[2]) {
  console.error('用法：npm run verify-backup -- <备份文件路径>');
  process.exitCode = 1;
} else {
  try {
    const result = verifyBackup(resolve(process.argv[2]));
    console.log(JSON.stringify(result, null, 2));
    if (result.integrity !== 'ok') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
