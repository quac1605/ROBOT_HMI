import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import pg from 'pg';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { createUsersRepository } from '../src/auth/usersRepository.js';
import { createPassportInstance } from '../src/auth/passport.js';
import { createSessionLifecycle, ANONYMOUS_CSRF_LIFETIME_MS } from '../src/auth/sessionLifecycle.js';
import { createSessionRevalidator } from '../src/auth/sessionRevalidator.js';

const { Pool } = pg;
const ORIGIN = 'http://127.0.0.1:4173';
const SECRET = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

function cookie(response) {
  const pair = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(pair, 'Response phải phát session cookie');
  return pair;
}

function sidFromCookie(pair) {
  const value = decodeURIComponent(pair.slice(pair.indexOf('=') + 1));
  return value.slice(2).split('.')[0]; // express-session signed cookie: s:<sid>.<sig>
}

function makeApp(pool, users, lifecycle) {
  const passport = createPassportInstance({ users, dummyHash: users.dummyHash });
  return createApp({
    config: { NODE_ENV: 'test', APP_ORIGIN: ORIGIN, SESSION_SECRET: SECRET,
      TRUST_LOOPBACK_PROXY: 'false' },
    logger: createLogger({ nodeEnv: 'test' }),
    readinessState: { isReady: () => false },
    pool, passport, lifecycle,
  });
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('M5 HTTP thật: strict credentials, CSRF/Origin, rotation, disable, logout', async () => {
  await assertTestTarget(process.env); // Trước mọi DB mutation.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const username = `m5_${randomUUID().replaceAll('-', '')}`;
  const password = 'test-only-password-123';
  const cookies = new Set();
  let userId;
  let server;
  let sessionStore;
  try {
    const users = await createUsersRepository(pool);
    assert.deepEqual(await users.ensureAdminUser({ username, password }), { created: true });
    const inserted = await pool.query('SELECT id, password_hash FROM users WHERE username=$1', [username]);
    userId = inserted.rows[0].id;
    const originalHash = inserted.rows[0].password_hash;
    assert.deepEqual(await users.ensureAdminUser({ username, password: 'another-test-only-password' }),
      { created: false });
    assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1',
      [userId])).rows[0].password_hash, originalHash,
    'Provision duplicate không reset mật khẩu hiện có');
    const lifecycle = createSessionLifecycle();
    const revoked = [];
    lifecycle.onRevoke((sid, reason) => revoked.push({ sid, reason }));
    const app = makeApp(pool, users, lifecycle);
    sessionStore = app.locals.sessionStore;
    const endpoint = await listen(app);
    server = endpoint.server;
    const base = endpoint.url;
    const login = (sessionCookie, csrf, payload, origin = ORIGIN) => fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin,
        'X-CSRF-Token': csrf, Cookie: sessionCookie }, body: JSON.stringify(payload),
    });

    const bootstrap = await fetch(`${base}/api/auth/csrf`);
    assert.equal(bootstrap.status, 200);
    const anonymousCookie = cookie(bootstrap);
    cookies.add(anonymousCookie);
    const { csrfToken } = await bootstrap.json();
    assert.match(csrfToken, /^[a-f0-9]{64}$/);
    const repeat = await fetch(`${base}/api/auth/csrf`, { headers: { Cookie: anonymousCookie } });
    assert.equal((await repeat.json()).csrfToken, csrfToken, 'GET lặp không làm mất token tab khác');

    assert.equal((await login(anonymousCookie, csrfToken, { username, password },
      'http://evil.invalid')).status, 403);
    assert.equal((await login(anonymousCookie, 'f'.repeat(64), { username, password })).status, 403);
    assert.equal((await login(anonymousCookie, csrfToken,
      { username, password, unexpected: true })).status, 400);
    assert.equal((await login(anonymousCookie, csrfToken,
      { username, password: 'x'.repeat(1025) })).status, 400);
    assert.equal((await login(anonymousCookie, csrfToken,
      { username, password: 'wrong' })).status, 401);

    const first = await login(anonymousCookie, csrfToken, { username, password });
    assert.equal(first.status, 200);
    const firstCookie = cookie(first);
    cookies.add(firstCookie);
    assert.notEqual(firstCookie, anonymousCookie);
    let authCsrf = first.headers.get('x-csrf-token');
    assert.match(authCsrf, /^[a-f0-9]{64}$/);
    assert.equal((await fetch(`${base}/api/auth/session`,
      { headers: { Cookie: anonymousCookie } })).status, 401);

    const second = await login(firstCookie, authCsrf, { username, password });
    assert.equal(second.status, 200, 'login cùng user cũng phải rotate SID');
    const secondCookie = cookie(second);
    cookies.add(secondCookie);
    assert.notEqual(secondCookie, firstCookie);
    authCsrf = second.headers.get('x-csrf-token');
    assert.equal((await fetch(`${base}/api/auth/session`,
      { headers: { Cookie: firstCookie } })).status, 401);
    const current = await fetch(`${base}/api/auth/session`,
      { headers: { Cookie: secondCookie } });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).user.id, userId);

    const logout = (origin, csrf = authCsrf) => fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { Origin: origin, Cookie: secondCookie, 'X-CSRF-Token': csrf },
    });
    assert.equal((await logout('http://evil.invalid')).status, 403);
    assert.equal((await logout(ORIGIN, 'f'.repeat(64))).status, 403);
    assert.equal((await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: anonymousCookie,
        'X-CSRF-Token': csrfToken },
    })).status, 401);

    const socketInvalidations = [];
    const socketProof = createSessionRevalidator({ sessionStore, users, lifecycle });
    const watcher = await socketProof.watch({ sid: sidFromCookie(secondCookie),
      onInvalidated: reason => socketInvalidations.push(reason) });
    assert.equal((await logout(ORIGIN)).status, 204);
    assert.deepEqual(socketInvalidations, ['LOGOUT'],
      'HTTP logout phải thu hồi watcher cùng SID trước khi trả 204');
    watcher.dispose();
    assert.equal((await fetch(`${base}/api/auth/session`,
      { headers: { Cookie: secondCookie } })).status, 401);

    // Passport xóa user khỏi session khi deserialize trả false; kiểm bằng phiên mới.
    const nextBootstrap = await fetch(`${base}/api/auth/csrf`);
    const nextAnon = cookie(nextBootstrap);
    cookies.add(nextAnon);
    const nextCsrf = (await nextBootstrap.json()).csrfToken;
    const third = await login(nextAnon, nextCsrf, { username, password });
    assert.equal(third.status, 200);
    const thirdCookie = cookie(third);
    cookies.add(thirdCookie);
    await pool.query('UPDATE users SET enabled=false WHERE id=$1', [userId]);
    assert.equal((await fetch(`${base}/api/auth/session`,
      { headers: { Cookie: thirdCookie } })).status, 401,
    'Disabled user không còn được đọc session');
    assert.ok(revoked.some(event => event.sid === sidFromCookie(thirdCookie) &&
      event.reason === 'USER_DISABLED_OR_MISSING'),
    'Disabled user phải phát revoke cho authority/socket cùng SID');
    const disabledBootstrap = await fetch(`${base}/api/auth/csrf`,
      { headers: { Cookie: thirdCookie } });
    assert.equal(disabledBootstrap.status, 200);
    const freshAnonymousCookie = cookie(disabledBootstrap);
    cookies.add(freshAnonymousCookie);
    assert.notEqual(freshAnonymousCookie, thirdCookie);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (sessionStore) await sessionStore.close();
    // Chỉ dọn bản ghi test đã tạo, không truncate DB/session của người khác.
    for (const pair of cookies) {
      await pool.query('DELETE FROM session WHERE sid=$1', [sidFromCookie(pair)]);
    }
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await pool.end();
  }
});

