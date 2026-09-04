import { Global, Injectable, Module, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { Pool, type PoolClient, types } from 'pg';
import { loadConfig } from '../config/config';

/* ---- type parsers, applied once for the whole process ---- */

// A DATE column is a calendar day, not an instant. node-pg otherwise builds a
// JS Date at *local* midnight, so on UTC+5 '2026-06-01' serialises back as
// '2026-05-31'. Silent, and it moves records across day and month boundaries
// for everyone outside UTC.
types.setTypeParser(1082, v => v);          // date
// 1182 is date[]; pg's TypeId union omits it, so the cast is the documented escape hatch.
types.setTypeParser(1182 as unknown as Parameters<typeof types.setTypeParser>[0], (v: string) => v);

// bigint arrives as a string so precision is not lost. Our bigints are byte
// sizes and row ids that fit comfortably in a JS number.
types.setTypeParser(20, v => (v === null ? null : Number(v)));

@Injectable()
export class Db implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Db');
  readonly pool: Pool;

  constructor() {
    const cfg = loadConfig();
    this.pool = new Pool({
      connectionString: cfg.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // A runaway query must not pin a connection forever.
      statement_timeout: 15_000,
    });

    // An idle-client error is emitted on the pool, not a query, and crashes the
    // process if nothing listens.
    this.pool.on('error', err => this.log.error(`idle client error: ${err.message}`));
  }

  async onModuleInit() {
    const { rows } = await this.pool.query('SELECT current_database() db, version()');
    this.log.log(`connected to ${rows[0].db}`);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  /** Single query. Generic is the row shape, so callers get typed results. */
  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(text, params);
    return res.rows as T[];
  }

  /** First row or null — the common case, without `rows[0]` at every call site. */
  async one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /**
   * Runs a function inside a transaction, committing on return and rolling
   * back on throw. Financial-grade discipline applied to social data because
   * the alternative — a half-created account with no profile row — is worse to
   * clean up than to prevent.
   */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

@Global()
@Module({ providers: [Db], exports: [Db] })
export class DatabaseModule {}
