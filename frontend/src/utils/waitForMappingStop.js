import { matchesPendingStop } from '@robot-hmi/control-domain/controlEvidence';

export function waitForMappingStop({
  requestId,
  mappingSessionId,
  controlStore,
  mappingStore,
  signal,
  timeoutMs = 5000,
}) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    let unsubscribeControl = () => {};
    let unsubscribeMapping = () => {};

    const settle = (error, confirmation) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribeControl();
      unsubscribeMapping();
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(confirmation);
    };
    const onAbort = () => settle(new Error('Đã rời trang hoặc hủy thao tác lưu.'));
    const check = () => {
      if (done) return;
      const session = mappingStore.getState().session;
      if (session?.mappingSessionId !== mappingSessionId ||
          !['mapping', 'save_failed'].includes(session.status)) {
        settle(new Error('Phiên mapping đã thay đổi; thao tác lưu cũ bị hủy.'));
        return;
      }
      const state = controlStore.getState();
      if (!state.ready) {
        settle(new Error('Mất kết nối điều khiển; chưa được phép lưu.'));
        return;
      }
      const stop = state.stopState;
      if (stop?.requestId && stop.requestId !== requestId) {
        settle(new Error('Yêu cầu dừng đã bị thay thế; hãy bắt đầu lại thao tác lưu.'));
        return;
      }
      if (stop?.status !== 'confirmed' || state.stopUnconfirmed || state.lease) return;
      if (state.controlGeneration !== stop.controlGeneration ||
          !matchesPendingStop(state.controlProfile, stop, stop.confirmation)) return;
      settle(null, stop.confirmation);
    };

    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    unsubscribeControl = controlStore.subscribe(check);
    unsubscribeMapping = mappingStore.subscribe(check);
    timer = setTimeout(() => settle(new Error(
      'Quá thời gian chờ mẫu đo xác nhận dừng. Phiên mapping vẫn được giữ; chưa gửi yêu cầu lưu.',
    )), timeoutMs);
    // Có thể event confirmed đã tới trước response HTTP accepted.
    check();
  });
}
