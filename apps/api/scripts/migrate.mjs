import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import './env.mjs';

/**
 * Bootstrap migration: drops and rebuilds the public schema.
 *
 * The DROP is catalogue-driven rather than a hand-written list of table names,
 * because a hand-written list falls behind the schema the first time someone
 * adds a table and forgets. Destructive by design — this is for development and
 * first deploy, not incremental production migration. Phase 10 adds a real
 * migration tool with this file as the baseline.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required'); process.exit(1); }

/*
 * Objects belonging to an extension are skipped (`pg_depend.deptype = 'e'`).
 * pgcrypto and citext install their functions into `public`, and Postgres
 * refuses to drop one out from under its extension — so without this filter the
 * very first `DROP FUNCTION digest(text,text)` aborts the whole block, and the
 * command works exactly once: on a database where the extensions do not exist
 * yet. `CREATE EXTENSION IF NOT EXISTS` in schema.sql then leaves them in place
 * for the next run, which is what we want.
 */
const DROP = `
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname='public' AND c.relkind='v'
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                               WHERE d.objid = c.oid AND d.deptype = 'e')
  LOOP EXECUTE format('DROP VIEW IF EXISTS %I CASCADE', r.relname); END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname='public' AND c.relkind IN ('r','p')
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                               WHERE d.objid = c.oid AND d.deptype = 'e')
  LOOP EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', r.relname); END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
             JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.prokind = 'f'
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                               WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', r.sig); END LOOP;
END $$;`;

const client = new pg.Client(url);
await client.connect();
console.log('Dropping existing objects…');
await client.query(DROP);
console.log('Applying schema…');
await client.query(fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8'));
const { rows } = await client.query(
  `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`);
console.log(`Migrated. ${rows[0].n} tables.`);
await client.end();
