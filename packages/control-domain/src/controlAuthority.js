/**
 * packages/control-domain/src/controlAuthority.js
 * 
 * CORE AUTHORITY ĐIỀU KHIỂN ROBOT, QUẢN LÝ LEASE VÀ MEASURED STOP OBSERVATION (M7 / CHẶNG 8).
 */
import { createControlLeaseCore } from './controlLeaseCore.js';
import { controlRobotReasons, CONTROL_POLICY, ZERO, isZero } from './controlPolicy.js';
import { createControlRequestRegistry } from './controlRequestRegistry.js';
import { acceptsFreshMotionSample, acceptsStopSample, acceptsStationarySample } from './stopObservation.js';
import {
    AcquireControlRequestSchema,
    AcquireControlResponseSchema,
    ReleaseControlRequestSchema,
    ReleaseControlResponseSchema,
    RequestStopRequestSchema,
    TeleopVelocityMessageSchema,
} from '@robot-hmi/contracts/control';

function controlError(code, message) {
    return Object.assign(new Error(message), { code });
}

export function createControlAuthority({
    sharedRobotState,
    telemetry,
    missionService = {},
    mapActivationService = {},
    motionGate,
    motionSource,
    mappingDriveGate = null,
    now = () => performance.now(),
    wallNow = () => Date.now(),
    uuid = () => crypto.randomUUID(),
    policy = CONTROL_POLICY,
    requestLimit = 4096,
    // Hook tùy chọn, gọi ở đầu mỗi lần dừng, trước khi thu hồi quyền lái.
    onStopRequested = null,
}) {
    if (!motionGate || typeof motionGate.enter !== 'function' || typeof motionGate.assert !== 'function') {
        throw new TypeError('Shared motionGate is required in controlAuthority');
    }
    if (!motionSource || typeof motionSource.writeCommand !== 'function') {
        throw new TypeError('Shared motionSource is required in controlAuthority');
    }

    let disposed = false;

    // --- Multi-Session / Subject Management (F01, F07) ---
    const activeSessions = new Set();
    const stopOnlySubjects = new Set();
    const sessionSubscribers = new Map(); // sessionId → Set<listener>
    let streamEpoch = uuid();
    let streamSequence = 0;

    // --- Idempotency Registry (F08) ---
    let resourceExhausted = false;
    const controlRequests = createControlRequestRegistry({
        maxEntries: requestLimit,
        onCapacity() {
            if (resourceExhausted) return;
            resourceExhausted = true;
            sharedRobotState.update({ motionInhibited: true, motionInhibitReason: 'CONTROL_RESOURCE_EXHAUSTED' });
            void stopTransaction({ requestId: uuid() }).catch(() => { /* Remain inhibited. */ });
        }
    });

    // --- Stop State & Ownership (F03, F05) ---
    let stopping = false;
    let ownedStopTicket = null;
    let stopState = null;
    let activeStopContext = null;

    // --- Timers ---
    let watchdogTimer = null;
    let heartbeatTimer = null;

    // --- Lease Core Setup ---
    let claimedLeaseId = null;

    const assertUsable = () => {
        if (disposed) throw controlError('SERVICE_DISPOSED', 'Control service đã dispose.');
    };

    const reasonsFor = (phase, context) => {
        const { snapshot, transportStale } = telemetry.getControlState();
        const reasons = controlRobotReasons(snapshot, transportStale, phase, context);
        if (context?.kind === 'mapping') {
            if (!mappingDriveGate?.canDrive(context.mappingSessionId)) {
                reasons.push('MAPPING_PHASE_BLOCKED');
            }
        } else if (mappingDriveGate?.getState()) {
            reasons.push('MAPPING_ACTIVE_OR_UNKNOWN');
        }
        return reasons;
    };

    let requiredCommandRevision = 0;
    let stopMutationActive = false;
    const stopMutations = [];

    // Serialize tuần tự toàn bộ giao dịch stop/confirmation
    function serializeStop(work) {
        return new Promise((resolve, reject) => {
            if (stopMutations.length >= 64) {
                reject(controlError('CONTROL_BUSY', 'Quá nhiều yêu cầu dừng đồng thời.'));
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
                        if (--budget < 0) throw controlError('CONTROL_BUSY', 'Stop re-entry budget exceeded.');
                        task.resolve(task.work());
                    } catch (error) { task.reject(error); }
                }
            } finally { stopMutationActive = false; }
        });
    }

    const core = createControlLeaseCore({
        now, wallNow, uuid, policy,
        checkAcquire: context => {
            if (resourceExhausted) return 'CONTROL_RESOURCE_EXHAUSTED';
            if (stopping || stopMutationActive) return 'STOP_IN_PROGRESS';
            if (!acceptsStationarySample({
                sample: motionSource.latest(), cursor: motionSource.cursor(),
                command: motionSource.getCommand(), requiredRevision: requiredCommandRevision,
                nowMono: now(), maxAgeMs: policy.motionSampleMaxAgeMs,
            })) return 'ROBOT_NOT_STATIONARY';
            return reasonsFor('acquire', context)[0] ?? null;
        },
        checkDrive: context => {
            if (resourceExhausted) return 'CONTROL_RESOURCE_EXHAUSTED';
            const reason = reasonsFor('drive', context)[0];
            if (reason) return reason;
            if (context.kind === 'mapping' && !acceptsFreshMotionSample({
                sample: motionSource.latest(), cursor: motionSource.cursor(),
                nowMono: now(), maxAgeMs: policy.motionSampleMaxAgeMs,
            })) return 'MOTION_SOURCE_STALE';
            return null;
        },
        setVelocity: velocity => {
            const rev = motionSource.writeCommand(velocity);
            if (isZero(velocity)) {
                requiredCommandRevision = rev;
            }
            sharedRobotState.update({ velocity });
        },
        claimMode: (leaseId, context) => {
            claimedLeaseId = leaseId;
            // Mode mapping thuộc vòng đời SLAM. Lease chỉ sở hữu motion.
            sharedRobotState.update(context.kind === 'mapping'
                ? { velocity: ZERO } : { mode: 'teleop', velocity: ZERO });
        },
        releaseMode: (leaseId, context) => {
            if (claimedLeaseId !== leaseId) return;
            claimedLeaseId = null;
            if (context.kind === 'manual' && sharedRobotState.getSnapshot().mode === 'teleop') {
                sharedRobotState.update({ mode: 'idle' });
            }
        },
    });

    const assertSession = sessionId => {
        assertUsable();
        if (!sessionId || !activeSessions.has(sessionId)) {
            throw controlError('UNAUTHENTICATED', 'Session hoặc Subject không hợp lệ.');
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

    function releaseOwnInhibit(ticket) {
        if (ownedStopTicket !== ticket) return;
        ownedStopTicket = null;
        const state = sharedRobotState.getSnapshot();
        if (state.motionInhibited === true && state.motionInhibitReason === 'CONTROL_STOP_PENDING') {
            sharedRobotState.update({ motionInhibited: false, motionInhibitReason: null });
        }
    }

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
            }).catch(() => { /* Giữ stop pending khi observation fail */ });
        });
        context.unsubscribe = unsubscribe;
    }

    function stopTransaction(req) {
        return serializeStop(() => performStop(req));
    }

    function performStop(req) {
        stopping = true;
        // Báo trước khi thu hồi lease để lệnh 0 do revoke sinh ra đã mang ngữ cảnh dừng.
        // Lỗi của hook không được chặn đường dừng.
        try { onStopRequested?.(); } catch { /* cô lập lỗi hook */ }

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
        const generation = core.stop();

        missionService.stopForControl?.();
        mapActivationService.stopForControl?.();

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

    // API nội bộ, không expose thành endpoint cho browser.
    // Bên gọi phải beginFinish NGAY sau hàm này, trước mọi await.
    function assertMappingFinishSafe(mappingSessionId) {
        assertUsable();
        if (!mappingDriveGate) throw controlError('MAPPING_PHASE_BLOCKED', 'Thiếu lifecycle gate.');
        mappingDriveGate.assertFinish(mappingSessionId);
        if (resourceExhausted) throw controlError('CONTROL_RESOURCE_EXHAUSTED', 'Control đang bị khóa.');
        if (stopping || stopMutationActive) throw controlError('STOP_IN_PROGRESS', 'Chưa xác nhận dừng.');
        if (claimedLeaseId !== null) throw controlError('CONTROL_BUSY', 'Cần trả lease trước khi lưu.');
        const { snapshot, transportStale } = telemetry.getControlState();
        // Dùng guard acquire để kiểm stationary nhưng mode vẫn là mapping.
        const reasons = controlRobotReasons(snapshot, transportStale, 'acquire', {
            kind: 'mapping', mappingSessionId,
        });
        if (reasons.length) throw controlError(reasons[0], 'Điều kiện lưu map chưa an toàn.');
        if (!acceptsStationarySample({
            sample: motionSource.latest(), cursor: motionSource.cursor(),
            command: motionSource.getCommand(), requiredRevision: requiredCommandRevision,
            nowMono: now(), maxAgeMs: policy.motionSampleMaxAgeMs,
        })) throw controlError('ROBOT_NOT_STATIONARY', 'Cần mẫu đứng yên mới từ nguồn đo.');
        return motionGate.enter();
    }

    return {
        assertMappingFinishSafe,
        createSession(customId, { stopOnly = false } = {}) {
            assertUsable();
            const sid = customId || uuid();
            activeSessions.add(sid);
            if (stopOnly) {
                stopOnlySubjects.add(sid);
            }
            sessionSubscribers.set(sid, new Set());
            return sid;
        },

        acquireControl(raw, sessionId) {
            assertSession(sessionId);
            if (stopOnlySubjects.has(sessionId)) {
                throw controlError('FORBIDDEN', 'Stop-only subject không được phép acquire quyền lái.');
            }
            const req = AcquireControlRequestSchema.parse(raw);
            return controlRequests.run({
                sessionId, operation: 'acquireControl',
                requestId: req.requestId, payload: req,
            }, () => {
                const lease = core.acquire(sessionId, req.context);
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
            if (stopOnlySubjects.has(sessionId)) {
                throw controlError('FORBIDDEN', 'Stop-only subject không được phép release quyền lái.');
            }
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
            if (stopOnlySubjects.has(sessionId)) {
                throw controlError('FORBIDDEN', 'Stop-only subject không được phép gửi vận tốc.');
            }
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
            stopOnlySubjects.delete(sessionId);
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
            stopOnlySubjects.clear();
            controlRequests.clear();
            core.dispose();
        },
    };
}
