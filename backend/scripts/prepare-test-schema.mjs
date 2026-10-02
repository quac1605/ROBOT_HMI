import pg from 'pg';
import { assertTestTarget } from './assert-test-target.mjs';
import { loadMigrations } from '../src/db/migrationFiles.js';
import { migrate } from '../src/db/migrations.js';

try {
  await assertTestTarget(process.env);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
    max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000,
    statement_timeout: 5000 });
  try { await migrate(pool, await loadMigrations()); }
  finally { await pool.end(); }
  console.log('GUARDED_TEST_SCHEMA_READY');
} catch {
  console.error('GUARDED_TEST_SCHEMA_FAILED');
  process.exitCode = 1;
}
