// utils/teleopHoldController.js
export function createTeleopHoldController({
    getLatest,      // () => { allowed, reasons, lease, freshnessToken } — đọc store tại thời điểm send
    sendVelocity,   // (msg) => void — SYNCHRONOUS, không phải Promise
    requestStop,    // (reason) => Promise<void> — để facade xử lý dedupe/error
    onError = () => { },
    setEvery = (cb, ms) => setInterval(cb, ms),
    clearEvery = timer => clearInterval(timer),
    periodMs = 50,
}) {
    let timer = null;
    let active = null; // { inputOwner, leaseId, vector } | null
    let disposed = false;
    let leaseId = null;  // leaseId đang dùng (để reset sequence khi lease đổi)
    let sequence = 0;

    // stop: dừng vòng lặp và gọi requestStop
    // inputOwner: nếu chỉ định → chỉ stop khi đúng owner đó đang giữ
    function stop(reason = 'RELEASED', inputOwner = null) {
        if (!active) return false;
        if (inputOwner !== null && active.inputOwner !== inputOwner) return false;
        active = null;
        if (timer !== null) { clearEvery(timer); timer = null; }
        // requestStop phải fence đồng bộ ngay; không defer bằng .then()
        try { Promise.resolve(requestStop(reason)).catch(onError); }
        catch (error) { onError(error); }
        return true;
    }

    // send: được gọi mỗi 50ms từ timer
    function send() {
        if (!active || disposed) return;
        const current = getLatest(); // Tính lại guard với performance.now() TẠI ĐÂY
        // Guard fail → dừng ngay
        if (!current.allowed || !current.lease || current.lease.leaseId !== active.leaseId) {
            stop('GUARD_REJECTED');
            return;
        }
        if (sequence >= Number.MAX_SAFE_INTEGER) {
            stop('SEQUENCE_EXHAUSTED');
            return;
        }
        try {
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
        // start: bắt đầu hold
        // inputOwner: 'pointer:123' | 'key:ArrowUp' (chuỗi định danh nguồn input)
        // vector: { linearX, angularZ }
        start(inputOwner, vector) {
            if (disposed || active || !inputOwner) return false;
            const current = getLatest();
            if (!current.allowed || !current.lease || !current.freshnessToken) return false;
            if (!Number.isFinite(vector.linearX) || !Number.isFinite(vector.angularZ)) return false;
            const limits = current.lease.limits;
            if (Math.abs(vector.linearX) > limits.maxLinearX ||
                Math.abs(vector.angularZ) > limits.maxAngularZ) return false;
            // Reset sequence khi lease mới
            if (leaseId !== current.lease.leaseId) {
                leaseId = current.lease.leaseId;
                sequence = 0;
            }
            active = {
                inputOwner,
                leaseId,
                vector: { linearX: vector.linearX, angularZ: vector.angularZ },
            };
            send(); // Gửi ngay lập tức, không đợi timer tick đầu tiên
            if (active) timer = setEvery(send, periodMs);
            return Boolean(active);
        },

        stop,
        isActive: () => active !== null,

        dispose() {
            stop('UNMOUNT');
            disposed = true;
        },
    };
}
