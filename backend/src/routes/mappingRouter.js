/**
 * backend/src/routes/mappingRouter.js
 * 
 * ROUTER QUẢN LÝ TIẾN TRÌNH QUÉT, JOBS VÀ KÍCH HOẠT BẢN ĐỒ (M8 / F8.3 - F8.4).
 */
import { Router } from 'express';
import {
    StartMappingRequestSchema,
    FinishMappingRequestSchema,
    GetActiveMappingSessionResponseSchema,
} from '@robot-hmi/contracts/mapping';
import { ActivateMapRequestSchema } from '@robot-hmi/contracts/mission';

function mapRouterError(err) {
    if (err.name === 'ZodError') {
        err.status = 400;
        err.code = 'VALIDATION_ERROR';
        return err;
    }
    const status404Codes = new Set(['MAP_NOT_FOUND', 'JOB_NOT_FOUND', 'SESSION_NOT_FOUND']);
    const status409Codes = new Set([
        'MAPPING_ACTIVE_OR_UNKNOWN', 'MISSION_ACTIVE_OR_UNKNOWN',
        'MAPPING_SESSION_NOT_FINISHABLE', 'MOTION_ADMISSION_BLOCKED',
        'MOTION_INHIBITED_OR_UNKNOWN', 'IDEMPOTENCY_CONFLICT',
    ]);
    const status503Codes = new Set(['MAP_ASSET_UNAVAILABLE']);
    const status400Codes = new Set(['INVALID_MAP_ID', 'INVALID_MAP_CONTEXT', 'MAP_TOO_LARGE', 'INVALID_MAP_DATA', 'INVALID_OPERATION_PAYLOAD']);

    if (status404Codes.has(err.code)) err.status = 404;
    else if (status409Codes.has(err.code)) err.status = 409;
    else if (status503Codes.has(err.code)) err.status = 503;
    else if (status400Codes.has(err.code)) err.status = 400;

    return err;
}

export function createMappingRouter({ lifecycle, mappingService, jobService, mapActivationService }) {
    const router = Router();

    // GET /api/mapping/sessions/active
    router.get('/mapping/sessions/active', lifecycle.requireAuth, async (_req, res, next) => {
        try {
            const data = await mappingService.getActiveMappingSession();
            res.status(200).json(GetActiveMappingSessionResponseSchema.parse(data));
        } catch (err) {
            next(mapRouterError(err));
        }
    });

    // POST /api/mapping/start
    router.post('/mapping/start', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            const dto = StartMappingRequestSchema.parse(req.body);
            const user = req.user.username;
            const result = await mappingService.startMapping(dto, user,
                () => lifecycle.assertRequestSessionCurrent(req));
            res.status(200).json(result);
        } catch (err) {
            next(mapRouterError(err));
        }
    });

    // POST /api/mapping/finish
    router.post('/mapping/finish', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            const dto = FinishMappingRequestSchema.parse(req.body);
            const user = req.user.username;
            const result = await mappingService.finishMapping(dto, user,
                () => lifecycle.assertRequestSessionCurrent(req));
            res.status(200).json(result);
        } catch (err) {
            next(mapRouterError(err));
        }
    });

    // GET /api/jobs/:id
    router.get('/jobs/:id', lifecycle.requireAuth, async (req, res, next) => {
        try {
            const job = await jobService.getJob(req.params.id);
            res.status(200).json(job);
        } catch (err) {
            next(mapRouterError(err));
        }
    });

    // POST /api/maps/activate
    router.post('/maps/activate', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            const dto = ActivateMapRequestSchema.parse(req.body);
            const user = req.user.username;
            const result = await mapActivationService.activateMap(dto, user,
                () => lifecycle.assertRequestSessionCurrent(req));
            res.status(200).json(result);
        } catch (err) {
            next(mapRouterError(err));
        }
    });

    return router;
}
