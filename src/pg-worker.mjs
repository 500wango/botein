import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { workerData } from 'node:worker_threads';

const INT_OIDS = new Set([20, 21, 23, 26]);
const FLOAT_OIDS = new Set([700, 701, 1700]);

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function md5Hex(input) {
  return createHash('md5').update(input).digest('hex');
}

function parseConnectionTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  const hostParam = url.searchParams.get('host') || '';
  const port = Number(url.port || 5432);
  const user = decodeURIComponent(url.username || process.env.PGUSER || process.env.USER || 'postgres');
  const password = decodeURIComponent(url.password || '');
  const database = decodeURIComponent((url.pathname || '/').replace(/^\/+/, '')) || user;
  const sslmode = (url.searchParams.get('sslmode') || '').toLowerCase();
  const unixPath = hostParam.startsWith('/')
    ? `${hostParam.replace(/\/+$/, '')}/.s.PGSQL.${port}`
    : (!url.hostname ? `/var/run/postgresql/.s.PGSQL.${port}` : null);
  return { host: url.hostname || 'localhost', port, user, password, database, sslmode, unixPath };
}

class WireBuffer {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.waiter = null;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }
  fail(err) {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(err);
    }
  }
  async ensure(n) {
    while (this.buf.length < n) {
      await new Promise((resolve, reject) => {
        this.waiter = err => (err ? reject(err) : resolve());
      });
    }
  }
  async readMessage() {
    await this.ensure(5);
    const type = String.fromCharCode(this.buf[0]);
    const len = this.buf.readInt32BE(1);
    await this.ensure(1 + len);
    const payload = this.buf.subarray(5, 1 + len);
    this.buf = this.buf.subarray(1 + len);
    return { type, payload };
  }
  async readByte() {
    await this.ensure(1);
    const b = this.buf[0];
    this.buf = this.buf.subarray(1);
    return b;
  }
}

function encodeString(str) {
  return Buffer.from(str, 'utf8');
}

function frame(type, parts) {
  const body = parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
  const out = Buffer.allocUnsafe(5 + body.length);
  out[0] = type.charCodeAt(0);
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}

function int32Buf(val) {
  const b = Buffer.allocUnsafe(4);
  b.writeInt32BE(val, 0);
  return b;
}

function int16Buf(val) {
  const b = Buffer.allocUnsafe(2);
  b.writeInt16BE(val, 0);
  return b;
}

function cstrBuf(str) {
  const s = encodeString(str);
  return Buffer.concat([s, Buffer.from([0])]);
}

function parseErrorPayload(payload) {
  const fields = {};
  let i = 0;
  while (i < payload.length) {
    const code = String.fromCharCode(payload[i++]);
    if (code === '\0') break;
    const end = payload.indexOf(0, i);
    fields[code] = payload.toString('utf8', i, end === -1 ? payload.length : end);
    i = end === -1 ? payload.length : end + 1;
  }
  const err = new Error(fields.M || 'PostgreSQL error');
  err.code = fields.C || 'PG_ERROR';
  err.detail = fields.D;
  err.constraint = fields.n;
  return err;
}

function parseValue(str, oid) {
  if (INT_OIDS.has(oid)) {
    const n = Number(str);
    return Number.isSafeInteger(n) ? n : str;
  }
  if (FLOAT_OIDS.has(oid)) {
    const n = Number(str);
    return Number.isFinite(n) ? n : str;
  }
  return str;
}

function parseChanges(tag) {
  const parts = String(tag || '').trim().split(/\s+/);
  const last = Number(parts[parts.length - 1]);
  return Number.isFinite(last) ? last : 0;
}

class PgConnection {
  constructor(databaseUrl) {
    this.target = parseConnectionTarget(databaseUrl);
    this.socket = null;
    this.reader = new WireBuffer();
    this.closed = false;
  }

