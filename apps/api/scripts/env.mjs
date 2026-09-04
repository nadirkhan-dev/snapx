import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Side-effect import: the same `.env` the API reads, so `npm run db:reset`
 * from the repository root needs no exported DATABASE_URL of its own.
 * Anything already in the environment wins — see src/config/env-file.ts.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

if (typeof process.loadEnvFile === 'function') {
  for (const file of [process.env.ENV_FILE, path.resolve(here, '../.env'),
                      path.resolve(process.cwd(), '.env')].filter(Boolean)) {
    if (fs.existsSync(file)) { process.loadEnvFile(file); break; }
  }
}
