import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_DATABASE_PATH = 'data/botein.sqlite';
export const LEGACY_DATABASE_PATH = 'data/signalsniper.sqlite';

// Keep existing local data readable after the product rename. A configured
// DATABASE_PATH always wins; otherwise prefer the new path, then the legacy one.
export function defaultDatabasePath() {
  if (process.env.DATABASE_PATH) return resolve(process.env.DATABASE_PATH);
  if (existsSync(resolve(DEFAULT_DATABASE_PATH))) return resolve(DEFAULT_DATABASE_PATH);
  if (existsSync(resolve(LEGACY_DATABASE_PATH))) {
    console.warn(`Legacy database found at ${LEGACY_DATABASE_PATH}; using it. Move it to ${DEFAULT_DATABASE_PATH} or set DATABASE_PATH.`);
    return resolve(LEGACY_DATABASE_PATH);
  }
  return resolve(DEFAULT_DATABASE_PATH);
}
