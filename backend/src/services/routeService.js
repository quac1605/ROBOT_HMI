/** Route preview/save giữ đúng revision, asset và idempotency của requestId. */
import { randomUUID } from 'node:crypto';
import {
    PreviewRouteRequestSchema,
    PreviewRouteResponseSchema,
    SaveRouteRequestSchema,
    SaveRouteResponseSchema,
    ListRoutesQuerySchema,
} from '@robot-hmi/contracts/mission';
import { reserveBusinessOperation } from '../db/businessLedger.js';
import { assertAdapterCapability } from '../ros/adapterContract.js';
import { assertPosesInsideMap } from './mapPosePolicy.js';

export function createRouteService({ pool, routesRepo, mapPersistence, adapter, jobService }) {
    if (!mapPersistence?.getReadyMap) throw new Error('MAP_PERSISTENCE_REQUIRED');

    async function assertReadyRouteMap(dto) {
        // getReadyMap verifies DB status and every required asset's hash/size.
        const { metadata } = await mapPersistence.getReadyMap(dto.mapId, dto.mapRevision);
        assertPosesInsideMap(metadata, dto.poses);
    }

    return {
        async previewRoute(rawDto, principal, assertCurrent) {
            const dto = PreviewRouteRequestSchema.parse(rawDto);
            assertAdapterCapability(adapter, 'routePreview');
            await assertReadyRouteMap(dto);
            assertCurrent?.();

            const reservation = await reserveBusinessOperation({
                pool, principalScope: principal, requestId: dto.requestId,
                operation: 'preview_route',
                payload: { mapId: dto.mapId, mapRevision: dto.mapRevision,
                    poses: dto.poses },
                create: async client => {
                    assertCurrent?.();
                    const job = await jobService.createJob({
                        kind: 'preview_route', principal,
                    }, client, false);
                    return { status: 200,
                        body: { jobId: job.jobId, status: 'accepted' },
                        resourceRef: { jobId: job.jobId } };
                },
            });
            assertCurrent?.();
            if (!reservation.replayed) {
                // Dispatch only after the ledger and job have committed.
                queueMicrotask(() => {
                    void (async () => {
                        try {
                            jobService.broadcastJobUpdated(
                                await jobService.getJob(reservation.body.jobId));
                            await jobService.updateJobStatus(reservation.body.jobId, 'running');
                            assertCurrent?.();
                            const path = adapter.previewRoute(dto);
                            await jobService.completeJob(reservation.body.jobId, {
                                mapId: dto.mapId, mapRevision: dto.mapRevision,
                                frameId: 'map', label: 'Đường minh họa', path,
                            });
                        } catch (error) {
                            // A DB outage may prevent marking the job failed;
                            // it must never retry or dispatch the preview twice.
                            await jobService.failJob(reservation.body.jobId, {
                                code: typeof error?.code === 'string' &&
                                    /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
                                    ? error.code : 'PREVIEW_ROUTE_FAILED',
                                message: 'Không thể tạo đường minh họa.',
                            }).catch(() => {});
                        }
                    })();
                });
            }
            return PreviewRouteResponseSchema.parse(reservation.body);
        },

        async saveRoute(rawDto, principal, assertCurrent) {
            const dto = SaveRouteRequestSchema.parse(rawDto);
            await assertReadyRouteMap(dto);
            assertCurrent?.();
            const reservation = await reserveBusinessOperation({
                pool, principalScope: principal, requestId: dto.requestId,
                operation: 'save_route',
                payload: { name: dto.name, mapId: dto.mapId,
                    mapRevision: dto.mapRevision, poses: dto.poses },
                create: async client => {
                    assertCurrent?.();
                    const route = await routesRepo.saveRoute({
                        id: 'route-' + randomUUID(),
                        mapId: dto.mapId, mapRevision: dto.mapRevision,
                        name: dto.name, poses: dto.poses,
                    }, client);
                    return { status: 200, body: route,
                        resourceRef: { routeId: route.routeId } };
                },
            });
            assertCurrent?.();
            return SaveRouteResponseSchema.parse(reservation.body);
        },

        async listRoutes(rawQuery) {
            const query = ListRoutesQuerySchema.parse(rawQuery);
            return routesRepo.listRoutes({
                mapId: query.mapId, mapRevision: query.mapRevision,
            });
        },
    };
}
