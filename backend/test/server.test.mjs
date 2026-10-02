import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import pg from 'pg';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { migrate } from '../src/db/migrations.js';
import { loadMigrations } from '../src/db/migrationFiles.js';
import { createServerRuntime } from '../src/server.js';

const { Pool } = pg;

function cookie(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0];
}

function sid(pair) {
  return decodeURIComponent(pair.slice(pair.indexOf('=') + 1)).slice(2).split('.')[0];
}

test('server entrypoint thật gắn DB/auth; restart không tái dùng login cũ', async () => {
  await assertTestTarget(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const username = `entry_${randomUUID().replaceAll('-', '')}`;
  const password = 'test-only-entry-password';
  const cookiePairs = new Set();
  let userId;
  let first;
  let second;
  try {
    await migrate(pool, await loadMigrations());
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const row = await pool.query('INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id',
      [username, hash]);
    userId = row.rows[0].id;

    first = createServerRuntime(process.env);
    const started = await first.start({ port: 0 });
    const base = `http://127.0.0.1:${started.server.address().port}`;
    const live = await fetch(`${base}/api/health/live`);
    assert.equal(live.status, 200);
    const ready = await fetch(`${base}/api/health/ready`);
    assert.equal(ready.status, 503, 'M5 chưa có robot adapter/runtime, chưa được báo ready');
    const bootstrap = await fetch(`${base}/api/auth/csrf`);
    assert.equal(bootstrap.status, 200, 'Entrypoint thật phải lắp auth router');
    const anon = cookie(bootstrap);
    cookiePairs.add(anon);
    const { csrfToken } = await bootstrap.json();
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { Origin: process.env.APP_ORIGIN, Cookie: anon,
        'X-CSRF-Token': csrfToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(login.status, 200);
    const authenticated = cookie(login);
    cookiePairs.add(authenticated);
    assert.equal((await fetch(`${base}/api/auth/session`,
      { headers: { Cookie: authenticated } })).status, 200);
    assert.equal((await started.sessionRevalidator.verify(sid(authenticated))).userId,
      userId, 'Socket proof phải đọc session và enabled user thật từ PostgreSQL');
    await first.stop();
    first = null;

    second = createServerRuntime(process.env);
    const restarted = await second.start({ port: 0 });
    const nextBase = `http://127.0.0.1:${restarted.server.address().port}`;
    await assert.rejects(() => restarted.sessionRevalidator.verify(sid(authenticated)),
      /SESSION_EXPIRED/, 'Socket proof không chấp nhận authBootEpoch cũ');
    assert.equal((await fetch(`${nextBase}/api/auth/session`,
      { headers: { Cookie: authenticated } })).status, 401,
    'Session còn trong PostgreSQL nhưng authBootEpoch cũ phải bị từ chối');
    const freshCsrf = await fetch(`${nextBase}/api/auth/csrf`,
      { headers: { Cookie: authenticated } });
    assert.equal(freshCsrf.status, 200, 'Cookie cũ phải được bootstrap lại thành anonymous session');
    const freshCookie = cookie(freshCsrf);
    cookiePairs.add(freshCookie);
    assert.notEqual(freshCookie, authenticated);
    const freshToken = (await freshCsrf.json()).csrfToken;
    const relogin = await fetch(`${nextBase}/api/auth/login`, {
      method: 'POST', headers: { Origin: process.env.APP_ORIGIN, Cookie: freshCookie,
        'X-CSRF-Token': freshToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    assert.equal(relogin.status, 200, 'Người dùng phải đăng nhập lại được sau restart');
    cookiePairs.add(cookie(relogin));
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    for (const pair of cookiePairs) {
      if (pair) await pool.query('DELETE FROM session WHERE sid=$1', [sid(pair)]);
    }
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await pool.end();
  }
});
