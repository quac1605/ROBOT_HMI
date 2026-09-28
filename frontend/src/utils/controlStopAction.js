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

    return {
        request({ retry = false } = {}) {
            if (!active) return Promise.reject(new Error('ACTION_DISPOSED'));
            if (inFlight) return inFlight;
            if (!retry || !attempt) attempt = { requestId: uuid() };
            const mine = attempt;
            let resolve, reject;
            const result = new Promise((yes, no) => { resolve = yes; reject = no; });
            inFlight = result;

            let raw;
            try {
                onPending(mine.requestId);
                raw = client.requestStop({ requestId: mine.requestId });
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
        },
        dispose() {
            active = false;
            attempt = null;
            inFlight = null;
        },
    };
}
