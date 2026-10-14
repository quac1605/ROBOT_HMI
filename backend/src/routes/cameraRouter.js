/**
 * backend/src/routes/cameraRouter.js
 * 
 * HTTP ROUTER CHO CAMERA SUBSYSTEM (M8 / F8.6).
 */
import express from 'express';
import {
    ListCamerasResponseSchema,
    GetCameraStreamResponseSchema,
} from '@robot-hmi/contracts/camera';

export function createCameraRouter({
    lifecycle,
    cameraService,
}) {
    const router = express.Router();

    // 1. GET /api/cameras - Danh sách camera khả dụng
    router.get('/cameras', lifecycle.requireAuth, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = cameraService.listCameras();
            res.status(200).json(ListCamerasResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    // 2. GET /api/cameras/:cameraId/stream - Lấy stream descriptor của camera
    router.get('/cameras/:cameraId/stream', lifecycle.requireAuth, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = cameraService.getCameraStream(
                req.params.cameraId, req.sessionID, req.session.absoluteExpiresAt);
            res.status(200).json(GetCameraStreamResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    return router;
}
