// Lý do dừng từ teleopHoldController. Chỉ nút dừng/phím Space ('MANUAL') hoặc gọi không lý do
// là người dùng chọn dừng; nhả joystick hay guard chặn thì dừng nhưng giữ mode /cmd_in.
export function stopOptionsForReason(reason) {
    return reason === undefined || reason === 'MANUAL' ? {} : { keepMode: true };
}

export function createControlStopAction({
    client,
    uuid = () => crypto.randomUUID(),
    onPending = () => { },
    onAccepted = () => { },
    onError = () => { },
}) {
    let active = true;
    let attempt = null;
    let inFlight = null;

    function request({ retry = false, keepMode = false } = {}) {
        if (!active) return Promise.reject(new Error('ACTION_DISPOSED'));
        if (inFlight) {
            // Bấm dừng trong lúc yêu cầu giữ mode đang chạy: gửi tiếp một yêu cầu dừng thật.
            if (attempt?.keepMode && !keepMode) {
                return inFlight.catch(() => { }).then(() => request());
            }
            return inFlight;
        }
        if (!retry || !attempt) attempt = { requestId: uuid(), keepMode: keepMode === true };
        const mine = attempt;
        let resolve, reject;
        const result = new Promise((yes, no) => { resolve = yes; reject = no; });
        inFlight = result;

        let raw;
        try {
            onPending(mine.requestId);
            raw = client.requestStop(mine.keepMode
                ? { requestId: mine.requestId, keepMode: true } : { requestId: mine.requestId });
        } catch (error) {
            raw = Promise.reject(error);
        }

        const finish = (ok, value) => {
            try {
                if (active && attempt === mine) {
                    if (ok) onAccepted(mine.requestId, value);
                    else onError(mine.requestId, value);
                }
            } catch (error) {
                ok = false;
                value = error;
            }
            if (attempt === mine && inFlight === result) inFlight = null;
            if (ok) resolve(value); else reject(value);
        };

        Promise.resolve(raw).then(
            value => finish(true, value),
            error => finish(false, error)
        );
        return result;
    }

    return {
        request,
        dispose() {
            active = false;
            attempt = null;
            inFlight = null;
        },
    };
}
