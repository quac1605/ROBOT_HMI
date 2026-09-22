import { PreviewRouteRequestSchema, SaveRouteRequestSchema, RouteSchema, ListRoutesQuerySchema } from '../schemas/mission.js';
import { checkSavedMap, checkRouteBounds } from '../utils/navigationGuards.js';
import { createLifecycleTimers } from '../utils/lifecycleTimers.js';
import { navigationError } from '../utils/navigationPolicy.js';

export function createMockRouteService({ jobService, mapRepository, idempotency }) {
    const routes = new Map();
    const timers = createLifecycleTimers();

    async function validateMap(payload, epoch) {
        const map = await mapRepository.getMap(payload.mapId, payload.mapRevision);
        timers.assert(epoch);
        for (const check of [checkSavedMap(map), checkRouteBounds(payload.poses, map)]) {
            if (!check.ok) throw navigationError(check.code, check.reason);
        }
    }

    return {
        previewRoute(raw, principalId = 'demo-admin') {
            const payload = PreviewRouteRequestSchema.parse(raw);
            const epoch = timers.capture();
            return idempotency.run({
                principalId, operation: 'previewRoute',
                requestId: payload.requestId, payload
            }, async () => {
                await validateMap(payload, epoch);
                timers.assert(epoch);
                const job = jobService.createJob({ type: 'preview_route' });
                timers.schedule(epoch, () => {
                    jobService.updateJob(job.jobId, {
                        status: 'completed', result: {
                            mapId: payload.mapId, mapRevision: payload.mapRevision, frameId: 'map',
                            label: 'Đường minh họa',
                            path: payload.poses.map(({ x, y, yaw }) => ({ x, y, yaw })),
                        }
                    });
                }, 150);
                return { jobId: job.jobId, status: 'accepted' };
            });
        },
        saveRoute(raw, principalId = 'demo-admin') {
            const payload = SaveRouteRequestSchema.parse(raw);
            const epoch = timers.capture();
            return idempotency.run({
                principalId, operation: 'saveRoute',
                requestId: payload.requestId, payload
            }, async () => {
                await validateMap(payload, epoch);
                timers.assert(epoch);
                const route = RouteSchema.parse({
                    routeId: crypto.randomUUID(), name: payload.name,
                    mapId: payload.mapId, mapRevision: payload.mapRevision, poses: payload.poses,
                    createdAt: new Date().toISOString(),
                });
                routes.set(route.routeId, structuredClone(route));
                return route;
            });
        },
        listRoutes(raw) {
            timers.capture();
            const { mapId, mapRevision } = ListRoutesQuerySchema.parse(raw);
            return [...routes.values()]
                .filter(route => route.mapId === mapId && route.mapRevision === mapRevision)
                .map(route => structuredClone(route));
        },
        clear() { timers.clear(); routes.clear(); },
        dispose() { this.clear(); timers.dispose(); },
    };
}