  async connect() {
    const t = this.target;
    let sock = await new Promise((resolve, reject) => {
      const s = t.unixPath
        ? net.connect({ path: t.unixPath })
        : net.connect({ host: t.host, port: t.port });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });

    if (!t.unixPath && ['require', 'verify-ca', 'verify-full', 'prefer'].includes(t.sslmode)) {
      const sslReq = Buffer.allocUnsafe(8);
      sslReq.writeInt32BE(8, 0);
      sslReq.writeInt32BE(80877103, 4);
      sock.write(sslReq);
      const reply = await new Promise((resolve, reject) => {
        sock.once('data', d => resolve(d[0]));
        sock.once('error', reject);
      });
      if (reply === 83) { // 'S'
        sock = await new Promise((resolve, reject) => {
          const ts = tls.connect({
            socket: sock,
            servername: t.host,
            rejectUnauthorized: ['verify-ca', 'verify-full'].includes(t.sslmode),
          }, () => resolve(ts));
          ts.once('error', reject);
        });
      } else if (t.sslmode !== 'prefer') {
        sock.destroy();
        throw new Error('PostgreSQL server rejected required TLS connection.');
      }
    }

    this.socket = sock;
    sock.on('data', chunk => this.reader.push(chunk));
    sock.on('error', err => this.reader.fail(err));
    sock.on('close', () => {
      this.closed = true;
      this.reader.fail(new Error('PostgreSQL connection closed unexpectedly.'));
    });

    const params = [
      'user', t.user,
      'database', t.database,
      'client_encoding', 'UTF8',
    ];
    const body = Buffer.concat([int32Buf(196608), ...params.map(cstrBuf), Buffer.from([0])]);
    const startup = Buffer.concat([int32Buf(4 + body.length), body]);
    sock.write(startup);

    let scramState = null;
    while (true) {
      const msg = await this.reader.readMessage();
      if (msg.type === 'E') throw parseErrorPayload(msg.payload);
      if (msg.type === 'R') {
        const authType = msg.payload.readInt32BE(0);
        if (authType === 0) continue;
        if (authType === 3) {
          sock.write(frame('p', [cstrBuf(t.password)]));
        } else if (authType === 5) {
          const salt = msg.payload.subarray(4, 8);
          const inner = md5Hex(encodeString(t.password + t.user));
          const outer = 'md5' + md5Hex(Buffer.concat([encodeString(inner), salt]));
          sock.write(frame('p', [cstrBuf(outer)]));
        } else if (authType === 10) {
          const nonce = randomBytes(18).toString('base64');
          const clientFirstBare = `n=,r=${nonce}`;
          const clientFirstMsg = `n,,${clientFirstBare}`;
          scramState = { nonce, clientFirstBare };
          const msgBytes = encodeString(clientFirstMsg);
          sock.write(frame('p', [cstrBuf('SCRAM-SHA-256'), int32Buf(msgBytes.length), msgBytes]));
        } else if (authType === 11) {
          const serverFirstMsg = msg.payload.subarray(4).toString('utf8');
          const parts = Object.fromEntries(serverFirstMsg.split(',').map(p => [p[0], p.slice(2)]));
          if (!parts.r?.startsWith(scramState.nonce)) throw new Error('Invalid SCRAM server nonce.');
          const salt = Buffer.from(parts.s, 'base64');
          const iters = Number(parts.i);
          const salted = pbkdf2Sync(t.password, salt, iters, 32, 'sha256');
          const clientKey = hmacSha256(salted, 'Client Key');
          const storedKey = sha256(clientKey);
          const clientFinalWithoutProof = `c=biws,r=${parts.r}`;
          const authMessage = `${scramState.clientFirstBare},${serverFirstMsg},${clientFinalWithoutProof}`;
          const clientSig = hmacSha256(storedKey, authMessage);
          const proof = Buffer.allocUnsafe(clientKey.length);
          for (let i = 0; i < clientKey.length; i++) proof[i] = clientKey[i] ^ clientSig[i];
          const serverKey = hmacSha256(salted, 'Server Key');
          scramState.serverSig = hmacSha256(serverKey, authMessage).toString('base64');
          const clientFinal = `${clientFinalWithoutProof},p=${proof.toString('base64')}`;
          sock.write(frame('p', [encodeString(clientFinal)]));
        } else if (authType === 12) {
          const serverFinal = msg.payload.subarray(4).toString('utf8');
          const v = serverFinal.split(',').find(p => p.startsWith('v='))?.slice(2);
          if (v !== scramState?.serverSig) throw new Error('SCRAM server signature mismatch.');
        } else {
          throw new Error(`Unsupported PostgreSQL authentication type: ${authType}`);
        }
      } else if (msg.type === 'Z') {
        break;
      }
    }
  }

  async simpleQuery(sql) {
    this.socket.write(frame('Q', [cstrBuf(sql)]));
    let lastError = null;
    while (true) {
      const msg = await this.reader.readMessage();
      if (msg.type === 'E') lastError = parseErrorPayload(msg.payload);
      else if (msg.type === 'Z') {
        if (lastError) throw lastError;
        return { changes: 0 };
      }
    }
  }

