// clients/mockControl.js
import { createControlLeaseCore } from '../utils/controlLeaseCore.js';
import { controlRobotReasons, CONTROL_POLICY, ZERO, isZero } from '../utils/controlPolicy.js';
import { navigationError } from '../utils/navigationPolicy.js';
import { createControlRequestRegistry } from '../utils/controlRequestRegistry.js';
import { acceptsStopSample, acceptsStationarySample } from '../utils/stopObservation.js';
import {
    AcquireControlRequestSchema,
    AcquireControlResponseSchema,
    ReleaseControlRequestSchema,
    ReleaseControlResponseSchema,
    RequestStopRequestSchema,
    TeleopVelocityMessageSchema,
} from '../schemas/control.js';

export function createMockControlService({
    sharedRobotState,
    telemetry,
    missionService,
    mapActivationService,
    motionGate,
    motionSource,
    now = () => performance.now(),
    wallNow = () => Date.now(),
    uuid = () => crypto.randomUUID(),
    policy = CONTROL_POLICY,
    requestLimit = 4096,
}) {
    if (!motionGate || typeof motionGate.enter !== 'function' || typeof motionGate.assert !== 'function') {
        throw new TypeError('Shared motionGate is required in mockControl');
    }
    if (!motionSource || typeof motionSource.writeCommand !== 'function') {
        throw new TypeError('Shared motionSource is required in mockControl');
    }

    let disposed = false;

    // --- Multi-Session Management (F01, F07) ---
    const activeSessions = new Set();
    const sessionSubscribers = new Map(); // sessionId → Set<listener>
    let streamEpoch = uuid();
    let streamSequence = 0;

    // --- Idempotency Registry (F08) ---
    let resourceExhausted = false;
    const controlRequests = createControlRequestRegistry({ maxEntries: requestLimit, onCapacity() {
        if (resourceExhausted) return;
        resourceExhausted = true;
        // Retain the inhibit even after observing zero. Recovery is a fresh mock
        // service, not eviction/replay or a normal Stop/Acquire click.
        sharedRobotState.update({ motionInhibited: true, motionInhibitReason: 'CONTROL_RESOURCE_EXHAUSTED' });
        void stopTransaction({ requestId: uuid() }).catch(() => { /* Remain inhibited. */ });
    } });

    // --- Stop State & Ownership (F03, F05) ---
    let stopping = false;
    let ownedStopTicket = null;
    let stopState = null; // { requestId, controlGeneration, status, confirmation }
    let activeStopContext = null;

    // --- Timers ---
    let watchdogTimer = null;
    let heartbeatTimer = null;

    // --- Lease Core Setup ---
    let claimedLeaseId = null;

    const assertUsable = () => {
        if (disposed) throw navigationError('SERVICE_DISPOSED', 'Control service đã dispose.');
    };

    const reasonsFor = phase => {
        const { snapshot, transportStale } = telemetry.getControlState();
        return controlRobotReasons(snapshot, transportStale, phase);
    };

    let requiredCommandRevision = 0;
    let stopMutationActive = false;
    const stopMutations = [];

    // Application callbacks can re-enter from ANY state/event notification.
    // Serialize the entire stop/confirmation transaction, not selected awaits.
    function serializeStop(work) {
        return new Promise((resolve, reject) => {
            if (stopMutations.length >= 64) {
                reject(navigationError('CONTROL_BUSY', 'Quá nhiều yêu cầu dừng đồng thời.'));
                return;
            }
            stopMutations.push({ work, resolve, reject });
            if (stopMutationActive) return;
            stopMutationActive = true;
            let budget = 128;
            try {
                while (stopMutations.length) {
                    const task = stopMutations.shift();
                    try {
                        assertUsable();
                        if (--budget < 0) throw navigationError('CONTROL_BUSY', 'Stop re-entry budget exceeded.');
                        task.resolve(task.work());
                    } catch (error) { task.reject(error); }
                }
            } finally { stopMutationActive = false; }
        });
    }

    const core = createControlLeaseCore({
        now, wallNow, uuid, policy,
        checkAcquire: () => {
            if (resourceExhausted) return 'CONTROL_RESOURCE_EXHAUSTED';
            if (stopping || stopMutationActive) return 'STOP_IN_PROGRESS';
            if (!acceptsStationarySample({
                sample: motionSource.latest(), cursor: motionSource.cursor(),
                command: motionSource.getCommand(), requiredRevision: requiredCommandRevision,
                nowMono: now(), maxAgeMs: policy.motionSampleMaxAgeMs,
            })) return 'ROBOT_NOT_STATIONARY';
            return reasonsFor('acquire')[0] ?? null;
        },
        checkDrive: () => resourceExhausted ? 'CONTROL_RESOURCE_EXHAUSTED' : reasonsFor('drive')[0] ?? null,
        setVelocity: velocity => {
            const rev = motionSource.writeCommand(velocity);
            if (isZero(velocity)) {
                requiredCommandRevision = rev;
            }
            sharedRobotState.update({ velocity });
        },
        claimMode: leaseId => {
            claimedLeaseId = leaseId;
            sharedRobotState.update({ mode: 'teleop', velocity: ZERO });
        },
        releaseMode: leaseId => {
            if (claimedLeaseId !== leaseId) return;
            claimedLeaseId = null;
            if (sharedRobotState.getSnapshot().mode === 'teleop') {
                sharedRobotState.update({ mode: 'idle' });
            }
        },
    });

    const assertSession = sessionId => {
        assertUsable();
        if (!sessionId || !activeSessions.has(sessionId)) {
            throw navigationError('UNAUTHENTICATED', 'Session không hợp lệ.');
        }
    };

    const nextEnvelope = (type, payload) => ({
        version: 1,
        streamEpoch,
        sequence: ++streamSequence,
        sentAt: new Date(wallNow()).toISOString(),
        type,
        payload,
    });

    const buildSnapshot = sid => {
        const view = core.view(sid);
        return {
            controlGeneration: view.controlGeneration,
            ownership: view.ownership,
            lease: view.ownership === 'self' ? view.lease : null,
            heartbeat: null,
            stop: stopState ? structuredClone(stopState) : null,
        };
    };

    const publishToSession = (sid, type, payload) => {
        const listeners = sessionSubscribers.get(sid);
        if (!listeners || listeners.size === 0) return;
        const envelope = nextEnvelope(type, payload);
        for (const listener of [...listeners]) {
            try { listener(structuredClone(envelope)); } catch { /* cô lập lỗi listener */ }
        }
    };

    const publishAll = (type, payloadBuilder) => {
        for (const sid of activeSessions) {
            const payload = typeof payloadBuilder === 'function' ? payloadBuilder(sid) : payloadBuilder;
            if (payload !== null) {
                publishToSession(sid, type, payload);
            }
        }
    };

    const drainRevocations = () => {
        for (const rev of core.takeRevocations()) {
            const payload = {
                leaseId: rev.leaseId,
                controlGeneration: rev.controlGeneration,
                reason: rev.reason,
            };
            if (rev.sessionId && !activeSessions.has(rev.sessionId)) {
                publishToSession(rev.sessionId, 'control.revoked', payload);
            }
            publishAll('control.revoked', payload);
            publishAll('control.snapshot', sid => buildSnapshot(sid));
        }
    };

    // Helper giải phóng cờ inhibit an toàn theo đúng vé sở hữu (F05)
    function releaseOwnInhibit(ticket) {
        if (ownedStopTicket !== ticket) return;
        ownedStopTicket = null;
        const state = sharedRobotState.getSnapshot();
        if (state.motionInhibited === true && state.motionInhibitReason === 'CONTROL_STOP_PENDING') {
            sharedRobotState.update({ motionInhibited: false, motionInhibitReason: null });
        }
    }

    // Stop observation: Sử dụng motionSource và acceptsStopSample (F03)
    function observeStopConfirmation(context) {
        const unsubscribe = motionSource.subscribe(sample => {
            if (disposed || !context.active || activeStopContext !== context) return;
            void serializeStop(() => {
            if (!context.active || activeStopContext !== context) return;
            const nowMono = now();
            const { snapshot, transportStale } = telemetry.getControlState();
            const healthy = transportStale === false && snapshot.rosConnected === true;
            const missionSettled = !snapshot.activeMissionId && snapshot.mode !== 'navigating';

            const accepted = acceptsStopSample({
                sample,
                baseline: context.baseline,
                stopCommandRevision: context.commandRevision,
                issuedMono: context.issuedMono,
                nowMono,
                healthy,
                missionSettled,
            });

            if (accepted) {
                context.active = false;
                context.unsubscribe?.();
                context.unsubscribe = null;

                // Xác nhận với admission gate
                const confirmedOk = motionGate.confirmStop(context.ticket);
                if (confirmedOk) {
                    const confirmation = {
                        requestId: context.requestId,
                        controlGeneration: context.generation,
                        evidenceKind: 'mock-source-observation',
                        sourceEpoch: sample.sourceEpoch,
                        sourceSequence: sample.sourceSequence,
                        observedAt: sample.observedAt,
                        velocity: structuredClone(sample.velocity),
                    };

                    stopState = {
                        requestId: context.requestId,
                        controlGeneration: context.generation,
                        status: 'confirmed',
                        confirmation,
                    };

                    releaseOwnInhibit(context.ticket);
                    stopping = false;

                    publishAll('control.stopConfirmed', confirmation);
                    publishAll('control.snapshot', sid => buildSnapshot(sid));
                }
            }
            }).catch(() => { /* Keep stop pending/locked on observation failure. */ });
        });
        context.unsubscribe = unsubscribe;
    }

    // Giao dịch dừng nguyên tử (F02, F08)
    function stopTransaction(req) {
        return serializeStop(() => performStop(req));
    }

    function performStop(req) {
        stopping = true;

        // Dọn dẹp observer của context cũ trước khi tạo stop context mới
        if (activeStopContext) {
            activeStopContext.active = false;
            activeStopContext.unsubscribe?.();
            activeStopContext = null;
        }

        const currentState = sharedRobotState.getSnapshot();
        const ownsInhibit = currentState.motionInhibited === false ||
            (ownedStopTicket !== null && currentState.motionInhibitReason === 'CONTROL_STOP_PENDING');
        const ticket = motionGate.beginStop();
        ownedStopTicket = ownsInhibit ? ticket : null;
        if (currentState.motionInhibited === false) {
            sharedRobotState.update({
                motionInhibited: true,
                motionInhibitReason: 'CONTROL_STOP_PENDING',
            });
        }

        const baseline = motionSource.cursor();
        const issuedMono = now();

        // Thu hồi quyền lái và đưa core về dừng
        const generation = core.stop();

        // Dừng các dịch vụ điều hướng
        missionService.stopForControl?.();
        mapActivationService.stopForControl?.();

        // Ghi lệnh dừng vận tốc 0 vào motionSource và lấy revision
        const stopRevision = motionSource.writeCommand({ linearX: 0, angularZ: 0 });
        requiredCommandRevision = stopRevision;
        sharedRobotState.update({ velocity: ZERO });

        stopState = {
            requestId: req.requestId,
            controlGeneration: generation,
            status: 'accepted',
            confirmation: null,
        };

        const context = {
            requestId: req.requestId,
            ticket,
            baseline,
            issuedMono,
            generation,
            commandRevision: stopRevision,
            active: true,
            unsubscribe: null,
        };
        activeStopContext = context;

        observeStopConfirmation(context);
        drainRevocations();
        publishAll('control.snapshot', sid => buildSnapshot(sid));
        return { requestId: req.requestId, status: 'accepted' };
    }

    // Watchdog & Heartbeat chạy theo vòng đời service (F07)
    watchdogTimer = setInterval(() => {
        if (disposed) return;
        try {
            core.tick();
            drainRevocations();
        } catch { /* cô lập lỗi */ }
    }, policy.watchdogPollMs);
    watchdogTimer?.unref?.();

    heartbeatTimer = setInterval(() => {
        if (disposed) return;
        try {
            for (const sid of activeSessions) {
                const hb = core.heartbeat(sid);
                if (hb) {
                    publishToSession(sid, 'control.heartbeat', hb);
                }
            }
        } catch { /* cô lập lỗi */ }
    }, policy.heartbeatMs);
    heartbeatTimer?.unref?.();

    return {
        createSession() {
            assertUsable();
            const sid = uuid();
            activeSessions.add(sid);
            sessionSubscribers.set(sid, new Set());
            return sid;
        },

        acquireControl(raw, sessionId) {
            assertSession(sessionId);
            const req = AcquireControlRequestSchema.parse(raw);
            return controlRequests.run({
                sessionId, operation: 'acquireControl',
                requestId: req.requestId, payload: req,
            }, () => {
                const lease = core.acquire(sessionId);
                drainRevocations();
                const response = AcquireControlResponseSchema.parse(lease);
                publishToSession(sessionId, 'control.granted', response);
                const hb = core.heartbeat(sessionId);
                if (hb) {
                    publishToSession(sessionId, 'control.heartbeat', hb);
                }
                publishAll('control.snapshot', sid => buildSnapshot(sid));
                return response;
            });
        },

        releaseControl(raw, sessionId) {
            assertSession(sessionId);
            const req = ReleaseControlRequestSchema.parse(raw);
            return controlRequests.run({
                sessionId, operation: 'releaseControl',
                requestId: req.requestId, payload: req,
            }, () => {
                core.release(sessionId, req.leaseId);
                drainRevocations();
                const response = ReleaseControlResponseSchema.parse({
                    leaseId: req.leaseId, requestId: req.requestId, status: 'released',
                });
                publishAll('control.snapshot', sid => buildSnapshot(sid));
                return response;
            });
        },

        sendVelocity(raw, sessionId) {
            assertSession(sessionId);
            const message = TeleopVelocityMessageSchema.parse(raw);
            try {
                core.send(sessionId, message);
                publishToSession(sessionId, 'teleop.commandResult', {
                    leaseId: message.leaseId,
                    commandSequence: message.sequence,
                    success: true,
                    error: null,
                });
            } catch (error) {
                publishToSession(sessionId, 'teleop.commandResult', {
                    leaseId: message.leaseId,
                    commandSequence: message.sequence,
                    success: false,
                    error: { code: error.code || 'SEND_ERROR', message: error.message },
                });
                throw error;
            } finally {
                drainRevocations();
            }
        },

        requestStop(raw, sessionId) {
            assertSession(sessionId);
            const req = RequestStopRequestSchema.parse(raw);
            return controlRequests.run({
                sessionId, operation: 'requestStop',
                requestId: req.requestId, payload: req, allowPending: true,
            }, () => stopTransaction(req));
        },

        subscribeControl(sessionId, listener) {
            assertSession(sessionId);
            const listeners = sessionSubscribers.get(sessionId);
            listeners.add(listener);
            // Gửi snapshot ban đầu ngay lập tức
            try {
                listener(structuredClone(nextEnvelope('control.snapshot', buildSnapshot(sessionId))));
            } catch { /* cô lập */ }
            return () => {
                listeners.delete(listener);
            };
        },

        getControlState(sessionId) {
            assertSession(sessionId);
            return Promise.resolve(structuredClone(nextEnvelope('control.snapshot', buildSnapshot(sessionId))));
        },

        revokeSession(sessionId) {
            if (!activeSessions.has(sessionId)) return;
            activeSessions.delete(sessionId);
            controlRequests.clearSession(sessionId);

            core.revokeSession(sessionId);
            drainRevocations();

            const listeners = sessionSubscribers.get(sessionId);
            sessionSubscribers.delete(sessionId);
            listeners?.clear();
            publishAll('control.snapshot', sid => buildSnapshot(sid));
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            clearInterval(watchdogTimer);
            clearInterval(heartbeatTimer);
            watchdogTimer = null;
            heartbeatTimer = null;
            if (activeStopContext) {
                activeStopContext.active = false;
                activeStopContext.unsubscribe?.();
                activeStopContext = null;
            }
            sessionSubscribers.clear();
            activeSessions.clear();
            controlRequests.clear();
            core.dispose();
        },
    };
}
