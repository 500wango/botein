import { applyPostgresSchema, exportPostgresDdl, migrateSqliteToPostgres } from '../src/storage.mjs';

const args = process.argv.slice(2);
if (args.includes('--print')) {
  process.stdout.write(`${exportPostgresDdl()}\n`);
  process.exit(0);
}

const url = process.env.DATABASE_URL || args.find(a => /^postgres(?:ql)?:\/\//.test(a));
if (!url) {
  console.error('请通过 DATABASE_URL 环境变量或参数传入 postgres://... 连接串，可选 --from-sqlite <path>，或使用 --print 导出 DDL。');
  process.exit(1);
}

const fromIdx = args.indexOf('--from-sqlite');
const sqlitePath = fromIdx >= 0 ? args[fromIdx + 1] : '';
if (sqlitePath) {
  const result = migrateSqliteToPostgres(sqlitePath, url);
  console.log(`PostgreSQL schema v17 & ${result.migrated_rows} SQLite rows migrated successfully.`);
} else {
  const result = applyPostgresSchema(url);
  console.log('PostgreSQL schema v17 migrated successfully.', result.stdout.trim());
}
