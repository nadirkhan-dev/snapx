import { z } from 'zod';
import { loadDotEnv } from './env-file';

/**
 * Environment configuration, validated once at boot.
 *
 * The process refuses to start on a bad or missing value rather than failing
 * at the first request that needs it. A server that boots and then 500s on
 * login is harder to diagnose than one that never came up and said why.
 *
 * Secrets have no defaults. A default that works everywhere is a default nobody
 * notices reached production, and anyone who has read the source can then forge
 * a token for any account.
 */

const secret = (name: string) =>
  z.string({ required_error: `${name} is required` })
    .min(32, `${name} must be at least 32 characters — generate with: openssl rand -hex 32`)
    .refine(v => !/change-?me|dev-only|placeholder|secret123|^x+$/i.test(v),
      `${name} looks like a placeholder. Use a real random value.`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  /* Not z.string().url(): a Unix-socket DSN such as
     postgres://user@localhost/db?host=/var/run/postgresql is perfectly valid
     for pg and for most managed providers, but fails WHATWG URL parsing on the
     path component. Check the scheme, which is what actually matters. */
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//,
    'DATABASE_URL must start with postgres:// or postgresql://'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  /* Access and refresh tokens are signed with *different* keys. Sharing one
     means a leaked access token key also mints refresh tokens, turning a
     15-minute problem into a 30-day one. */
  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  /* Object storage. Optional in Phase 1 — media lands in Phase 2, and the API
     should still boot for auth work without S3 credentials on hand. */
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  CDN_BASE_URL: z.string().optional(),

  /* Where the local-disk backend keeps objects when S3 is not configured.
     Relative paths resolve against the process working directory. */
  STORAGE_DIR: z.string().default('./storage'),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(): AppConfig {
  /* Here rather than in bootstrap(): several modules call loadConfig() at
     import time, which is before main() runs a single line. */
  loadDotEnv();

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `  • ${i.path.join('.')}: ${i.message}`);
    // Thrown, not logged: this must stop the process.
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}\n`);
  }
  return parsed.data;
}

export const isProd = () => process.env.NODE_ENV === 'production';
