import { completeJson, modelConfig } from '../src/model.mjs';
import { defaultDatabasePath } from '../src/paths.mjs';
import { searchConfig, searchStatus, searchWeb } from '../src/search.mjs';
import { fetchPublicPage } from '../src/source-fetch.mjs';
import { getStorageConfig } from '../src/storage.mjs';
import { openStore } from '../src/store.mjs';
import { startWorkerLoop } from '../src/worker.mjs';

const storage = getStorageConfig();
const target = defaultDatabasePath();
const db = openStore(target);
const services = {
  searchWeb,
  searchStatus,
  searchBase: searchConfig().base,
  fetchPage: fetchPublicPage,
  completeJson,
  modelConfig,
};

const stop = startWorkerLoop(db, services, {
  workerId: process.env.WORKER_ID || `worker-${process.pid}`,
  pollMs: Number(process.env.WORKER_POLL_MS || 2000),
});

console.log(`Botein external worker listening (${storage.active_runtime}: ${storage.active_runtime === 'postgres' ? 'DATABASE_URL' : target})`);

const shutdown = () => {
  stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
