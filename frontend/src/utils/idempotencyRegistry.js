import { stableStringify } from './stableStringify.js';
import { navigationError } from './navigationPolicy.js';

export function createIdempotencyRegistry() {
  const records = new Map();
  let generation = 0;
  const keyOf = args => JSON.stringify([args.principalId, args.requestId]);
  const fingerprintOf = args => stableStringify({ operation: args.operation, payload: args.payload });

  function existing(args) {
    const record = records.get(keyOf(args));
    if (record && record.fingerprint !== fingerprintOf(args)) {
      throw navigationError('IDEMPOTENCY_CONFLICT', 'requestId đã dùng với ý định khác.');
    }
    return record;
  }

  return {
    // Giữ API cũ cho caller đồng bộ; caller bất đồng bộ phải dùng run().
    replayOrThrow(args) {
      const record = existing(args);
      if (record?.pending) throw navigationError('REQUEST_IN_FLIGHT', 'Yêu cầu đang được xử lý.');
      return record ? structuredClone(record.response) : null;
    },
    remember(args) {
      if (existing(args)) return;
      records.set(keyOf(args), { fingerprint: fingerprintOf(args), response: structuredClone(args.response) });
    },
    run(args, work) {
      const record = existing(args);
      if (record) return record.pending
        ? record.pending.then(structuredClone)
        : Promise.resolve(structuredClone(record.response));

      // Đăng ký promise trước khi chạy work: hai caller không cùng vượt qua await.
      const epoch = generation;
      const entry = { fingerprint: fingerprintOf(args), pending: null };
      entry.pending = Promise.resolve().then(async () => {
        if (epoch !== generation) throw navigationError('OPERATION_SUPERSEDED', 'Phiên đã thay đổi.');
        const response = await work();
        if (epoch !== generation) throw navigationError('OPERATION_SUPERSEDED', 'Phiên đã thay đổi.');
        entry.response = structuredClone(response);
        entry.pending = null;
        return structuredClone(response);
      }).catch(error => {
        if (records.get(keyOf(args)) === entry) records.delete(keyOf(args));
        throw error;
      });
      records.set(keyOf(args), entry);
      return entry.pending;
    },
    clear() {
      generation += 1;
      records.clear();
    },
  };
}
