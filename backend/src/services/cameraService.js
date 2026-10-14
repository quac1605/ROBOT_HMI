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
import { createHash, randomBytes } from 'node:crypto';

const GRANT_LIFETIME_MS = 60_000;
const MAX_GRANTS = 1024;
const digest = token => createHash('sha256').update(token).digest('hex');

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

export function createCameraService({ mode = 'demo', whepBaseUrl, lifecycle,
    now = Date.now } = {}) {
    if (mode === 'ros' && (!lifecycle || !whepBaseUrl)) {
        throw new Error('CAMERA_ROS_CONFIGURATION_REQUIRED');
    }
    const grants = new Map();
    const unsubscribeRevoke = lifecycle?.onRevoke((sid) => {
        if (sid === null) grants.clear();
        else for (const [key, grant] of grants) {
            if (grant.sid === sid) grants.delete(key);
        }
    });

    function prune() {
        const current = now();
        for (const [key, grant] of grants) {
            if (current >= grant.expiresAt) grants.delete(key);
        }
    }

    return {
        listCameras() {
            return ListCamerasResponseSchema.parse(CAMERAS);
        },

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
            const grantToken = randomBytes(32).toString('hex');
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

        // MediaMTX calls this endpoint from loopback. The token is short lived,
        // path bound and issued only by the authenticated descriptor endpoint.
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

        dispose() {
            grants.clear();
            unsubscribeRevoke?.();
        },
    };
}
