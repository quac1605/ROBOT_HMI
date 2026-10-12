/**
 * backend/src/services/cameraService.js
 * 
 * CAMERA SUBSYSTEM SERVICE (M8 / F8.6).
 */
import {
    ListCamerasResponseSchema,
    GetCameraStreamResponseSchema,
    CameraQuerySchema,
} from '@robot-hmi/contracts/camera';

const CAMERAS = [
    {
        cameraId: 'front',
        label: 'Camera trước',
        position: 'front',
        available: true,
    },
    {
        cameraId: 'rear',
        label: 'Camera sau',
        position: 'rear',
        available: true,
    },
];

export function createCameraService() {
    return {
        listCameras() {
            return ListCamerasResponseSchema.parse(CAMERAS);
        },

        getCameraStream(rawCameraId) {
            const parsed = CameraQuerySchema.safeParse({ cameraId: rawCameraId });
            if (!parsed.success) {
                throw Object.assign(new Error('CAMERA_NOT_FOUND'), {
                    code: 'CAMERA_NOT_FOUND', status: 404,
                });
            }
            const { cameraId } = parsed.data;
            const camera = CAMERAS.find(c => c.cameraId === cameraId);
            if (!camera) {
                throw Object.assign(new Error('CAMERA_NOT_FOUND'), {
                    code: 'CAMERA_NOT_FOUND',
                    status: 404,
                });
            }

            return GetCameraStreamResponseSchema.parse({
                kind: 'file',
                cameraId,
                url: `/demo/${cameraId}.mp4`,
            });
        },
    };
}
