/**
 * [READ FLOW STEP 9] Cấp quyền xem camera, không vận chuyển từng frame video.
 * Browser dùng session HMI để xin descriptor; MediaMTX dùng grant trong descriptor
 * để kiểm tra quyền đọc WebRTC. Tách hai bước giúp MediaMTX không cần biết mật khẩu
 * hoặc truy cập bảng session PostgreSQL của ứng dụng.
 * @module backend/services/cameraService
 */
import {
    ListCamerasResponseSchema,
    GetCameraStreamResponseSchema,
    CameraQuerySchema,
} from '@robot-hmi/contracts/camera';
import { createHash, randomBytes } from 'node:crypto';

const GRANT_LIFETIME_MS = 60_000;
const MAX_GRANTS = 1024;
/**
 * Băm vé trước khi dùng làm khóa tra cứu; SHA-256 không phải phép mã hóa vé.
 * @param {string} token Vé bearer dạng hex do server sinh ngẫu nhiên.
 * @returns {string} Digest SHA-256 dạng hex, không thể dùng thay vé gốc tại WHEP.
 */
const digest = token => createHash('sha256').update(token).digest('hex');

// Đây là danh mục cấu hình; available=true chưa chứng minh ROS đang phát ảnh.
// Sức khỏe hình phải được xác nhận bằng frame thực sự đến trình duyệt.
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

/**
 * Tạo registry vé camera trong RAM của một runtime backend.
 * @param {object} [options={}] Các phụ thuộc được inject để test với đồng hồ giả.
 * @param {'demo'|'ros'} [options.mode='demo'] Demo trả MP4; ros trả descriptor WHEP.
 * @param {string} [options.whepBaseUrl] URL HTTPS MediaMTX mà browser truy cập được.
 * @param {object} [options.lifecycle] Kiểm tra và nhận thông báo thu hồi session.
 * @param {() => number} [options.now=Date.now] Đồng hồ epoch, đơn vị millisecond.
 * @returns {object} API list/get descriptor, authorizeMediaRequest và dispose.
 * @throws {Error} CAMERA_ROS_CONFIGURATION_REQUIRED nếu ros thiếu cấu hình.
 */
export function createCameraService({ mode = 'demo', whepBaseUrl, lifecycle,
    now = Date.now } = {}) {
    if (mode === 'ros' && (!lifecycle || !whepBaseUrl)) {
        throw new Error('CAMERA_ROS_CONFIGURATION_REQUIRED');
    }
    const grants = new Map();
    // Thu hồi SID chặn việc dùng vé để mở phiên mới. Callback này không gọi API
    // MediaMTX để cưỡng bức ngắt một PeerConnection đã được chấp nhận trước đó.
    const unsubscribeRevoke = lifecycle?.onRevoke((sid) => {
        if (sid === null) grants.clear();
        else for (const [key, grant] of grants) {
            if (grant.sid === sid) grants.delete(key);
        }
    });

    /** @returns {void} Dọn vé hết hạn trước cấp/kiểm tra; không cần timer riêng. */
    function prune() {
        const current = now();
        for (const [key, grant] of grants) {
            if (current >= grant.expiresAt) grants.delete(key);
        }
    }

    return {
        /**
         * @returns {Array<object>} Danh mục camera qua schema chung với frontend.
         * @throws {Error} Lỗi Zod nếu cấu hình nội bộ vi phạm contract.
         */
        listCameras() {
            return ListCamerasResponseSchema.parse(CAMERAS);
        },

        /**
         * Tạo descriptor để browser biết dùng file hay thương lượng WebRTC.
         * @param {unknown} rawCameraId Chỉ chấp nhận front hoặc rear.
         * @param {string} sid SID do middleware xác thực, không lấy từ body browser.
         * @param {number} sessionExpiresAt Hạn tuyệt đối của session, epoch ms.
         * @returns {object} Descriptor hợp schema; ros chứa vé bí mật và URL WHEP.
         * @throws {Error} CAMERA_NOT_FOUND, lỗi session, CAMERA_GRANTS_EXHAUSTED
         * hoặc lỗi schema. Router chuyển lỗi về middleware HTTP chung.
         */
        getCameraStream(rawCameraId, sid, sessionExpiresAt) {
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

            if (mode === 'demo') {
                return GetCameraStreamResponseSchema.parse({
                    kind: 'file', cameraId, url: `/demo/${cameraId}.mp4`,
                });
            }
            lifecycle?.assertSidCurrent(sid);
            prune();
            if (grants.size >= MAX_GRANTS) {
                throw Object.assign(new Error('CAMERA_GRANTS_EXHAUSTED'),
                    { code: 'CAMERA_GRANTS_EXHAUSTED', status: 503 });
            }
            // 32 byte ngẫu nhiên = 256 bit; hex thành 64 ký tự. Không ghi token
            // này vào log: ai giữ nó có thể xin đọc đúng camera trong thời hạn vé.
            const grantToken = randomBytes(32).toString('hex');
            // Vé sống tối đa 60 giây và không được sống lâu hơn session cấp vé.
            // Đây là hạn xác thực yêu cầu đọc, không phải thời lượng video 60 giây.
            const expiresAt = Math.min(now() + GRANT_LIFETIME_MS,
                Number.isSafeInteger(sessionExpiresAt) ? sessionExpiresAt : Infinity);
            if (expiresAt <= now()) {
                throw Object.assign(new Error('SESSION_EXPIRED'),
                    { code: 'SESSION_EXPIRED', status: 401 });
            }
            grants.set(digest(grantToken), { sid, cameraId, expiresAt });
            return GetCameraStreamResponseSchema.parse({
                kind: 'webrtc', cameraId,
                whepUrl: `${whepBaseUrl}/${cameraId}/whep`,
                grantToken, expiresAt: new Date(expiresAt).toISOString(),
            });
        },

        /**
         * Kiểm tra webhook từ MediaMTX; giới hạn peer loopback nằm ở app.js.
         * Vé gắn với SID + path, chỉ cho read/webrtc; không cho quyền publish.
         * @param {unknown} raw Body do MediaMTX gửi: action/protocol/path/token.
         * @returns {boolean} false cho vé sai/hết hạn/session đã revoke.
         * Vé không bị tiêu thụ khi kiểm tra: có thể dùng lại trong TTL cho cùng path.
         */
        authorizeMediaRequest(raw) {
            if (mode !== 'ros' || raw?.action !== 'read' ||
                raw?.protocol !== 'webrtc' ||
                !['front', 'rear'].includes(raw?.path) ||
                typeof raw?.token !== 'string' || !/^[a-f0-9]{64}$/.test(raw.token)) {
                return false;
            }
            prune();
            const grant = grants.get(digest(raw.token));
            if (!grant || grant.cameraId !== raw.path || now() >= grant.expiresAt) return false;
            try { lifecycle?.assertSidCurrent(grant.sid); }
            catch { return false; }
            return true;
        },

        /** @returns {void} Xóa vé và bỏ listener khi runtime được đóng. */
        dispose() {
            grants.clear();
            unsubscribeRevoke?.();
        },
    };
}
