/**
 * backend/src/control/controlRouter.js
 * 
 * ROUTER ĐIỀU KHIỂN ROBOT, QUẢN LÝ LEASE VÀ MEASURED STOP (M7 / F7.2 - F7.3).
 */
import { Router } from 'express';
import {
    AcquireControlRequestSchema,
    AcquireControlResponseSchema,
    ReleaseControlRequestSchema,
    ReleaseControlResponseSchema,
    RequestStopRequestSchema,
    RequestStopResponseSchema,
    GetControlStateResponseSchema,
} from '@robot-hmi/contracts/control';
import { bindHttpOwner } from '../realtime/bindHttpOwner.js';

function mapControlError(err) {
    if (err.name === 'ZodError') {
        err.status = 400;
        err.code = 'VALIDATION_ERROR';
        return err;
    }
    const status409Codes = new Set([
        'CONTROL_BUSY', 'LEASE_BUSY', 'LEASE_NOT_OWNED',
        'CONTROL_MUTATION_IN_PROGRESS', 'STOP_IN_PROGRESS', 'STOP_UNCONFIRMED',
        'ROBOT_NOT_STATIONARY', 'MODE_NOT_ALLOWED', 'ESTOP_ACTIVE_OR_UNKNOWN',
        'MOTION_INHIBITED_OR_UNKNOWN', 'MISSION_ACTIVE_OR_UNKNOWN',
        'MAPPING_ACTIVE_OR_UNKNOWN', 'ROS_UNAVAILABLE', 'TRANSPORT_UNHEALTHY',
    ]);
    if (status409Codes.has(err.code)) {
        err.status = 409;
    } else if (err.code === 'FORBIDDEN' || err.code === 'OWNER_BINDING_REJECTED') {
        err.status = 403;
    } else if (err.code === 'CONTROL_RESOURCE_EXHAUSTED') {
        err.status = 429;
    }
    return err;
}

export function createControlRouter({ lifecycle, registry, authority, subjects }) {
    const router = Router();

    // POST /api/control/lease - Nhận quyền lái kèm binding tab
    router.post('/lease', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            const record = bindHttpOwner(req, registry, lifecycle);
            const dto = AcquireControlRequestSchema.parse(req.body);
            const subjectId = subjects.getOrCreateAppSubject(record.connectionId);
            const result = await authority.acquireControl(dto, subjectId);
            res.status(200).json(AcquireControlResponseSchema.parse(result));
        } catch (err) {
            next(mapControlError(err));
        }
    });

    // POST /api/control/release - Trả quyền lái của tab hiện tại
    router.post('/release', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            const record = bindHttpOwner(req, registry, lifecycle);
            const dto = ReleaseControlRequestSchema.parse(req.body);
            const subjectId = subjects.getOrCreateAppSubject(record.connectionId);
            const result = await authority.releaseControl(dto, subjectId);
            res.status(200).json(ReleaseControlResponseSchema.parse(result));
        } catch (err) {
            next(mapControlError(err));
        }
    });

    // POST /api/control/stop - Yêu cầu dừng an toàn (HTTP 202 Accepted, không cần live WS)
    router.post('/stop', lifecycle.requireAuth, lifecycle.requireCsrf, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            const dto = RequestStopRequestSchema.parse(req.body);
            const subjectId = subjects.stopSubjectFor(req.sessionID);
            const accepted = await authority.requestStop(dto, subjectId);
            res.status(202).json(RequestStopResponseSchema.parse(accepted));
        } catch (err) {
            next(mapControlError(err));
        }
    });

    // GET /api/control/state - Lấy trạng thái snapshot (owner nhận lease, observer nhận view rút gọn)
    router.get('/state', lifecycle.requireAuth, async (req, res, next) => {
        try {
            lifecycle.assertRequestSessionCurrent(req);
            let subjectId;
            try {
                const record = bindHttpOwner(req, registry, lifecycle);
                subjectId = subjects.getOrCreateAppSubject(record.connectionId);
            } catch {
                subjectId = subjects.stopSubjectFor(req.sessionID);
            }
            const snapshot = await authority.getControlState(subjectId);
            res.status(200).json(GetControlStateResponseSchema.parse(snapshot));
        } catch (err) {
            next(mapControlError(err));
        }
    });

    return router;
}
