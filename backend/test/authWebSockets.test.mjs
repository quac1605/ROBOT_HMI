import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import pg from 'pg';
import WebSocket from 'ws';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { migrate } from '../src/db/migrations.js';
import { loadMigrations } from '../src/db/migrationFiles.js';
import { createServerRuntime } from '../src/server.js';

function cookie(response) {
  const value = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(value);
  return value;
}

function sid(pair) {
  return decodeURIComponent(pair.slice(pair.indexOf('=') + 1)).slice(2).split('.')[0];
}

function connect(url, headers) {
  const ws = new WebSocket(url, { headers, handshakeTimeout: 3000 });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      reject(new Error(`UPGRADE_${response.statusCode}`));
    });
  });
}

function waitClose(ws, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WEBSOCKET_CLOSE_TIMEOUT')), timeoutMs);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

test('M5 WS thật: Origin/cookie guard, logout đóng cả kênh, disable tự revoke', async () => {
  await assertTestTarget(process.env);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const username = `ws_${randomUUID().replaceAll('-', '')}`;
  const password = 'test-only-socket-password';
  const cookies = new Set();
  let userId;
  let runtime;
  const sockets = new Set();
  try {
    await migrate(pool, await loadMigrations());
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await pool.query(
      'INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id',
      [username, hash]);
    userId = inserted.rows[0].id;
    runtime = createServerRuntime(process.env);
    const started = await runtime.start({ port: 0 });
    const port = started.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const wsBase = `ws://127.0.0.1:${port}`;

    async function login() {
      const bootstrap = await fetch(`${base}/api/auth/csrf`);
      const anonymous = cookie(bootstrap);
      cookies.add(anonymous);
      const csrf = (await bootstrap.json()).csrfToken;
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST', headers: { Origin: process.env.APP_ORIGIN, Cookie: anonymous,
          'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      const authenticated = cookie(response);
      cookies.add(authenticated);
      return { authenticated, csrf: response.headers.get('x-csrf-token') };
    }

    const first = await login();
    await assert.rejects(() => connect(`${wsBase}/ws`, {
      Origin: 'http://evil.invalid', Cookie: first.authenticated,
    }), /UPGRADE_403/);
    await assert.rejects(() => connect(`${wsBase}/ws`, {
      Origin: process.env.APP_ORIGIN, Cookie: 'connect.sid=s:forged.signature',
    }), /UPGRADE_401/);
    const appSocket = await connect(`${wsBase}/ws`,
      { Origin: process.env.APP_ORIGIN, Cookie: first.authenticated });
    const mapSocket = await connect(`${wsBase}/map-stream`,
      { Origin: process.env.APP_ORIGIN, Cookie: first.authenticated });
    sockets.add(appSocket); sockets.add(mapSocket);
    assert.equal(started.authWebSockets.activeCount, 2);
    const bothClosed = Promise.all([waitClose(appSocket), waitClose(mapSocket)]);
    const logout = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { Origin: process.env.APP_ORIGIN,
        Cookie: first.authenticated, 'X-CSRF-Token': first.csrf },
    });
    assert.equal(logout.status, 204);
    await bothClosed;
    assert.equal(started.authWebSockets.activeCount, 0);
    await assert.rejects(() => connect(`${wsBase}/ws`, {
      Origin: process.env.APP_ORIGIN, Cookie: first.authenticated,
    }), /UPGRADE_401/);

    const second = await login();
    const disabledSocket = await connect(`${wsBase}/ws`,
      { Origin: process.env.APP_ORIGIN, Cookie: second.authenticated });
    const disabledMapSocket = await connect(`${wsBase}/map-stream`,
      { Origin: process.env.APP_ORIGIN, Cookie: second.authenticated });
    sockets.add(disabledSocket); sockets.add(disabledMapSocket);
    const disabledClosed = Promise.all([waitClose(disabledSocket),
      waitClose(disabledMapSocket)]);
    await pool.query('UPDATE users SET enabled=false WHERE id=$1', [userId]);
    await disabledClosed; // periodic DB proof revokes within the 1.5 s policy budget.
    assert.equal(started.authWebSockets.activeCount, 0);
    await assert.rejects(() => connect(`${wsBase}/ws`, {
      Origin: process.env.APP_ORIGIN, Cookie: second.authenticated,
    }), /UPGRADE_401/);

    // Hold the session-store read while an upgrade is pending. Revocation must
    // win even if the old DB response arrives afterward.
    await pool.query('UPDATE users SET enabled=true WHERE id=$1', [userId]);
    const third = await login();
    const store = started.app.locals.sessionStore;
    const originalGet = store.get.bind(store);
    let releaseRead;
    let signalRead;
    const readStarted = new Promise(resolve => { signalRead = resolve; });
    store.get = (requestedSid, callback) => {
      if (requestedSid === sid(third.authenticated) && !releaseRead) {
        releaseRead = () => originalGet(requestedSid, callback);
        signalRead();
        return;
      }
      originalGet(requestedSid, callback);
    };
    try {
      const pendingUpgrade = connect(`${wsBase}/ws`,
        { Origin: process.env.APP_ORIGIN, Cookie: third.authenticated });
      await readStarted;
      started.lifecycle.invalidate(sid(third.authenticated), 'TEST_PENDING_REVOKE');
      releaseRead();
      await assert.rejects(pendingUpgrade);
      assert.equal(started.authWebSockets.activeCount, 0,
        'Upgrade đến muộn không được đăng ký socket');
    } finally { store.get = originalGet; }

    const fourth = await login();
    const dbSocket = await connect(`${wsBase}/ws`,
      { Origin: process.env.APP_ORIGIN, Cookie: fourth.authenticated });
    sockets.add(dbSocket);
    const dbClosed = waitClose(dbSocket);
    store.get = (requestedSid, callback) => {
      if (requestedSid === sid(fourth.authenticated)) {
        callback(new Error('private database driver detail'));
      } else originalGet(requestedSid, callback);
    };
    try {
      await dbClosed;
      assert.equal(started.authWebSockets.activeCount, 0);
      assert.throws(() => started.lifecycle.assertSidCurrent(sid(fourth.authenticated)),
        /SESSION_REVOKED/);
    } finally { store.get = originalGet; }
  } finally {
    for (const ws of sockets) ws.terminate();
    if (runtime) await runtime.stop();
    for (const pair of cookies) await pool.query('DELETE FROM session WHERE sid=$1', [sid(pair)]);
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await pool.end();
  }
});
