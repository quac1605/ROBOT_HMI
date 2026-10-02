import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db/migrations.js';
import { loadMigrations } from '../src/db/migrationFiles.js';
import { assertTestTarget } from './assert-test-target.mjs';

// Chạy bằng hành động operator riêng; server startup chỉ VERIFY checksum.
// Không import script này từ app/server hay từ unit test.
async function main() {
  if (process.env.MIGRATE_DATABASE !== 'true') throw new Error('MIGRATION_FLAG_REQUIRED');
  const config = loadConfig(process.env);
  if (config.NODE_ENV === 'test') await assertTestTarget(process.env);
  const migrations = await loadMigrations();
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
  try {
    await migrate(pool, migrations);
    console.log('MIGRATION_CHECKED_OR_APPLIED');
  } finally { await pool.end(); }
}

main().catch(() => {
  // Driver/config messages can contain credentials; keep output generic.
  console.error('MIGRATION_FAILED: verify explicit flag, DB target and SQL locally');
  process.exitCode = 1;
});
