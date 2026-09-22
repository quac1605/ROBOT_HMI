import { navigationError } from './navigationPolicy.js';

export function createLifecycleTimers() {
  let generation = 0;
  let disposed = false;
  const timers = new Set();
  return {
    capture() {
      if (disposed) throw navigationError('SERVICE_DISPOSED', 'Service đã dispose.');
      return generation;
    },
    assert(epoch) {
      if (disposed || epoch !== generation) {
        throw navigationError('OPERATION_SUPERSEDED', 'Operation thuộc phiên cũ.');
      }
    },
    schedule(epoch, callback, delayMs) {
      if (disposed || epoch !== generation) return;
      const handle = setTimeout(() => {
        timers.delete(handle);
        if (!disposed && epoch === generation) callback();
      }, delayMs);
      timers.add(handle);
    },
    clear() {
      generation += 1;
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
    },
    dispose() {
      this.clear();
      disposed = true;
    },
    get pendingCount() { return timers.size; },
  };
}
