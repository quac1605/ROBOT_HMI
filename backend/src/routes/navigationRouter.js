/**
 * backend/src/routes/navigationRouter.js
 * 
 * HTTP ROUTER CHO ROUTES & MISSIONS (M8 / F8.5).
 */
import express from 'express';
import {
    PreviewRouteResponseSchema,
    SaveRouteResponseSchema,
    ListRoutesResponseSchema,
    CreateMissionResponseSchema,
    GetActiveMissionResponseSchema,
    GetMissionResponseSchema,
    CancelMissionResponseSchema,
} from '@robot-hmi/contracts/mission';
import { OriginalPositionResponseSchema } from '@robot-hmi/contracts/cmdIn';

export function createNavigationRouter({
    lifecycle,
    routeService,
    missionService,
    cmdInService = null,
}) {
    const router = express.Router();

    // 1. POST /api/routes/preview - Xem trước lộ trình
    router.post('/routes/preview', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = await routeService.previewRoute(req.body, req.user?.username,
                () => lifecycle.assertRequestSessionCurrent(req));
            res.status(200).json(PreviewRouteResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    // 2. POST /api/routes - Lưu lộ trình
    router.post('/routes', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = await routeService.saveRoute(req.body, req.user?.username,
                () => lifecycle.assertRequestSessionCurrent(req));
            res.status(200).json(SaveRouteResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    // 3. GET /api/routes - Lấy danh sách lộ trình theo mapId & mapRevision
    router.get('/routes', lifecycle.requireAuth, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = await routeService.listRoutes(req.query);
            res.status(200).json(ListRoutesResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    // 4. POST /api/missions - Khởi tạo nhiệm vụ điều hướng
    router.post('/missions', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = await missionService.createMission(req.body, req.user?.username,
                () => lifecycle.assertRequestSessionCurrent(req));
            res.status(200).json(CreateMissionResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    // 5. GET /api/missions/active - Lấy nhiệm vụ đang thực thi (phải định nghĩa trước /:id)
    router.get('/missions/active', lifecycle.requireAuth, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = await missionService.getActiveMission();
            res.status(200).json(GetActiveMissionResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    // 6. GET /api/missions/:id - Chi tiết nhiệm vụ theo missionId
    router.get('/missions/:id', lifecycle.requireAuth, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = await missionService.getMission(req.params.id);
            res.status(200).json(GetMissionResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    // 7. POST /api/missions/:id/cancel - Hủy nhiệm vụ điều hướng
    router.post('/missions/:id/cancel', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = await missionService.cancelMission(req.params.id, req.body);
            res.status(200).json(CancelMissionResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    // 8. Ước lượng vị trí robot trước nhiệm vụ auto (/cmd_in original_position).
    if (cmdInService) {
        router.get('/navigation/original-position', lifecycle.requireAuth, (req, res, next) => {
            try {
                lifecycle.assertRequestSessionCurrent(req);
                res.status(200).json(OriginalPositionResponseSchema.parse({
                    originalPosition: cmdInService.getOriginalPosition(),
                }));
            } catch (err) {
                next(err);
            }
        });

        router.put('/navigation/original-position', lifecycle.requireAuth, lifecycle.requireCsrf, (req, res, next) => {
            try {
                lifecycle.assertRequestSessionCurrent(req);
                const originalPosition = cmdInService.setOriginalPosition(req.body);
                res.status(200).json(OriginalPositionResponseSchema.parse({ originalPosition }));
            } catch (err) {
                if (err.name === 'ZodError') Object.assign(err, { status: 400, code: 'VALIDATION_ERROR' });
                next(err);
            }
        });
    }

    return router;
}