test('pending credential lookup không được login sau khi SID bị revoke', async () => {
  await assertTestTarget(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const hash = await argon2.hash('test-only-race-password', { type: argon2.argon2id });
  let resumeLookup;
  let markLookupStarted;
  const lookupStarted = new Promise(resolve => { markLookupStarted = resolve; });
  const users = {
    dummyHash: hash,
    findByUsername: async () => {
      markLookupStarted();
      await new Promise(resolve => { resumeLookup = resolve; });
      return { id: randomUUID(), username: 'race-user', passwordHash: hash, enabled: true };
    },
    findEnabledById: async () => null,
  };
  const lifecycle = createSessionLifecycle();
  const app = makeApp(pool, users, lifecycle);
  const { server, url } = await listen(app);
  let anonymousCookie;
  try {
    const csrf = await fetch(`${url}/api/auth/csrf`);
    anonymousCookie = cookie(csrf);
    const token = (await csrf.json()).csrfToken;
    const pending = fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: anonymousCookie,
        'X-CSRF-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'race-user', password: 'test-only-race-password' }),
    });
    await lookupStarted;
    lifecycle.invalidate(sidFromCookie(anonymousCookie), 'LOGOUT');
    resumeLookup();
    const result = await pending;
    assert.equal(result.status, 401);
    assert.equal((await result.json()).error.code, 'SESSION_REVOKED');
    assert.equal(result.headers.get('set-cookie'), null, 'Không phát auth cookie mới');
  } finally {
    if (resumeLookup) resumeLookup();
    await new Promise(resolve => server.close(resolve));
    await app.locals.sessionStore.close();
    if (anonymousCookie) await pool.query('DELETE FROM session WHERE sid=$1',
      [sidFromCookie(anonymousCookie)]);
    await pool.end();
  }
});

