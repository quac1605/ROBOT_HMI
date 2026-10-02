/**
 * backend/scripts/assert-test-target.mjs
 * 
 * GUARD BẢO VỆ DATABASE VÀ DỮ LIỆU TEST (M4 / E3).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

function requireCondition(value, code) {
  if (!value) throw new Error(code);
}

export async function assertTestTarget(env = process.env) {
  requireCondition(env.NODE_ENV === 'test', 'TEST_NODE_ENV_REQUIRED');
  requireCondition(env.ROBOT_ADAPTER === 'mock', 'TEST_MOCK_ONLY');

  let url;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('TEST_DATABASE_URL_INVALID');
  }

  requireCondition(['postgres:', 'postgresql:'].includes(url.protocol), 'TEST_DB_PROTOCOL');
  requireCondition(url.hostname === '127.0.0.1' && (url.port || '5432') === '5432', 'TEST_DB_LOCAL_ONLY');
  requireCondition(!url.search && !url.hash, 'TEST_DB_NO_URL_OVERRIDES');
  requireCondition(decodeURIComponent(url.username) === 'robot_hmi_test', 'TEST_DB_ROLE');
  requireCondition(url.pathname === '/robot_hmi_test', 'TEST_DB_NAME');
  requireCondition(Boolean(url.password), 'TEST_DB_PASSWORD_REQUIRED');
  requireCondition(typeof env.DATA_DIR === 'string' && path.isAbsolute(env.DATA_DIR), 'TEST_DATA_ABSOLUTE');

  const expected = path.join(os.homedir(), '.local/share/robot-hmi/test');
  const actual = fs.realpathSync(env.DATA_DIR);
  requireCondition(actual === expected && fs.lstatSync(expected).isDirectory(), 'TEST_DATA_DIR');

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  pool.on('error', () => {}); // Tránh log credential nếu pool lỗi

  try {
    const { rows } = await pool.query(
      'SELECT current_database() AS db, current_user AS role, rolsuper, rolcreatedb, rolcreaterole ' +
      'FROM pg_roles WHERE rolname = current_user'
    );
    requireCondition(rows.length === 1, 'TEST_DB_IDENTITY_MISSING');
    const row = rows[0];
    requireCondition(row.db === 'robot_hmi_test' && row.role === 'robot_hmi_test', 'TEST_DB_IDENTITY');
    requireCondition(!row.rolsuper && !row.rolcreatedb && !row.rolcreaterole, 'TEST_DB_EXCESS_PRIVILEGES');

    return {
      database: row.db,
      role: row.role,
      dataDirectory: actual,
      destructiveActionPerformed: false,
    };
  } finally {
    await pool.end();
  }
}

// Chạy trực tiếp từ CLI để kiểm tra guard
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await assertTestTarget();
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // Driver errors may include connection details; never echo their message.
    console.error('TEST_TARGET_REJECTED: Vui lòng kiểm tra NODE_ENV=test, role/db robot_hmi_test và DATA_DIR test cục bộ.');
    process.exitCode = 1;
  }
}
