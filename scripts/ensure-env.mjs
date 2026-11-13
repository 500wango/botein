import { copyFileSync, existsSync } from 'node:fs';

// Node watch mode fails if --env-file-if-exists points at a missing file.
// Generate the ignored local .env from the example before starting watch mode.
if (!existsSync('.env')) copyFileSync('.env.example', '.env');