test('HTTP logout thắng same-user login đang chờ DB lookup', async () => {
  await assertTestTarget(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const password = 'test-only-concurrent-password';
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const user = { id: randomUUID(), username: 'concurrent-user', passwordHash: hash, enabled: true };
  let lookups = 0;
  let resumeLookup;
  let markLookupStarted;
  const lookupStarted = new Promise(resolve => { markLookupStarted = resolve; });
  const users = {
    dummyHash: hash,
    findByUsername: async () => {
      lookups += 1;
      if (lookups === 2) {
        markLookupStarted();
        await new Promise(resolve => { resumeLookup = resolve; });
      }
      return user;
    },
    findEnabledById: async () => ({ id: user.id, username: user.username }),
  };
  const lifecycle = createSessionLifecycle();
  const app = makeApp(pool, users, lifecycle);
  const { server, url } = await listen(app);
  const cookies = new Set();
  try {
    const bootstrap = await fetch(`${url}/api/auth/csrf`);
    const anon = cookie(bootstrap);
    cookies.add(anon);
    const token = (await bootstrap.json()).csrfToken;
    const login = (pair, csrf) => fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: pair,
        'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password }),
    });
    const first = await login(anon, token);
    assert.equal(first.status, 200);
    const authenticated = cookie(first);
    cookies.add(authenticated);
    const authCsrf = first.headers.get('x-csrf-token');
    const pendingLogin = login(authenticated, authCsrf);
    await lookupStarted;
    const logout = await fetch(`${url}/api/auth/logout`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: authenticated,
        'X-CSRF-Token': authCsrf },
    });
    assert.equal(logout.status, 204);
    resumeLookup();
    const late = await pendingLogin;
    assert.equal(late.status, 401);
    assert.equal((await late.json()).error.code, 'SESSION_REVOKED');
    assert.equal(late.headers.get('set-cookie'), null);
  } finally {
    if (resumeLookup) resumeLookup();
    await new Promise(resolve => server.close(resolve));
    await app.locals.sessionStore.close();
    for (const pair of cookies) await pool.query('DELETE FROM session WHERE sid=$1',
      [sidFromCookie(pair)]);
    await pool.end();
  }
});

test('logout chỉ revoke SID của mình; destroy lỗi vẫn giữ fence và trả 503', async () => {
  await assertTestTarget(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const password = 'test-only-session-isolation';
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  const user = { id: randomUUID(), username: 'isolation-user', passwordHash: hash, enabled: true };
  const users = {
    dummyHash: hash,
    findByUsername: async () => user,
    findEnabledById: async () => ({ id: user.id, username: user.username }),
  };
  const lifecycle = createSessionLifecycle();
  const revoked = [];
  lifecycle.onRevoke((sid, reason) => revoked.push({ sid, reason }));
  const app = makeApp(pool, users, lifecycle);
  const store = app.locals.sessionStore;
  const originalDestroy = store.destroy.bind(store);
  const { server, url } = await listen(app);
  const cookies = new Set();
  async function login() {
    const bootstrap = await fetch(`${url}/api/auth/csrf`);
    const anonymous = cookie(bootstrap);
    cookies.add(anonymous);
    const csrf = (await bootstrap.json()).csrfToken;
    const response = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: anonymous,
        'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user.username, password }),
    });
    assert.equal(response.status, 200);
    const authenticated = cookie(response);
    cookies.add(authenticated);
    return { authenticated, csrf: response.headers.get('x-csrf-token') };
  }
  try {
    const first = await login();
    const second = await login();
    const logout = ({ authenticated, csrf }) => fetch(`${url}/api/auth/logout`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: authenticated,
        'X-CSRF-Token': csrf },
    });
    assert.equal((await logout(second)).status, 204);
    assert.ok(revoked.some(event => event.sid === sidFromCookie(second.authenticated)));
    assert.equal((await fetch(`${url}/api/auth/session`,
      { headers: { Cookie: first.authenticated } })).status, 200,
    'Logout phiên thứ hai không được revoke phiên thứ nhất');

    store.destroy = (_sid, callback) => callback(new Error('private destroy failure'));
    const failed = await logout(first);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error.code, 'AUTH_UNAVAILABLE');
    assert.ok(revoked.some(event => event.sid === sidFromCookie(first.authenticated)),
      'Fence phải được đóng trước khi destroy lỗi');
  } finally {
    store.destroy = originalDestroy;
    await new Promise(resolve => server.close(resolve));
    await store.close();
    for (const pair of cookies) await pool.query('DELETE FROM session WHERE sid=$1',
      [sidFromCookie(pair)]);
    await pool.end();
  }
});

