import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLifecycle } from '../src/auth/sessionLifecycle.js';
import { createSessionRevalidator, SOCKET_REVALIDATION_INTERVAL_MS,
  SOCKET_PROOF_TTL_MS, SOCKET_QUERY_DEADLINE_MS } from '../src/auth/sessionRevalidator.js';

function fixture() {
  let now = 1000;
  const sid = 'test-socket-session';
  const userId = 'user-01';
  const lifecycle = createSessionLifecycle({ now: () => now });
  const request = { sessionID: sid, session: { cookie: { maxAge: 0 },
    passport: { user: userId } } };
  lifecycle.initializeAuthenticatedSession(request);
  let enabled = true;
  const sessionStore = { get: (_sid, callback) => callback(null, structuredClone(request.session)) };
  const users = { findEnabledById: async id => enabled ? { id } : null };
  let tick;
  const revalidator = createSessionRevalidator({ sessionStore, users, lifecycle,
    now: () => now, setIntervalFn: fn => { tick = fn; return { unref() {} }; },
    clearIntervalFn: () => { tick = undefined; } });
  return { sid, lifecycle, sessionStore, users, revalidator,
    setNow: value => { now = value; }, setEnabled: value => { enabled = value; },
    getTick: () => tick };
}

test('M5 socket proof policy có interval/TTL/deadline cố định', () => {
  assert.equal(SOCKET_REVALIDATION_INTERVAL_MS, 1000);
  assert.equal(SOCKET_PROOF_TTL_MS, 1500);
  assert.equal(SOCKET_QUERY_DEADLINE_MS, 500);
});

test('M5 proof: logout đóng watcher đồng bộ; session khác không bị ảnh hưởng', async () => {
  const f = fixture();
  const closed = [];
  const watcher = await f.revalidator.watch({ sid: f.sid,
    onInvalidated: reason => closed.push(reason) });
  watcher.assertFresh();
  f.lifecycle.invalidate('unrelated-session', 'LOGOUT');
  assert.deepEqual(closed, []);
  f.lifecycle.invalidate(f.sid, 'LOGOUT');
  assert.deepEqual(closed, ['LOGOUT']);
  assert.equal(f.getTick(), undefined);
  assert.throws(() => watcher.assertFresh(), /SESSION_REVOKED/);
  watcher.dispose();
});

test('M5 proof: user disabled và proof quá TTL đều revoke; không gia hạn bằng ping', async () => {
  const disabled = fixture();
  const reasons = [];
  await disabled.revalidator.watch({ sid: disabled.sid,
    onInvalidated: reason => reasons.push(reason) });
  disabled.setEnabled(false);
  disabled.setNow(2000);
  await disabled.getTick()();
  assert.deepEqual(reasons, ['USER_DISABLED_OR_MISSING']);

  const expired = fixture();
  const expiryReasons = [];
  const watcher = await expired.revalidator.watch({ sid: expired.sid,
    onInvalidated: reason => expiryReasons.push(reason) });
  expired.setNow(2499);
  watcher.assertFresh();
  expired.setNow(2500);
  assert.throws(() => watcher.assertFresh(), /AUTH_PROOF_EXPIRED/);
  assert.deepEqual(expiryReasons, ['AUTH_PROOF_EXPIRED']);
});

test('M5 proof: late DB response sau revoke và query timeout không mở lại SID', async () => {
  const late = fixture();
  let complete;
  late.sessionStore.get = (_sid, callback) => { complete = callback; };
  const pending = late.revalidator.verify(late.sid);
  await Promise.resolve();
  late.lifecycle.invalidate(late.sid, 'LOGOUT');
  complete(null, { passport: { user: 'user-01' },
    authBootEpoch: late.lifecycle.authBootEpoch,
    issuedAt: 1000, absoluteExpiresAt: 1000 + 8 * 60 * 60 * 1000 });
  await assert.rejects(pending, /SESSION_REVOKED/);

  const unavailable = fixture();
  unavailable.sessionStore.get = () => {};
  const shortDeadline = createSessionRevalidator({ sessionStore: unavailable.sessionStore,
    users: unavailable.users, lifecycle: unavailable.lifecycle, queryDeadlineMs: 10 });
  await assert.rejects(() => shortDeadline.verify(unavailable.sid),
    /AUTH_PROOF_TIMEOUT/);
  assert.throws(() => unavailable.lifecycle.assertSidCurrent(unavailable.sid),
    /SESSION_REVOKED/);
});
