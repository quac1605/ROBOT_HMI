/**
 * packages/control-domain/src/mockMotionSource.js
 * 
 * NGUỒN PHÁT MẪU VẬN TỐC MÔ PHỎNG AN TOÀN CHO KIỂM THỬ ĐIỀU KHIỂN (M7 / CHẶNG 8).
 */
export function createMockMotionSource({
    now = () => performance.now(),
    wallNow = () => Date.now(),
    uuid = () => crypto.randomUUID(),
    setEvery = (fn, ms) => setInterval(fn, ms),
    clearEvery = handle => clearInterval(handle),
    sourceHealthy = () => false,
    periodMs = 50,
} = {}) {
    let disposed = false;
    let frozen = false;
    let epoch = uuid();
    let sequence = 0;
    let commandRevision = 0;
    let desired = { linearX: 0, angularZ: 0 };
    let measured = { linearX: 0, angularZ: 0 };
    let sample = null;
    const listeners = new Set();
    const clone = value => structuredClone(value);
    const usable = () => {
        if (disposed) throw Object.assign(new Error('SERVICE_DISPOSED'), { code: 'SERVICE_DISPOSED' });
    };
    const validVelocity = v => v && Number.isFinite(v.linearX) && Number.isFinite(v.angularZ);

    function tick() {
        if (disposed || frozen || sourceHealthy() !== true) return;
        measured = clone(desired);
        sample = {
            sourceEpoch: epoch,
            sourceSequence: ++sequence,
            observedAt: new Date(wallNow()).toISOString(),
            observedMono: now(),
            appliedCommandRevision: commandRevision,
            velocity: clone(measured),
        };
        for (const listener of [...listeners]) {
            try { listener(clone(sample)); } catch { /* listener error không làm crash source */ }
        }
    }

    const timer = setEvery(tick, periodMs);
    timer?.unref?.();

    return {
        // Con trỏ phía lệnh tin cậy (command cursor), không phải là mẫu đo vật lý thực tế
        getCommand() {
            usable();
            return { sourceEpoch: epoch, commandRevision, velocity: clone(desired) };
        },
        ensureStopped() {
            usable();
            if (commandRevision === 0 || desired.linearX !== 0 || desired.angularZ !== 0) {
                desired = { linearX: 0, angularZ: 0 };
                commandRevision++;
            }
            return commandRevision;
        },
        writeCommand(velocity) {
            usable();
            if (!validVelocity(velocity)) {
                throw Object.assign(new Error('INVALID_VELOCITY'), { code: 'INVALID_VELOCITY' });
            }
            desired = clone(velocity);
            commandRevision++;
            return commandRevision;
        },
        latest() {
            usable();
            return clone(sample);
        },
        cursor() {
            usable();
            return { sourceEpoch: epoch, sourceSequence: sequence };
        },
        subscribe(listener) {
            usable();
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        reset() {
            usable();
            epoch = uuid();
            sequence = 0;
            commandRevision = 0;
            desired = { linearX: 0, angularZ: 0 };
            measured = { linearX: 0, angularZ: 0 };
            sample = null;
        },
        setFrozen(val) {
            usable();
            frozen = Boolean(val);
        },
        sample: tick,
        tick,
        dispose() {
            if (disposed) return;
            disposed = true;
            clearEvery(timer);
            listeners.clear();
            sample = null;
        },

    };
}
