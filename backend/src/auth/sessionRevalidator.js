// M5 proof policy. M6 upgrade/binding code must call watch() before registering
// a socket and assertFresh() before sending a capability-bearing effect.
export const SOCKET_REVALIDATION_INTERVAL_MS = 1000;
export const SOCKET_PROOF_TTL_MS = 1500;
export const SOCKET_QUERY_DEADLINE_MS = 500;

function proofError(code) {
  return Object.assign(new Error(code), { code, status: 503 });
}

export function createSessionRevalidator({
  sessionStore, users, lifecycle, now = Date.now,
  intervalMs = SOCKET_REVALIDATION_INTERVAL_MS,
  proofTtlMs = SOCKET_PROOF_TTL_MS,
  queryDeadlineMs = SOCKET_QUERY_DEADLINE_MS,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  if (!sessionStore || !users || !lifecycle) {
    throw new Error('SESSION_REVALIDATOR_DEPENDENCIES_REQUIRED');
  }

  function deadline(task) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(proofError('AUTH_PROOF_TIMEOUT')),
        queryDeadlineMs);
      Promise.resolve().then(task).then(
        value => { clearTimeout(timer); resolve(value); },
        () => { clearTimeout(timer); reject(proofError('AUTH_PROOF_UNAVAILABLE')); });
    });
  }

  async function verify(sid) {
    lifecycle.assertSidCurrent(sid); // Capture fence before DB await.
    try {
      const stored = await deadline(() => new Promise((resolve, reject) =>
        sessionStore.get(sid, (error, session) => error ? reject(error) : resolve(session))));
      lifecycle.assertStoredSessionCurrent(sid, stored); // Recheck after await.
      const userId = stored?.passport?.user;
      if (typeof userId !== 'string' || !userId) {
        lifecycle.invalidate(sid, 'USER_DISABLED_OR_MISSING');
        throw proofError('AUTH_PROOF_INVALID');
      }
      const user = await deadline(() => users.findEnabledById(userId));
      lifecycle.assertStoredSessionCurrent(sid, stored); // A late DB result cannot reopen SID.
      if (!user || user.id !== userId) {
        lifecycle.invalidate(sid, 'USER_DISABLED_OR_MISSING');
        throw proofError('AUTH_PROOF_INVALID');
      }
      return { sid, userId, verifiedAt: now() };
    } catch (error) {
      if (error.code === 'AUTH_PROOF_TIMEOUT' ||
        error.code === 'AUTH_PROOF_UNAVAILABLE') {
        lifecycle.invalidate(sid, 'AUTH_PROOF_UNAVAILABLE');
      }
      throw error;
    }
  }

  async function watch({ sid, onInvalidated }) {
    if (typeof onInvalidated !== 'function') throw new Error('ON_INVALIDATED_REQUIRED');
    let closed = false;
    let timer;
    let inFlight = false;
    let lastVerifiedAt = -Infinity;
    let verifiedUserId;

    const unsubscribe = lifecycle.onRevoke((revokedSid, reason) => {
      if (revokedSid !== null && revokedSid !== sid) return;
      if (closed) return;
      closed = true;
      if (timer) clearIntervalFn(timer);
      try { onInvalidated(reason); } catch { /* Fence remains closed. */ }
    });

    try {
      const proof = await verify(sid);
      lifecycle.assertSidCurrent(sid);
      if (closed) throw proofError('AUTH_PROOF_INVALID');
      lastVerifiedAt = proof.verifiedAt;
      verifiedUserId = proof.userId; // Lưu userId an toàn
    } catch (error) {
      unsubscribe();
      throw error;
    }

    function assertFresh() {
      lifecycle.assertSidCurrent(sid);
      if (closed || now() - lastVerifiedAt >= proofTtlMs) {
        lifecycle.invalidate(sid, 'AUTH_PROOF_EXPIRED');
        throw proofError('AUTH_PROOF_EXPIRED');
      }
    }

    async function tick() {
      if (closed || inFlight) return;
      try {
        assertFresh();
        inFlight = true;
        const proof = await verify(sid);
        if (!closed) lastVerifiedAt = proof.verifiedAt;
      } catch {
        lifecycle.invalidate(sid, 'AUTH_PROOF_UNAVAILABLE');
      } finally { inFlight = false; }
    }

    timer = setIntervalFn(tick, intervalMs);
    timer?.unref?.();

    return {
      userId: verifiedUserId, // Cung cấp userId cho M6 registry
      assertFresh,
      dispose() {
        if (timer) clearIntervalFn(timer);
        unsubscribe();
        closed = true;
      },
    };
  }
  return { verify, watch };
}
