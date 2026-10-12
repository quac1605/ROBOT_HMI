// clients/mockCamera.js
import { CameraQuerySchema } from '../schemas/camera.js';

export function createMockCameraService() {
    return {
        listCameras() {
            // Trả danh sách descriptor, không phải stream
            return [
                { cameraId: 'front', position: 'front', available: true, label: 'Camera trước (mô phỏng)' },
                { cameraId: 'rear', position: 'rear', available: true, label: 'Camera sau (mô phỏng)' },
            ];
        },

        getCameraStream(raw) {
            // Parse+validate input trước khi xử lý
            const { cameraId } = CameraQuerySchema.parse(raw);
            return { kind: 'file', cameraId, url: `/demo/${cameraId}.mp4` };
        },
    };
}
