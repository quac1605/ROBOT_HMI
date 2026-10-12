export function createPageLeaseIntent({
    client,
    getAcquirePayload = () => ({}),
    uuid = () => crypto.randomUUID(),
    onPending = () => { },
    onError = () => { },
    onLeaseChange = () => { },
    isLeaseCurrent = () => true,
}) {
    let active = true;
    let version = 0;
    let pending = false;
    let owned = null;

    const releaseExact = lease => {
        let result;
        try {
            result = client.releaseControl({ requestId: uuid(), leaseId: lease.leaseId });
        } catch (error) {
            result = Promise.reject(error);
        }
        return Promise.resolve(result).catch(error => {
            if (active && !['LEASE_NOT_OWNED', 'UNAUTHENTICATED', 'OPERATION_SUPERSEDED'].includes(error.code)) {
                onError(error);
            }
        });
    };

    function abandon() {
        version++;
        pending = false;
        if (active) onPending(false);
        const previous = owned;
        owned = null;
        if (active) onLeaseChange(null);
        if (previous) void releaseExact(previous);
    }

    return {
        async acquire() {
            if (!active || pending || owned) return false;
            const mine = ++version;
            pending = true;
            onPending(true);
            try {
                const lease = await client.acquireControl({
                    ...getAcquirePayload(),
                    requestId: uuid(),
                });
                if (!active || mine !== version || !isLeaseCurrent(lease)) {
                    await releaseExact(lease);
                    return false;
                }
                owned = lease;
                onLeaseChange(lease.leaseId);
                return true;
            } catch (error) {
                if (active && mine === version) onError(error);
                return false;
            } finally {
                if (active && mine === version) {
                    pending = false;
                    onPending(false);
                }
            }
        },
        canUseLease(leaseId) {
            return active && !pending && owned?.leaseId === leaseId;
        },
        invalidatePending() {
            if (!pending) return;
            version++;
            pending = false;
            if (active) onPending(false);
        },
        forgetRevokedLease(leaseId) {
            if (!leaseId || owned?.leaseId === leaseId) {
                owned = null;
                if (active) onLeaseChange(null);
                return true;
            }
            return false;
        },
        abandon,
        dispose() {
            active = false;
            abandon();
        },
    };
}
