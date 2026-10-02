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
    sharedRobotState,
    jobService,
    lifecycle,
}) {
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
        const accepted = await reserveBusinessOperation({
            pool,
            principalScope: principal,
            requestId: dto.requestId,
            operation: 'start_mapping',
            payload: { name: dto.name },
            create: async client => {
                // Admission applies only to a new operation. A replay must return
                // the original job even while its mapping session is active.
                assertCurrent?.();
                const state = sharedRobotState.getSnapshot();
                if (state.mode === 'mapping' || state.activeMappingSessionId) {
                    throw Object.assign(new Error('MAPPING_ACTIVE_OR_UNKNOWN'), {
                        code: 'MAPPING_ACTIVE_OR_UNKNOWN', status: 409 });
                }
                if (state.mode === 'navigating' || state.activeMissionId) {
                    throw Object.assign(new Error('MISSION_ACTIVE_OR_UNKNOWN'), {
                        code: 'MISSION_ACTIVE_OR_UNKNOWN', status: 409 });
                }
                if (state.motionInhibited !== false) {
                    throw Object.assign(new Error('MOTION_INHIBITED_OR_UNKNOWN'), {
                        code: 'MOTION_INHIBITED_OR_UNKNOWN', status: 409 });
                }
                ticket = motionGate.enter();
                const activeCheck = await client.query(
                    "SELECT id FROM mapping_sessions WHERE robot_id = 'robot-01' AND active = true FOR UPDATE"
                );
                if (activeCheck.rowCount) {
                    throw Object.assign(new Error('MAPPING_ACTIVE_OR_UNKNOWN'), {
                        code: 'MAPPING_ACTIVE_OR_UNKNOWN',
                        status: 409,
                    });
                }
                const mappingSessionId = randomUUID();
                const jobId = randomUUID();
                await client.query(
                    "INSERT INTO mapping_sessions(id, robot_id, name, status, active) VALUES($1, 'robot-01', $2, 'mapping', true)",
                    [mappingSessionId, dto.name]
                );
                await client.query(
                    "INSERT INTO jobs(id, kind, status, result, error, principal, dispatch_state) VALUES($1, 'start_mapping', 'accepted', NULL, NULL, $2, 'pending')",
                    [jobId, principal]
                );
                return {
                    status: 200,
                    body: { mappingSessionId, jobId, status: 'accepted' },
                    resourceRef: { mappingSessionId, jobId },
                };
            },
        });

        if (accepted.replayed) {
            assertCurrent?.();
            return StartMappingResponseSchema.parse(accepted.body);
        }

        let adapterAttempted = false;
        try {
            motionGate.assert(ticket);
            assertCurrent?.();
            const running = await jobService.updateJob(pool, accepted.body.jobId, {
                status: 'running', allowedStatuses: ['accepted'],
            });
            if (!running) throw Object.assign(new Error('MAPPING_START_UNCERTAIN'),
                { code: 'MAPPING_START_UNCERTAIN', status: 503 });
            motionGate.assert(ticket);
            assertCurrent?.();
            adapterAttempted = true;
            adapter.startMapping(accepted.body.mappingSessionId);
            sharedRobotState.update({
                mode: 'mapping',
                activeMappingSessionId: accepted.body.mappingSessionId,
            });
            const completed = await jobService.updateJob(pool, accepted.body.jobId, {
                status: 'completed',
                result: { mappingSessionId: accepted.body.mappingSessionId },
                allowedStatuses: ['running'],
            });
            if (!completed) throw Object.assign(new Error('MAPPING_START_UNCERTAIN'),
                { code: 'MAPPING_START_UNCERTAIN', status: 503 });
        } catch (error) {
            if (adapterAttempted) {
                try { adapter.finishMapping(accepted.body.mappingSessionId); } catch { /* uncertain */ }
                sharedRobotState.update({ mode: 'fault', activeMappingSessionId: null,
                    motionInhibited: true, motionInhibitReason: 'MAPPING_START_UNCERTAIN' });
            }
            await pool.query(
                'UPDATE mapping_sessions SET active=false,ended_at=now() WHERE id=$1',
                [accepted.body.mappingSessionId]).catch(() => {});
            await jobService.updateJob(pool, accepted.body.jobId, {
                status: 'failed', error: { code: 'MAPPING_START_FAILED',
                    message: 'Không thể xác nhận mapping đã bắt đầu.' },
            }).catch(() => {});
            throw error;
        }

        return StartMappingResponseSchema.parse(accepted.body);
    }

    async function finishMapping(dto, principal, assertCurrent) {
        assertCurrent?.();
        const ticket = motionGate.enter();

        const accepted = await mapPersistence.acceptFinish({
            principalScope: principal,
            requestId: dto.requestId,
            mappingSessionId: dto.mappingSessionId,
            name: dto.name,
        });

        if (accepted.replayed) {
            assertCurrent?.();
            return FinishMappingResponseSchema.parse(accepted.body);
        }

        const jobId = accepted.body.jobId;
        let snapshot;
        try {
            motionGate.assert(ticket);
            assertCurrent?.();
            snapshot = adapter.getMappingGrid(dto.mappingSessionId);
        } catch (error) {
            // Reservation already committed. Leave the session recoverable and
            // settle its job rather than leaving an accepted job forever.
            await mapPersistence.failAcceptedFinish(jobId,
                error.code || 'MAPPING_GRID_UNAVAILABLE');
            throw error;
        }

        jobService.broadcastJobUpdated({
            jobId,
            type: 'finish_mapping',
            status: 'accepted',
            result: null,
            error: null,
            createdAt: new Date().toISOString(),
        });

        // Keep the adapter's snapshot until the assets are durable. If save
        // fails, a new finish request can read that same live grid and retry.
        void (async () => {
            try {
                await mapPersistence.runFinish({
                    jobId,
                    snapshot,
                    yaml: FIXTURE_YAML,
                });
                try {
                    adapter.finishMapping(dto.mappingSessionId);
                } catch {
                    // Persistence is already completed; do not rewrite that
                    // terminal job. A leaked producer needs operator review.
                    sharedRobotState.update({ mode: 'fault',
                        activeMappingSessionId: null, motionInhibited: true,
                        motionInhibitReason: 'MAPPING_CLEANUP_UNCERTAIN' });
                }
                if (sharedRobotState.getSnapshot().activeMappingSessionId ===
                    dto.mappingSessionId) {
                    sharedRobotState.update({ mode: 'idle',
                        activeMappingSessionId: null });
                }
                const finishedJob = await jobService.getJob(jobId);
                jobService.broadcastJobUpdated(finishedJob);
            } catch {
                // runFinish marks save_failed and leaves the session active.
                // Do not erase the mapping context or its grid on failure.
                const failedJob = await jobService.getJob(jobId).catch(() => null);
                if (failedJob) jobService.broadcastJobUpdated(failedJob);
            }
        })().catch(() => {});

        return FinishMappingResponseSchema.parse(accepted.body);
    }

    return {
        getActiveMappingSession,
        startMapping,
        finishMapping,
    };
}