  async extendedQuery(sql, params) {
    const parsePacket = frame('P', [
      cstrBuf(''),
      cstrBuf(sql),
      int16Buf(params.length),
      ...params.map(() => int32Buf(0)),
    ]);

    const paramParts = [
      cstrBuf(''),
      cstrBuf(''),
      int16Buf(0),
      int16Buf(params.length),
    ];
    for (const val of params) {
      if (val === null || val === undefined) {
        paramParts.push(int32Buf(-1));
      } else {
        const b = encodeString(String(val));
        paramParts.push(int32Buf(b.length), b);
      }
    }
    paramParts.push(int16Buf(0));
    const bindPacket = frame('B', paramParts);
    const descPacket = frame('D', [encodeString('P'), cstrBuf('')]);
    const execPacket = frame('E', [cstrBuf(''), int32Buf(0)]);
    const syncPacket = frame('S', []);

    this.socket.write(Buffer.concat([parsePacket, bindPacket, descPacket, execPacket, syncPacket]));

    let columns = [];
    const rows = [];
    let changes = 0;
    let lastError = null;

    while (true) {
      const msg = await this.reader.readMessage();
      if (msg.type === 'E') {
        lastError = parseErrorPayload(msg.payload);
      } else if (msg.type === 'T') {
        const count = msg.payload.readInt16BE(0);
        let offset = 2;
        columns = [];
        for (let i = 0; i < count; i++) {
          const end = msg.payload.indexOf(0, offset);
          const name = msg.payload.toString('utf8', offset, end);
          offset = end + 1;
          offset += 4 + 2; // tableOid + colAttr
          const typeOid = msg.payload.readUInt32BE(offset);
          offset += 4 + 2 + 4 + 2;
          columns.push({ name, typeOid });
        }
      } else if (msg.type === 'D') {
        const count = msg.payload.readInt16BE(0);
        let offset = 2;
        const row = {};
        for (let i = 0; i < count; i++) {
          const len = msg.payload.readInt32BE(offset);
          offset += 4;
          const col = columns[i];
          if (len === -1) {
            row[col.name] = null;
          } else {
            const raw = msg.payload.toString('utf8', offset, offset + len);
            offset += len;
            row[col.name] = parseValue(raw, col.typeOid);
          }
        }
        rows.push(row);
      } else if (msg.type === 'C') {
        changes = parseChanges(msg.payload.toString('utf8', 0, msg.payload.length - 1));
      } else if (msg.type === 'Z') {
        if (lastError) throw lastError;
        return { rows, changes };
      }
    }
  }

  close() {
    if (!this.socket || this.closed) return;
    this.closed = true;
    try { this.socket.write(frame('X', [])); } catch { /* ignore */ }
    this.socket.end();
  }
}

const { databaseUrl, sharedBuffer } = workerData;
const ctrl = new Int32Array(sharedBuffer, 0, 4);
const dataArea = new Uint8Array(sharedBuffer, 16);
const maxChunk = dataArea.length;

function readRequestBlocking() {
  const chunks = [];
  while (true) {
    while (true) {
      const cur = Atomics.load(ctrl, 0);
      if (cur === 1) break;
      Atomics.wait(ctrl, 0, cur);
    }
    const len = Atomics.load(ctrl, 1);
    const isLast = Atomics.load(ctrl, 2) === 1;
    chunks.push(Buffer.from(dataArea.subarray(0, len)));
    if (isLast) return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    Atomics.store(ctrl, 0, 2);
    Atomics.notify(ctrl, 0);
  }
}

function writeResponseBlocking(stateCode, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  let offset = 0;
  do {
    const slice = buf.subarray(offset, offset + maxChunk);
    offset += slice.length;
    const isLast = offset >= buf.length ? 1 : 0;
    dataArea.set(slice, 0);
    Atomics.store(ctrl, 1, slice.length);
    Atomics.store(ctrl, 2, isLast);
    Atomics.store(ctrl, 0, stateCode);
    Atomics.notify(ctrl, 0);
    if (!isLast) {
      Atomics.wait(ctrl, 0, stateCode);
    }
  } while (offset < buf.length);
}

const conn = new PgConnection(databaseUrl);

(async () => {
  while (true) {
    const req = readRequestBlocking();
    try {
      if (req.op === 'INIT') {
        await conn.connect();
        writeResponseBlocking(3, { ok: true });
      } else if (req.op === 'EXEC') {
        const res = await conn.simpleQuery(req.sql);
        writeResponseBlocking(3, res);
      } else if (req.op === 'QUERY') {
        const res = await conn.extendedQuery(req.sql, req.params || []);
        writeResponseBlocking(3, res);
      } else if (req.op === 'CLOSE') {
        conn.close();
        writeResponseBlocking(3, { closed: true });
        break;
      } else {
        throw new Error(`Unknown worker op: ${req.op}`);
      }
    } catch (error) {
      writeResponseBlocking(5, {
        message: error.message || 'PostgreSQL error',
        code: error.code || 'PG_ERROR',
        detail: error.detail || '',
      });
      if (req.op === 'INIT') break;
    }
  }
})().catch(err => {
  writeResponseBlocking(5, { message: err.message, code: 'PG_FATAL' });
  process.exit(1);
});
