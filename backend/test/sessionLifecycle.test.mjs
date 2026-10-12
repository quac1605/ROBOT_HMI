import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLifecycle, AUTH_LIFETIME_MS,
  ANONYMOUS_CSRF_LIFETIME_MS, MAX_REVOCATIONS } from '../src/auth/sessionLifecycle.js';

function request(sid) {
  return {
    sessionID: sid,
    session: { cookie: { maxAge: 0 } },
    get: () => undefined,
    isAuthenticated: () => false,
  };
}

test('CSRF anonymous hết hạn ở đúng ranh giới 15 phút; token cũ không được dùng', () => {
  let now = 1000;
  const life = createSessionLifecycle({ now: () => now });
  const req = request('sid-anon');
  const first = life.issueCsrf(req);
  assert.equal(life.issueCsrf(req), first, 'GET lặp lại không làm token tab khác mất hiệu lực');
  assert.equal(req.session.cookie.maxAge, ANONYMOUS_CSRF_LIFETIME_MS);
  now += ANONYMOUS_CSRF_LIFETIME_MS;
  assert.throws(() => life.assertLoginAttemptCurrent(req, req.sessionID), /CSRF_EXPIRED/);
  assert.notEqual(life.issueCsrf(req), first);
});

test('auth absolute lifetime không bị touch kéo dài; restart epoch cũ bị từ chối', () => {
  let now = 1000;
  const life = createSessionLifecycle({ now: () => now });
  const req = request('sid-auth');
  const revoked = [];
  life.onRevoke((sid, reason) => revoked.push({ sid, reason }));
  life.initializeAuthenticatedSession(req);
  now += AUTH_LIFETIME_MS - 1;
  life.assertRequestSessionCurrent(req);
  assert.equal(req.session.cookie.maxAge, 1);
  now += 1;
  assert.throws(() => life.assertRequestSessionCurrent(req), /SESSION_EXPIRED/);
  assert.deepEqual(revoked, [{ sid: 'sid-auth', reason: 'SESSION_EXPIRED' }]);
  assert.throws(() => life.assertRequestSessionCurrent(req), /SESSION_REVOKED/);
  assert.equal(revoked.length, 1, 'Expiry không được revoke trùng');
  assert.throws(() => createSessionLifecycle({ now: () => 1000 }).assertRequestSessionCurrent(req),
    /SESSION_EXPIRED/);
});

test('invalidate fence trước callback và idempotent; pending login cùng SID bị chặn', () => {
  const life = createSessionLifecycle();
  const req = request('sid-race');
  life.issueCsrf(req);
  let calls = 0;
  life.onRevoke(sid => {
    calls += 1;
    assert.equal(sid, 'sid-race');
    assert.throws(() => life.assertLoginAttemptCurrent(req, 'sid-race'), /SESSION_REVOKED/);
  });
  life.invalidate('sid-race');
  life.invalidate('sid-race');
  assert.equal(calls, 1);
  assert.equal(life.revocationCount, 1);
});

test('đầy tombstones sẽ lockdown, không evict SID cũ rồi cho request đi qua', () => {
  const life = createSessionLifecycle();
  let globalRevokes = 0;
  life.onRevoke(sid => { if (sid === null) globalRevokes += 1; });
  for (let i = 0; i < MAX_REVOCATIONS; i += 1) life.invalidate(`sid-${i}`);
  assert.equal(life.revocationCount, MAX_REVOCATIONS);
  assert.throws(() => life.invalidate('overflow'), /AUTH_UNAVAILABLE/);
  assert.equal(globalRevokes, 1);
  assert.equal(life.isLockedDown, true);
  assert.throws(() => life.assertRequestSessionCurrent(request('unrevoked')), /AUTH_UNAVAILABLE/);
});
