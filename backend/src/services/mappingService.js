/**
 * backend/src/services/mappingService.js
 * 
 * DỊCH VỤ QUẢN LÝ QUÉT BẢN ĐỒ VÀ TIẾN TRÌNH FINISH/SAVE (M8 / F8.3).
 */
import { randomUUID } from 'node:crypto';
import {
    StartMappingResponseSchema,
    FinishMappingResponseSchema,
    MappingSessionSchema,
} from '@robot-hmi/contracts/mapping';
import { reserveBusinessOperation } from '../db/businessLedger.js';

const FIXTURE_YAML = `image: grid.json\nresolution: 0.05\norigin: [0.0, 0.0, 0.0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n`;

export function createMappingService({
    pool,
    mapPersistence,
    adapter,
    motionGate,
    mappingDriveGate,
    assertMappingFinishSafe,
    sharedRobotState,
    jobService,
    lifecycle,
}) {
    if (!mappingDriveGate || typeof assertMappingFinishSafe !== 'function') {
        throw new Error('MAPPING_DRIVE_DEPENDENCIES_REQUIRED');
    }
    async function getActiveMappingSession() {
        const res = await pool.query(
            "SELECT id, name, status, started_at FROM mapping_sessions WHERE robot_id = 'robot-01' AND active = true"
        );
        if (!res.rowCount) {
            return { session: null };
        }
        const row = res.rows[0];
        const session = MappingSessionSchema.parse({
            mappingSessionId: row.id,
            name: row.name,
            status: row.status,
            startedAt: new Date(row.started_at).toISOString(),
        });
        return { session };
    }

    async function startMapping(dto, principal, assertCurrent) {
        assertCurrent?.();
        let ticket;
        let reservedId = null;
        let accepted = null;
        let adapterAttempted = false;
        const conflict = code => Object.assign(new Error(code), { code, status: 409 });

        function assertReserved() {
            assertCurrent?.();
            motionGate.assert(ticket);
            const state = sharedRobotState.getSnapshot();
            const gate = mappingDriveGate.getState();
            if (gate?.mappingSessionId !== reservedId || gate.phase !== 'starting' ||
                state.activeMappingSessionId !== reservedId || state.activeMissionId !== null ||
                state.mode !== 'idle' || state.motionInhibited !== false ||
                state.rosConnected !== true || state.physicalEstopActive !== false) {
                throw conflict('MAPPING_START_SUPERSEDED');
            }
        }

        function assertReadyToActivate() {
            // Sau await cập nhật job, Stop/fault có thể đã đổi epoch hoặc
            // trạng thái. Không được mở gate lái chỉ vì DB vừa trả completed.
            assertCurrent?.();
            motionGate.assert(ticket);
            const state = sharedRobotState.getSnapshot();
            const gate = mappingDriveGate.getState();
            if (gate?.mappingSessionId !== reservedId || gate.phase !== 'starting' ||
                state.activeMappingSessionId !== reservedId || state.activeMissionId !== null ||
                state.mode !== 'mapping' || state.motionInhibited !== false ||
                state.rosConnected !== true || state.physicalEstopActive !== false) {
                throw conflict('MAPPING_START_SUPERSEDED');
            }
        }

        try {
            accepted = await reserveBusinessOperation({
                pool, principalScope: principal, requestId: dto.requestId,
                operation: 'start_mapping', payload: { name: dto.name },
                create: async client => {
                    // Replay không đi vào đây. Kiểm trạng thái mới nhất sau ledger await.
                    assertCurrent?.();
                    const state = sharedRobotState.getSnapshot();
                    if (state.mode !== 'idle' || state.activeMappingSessionId !== null ||
                        state.activeMissionId !== null) throw conflict('MODE_NOT_ALLOWED');
                    if (state.motionInhibited !== false) throw conflict('MOTION_INHIBITED_OR_UNKNOWN');
                    if (state.rosConnected !== true) throw conflict('ROS_UNAVAILABLE');
                    if (state.physicalEstopActive !== false) throw conflict('ESTOP_ACTIVE_OR_UNKNOWN');
                    ticket = motionGate.enter();
                    const id = randomUUID();
                    mappingDriveGate.beginSession(id);
                    reservedId = id;
                    // Đồng bộ với beginSession, trước await đầu tiên trong create.
                    // Mission/activation/acquire đều thấy robot đã được giữ cho mapping.
                    sharedRobotState.update({ activeMappingSessionId: id });
                    const active = await client.query(
                        "SELECT id FROM mapping_sessions WHERE robot_id='robot-01' AND active=true FOR UPDATE",
                    );
                    assertReserved();
                    if (active.rowCount) throw conflict('MAPPING_ACTIVE_OR_UNKNOWN');
                    const jobId = randomUUID();
                    await client.query(
                        "INSERT INTO mapping_sessions(id, robot_id, name, status, active) VALUES($1, 'robot-01', $2, 'mapping', true)",
                        [id, dto.name],
                    );
                    assertReserved();
                    await client.query(
                        "INSERT INTO jobs(id, kind, status, result, error, principal, dispatch_state) VALUES($1, 'start_mapping', 'accepted', NULL, NULL, $2, 'pending')",
                        [jobId, principal],
                    );
                    assertReserved();
                    return { status: 200,
                        body: { mappingSessionId: id, jobId, status: 'accepted' },
                        resourceRef: { mappingSessionId: id, jobId } };
                },
            });
            if (accepted.replayed) {
                assertCurrent?.();
                return StartMappingResponseSchema.parse(accepted.body);
            }
            assertReserved();
            const running = await jobService.updateJob(pool, accepted.body.jobId, {
                status: 'running', allowedStatuses: ['accepted'],
            });
            assertReserved();
            if (!running) throw conflict('MAPPING_START_UNCERTAIN');
            adapterAttempted = true;
            adapter.startMapping(reservedId);
            // Chưa có mẫu nguồn mapping mới thì pose phải null; observer ở mục 6 cấp pose.
            sharedRobotState.update({ mode: 'mapping', activeMap: null,
                pose: null, poseSourceUpdateAgeMs: null,
                localization: { status: 'unknown', reason: 'MAPPING_STARTING' } });
            const completed = await jobService.updateJob(pool, accepted.body.jobId, {
                status: 'completed', result: { mappingSessionId: reservedId },
                allowedStatuses: ['running'],
            });
            if (!completed) throw conflict('MAPPING_START_UNCERTAIN');
            // Chỉ mở joystick sau job xác nhận. Stop/fault trong lúc await vẫn chặn drive
            // bằng authority. Activate phase không được tự xóa inhibit hoặc đổi mode.
            assertReadyToActivate();
            mappingDriveGate.activateSession(reservedId);
            return StartMappingResponseSchema.parse(accepted.body);
        } catch (error) {
            if (reservedId && mappingDriveGate.getState()?.mappingSessionId === reservedId) {
                if (adapterAttempted) {
                    try { adapter.finishMapping(reservedId); } catch { /* Giữ fault bên dưới. */ }
                }
                // DB/network lỗi có thể có kết quả commit chưa biết. Giữ reservation + fault;
                // không mở robot cho lease mới khi session thật còn chưa xác định.
                const state = sharedRobotState.getSnapshot();
                sharedRobotState.update({ mode: 'fault', motionInhibited: true,
                    motionInhibitReason: state.motionInhibited === true
                        ? state.motionInhibitReason : 'MAPPING_START_UNCERTAIN' });
                if (accepted && !accepted.replayed) {
                    await jobService.updateJob(pool, accepted.body.jobId, {
                        status: 'failed', allowedStatuses: ['accepted', 'running'],
                        error: { code: 'MAPPING_START_UNCERTAIN', message: 'Cần recovery phiên mapping.' },
                    }).catch(() => {});
                }
                // Recovery phải reconcile ledger/job/session và đóng producer trước khi
                // clearSession(reservedId). Không tự mở lại gate trong catch tổng quát này.
            }
            throw error;
        }
    }

    async function restoreAfterFailedFinish(mappingSessionId) {
        // Sau lỗi DB, không đoán transaction đã rollback hay commit thành công.
        // Chỉ cho retry lưu khi DB chứng minh session vẫn recoverable; vẫn khóa lái.
        try {
            const found = await pool.query(
                'SELECT active,status FROM mapping_sessions WHERE id=$1',
                [mappingSessionId],
            );
            if (found.rowCount === 1 && found.rows[0].active === true &&
                ['mapping', 'save_failed'].includes(found.rows[0].status)) {
                mappingDriveGate.finishFailed(mappingSessionId);
                return;
            }
        } catch {
            // Giữ gate finishing nếu chưa biết trạng thái; operator dùng recovery.
        }
    }

    async function finishMapping(dto, principal, assertCurrent) {
        assertCurrent?.();
        let ticket;
        let ownsFinishGate = false;
        let accepted;
        try {
            accepted = await mapPersistence.acceptFinish({
                principalScope: principal,
                requestId: dto.requestId,
                mappingSessionId: dto.mappingSessionId,
                name: dto.name,
                beforeAccept() {
                    assertCurrent?.();
                    ticket = assertMappingFinishSafe(dto.mappingSessionId);
                    mappingDriveGate.beginFinish(dto.mappingSessionId);
                    ownsFinishGate = true;
                },
            });
        } catch (error) {
            if (ownsFinishGate) await restoreAfterFailedFinish(dto.mappingSessionId);
            throw error;
        }

        if (accepted.replayed) {
            assertCurrent?.();
            return FinishMappingResponseSchema.parse(accepted.body);
        }

        const jobId = accepted.body.jobId;
        let snapshot;
        try {
            // Stop xảy ra khi transaction await làm ticket hết hiệu lực.
            motionGate.assert(ticket);
            assertCurrent?.();
            snapshot = adapter.getMappingGrid(dto.mappingSessionId);
        } catch (error) {
            await mapPersistence.failAcceptedFinish(jobId,
                error.code || 'MAPPING_GRID_UNAVAILABLE');
            await restoreAfterFailedFinish(dto.mappingSessionId);
            throw error;
        }

        jobService.broadcastJobUpdated({
            jobId, type: 'finish_mapping', status: 'accepted',
            result: null, error: null, createdAt: new Date().toISOString(),
        });

        void (async () => {
            try {
                await mapPersistence.runFinish({ jobId, snapshot, yaml: FIXTURE_YAML });
            } catch {
                // Grid sống và session vẫn tồn tại để retry requestId mới.
                await restoreAfterFailedFinish(dto.mappingSessionId);
                const failedJob = await jobService.getJob(jobId).catch(() => null);
                if (failedJob) jobService.broadcastJobUpdated(failedJob);
                return;
            }

            // Job đã durable completed. Cleanup lỗi không được đổi job thành failed.
            try {
                adapter.finishMapping(dto.mappingSessionId);
                mappingDriveGate.finishSucceeded(dto.mappingSessionId);
                const state = sharedRobotState.getSnapshot();
                if (state.activeMappingSessionId === dto.mappingSessionId) {
                    sharedRobotState.update({
                        mode: state.mode === 'mapping' ? 'idle' : state.mode,
                        activeMappingSessionId: null,
                        pose: null, poseSourceUpdateAgeMs: null,
                    });
                }
            } catch {
                mappingDriveGate.clearSession(dto.mappingSessionId);
                sharedRobotState.update({
                    mode: 'fault', activeMappingSessionId: null,
                    motionInhibited: true, motionInhibitReason: 'MAPPING_CLEANUP_UNCERTAIN',
                });
            }
            const finishedJob = await jobService.getJob(jobId);
            jobService.broadcastJobUpdated(finishedJob);
        })().catch(() => {
            // Notification lỗi không hồi sinh session hoặc sửa terminal job.
        });

        return FinishMappingResponseSchema.parse(accepted.body);
    }

    return {
        getActiveMappingSession,
        startMapping,
        finishMapping,
    };
}
