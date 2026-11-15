import { Worker } from 'node:worker_threads';

/**
 * Rewrites positional SQLite `?` placeholders to PostgreSQL `$1, $2, ...`,
 * skipping `?` characters inside single-quoted string literals `'...'`.
 */
export function rewritePlaceholders(sql) {
  let out = '';
  let index = 1;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      out += ch;
      if (inString && sql[i + 1] === "'") {
        out += "'";
        i++;
      } else {
        inString = !inString;
      }
    } else if (ch === '?' && !inString) {
      out += `$${index++}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Translates the bounded SQLite idioms used by Botein modules to PostgreSQL SQL.
 */
export function translateSqliteToPostgres(rawSql) {
  const trimmed = String(rawSql || '').trim();
  if (!trimmed) return { skip: true };
  if (/^PRAGMA\s+integrity_check\b/i.test(trimmed)) {
    return { syntheticRow: { integrity_check: 'ok' } };
  }
  if (/^PRAGMA\b/i.test(trimmed)) {
    return { skip: true };
  }
  if (/^VACUUM\b(?:\s+INTO\b)?/i.test(trimmed)) {
    return { skip: true };
  }
  if (/^BEGIN\s+IMMEDIATE\s*;?$/i.test(trimmed)) {
    return { sql: 'BEGIN' };
  }

  let sql = trimmed;
  sql = sql.replace(/PRAGMA\s+[^;]+;?/gi, '');
  sql = sql.replace(/\bVACUUM\s*;?/gi, '');
  sql = sql.replace(/\bBEGIN\s+IMMEDIATE\b/gi, 'BEGIN');
  sql = sql.replace(
    /SELECT\s+name\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'/gi,
    "SELECT tablename AS name FROM pg_tables WHERE schemaname='public'",
  );
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) {
    sql = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
    if (!/\bON\s+CONFLICT\b/i.test(sql)) {
      sql = sql.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
    }
  }
  if (!sql.trim()) return { skip: true };
  return { sql: rewritePlaceholders(sql) };
}

class SyncWorkerBridge {
  constructor(databaseUrl) {
    this.sharedBuffer = new SharedArrayBuffer(1024 * 1024);
    this.ctrl = new Int32Array(this.sharedBuffer, 0, 4);
    this.dataArea = new Uint8Array(this.sharedBuffer, 16);
    this.maxChunk = this.dataArea.length;
    this.workerError = null;
    this.worker = new Worker(new URL('./pg-worker.mjs', import.meta.url), {
      execArgv: [],
      workerData: { databaseUrl, sharedBuffer: this.sharedBuffer },
    });
    this.worker.on('error', err => {
      this.workerError = err;
      Atomics.store(this.ctrl, 0, 6);
      Atomics.notify(this.ctrl, 0);
    });
    this.worker.on('exit', code => {
      if (!this.closed && code !== 0 && !this.workerError) {
        this.workerError = new Error(`PostgreSQL worker exited unexpectedly (code ${code}).`);
        Atomics.store(this.ctrl, 0, 6);
        Atomics.notify(this.ctrl, 0);
      }
    });
    this.closed = false;
    this.call({ op: 'INIT' });
  }

  call(payload) {
    if (this.closed) throw new Error('PostgreSQL store is already closed.');
    if (this.workerError) throw this.workerError;
    const reqBytes = Buffer.from(JSON.stringify(payload), 'utf8');
    let offset = 0;
    do {
      const slice = reqBytes.subarray(offset, offset + this.maxChunk);
      offset += slice.length;
      const isLast = offset >= reqBytes.length ? 1 : 0;
      this.dataArea.set(slice, 0);
      Atomics.store(this.ctrl, 1, slice.length);
      Atomics.store(this.ctrl, 2, isLast);
      Atomics.store(this.ctrl, 0, 1);
      Atomics.notify(this.ctrl, 0);
      if (!isLast) {
        Atomics.wait(this.ctrl, 0, 1, 30000);
        if (Atomics.load(this.ctrl, 0) === 6) throw this.workerError || new Error('PostgreSQL worker failed.');
      }
    } while (offset < reqBytes.length);

    const chunks = [];
    let statusCode = 0;
    while (true) {
      while (true) {
        const cur = Atomics.load(this.ctrl, 0);
        if (cur === 3 || cur === 5 || cur === 6) {
          statusCode = cur;
          break;
        }
        Atomics.wait(this.ctrl, 0, cur, 30000);
      }
      if (statusCode === 6) {
        throw this.workerError || new Error('PostgreSQL worker crashed.');
      }
      const len = Atomics.load(this.ctrl, 1);
      const isLast = Atomics.load(this.ctrl, 2) === 1;
      chunks.push(Buffer.from(this.dataArea.subarray(0, len)));
      if (isLast) {
        Atomics.store(this.ctrl, 0, 0);
        break;
      }
      Atomics.store(this.ctrl, 0, 4);
      Atomics.notify(this.ctrl, 0);
    }

    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (statusCode === 5) {
      const err = new Error(parsed.message || 'PostgreSQL error');
      err.code = parsed.code;
      err.detail = parsed.detail;
      throw err;
    }
    return parsed;
  }

  close() {
    if (this.closed) return;
    try { this.call({ op: 'CLOSE' }); } catch { /* ignore */ }
    this.closed = true;
    this.worker.terminate().catch(() => {});
  }
}

export function openPostgresStore(databaseUrl) {
  const bridge = new SyncWorkerBridge(databaseUrl);

  const runPrepared = (rawSql, params) => {
    const plan = translateSqliteToPostgres(rawSql);
    if (plan.syntheticRow) return { rows: [plan.syntheticRow], changes: 1 };
    if (plan.skip) return { rows: [], changes: 0 };
    return bridge.call({ op: 'QUERY', sql: plan.sql, params });
  };

  return {
    dialect: 'postgres',
    prepare(rawSql) {
      return {
        get(...params) {
          const { rows } = runPrepared(rawSql, params);
          return rows[0];
        },
        all(...params) {
          const { rows } = runPrepared(rawSql, params);
          return rows;
        },
        run(...params) {
          const { changes } = runPrepared(rawSql, params);
          return { changes };
        },
      };
    },
    exec(rawSql) {
      const plan = translateSqliteToPostgres(rawSql);
      if (plan.skip) return;
      bridge.call({ op: 'EXEC', sql: plan.sql });
    },
    close() {
      bridge.close();
    },
  };
}
