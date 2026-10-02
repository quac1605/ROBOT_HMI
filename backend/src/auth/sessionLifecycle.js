import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const AUTH_LIFETIME_MS = 8 * 60 * 60 * 1000;
export const ANONYMOUS_CSRF_LIFETIME_MS = 15 * 60 * 1000;
export const REVOCATION_GRACE_MS = 5 * 60 * 1000;
export const MAX_REVOCATIONS = 10_000;

function authError(code, status = 401) {
  return Object.assign(new Error(code), { code, status });
}

export function createSessionLifecycle({ now = Date.now } = {}) {
  const authBootEpoch = randomUUID();
  const tombstones = new Map(); // SID -> thời điểm có thể bỏ tombstone.
  const onRevokeCallbacks = new Set();
  let lockedDown = false;
  let nextPruneAt = 0;

      function assertConnectionCurrent(record) {
        if (!record || record.closed) {
            const err = new Error('CONNECTION_CLOSED');
            err.status = 403;
            err.code = 'OWNER_BINDING_REJECTED';
            throw err;
        }
        if (tombstones.has(record.sessionId)) {
            const err = new Error('SESSION_REVOKED');
            err.status = 403;
            err.code = 'OWNER_BINDING_REJECTED';
            throw err;
        }
        if (record.authBootEpoch && record.authBootEpoch !== authBootEpoch) {
            const err = new Error('SESSION_EXPIRED_SERVER_RESTARTED');
            err.status = 403;
            err.code = 'OWNER_BINDING_REJECTED';
            throw err;
        }
    }


  function prune() {
    const current = now();
    if (current < nextPruneAt) return;
    nextPruneAt = current + 60_000;
    for (const [sid, expiresAt] of tombstones) {
      if (current >= expiresAt) tombstones.delete(sid);
    }
  }

  function notify(sid, reason) {
    for (const callback of onRevokeCallbacks) {
      try { callback(sid, reason); } catch { /* Fence đã đóng; callback lỗi không mở lại. */ }
    }
  }

  function onRevoke(callback) {
    onRevokeCallbacks.add(callback);
    return () => onRevokeCallbacks.delete(callback);
  }

  function invalidateAll(reason = 'AUTH_DEPENDENCY_UNAVAILABLE') {
    if (lockedDown) return;
    lockedDown = true;
    // SID null có nghĩa revoke mọi owner; authority M7 phải xử lý tín hiệu này.
    notify(null, reason);
  }

  function assertAvailable() {
    if (lockedDown) throw authError('AUTH_UNAVAILABLE', 503);
  }

  function invalidate(sid, reason = 'LOGOUT') {
    if (!sid || tombstones.has(sid)) return;
    prune();
    if (tombstones.size >= MAX_REVOCATIONS) {
      invalidateAll('REVOCATION_CAPACITY_EXHAUSTED');
      throw authError('AUTH_UNAVAILABLE', 503);
    }
    // Fence trước callback, socket close, DB destroy và mọi await.
    tombstones.set(sid, now() + AUTH_LIFETIME_MS + REVOCATION_GRACE_MS);
    notify(sid, reason);
  }

  function assertSidCurrent(sid) {
    assertAvailable();
    if (!sid || tombstones.has(sid)) throw authError('SESSION_REVOKED');
  }

  function initializeAuthenticatedSession(req) {
    assertSidCurrent(req.sessionID);
    const issuedAt = now();
    req.session.authBootEpoch = authBootEpoch;
    req.session.issuedAt = issuedAt;
    req.session.absoluteExpiresAt = issuedAt + AUTH_LIFETIME_MS;
    req.session.cookie.maxAge = AUTH_LIFETIME_MS;
  }

  function assertStoredSessionCurrent(sid, session) {
    assertSidCurrent(sid);
    if (!session || session.authBootEpoch !== authBootEpoch ||
        !Number.isSafeInteger(session.absoluteExpiresAt) ||
        !Number.isSafeInteger(session.issuedAt) ||
        session.absoluteExpiresAt !== session.issuedAt + AUTH_LIFETIME_MS ||
        now() >= session.absoluteExpiresAt) {
      // Quyền gắn với SID phải bị thu hồi ngay khi phát hiện phiên không còn hợp lệ.
      // Các callback authority/socket về sau sẽ nhận fence trước khi HTTP trả 401.
      invalidate(sid, 'SESSION_EXPIRED');
      throw authError('SESSION_EXPIRED');
    }
    return session.absoluteExpiresAt - now();
  }

  function assertRequestSessionCurrent(req) {
    const remaining = assertStoredSessionCurrent(req.sessionID, req.session);
    // express-session có thể touch cookie; không cấp TTL vượt absolute lifetime.
    req.session.cookie.maxAge = remaining;
  }

  function assertLoginAttemptCurrent(req, expectedSid) {
    assertSidCurrent(expectedSid);
    if (req.sessionID !== expectedSid) throw authError('SESSION_REVOKED');
    if (req.isAuthenticated?.()) {
      assertRequestSessionCurrent(req);
    } else if (req.session?.csrfBootEpoch !== authBootEpoch ||
               !Number.isSafeInteger(req.session.csrfIssuedAt) ||
               now() >= req.session.csrfIssuedAt + ANONYMOUS_CSRF_LIFETIME_MS) {
      throw authError('CSRF_EXPIRED', 403);
    }
  }

  function issueCsrf(req) {
    assertSidCurrent(req.sessionID);
    const authenticated = Boolean(req.isAuthenticated?.());
    if (authenticated) assertRequestSessionCurrent(req);
    const current = now();
    const valid = req.session.csrfBootEpoch === authBootEpoch &&
      typeof req.session.csrfToken === 'string' &&
      /^[a-f0-9]{64}$/.test(req.session.csrfToken) &&
      Number.isSafeInteger(req.session.csrfIssuedAt) &&
      (authenticated || current < req.session.csrfIssuedAt + ANONYMOUS_CSRF_LIFETIME_MS);
    if (!valid) {
      req.session.csrfToken = randomBytes(32).toString('hex');
      req.session.csrfIssuedAt = current;
      req.session.csrfBootEpoch = authBootEpoch;
    }
    if (!authenticated) req.session.cookie.maxAge = ANONYMOUS_CSRF_LIFETIME_MS;
    return req.session.csrfToken;
  }

  function requireCsrf(req, _res, next) {
    try {
      assertSidCurrent(req.sessionID);
      if (req.isAuthenticated?.()) assertRequestSessionCurrent(req);
      else assertLoginAttemptCurrent(req, req.sessionID);
      const supplied = req.get('x-csrf-token');
      const expected = req.session?.csrfToken;
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
          typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) ||
          !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))) {
        throw authError('CSRF_REJECTED', 403);
      }
      next();
    } catch (error) { next(error); }
  }

  function requireAuth(req, _res, next) {
    try {
      if (!req.isAuthenticated?.() || !req.user) throw authError('UNAUTHORIZED');
      assertRequestSessionCurrent(req);
      next();
    } catch (error) { next(error); }
  }

  return {
    authBootEpoch, assertConnectionCurrent, onRevoke, invalidate, invalidateAll, assertAvailable,
    assertSidCurrent, assertStoredSessionCurrent,
    assertRequestSessionCurrent, assertLoginAttemptCurrent,
    initializeAuthenticatedSession, issueCsrf, requireCsrf, requireAuth,
    get revocationCount() { prune(); return tombstones.size; },
    get isLockedDown() { return lockedDown; },
  };
}
