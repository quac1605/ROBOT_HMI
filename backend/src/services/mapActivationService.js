/** Map activation may claim a new context only after the mock adapter ACKs it. */
import { randomUUID } from 'node:crypto';
import {
    ActivateMapRequestSchema,
    ActivateMapResponseSchema,
} from '@robot-hmi/contracts/mission';
import { reserveBusinessOperation } from '../db/businessLedger.js';
import { assertAdapterCapability } from '../ros/adapterContract.js';

function activationError(code, status) {
    return Object.assign(new Error(code), { code, status });
}

export function createMapActivationService({
    pool, mapPersistence, adapter, motionGate, sharedRobotState, jobService,
}) {
    async function activateMap(rawDto, principal, assertCurrent) {
        const dto = ActivateMapRequestSchema.parse(rawDto);
        assertAdapterCapability(adapter, 'activation');
        if (typeof adapter.activateMap !== 'function') {
            throw activationError('ADAPTER_CAPABILITY_MISSING', 501);
        }
        let ticket;
        const { metadata } = await mapPersistence.getReadyMap(dto.mapId, dto.mapRevision);
        if (!metadata.capabilities.canLocalize) {
            throw activationError('MAP_CONTEXT_MISMATCH', 409);
        }
        assertCurrent?.();
        const accepted = await reserveBusinessOperation({
            pool, principalScope: principal, requestId: dto.requestId,
            operation: 'activate_map',
            payload: { mapId: dto.mapId, mapRevision: dto.mapRevision },
            create: async client => {
                assertCurrent?.();
                // Replays are resolved by the ledger before this callback. Only
                // a new activation needs current admission conditions.
                const state = sharedRobotState.getSnapshot();
                if (state.mode !== 'idle' || state.activeMappingSessionId ||
                    state.activeMissionId) {
                    throw activationError('MODE_NOT_ALLOWED', 409);
                }
                if (state.motionInhibited !== false) {
                    throw activationError('MOTION_INHIBITED_OR_UNKNOWN', 409);
                }
                if (state.rosConnected !== true || state.physicalEstopActive !== false) {
                    throw activationError('ESTOP_ACTIVE_OR_UNKNOWN', 409);
                }
                ticket = motionGate.enter();
                motionGate.assert(ticket);
                const jobId = randomUUID();
                await client.query(
                    "INSERT INTO jobs(id, kind, status, result, error, principal, dispatch_state) " +
                    "VALUES($1, 'activate_map', 'accepted', NULL, NULL, $2, 'pending')",
                    [jobId, principal],
                );
                return { status: 200,
                    body: { jobId, status: 'accepted' },
                    resourceRef: { jobId, mapId: dto.mapId,
                        mapRevision: dto.mapRevision } };
            },
        });
        if (accepted.replayed) {
            assertCurrent?.();
            return ActivateMapResponseSchema.parse(accepted.body);
        }

        let adapterAttempted = false;
        try {
            motionGate.assert(ticket);
            assertCurrent?.();
            // A new map cannot inherit the previous map's localization/pose.
            sharedRobotState.update({ mode: 'localizing', activeMap: null,
                pose: null, poseSourceUpdateAgeMs: null,
                localization: { status: 'unknown', reason: 'SWITCHING_MAP' } });
            adapterAttempted = true;
            const confirmation = adapter.activateMap({
                mapId: dto.mapId, mapRevision: dto.mapRevision,
            });
            if (confirmation?.status !== 'ready' ||
                confirmation.mapId !== dto.mapId ||
                confirmation.mapRevision !== dto.mapRevision) {
                throw activationError('ACTIVATION_CONTEXT_MISMATCH', 503);
            }
            motionGate.assert(ticket);
            assertCurrent?.();
            const completed = await jobService.updateJob(pool, accepted.body.jobId, {
                status: 'completed',
                result: { mapId: dto.mapId, mapRevision: dto.mapRevision,
                    frameId: metadata.frameId },
                allowedStatuses: ['accepted'],
            });
            if (!completed) throw activationError('ACTIVATION_UNCERTAIN', 503);
            motionGate.assert(ticket);
            sharedRobotState.update({ mode: 'idle',
                activeMap: { id: dto.mapId, revision: dto.mapRevision },
                localization: { status: 'tracking', reason: null } });
            return ActivateMapResponseSchema.parse(accepted.body);
        } catch (error) {
            await jobService.updateJob(pool, accepted.body.jobId, {
                status: 'failed', result: null,
                error: { code: 'ACTIVATION_UNCERTAIN',
                    message: 'Không thể xác nhận bản đồ đã kích hoạt.' },
                allowedStatuses: ['accepted', 'running'],
            }).catch(() => {});
            if (adapterAttempted) {
                // Adapter may have switched context even when its response or
                // the DB failed. Never present the old pose/map as navigable.
                sharedRobotState.update({ mode: 'fault', activeMap: null,
                    pose: null, poseSourceUpdateAgeMs: null,
                    localization: { status: 'unknown', reason: 'ACTIVATION_UNCERTAIN' },
                    motionInhibited: true,
                    motionInhibitReason: 'ACTIVATION_UNCERTAIN' });
            }
            if (error.code === 'MOTION_ADMISSION_BLOCKED') error.status = 409;
            if (!error.status) throw activationError('ACTIVATION_UNCERTAIN', 503);
            throw error;
        }
    }

    function stopForControl() {
        if (sharedRobotState.getSnapshot().mode === 'localizing') {
            sharedRobotState.update({ mode: 'idle', activeMap: null,
                pose: null, poseSourceUpdateAgeMs: null,
                localization: { status: 'unknown', reason: 'STOP_DURING_ACTIVATION' } });
        }
    }

    return { activateMap, stopForControl };
}
