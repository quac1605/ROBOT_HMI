import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createUsersRepository } from '../src/auth/usersRepository.js';
import { assertTestTarget } from './assert-test-target.mjs';

// Chạy thủ công với env riêng; không tự seed lúc server khởi động.
// Không in password, session secret hoặc DATABASE_URL ra stdout/stderr.
async function main() {
  if (process.env.PROVISION_ADMIN !== 'true') {
    throw new Error('PROVISION_ADMIN_FLAG_REQUIRED');
  }
  const config = loadConfig(process.env);
  if (config.NODE_ENV === 'test') await assertTestTarget(process.env);
  const username = process.env.PROVISION_ADMIN_USERNAME;
  const password = process.env.PROVISION_ADMIN_PASSWORD;
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5000 });
  try {
    const users = await createUsersRepository(pool);
    const result = await users.ensureAdminUser({ username, password });
    console.log(result.created ? 'ADMIN_CREATED' : 'ADMIN_ALREADY_EXISTS_UNCHANGED');
  } finally { await pool.end(); }
}

main().catch(() => {
  console.error('ADMIN_PROVISION_FAILED: verify explicit flag, input and DB migration locally');
  process.exitCode = 1;
});
