import { resolve } from 'node:path';
import { backupDatabase } from '../src/maintenance.mjs';
import { defaultDatabasePath } from '../src/paths.mjs';

const source = defaultDatabasePath();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = resolve(process.argv[2] || `data/backups/botein-${stamp}.sqlite`);
try {
  const result = backupDatabase(source, destination);
  console.log(JSON.stringify(result, null, 2));
  if (result.integrity !== 'ok') process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
