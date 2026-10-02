/**
 * backend/src/services/missionService.js
 * 
 * AUTONOMOUS MISSION EXECUTOR & NAVIGATION STREAM SERVICE (M8 / F8.5).
 */
import { randomUUID } from 'node:crypto';
import {
    MissionRequestSchema,
    CancelMissionRequestSchema,
    MissionEventEnvelopeSchema,
    NavigationPathEnvelopeSchema,
    preflightNavigationPath,
} from '@robot-hmi/contracts/mission';
import { assertAdapterCapability } from '../ros/adapterContract.js';
import { reserveBusinessOperation } from '../db/businessLedger.js';
import { assertPosesInsideMap } from './mapPosePolicy.js';

export function createMissionService({
    pool,
    missionsRepo,
    mapPersistence,
    adapter,
    motionGate,
    sharedRobotState,
    registry,
    lifecycle,
}) {
    let missionSequence = 0;
    let pathSequence = 0;
    let activeExecution = null; // { missionId, cancelled: boolean, timer: handle }
    let disposed = false;

    function cancelExecution(context) {
        if (!context || context.cancelled) return;
        context.cancelled = true;
        context.wake?.();
        adapter.cancelMission(context.handle); // Revoke source authority synchronously.
    }

    function waitStep(context) {
        return new Promise(resolve => {
            context.wake = () => {
                clearTimeout(context.timer);
                context.timer = null;
                context.wake = null;
                resolve(false);
            };
            context.timer = setTimeout(() => {
                context.timer = null;
                context.wake = null;
                resolve(true);
            }, 80);
        });
    }

    function broadcastMission(mission) {
        const envelope = MissionEventEnvelopeSchema.parse({
            version: 1,
            type: 'mission.updated',
            streamEpoch: lifecycle.authBootEpoch,
            sequence: ++missionSequence,
            sentAt: new Date().toISOString(),
            payload: mission,
        });
        registry.broadcastApp(envelope);
    }

    function broadcastPath(mission, plannedPoses) {
        const rawPayload = {
            version: 1,
            type: 'navigation.path',
            streamEpoch: lifecycle.authBootEpoch,
            sequence: ++pathSequence,
            sentAt: new Date().toISOString(),
            payload: {
                missionId: mission.missionId,
                mapId: mission.mapId,
                mapRevision: mission.mapRevision,
                frameId: 'map',
                kind: 'planned',
                poses: plannedPoses.map(p => ({ x: p.x, y: p.y, yaw: p.yaw })),
            },
        };
        preflightNavigationPath(rawPayload);
        const envelope = NavigationPathEnvelopeSchema.parse(rawPayload);
        registry.broadcastApp(envelope);
    }

    return {
        async createMission(rawDto, principal, assertCurrent) {
            if (disposed) {
                throw Object.assign(new Error('SERVICE_DISPOSED'), {
                    code: 'SERVICE_DISPOSED', status: 503,
                });
            }
            const dto = MissionRequestSchema.parse(rawDto);
            assertAdapterCapability(adapter, 'mission');
            // Replays are resolved by the ledger before new-operation guards.
            // Verify assets outside the DB transaction; never hold its lock
            // across filesystem I/O. A missing asset remains fail closed.
            const { metadata } = await mapPersistence.getReadyMap(dto.mapId, dto.mapRevision);
            assertPosesInsideMap(metadata, dto.poses);
            assertCurrent?.();

            let ticket;
            let reservation;
            try {
                reservation = await reserveBusinessOperation({
                    pool, principalScope: principal, requestId: dto.requestId,
                    operation: 'create_mission',
                    payload: { kind: dto.kind, mapId: dto.mapId,
                        mapRevision: dto.mapRevision, poses: dto.poses },
                    create: async client => {
                        assertCurrent?.();
                        const state = sharedRobotState.getSnapshot();
                        if (state.rosConnected !== true) {
                            throw Object.assign(new Error('ROS_UNAVAILABLE'),
                                { code: 'ROS_UNAVAILABLE', status: 409 });
                        }
                        if (state.physicalEstopActive !== false) {
                            throw Object.assign(new Error('ESTOP_ACTIVE_OR_UNKNOWN'),
                                { code: 'ESTOP_ACTIVE_OR_UNKNOWN', status: 409 });
                        }
                        if (state.motionInhibited !== false) {
                            throw Object.assign(new Error('MOTION_INHIBITED_OR_UNKNOWN'),
                                { code: 'MOTION_INHIBITED_OR_UNKNOWN', status: 409 });
                        }
                        if (state.localization?.status !== 'tracking') {
                            throw Object.assign(new Error('ROBOT_NOT_STATIONARY'),
                                { code: 'ROBOT_NOT_STATIONARY', status: 409 });
                        }
                        if (state.mode !== 'idle' || state.activeMissionId ||
                            state.activeMappingSessionId) {
                            throw Object.assign(new Error('MODE_NOT_ALLOWED'),
                                { code: 'MODE_NOT_ALLOWED', status: 409 });
                        }
                        if (state.activeMap?.id !== dto.mapId ||
                            state.activeMap?.revision !== dto.mapRevision) {
                            throw Object.assign(new Error('MAP_CONTEXT_MISMATCH'),
                                { code: 'MAP_CONTEXT_MISMATCH', status: 409 });
                        }
                        ticket = motionGate.enter();
                        const active = await client.query(
                            "SELECT id FROM missions WHERE robot_id='robot-01' " +
                            "AND status IN ('accepted','executing','canceling') LIMIT 1"
                        );
                        if (active.rowCount) {
                            throw Object.assign(new Error('MISSION_ACTIVE_OR_UNKNOWN'),
                                { code: 'MISSION_ACTIVE_OR_UNKNOWN', status: 409 });
                        }
                        assertCurrent?.();
                        motionGate.assert(ticket);
                        const mission = await missionsRepo.createMission({
                            id: 'mission-' + randomUUID(), robotId: 'robot-01',
                            principal, requestId: dto.requestId,
                            mapId: dto.mapId, mapRevision: dto.mapRevision,
                            kind: dto.kind, poses: dto.poses, status: 'accepted',
                            currentPoseIndex: 0,
                            distanceRemainingM: dto.poses.length * 2.5,
                        }, client);
                        return { status: 200,
                            body: { missionId: mission.missionId, status: 'accepted' },
                            resourceRef: { missionId: mission.missionId } };
                    },
                });
            } catch (error) {
                if (error.code === '23505') {
                    throw Object.assign(new Error('MISSION_ACTIVE_OR_UNKNOWN'),
                        { code: 'MISSION_ACTIVE_OR_UNKNOWN', status: 409 });
                }
                throw error;
            }
            if (reservation.replayed) {
                assertCurrent?.();
                return reservation.body;
            }
            const missionId = reservation.body.missionId;
            let mission;
            let handle;
            try {
                assertCurrent?.();
                mission = await missionsRepo.getMissionById(missionId);
                if (!mission) throw new Error('COMMITTED_MISSION_MISSING');
                motionGate.assert(ticket);
                assertCurrent?.();
                handle = adapter.beginMission(missionId);
                sharedRobotState.update({
                    mode: 'navigating',
                    activeMissionId: missionId,
                });
            } catch (error) {
                if (handle) adapter.cancelMission(handle);
                await missionsRepo.updateMission(missionId, {
                    status: 'failed', distanceRemainingM: null,
                    error: { code: 'DISPATCH_FAILED', message: 'Mission không được dispatch an toàn' },
                    allowedStatuses: ['accepted'],
                }).catch(() => {
                    sharedRobotState.update({ motionInhibited: true,
                        motionInhibitReason: 'MISSION_DISPATCH_UNCERTAIN' });
                });
                throw error;
            }

            // Bắt đầu background execution mô phỏng di chuyển
            const executionContext = {
                missionId: mission.missionId,
                handle,
                cancelled: false,
                timer: null,
                wake: null,
            };
            activeExecution = executionContext;

            queueMicrotask(async () => {
                try {
                    // Chuyển sang executing
                    mission = await missionsRepo.updateMission(mission.missionId, {
                        status: 'executing',
                        currentPoseIndex: 0,
                        distanceRemainingM: dto.poses.length * 2.0,
                        allowedStatuses: ['accepted'],
                    });
                    if (executionContext.cancelled || !mission) return;
                    broadcastMission(mission);

                    // Phát planned path
                    const path = adapter.previewRoute(dto);
                    broadcastPath(mission, path);

                    // Di chuyển qua từng pose
                    for (let i = 0; i < dto.poses.length; i++) {
                        if (executionContext.cancelled) return;

                        adapter.writeMissionVelocity(handle, { linearX: 0.3, angularZ: 0.05 });
                        if (!await waitStep(executionContext) || executionContext.cancelled) return;

                        const targetPose = dto.poses[i];
                        sharedRobotState.update({
                            pose: {
                                frameId: 'map',
                                x: targetPose.x,
                                y: targetPose.y,
                                yaw: targetPose.yaw,
                            },
                            velocity: { linearX: 0.3, angularZ: 0.05 },
                        });

                        const remaining = (dto.poses.length - 1 - i) * 1.5;
                        mission = await missionsRepo.updateMission(mission.missionId, {
                            currentPoseIndex: i,
                            distanceRemainingM: remaining,
                            allowedStatuses: ['executing'],
                        });
                        if (executionContext.cancelled || !mission) return;
                        broadcastMission(mission);
                    }

                    if (executionContext.cancelled) return;

                    // Hoàn tất mission
                    adapter.finishMission(handle);
                    sharedRobotState.update({
                        mode: 'idle',
                        activeMissionId: null,
                        velocity: { linearX: 0, angularZ: 0 },
                    });

                    mission = await missionsRepo.updateMission(mission.missionId, {
                        status: 'succeeded',
                        distanceRemainingM: 0,
                        allowedStatuses: ['executing'],
                    });
                    if (mission) broadcastMission(mission);
                } catch {
                    if (!executionContext.cancelled) {
                        try { adapter.cancelMission(handle); }
                        catch { /* motion source may already be disposed */ }
                        sharedRobotState.update({
                            mode: 'fault',
                            activeMissionId: null,
                            velocity: { linearX: 0, angularZ: 0 },
                            motionInhibited: true,
                            motionInhibitReason: 'MISSION_EXECUTION_FAILED',
                        });
                        try {
                            const failed = await missionsRepo.updateMission(mission.missionId, {
                                status: 'failed', distanceRemainingM: null,
                                error: { code: 'EXECUTION_FAILED', message: 'Nhiệm vụ thất bại trong quá trình di chuyển' },
                                allowedStatuses: ['accepted', 'executing'],
                            });
                            if (failed) broadcastMission(failed);
                        } catch { /* Keep inhibit; restart reconciliation handles DB loss. */ }
                    }
                } finally {
                    if (activeExecution === executionContext) {
                        activeExecution = null;
                    }
                }
            });

            return {
                missionId: mission.missionId,
                status: 'accepted',
            };
        },

        async cancelMission(missionId, rawDto) {
            const dto = CancelMissionRequestSchema.parse(rawDto);
            if (dto.missionId !== missionId) {
                throw Object.assign(new Error('VALIDATION_ERROR'), { code: 'VALIDATION_ERROR', status: 400 });
            }

            const mission = await missionsRepo.getMissionById(missionId);
            if (!mission) {
                throw Object.assign(new Error('MISSION_NOT_FOUND'), { code: 'MISSION_NOT_FOUND', status: 404 });
            }

            // Nếu đã ở trạng thái terminal thì trả về ngay (idempotent)
            if (['succeeded', 'failed', 'canceled'].includes(mission.status)) {
                return {
                    missionId: mission.missionId,
                    status: mission.status,
                };
            }

            // Dừng background execution
            if (activeExecution && activeExecution.missionId === missionId) {
                cancelExecution(activeExecution);
                activeExecution = null;
            }

            // Dừng robot
            adapter.ensureStopped();
            sharedRobotState.update({
                mode: 'idle',
                activeMissionId: null,
                velocity: { linearX: 0, angularZ: 0 },
            });

            const canceled = await missionsRepo.updateMission(missionId, {
                status: 'canceled',
                distanceRemainingM: null,
                allowedStatuses: ['accepted', 'executing', 'canceling'],
            });
            if (!canceled) {
                const terminal = await missionsRepo.getMissionById(missionId);
                return { missionId, status: terminal.status };
            }
            broadcastMission(canceled);

            return {
                missionId: canceled.missionId,
                status: 'canceled',
            };
        },

        // Hook được gọi khi controlAuthority.requestStop kích hoạt
        stopForControl() {
            if (activeExecution) {
                const missionId = activeExecution.missionId;
                cancelExecution(activeExecution);
                activeExecution = null;

                adapter.ensureStopped();
                sharedRobotState.update({
                    mode: 'idle',
                    activeMissionId: null,
                    velocity: { linearX: 0, angularZ: 0 },
                });

                void missionsRepo.updateMission(missionId, {
                    status: 'canceled',
                    distanceRemainingM: null,
                    allowedStatuses: ['accepted', 'executing', 'canceling'],
                }).then(canceled => {
                    if (canceled) broadcastMission(canceled);
                }).catch(() => { });
            }
        },

        async getActiveMission() {
            const mission = await missionsRepo.getActiveMission();
            return { mission };
        },

        async getMission(missionId) {
            const mission = await missionsRepo.getMissionById(missionId);
            if (!mission) {
                throw Object.assign(new Error('MISSION_NOT_FOUND'), { code: 'MISSION_NOT_FOUND', status: 404 });
            }
            return mission;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            if (activeExecution) {
                cancelExecution(activeExecution);
                activeExecution = null;
            }
            adapter.ensureStopped();
        },
    };
}