test('PostgreSQL session store lỗi phải trả 503, không giả 401 và không lộ lỗi driver', async () => {
  await assertTestTarget(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const users = await createUsersRepository(pool);
  const lifecycle = createSessionLifecycle();
  let revokeAll = 0;
  lifecycle.onRevoke(sid => { if (sid === null) revokeAll += 1; });
  const app = makeApp(pool, users, lifecycle);
  const { server, url } = await listen(app);
  try {
    await pool.end(); // Chỉ đóng pool riêng của test này; không dừng PostgreSQL thật.
    const result = await fetch(`${url}/api/auth/csrf`);
    assert.equal(result.status, 503);
    const body = await result.json();
    assert.equal(body.error.code, 'AUTH_UNAVAILABLE');
    assert.ok(!JSON.stringify(body).includes('pool'), 'Không lộ lỗi driver');
    assert.equal(lifecycle.isLockedDown, true);
    assert.equal(revokeAll, 1, 'DB failure phải báo authority thu hồi tất cả SID');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await app.locals.sessionStore.close();
    if (!pool.ending) await pool.end();
  }
});

test('login rate limit trả 429 trước Argon2; cookie secure sau loopback proxy', async () => {
  await assertTestTarget(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const users = await createUsersRepository(pool);
  const lifecycle = createSessionLifecycle();
  const passport = createPassportInstance({ users, dummyHash: users.dummyHash });
  const app = createApp({
    config: { NODE_ENV: 'production', APP_ORIGIN: 'https://hmi.example.invalid',
      SESSION_SECRET: SECRET, TRUST_LOOPBACK_PROXY: 'true' },
    logger: createLogger({ nodeEnv: 'test' }), readinessState: { isReady: () => false },
    pool, passport, lifecycle,
  });
  const { server, url } = await listen(app);
  let secureCookie;
  try {
    const bootstrap = await fetch(`${url}/api/auth/csrf`,
      { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(bootstrap.status, 200);
    assert.match(bootstrap.headers.get('set-cookie') || '', /; Secure/i);
    assert.match(bootstrap.headers.get('set-cookie') || '', /; HttpOnly/i);
    assert.match(bootstrap.headers.get('set-cookie') || '', /SameSite=Lax/i);
    secureCookie = cookie(bootstrap);
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const response = await fetch(`${url}/api/auth/login`, {
        method: 'POST', headers: { Origin: 'https://hmi.example.invalid',
          Cookie: secureCookie, 'X-Forwarded-Proto': 'https',
          'X-CSRF-Token': 'f'.repeat(64), 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, attempt <= 10 ? 403 : 429);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await app.locals.sessionStore.close();
    if (secureCookie) await pool.query('DELETE FROM session WHERE sid=$1',
      [sidFromCookie(secureCookie)]);
    await pool.end();
  }
});

test('HTTP anonymous CSRF hết hạn đúng ranh giới và bootstrap token mới', async () => {
  await assertTestTarget(process.env);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const users = await createUsersRepository(pool);
  let now = Date.now();
  const lifecycle = createSessionLifecycle({ now: () => now });
  const app = makeApp(pool, users, lifecycle);
  const { server, url } = await listen(app);
  let anonymousCookie;
  try {
    const first = await fetch(`${url}/api/auth/csrf`);
    anonymousCookie = cookie(first);
    const oldToken = (await first.json()).csrfToken;
    now += ANONYMOUS_CSRF_LIFETIME_MS;
    const expired = await fetch(`${url}/api/auth/login`, {
      method: 'POST', headers: { Origin: ORIGIN, Cookie: anonymousCookie,
        'X-CSRF-Token': oldToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'irrelevant' }),
    });
    assert.equal(expired.status, 403);
    assert.equal((await expired.json()).error.code, 'CSRF_EXPIRED');
    const renewed = await fetch(`${url}/api/auth/csrf`,
      { headers: { Cookie: anonymousCookie } });
    assert.equal(renewed.status, 200);
    assert.notEqual((await renewed.json()).csrfToken, oldToken);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await app.locals.sessionStore.close();
    if (anonymousCookie) await pool.query('DELETE FROM session WHERE sid=$1',
      [sidFromCookie(anonymousCookie)]);
    await pool.end();
  }
});
