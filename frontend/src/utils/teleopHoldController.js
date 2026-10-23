export function createTeleopHoldController({
  getLatest,
  sendVelocity,
  requestStop,
  onError = () => {},
  setEvery = (callback, milliseconds) => setInterval(callback, milliseconds),
  clearEvery = timer => clearInterval(timer),
  periodMs = 50,
}) {
  let timer = null;
  let active = null;
  let disposed = false;
  let leaseId = null;
  let sequence = 0;

  function validVector(vector, limits) {
    return Boolean(
      vector && limits &&
      Number.isFinite(vector.linearX) && Number.isFinite(vector.angularZ) &&
      Number.isFinite(limits.maxLinearX) && Number.isFinite(limits.maxAngularZ) &&
      limits.maxLinearX >= 0 && limits.maxAngularZ >= 0 &&
      Math.abs(vector.linearX) <= limits.maxLinearX &&
      Math.abs(vector.angularZ) <= limits.maxAngularZ
    );
  }

  function isZero(vector) {
    return vector?.linearX === 0 && vector?.angularZ === 0;
  }

  function stop(reason = 'RELEASED', inputOwner = null) {
    if (!active) return false;
    if (inputOwner !== null && active.inputOwner !== inputOwner) return false;

    // Fence local publisher trước khi gửi bất kỳ request bất đồng bộ nào.
    active = null;
    if (timer !== null) {
      clearEvery(timer);
      timer = null;
    }
    try {
      // Gọi đồng bộ để stopAction đánh dấu stopUnconfirmed ngay.
      Promise.resolve(requestStop(reason)).catch(onError);
    } catch (error) {
      onError(error);
    }
    return true;
  }

  function cancel() {
    active = null;
    if (timer !== null) {
      clearEvery(timer);
      timer = null;
    }
  }

  function send() {
    if (!active || disposed) return;
    const current = getLatest();
    if (!current.allowed || !current.lease || !current.freshnessToken ||
        current.lease.leaseId !== active.leaseId ||
        current.lease.controlGeneration !== active.controlGeneration ||
        !validVector(active.vector, current.lease.limits)) {
      stop('GUARD_REJECTED');
      return;
    }
    if (sequence >= Number.MAX_SAFE_INTEGER) {
      stop('SEQUENCE_EXHAUSTED');
      return;
    }
    try {
      // sendVelocity trả undefined đồng bộ; không có queue/retry tại đây.
      sendVelocity({
        leaseId: active.leaseId,
        sequence: ++sequence,
        freshnessToken: current.freshnessToken,
        ...active.vector,
      });
    } catch (error) {
      stop('SEND_FAILED');
      onError(error);
    }
  }

  return {
    start(inputOwner, vector) {
      if (disposed || active || !inputOwner || isZero(vector)) return false;
      const current = getLatest();
      if (!current.allowed || !current.lease || !current.freshnessToken ||
          !validVector(vector, current.lease.limits)) return false;
      if (leaseId !== current.lease.leaseId) {
        leaseId = current.lease.leaseId;
        sequence = 0;
      }
      active = {
        inputOwner,
        leaseId,
        controlGeneration: current.lease.controlGeneration,
        vector: { linearX: vector.linearX, angularZ: vector.angularZ },
      };
      send();
      if (active) timer = setEvery(send, periodMs);
      return Boolean(active);
    },

    update(inputOwner, vector) {
      if (disposed || !active || active.inputOwner !== inputOwner) return false;
      const current = getLatest();
      if (!current.allowed || !current.lease || !current.freshnessToken ||
          current.lease.leaseId !== active.leaseId ||
          current.lease.controlGeneration !== active.controlGeneration ||
          !validVector(vector, current.lease.limits) || isZero(vector)) {
        stop('VECTOR_OR_GUARD_REJECTED', inputOwner);
        return false;
      }
      // Chỉ lưu vector mới nhất. Tick 50 ms hiện có sẽ đọc vector này.
      // Không gọi setInterval mới và không giữ hàng đợi vector cũ.
      active.vector = { linearX: vector.linearX, angularZ: vector.angularZ };
      return true;
    },

    stop,
    cancel,
    isActive: () => active !== null,
    dispose() {
      stop('UNMOUNT');
      disposed = true;
    },
  };
}
