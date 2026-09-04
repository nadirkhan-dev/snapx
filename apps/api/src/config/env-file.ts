import fs from 'node:fs';
import path from 'node:path';

/**
 * Loads `apps/api/.env` into the environment, if it is there.
 *
 * Secrets reach the process from the environment in every deployment that
 * matters; a file is the development convenience that keeps them out of shell
 * history and out of the repository. Anything already set in the environment
 * wins, so CI and production — which export real values — are untouched by a
 * stray file, and `DATABASE_URL=... npm run dev` still overrides for one run.
 *
 * Missing file is not an error: the environment may well be complete already,
 * and config validation is what decides whether it is.
 */
let loaded: string | null | undefined;

export function loadDotEnv(): string | null {
  // Config is read from module scope in several places; the file is read once.
  if (loaded !== undefined) return loaded;
  loaded = null;
  // Added in Node 20.12. On anything older the environment is the only source,
  // which is exactly how CI already runs.
  if (typeof process.loadEnvFile !== 'function') return loaded;

  const candidates = [
    process.env.ENV_FILE,
    // dist/config/env-file.js → apps/api/.env, wherever the process was started.
    path.resolve(__dirname, '../../.env'),
    path.resolve(process.cwd(), '.env'),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    process.loadEnvFile(file);
    loaded = file;
    return loaded;
  }
  return loaded;
}
