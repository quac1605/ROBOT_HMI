/**
 * [READ FLOW STEP 10] Cửa HTTP đã xác thực cho danh mục và descriptor camera.
 * JSON trả về hướng dẫn cách mở video; pixel video đi từ MediaMTX đến browser.
 * @module backend/routes/cameraRouter
 */
import express from 'express';
import {
    ListCamerasResponseSchema,
    GetCameraStreamResponseSchema,
} from '@robot-hmi/contracts/camera';

/**
 * @param {object} dependencies Phụ thuộc từ runtime, không tạo camera/ROS node mới.
 * @param {object} dependencies.lifecycle Middleware và guard session HMI.
 * @param {object} dependencies.cameraService Dịch vụ cấp descriptor/vé camera.
 * @returns {import('express').Router} Router được app.js mount dưới /api.
 */
export function createCameraRouter({
    lifecycle,
    cameraService,
}) {
    const router = express.Router();

    /**
     * GET /api/cameras: danh mục cấu hình, không phải phép đo camera đang sống.
     * @param {import('express').Request} req Request chứa session đã xác thực.
     * @param {import('express').Response} res Trả JSON đúng schema, HTTP 200.
     * @param {import('express').NextFunction} next Nhận lỗi session/schema.
     * @returns {Promise<void>} Express hoàn tất response hoặc chuyển sang next(err).
     */
    router.get('/cameras', lifecycle.requireAuth, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const result = cameraService.listCameras();
            res.status(200).json(ListCamerasResponseSchema.parse(result));
        } catch (err) {
            next(err);
        }
    });

    /**
     * GET /api/cameras/:cameraId/stream: xin vé cho đúng camera người dùng chọn.
     * SID và hạn session do backend lấy từ cookie đã xác thực; không tin SID
     * tự khai trong query. Vé front không được tái dùng để đọc rear.
     * @param {import('express').Request} req Params cameraId và session HMI.
     * @param {import('express').Response} res Descriptor MP4/WHEP, HTTP 200.
     * @param {import('express').NextFunction} next Nhận lỗi để app.js chuẩn hóa.
     * @returns {Promise<void>} Không proxy byte video trong handler này.
     */
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
