import { stableStringify } from './stableStringify.js';

export function createControlRequestRegistry({ maxEntries = 4096, onCapacity = () => {} } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('Invalid request registry capacity');
  const records = new Map();
  const error = code => Object.assign(new Error(code), { code });

  return {
    run({ sessionId, operation, requestId, payload, allowPending = false }, work) {
      try {
        const key = JSON.stringify([sessionId, requestId]);
        const fingerprint = stableStringify({ operation, payload });
        const existing = records.get(key);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw error('IDEMPOTENCY_CONFLICT');
          return existing.promise.then(value => structuredClone(value));
        }
        // Never evict a completed ID: replaying an old stop must not stop a new owner.
        // The service installs a fail-closed stop before rejecting overload.
        if (records.size >= maxEntries) {
          onCapacity();
          throw error('CONTROL_REQUEST_CAPACITY');
        }

        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        const record = { sessionId, fingerprint, promise };
        records.set(key, record); // Giữ chỗ TRƯỚC khi gọi work

        // Đính kèm catch để không phát sinh UnhandledPromiseRejection nếu work ném lỗi đồng bộ
        promise.catch(() => {});

        try {
          const value = work(); // Chạy đồng bộ, tuyệt đối không dùng await hay Promise.resolve().then()
          const complete = result => {
            if (records.get(key) !== record) throw error('OPERATION_SUPERSEDED');
            resolve(structuredClone(result));
          };
          if (value && typeof value.then === 'function') {
            // Only the stop service's synchronous FIFO may defer completion.
            // The stop fence is installed during work(), never in a .then().
            if (!allowPending) {
              Promise.resolve(value).catch(() => {});
              throw error('ASYNC_CONTROL_WORK_FORBIDDEN');
            }
            Promise.resolve(value).then(complete).catch(reject);
          } else {
            complete(value);
          }
        } catch (cause) {
          reject(cause);
        }

        return promise.then(value => structuredClone(value));
      } catch (cause) {
        return Promise.reject(cause);
      }
    },
    clearSession(sessionId) {
      for (const [key, record] of records) {
        if (record.sessionId === sessionId) records.delete(key);
      }
    },
    clear() {
      records.clear();
    },
    get size() {
      return records.size;
    },
  };
}
