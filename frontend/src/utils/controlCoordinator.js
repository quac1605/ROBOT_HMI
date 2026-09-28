// utils/controlCoordinator.js
import { useControlStore } from '../state/controlStore.js';
import { ControlEventEnvelopeSchema, GetControlStateResponseSchema } from '../schemas/control.js';
import { createControlStreamFence } from './controlStreamFence.js';
import { matchesPendingStop } from './controlEvidence.js';

export function createControlCoordinator(client, options = {}) {
    let active = true;
    const streamFence = createControlStreamFence();
    let healthTimer = null;
    const cleanup = [];
    let generationFloor = 0;

    const configuredProfile = options.controlProfile ?? client?.controlProfile ?? 'unknown';
    useControlStore.getState().setControlState({ controlProfile: configuredProfile });

    function setStore(partial) {
        useControlStore.getState().setControlState(partial);
    }

    // Tính leaseDeadline từ leaseRemainingMs (server tính từ đồng hồ của nó)
    // Trừ ngân sách bảo thủ 50ms để fail closed sớm hơn server một chút
    const localDeadline = remainingMs =>
        remainingMs != null ? performance.now() + remainingMs - 50 : null;

    const clearedLease = {
        lease: null, heartbeatReceivedAt: null, freshnessToken: null,
        tokenDeadline: null, leaseDeadline: null, commandResult: null,
    };

    function applySnapshot(snap) {
        if (snap.controlGeneration < generationFloor) return;
        generationFloor = snap.controlGeneration;
        const isOwner = snap.ownership === 'self';
        const state = useControlStore.getState();
        const profile = snap.controlProfile ?? state.controlProfile;

        const pendingId = state.pendingStopRequestId;
        let effectiveStop = snap.stop;
        let stopUnconfirmed = state.stopUnconfirmed;
        if (pendingId && snap.stop?.requestId !== pendingId) {
            effectiveStop = state.stopState;
            stopUnconfirmed = true;
        } else if (snap.stop?.status === 'confirmed') {
            // A response may be lost before the accepted event arrives. A matching
            // authoritative snapshot supplies the generation the local intent lacks.
            const expectedStop = pendingId === snap.stop.requestId && state.stopState?.status === 'requested'
                ? snap.stop : state.stopState || snap.stop;
            if (snap.stop.confirmation && matchesPendingStop(profile, expectedStop, snap.stop.confirmation)) {
                stopUnconfirmed = false;
                effectiveStop = snap.stop;
            } else {
                stopUnconfirmed = true;
                effectiveStop = state.stopState ?? snap.stop;
            }
        } else if (snap.stop?.status === 'accepted') {
            stopUnconfirmed = true;
        } else if (!snap.stop && state.stopUnconfirmed) {
            effectiveStop = state.stopState;
        }

        setStore({
            ...(!snap.lease || snap.lease.leaseId !== state.lease?.leaseId ? clearedLease : {}),
            controlGeneration: snap.controlGeneration,
            phase: isOwner ? 'granted' : 'idle',
            lease: snap.lease,
            leaseDeadline: snap.lease
                ? localDeadline(snap.lease.expiresAt
                    ? new Date(snap.lease.expiresAt).getTime() - Date.now()
                    : null)
                : null,
            stopState: effectiveStop,
            stopUnconfirmed,
            ...(!stopUnconfirmed ? { pendingStopRequestId: null, stopRequestPhase: null } : {}),
            ready: true,
            controlProfile: profile,
        });
    }

    function applyEvent(envelope) {
        // --- Stream Fencing (F06) ---
        const action = streamFence.event(envelope);
        if (action === 'drop') return;
        if (action === 'recover') {
            generationFloor = 0; // Generation comparisons are scoped to stream epoch.
            setStore({
                ...clearedLease, phase: 'reconciling', ready: false,
            });
            reconcile();
            return;
        }

        // --- Apply by type ---
        switch (envelope.type) {
            case 'control.granted': {
                const lease = envelope.payload;
                const state = useControlStore.getState();
                if (lease.controlGeneration < generationFloor) return;
                if (state.pendingStopRequestId || state.stopUnconfirmed) return;
                generationFloor = lease.controlGeneration;
                setStore({
                    ...(state.lease?.leaseId !== lease.leaseId ? clearedLease : {}),
                    phase: 'granted', ready: true,
                    controlProfile: lease.controlProfile ?? state.controlProfile,
                    lease,
                    controlGeneration: lease.controlGeneration,
                    leaseDeadline: localDeadline(
                        new Date(lease.expiresAt).getTime() - Date.now()
                    ),
                    stopUnconfirmed: false,
                    stopState: null,
                });
                break;
            }
            case 'control.heartbeat': {
                const hb = envelope.payload;
                const state = useControlStore.getState();
                if (!state.lease || hb.leaseId !== state.lease.leaseId) {
                    return;
                }
                if (hb.controlGeneration !== state.controlGeneration ||
                    hb.controlGeneration !== state.lease.controlGeneration) {
                    return;
                }
                setStore({
                    heartbeatReceivedAt: performance.now(),
                    freshnessToken: hb.freshnessToken,
                    tokenDeadline: performance.now() + hb.tokenValidForMs,
                    leaseDeadline: localDeadline(hb.leaseRemainingMs),
                    controlGeneration: hb.controlGeneration,
                });
                break;
            }
            case 'control.revoked': {
                const state = useControlStore.getState();
                const rev = envelope.payload;
                if (rev.controlGeneration < generationFloor) return;
                if (state.lease && rev.leaseId && rev.leaseId !== state.lease.leaseId) {
                    return;
                }
                generationFloor = rev.controlGeneration;
                setStore({
                    ...clearedLease,
                    controlGeneration: rev.controlGeneration,
                    phase: 'revoked',
                    lease: null, heartbeatReceivedAt: null,
                    freshnessToken: null, tokenDeadline: null, leaseDeadline: null,
                    lastRevocationReason: rev.reason,
                });
                break;
            }
            case 'control.snapshot': {
                applySnapshot(envelope.payload);
                break;
            }
            case 'control.stopConfirmed': {
                const confirmation = envelope.payload;
                const state = useControlStore.getState();
                const profile = state.controlProfile;
                const pending = state.stopState;
                if (confirmation.controlGeneration < generationFloor) return;
                if (!matchesPendingStop(profile, pending, confirmation)) {
                    return;
                }
                setStore({
                    stopState: {
                        ...(state.stopState ?? {}),
                        status: 'confirmed',
                        confirmation,
                    },
                    stopUnconfirmed: false,
                    pendingStopRequestId: null, stopRequestPhase: null,
                });
                break;
            }
            case 'teleop.commandResult': {
                const state = useControlStore.getState();
                const ack = envelope.payload;
                if (!state.lease || ack.leaseId !== state.lease.leaseId) {
                    return;
                }
                if (state.commandResult &&
                    state.commandResult.leaseId === ack.leaseId &&
                    ack.commandSequence <= state.commandResult.commandSequence) {
                    return;
                }
                setStore({ commandResult: ack });
                break;
            }
        }
    }

    async function reconcile() {
        if (!active) return;
        const ticket = streamFence.beginQuery();
        try {
            const raw = await client.getControlState();
            if (!active || !streamFence.queryStillCurrent(ticket)) return;
            const envelope = GetControlStateResponseSchema.parse(raw);
            if (!streamFence.query(ticket, envelope)) return;
            try {
                applySnapshot(envelope.payload);
            } catch (cause) {
                if (active) setStore({
                    phase: 'error', ready: false, lease: null,
                    freshnessToken: null, tokenDeadline: null, leaseDeadline: null,
                    controlError: cause.message,
                });
            }
        } catch (cause) {
            if (active && streamFence.queryStillCurrent(ticket)) {
                setStore({ ...clearedLease, phase: 'error', ready: false, controlError: cause.message });
            }
        }
    }

    // Subscribe
    try {
        cleanup.push(client.subscribeControl(event => {
            if (!active) return;
            try {
                const envelope = ControlEventEnvelopeSchema.parse(event);
                applyEvent(envelope);
            } catch { /* bỏ qua event malformed */ }
        }));
    } catch {
        for (const close of cleanup) close();
        active = false;
        setStore({ phase: 'error', ready: false });
        return { dispose: () => { } };
    }

    // Reconcile ban đầu
    reconcile();

    // Health timer: phát hiện lease hết hạn dựa trên local deadline
    healthTimer = setInterval(() => {
        if (!active) return;
        const state = useControlStore.getState();
        if (
            state.lease &&
            state.leaseDeadline != null &&
            performance.now() > state.leaseDeadline
        ) {
            setStore({
                phase: 'revoked', lease: null,
                heartbeatReceivedAt: null, freshnessToken: null,
                tokenDeadline: null, leaseDeadline: null,
                lastRevocationReason: 'LEASE_EXPIRED_LOCAL',
            });
        }
    }, 75);

    return {
        dispose() {
            if (!active) return;
            active = false;
            clearInterval(healthTimer);
            streamFence.dispose();
            for (const close of cleanup) close();
        },
    };
}
