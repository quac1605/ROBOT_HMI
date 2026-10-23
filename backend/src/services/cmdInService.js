/**
 * backend/src/services/cmdInService.js
 *
 * CHỌN MODE VÀ DỰNG GÓI /cmd_in TỪ CÁC LỆNH CHUYỂN ĐỘNG ĐÃ ĐƯỢC CHẤP NHẬN.
 *
 * Service chỉ nhận lệnh sau bước kiểm tra quyền (adapter, controlAuthority),
 * nên lệnh bị từ chối không bao giờ ra /cmd_in.
 * Vận tốc vào dùng cùng kiểu với /cmd_out (VelocitySchema: { linearX, angularZ }).
 *
 * Mode chỉ đổi khi người dùng chọn mode khác:
 * - slam: bắt đầu phiên tạo bản đồ, hoặc nhận quyền lái ở trang tạo bản đồ.
 * - manual: nhận quyền lái ở trang điều hướng.
 * - auto: bắt đầu nhiệm vụ; target là các đích (PoseStamped), joystick luôn 0.
 * - stop: bấm nút dừng hoặc hủy nhiệm vụ; target null, joystick 0.
 * Lệnh lái khác 0 cũng là chọn slam/manual (theo phiên tạo bản đồ).
 * Mọi việc khác (nhả joystick, trả/hết hạn quyền lái, kết thúc nhiệm vụ hay phiên bản đồ,
 * lệnh vận tốc 0) chỉ phát lại mode hiện tại với joystick 0.
 */
import {
    CMD_IN_FRAME_ID, OriginalPositionSchema, buildCmdInMessage, poseToPoseStamped,
} from '@robot-hmi/contracts/cmdIn';
import { ZERO, isZero } from '@robot-hmi/control-domain/controlPolicy';

const conflict = (code, message) => Object.assign(new Error(message ?? code), { code, status: 409 });

export function createCmdInService({ publishers = [], logger = null, now = () => Date.now() } = {}) {
    // null: chưa có lệnh điều khiển nào kể từ khi khởi động, không phát gì.
    let mode = null;
    let target = null;
    let originalPosition = null;
    let mappingActive = false;
    let navigationActive = false;
    let disposed = false;

    function publish(velocity) {
        if (disposed || mode === null) return;
        const message = buildCmdInMessage({ mode, velocity, target, originalPosition });
        for (const publisher of publishers) {
            // Một publisher lỗi không được chặn publisher khác hay đường điều khiển.
            try { publisher.publish(message); }
            catch (error) { logger?.warn?.({ err: error }, 'cmd_in publish failed'); }
        }
    }

    function enter(nextMode, nextTarget = null) {
        mode = nextMode;
        target = nextTarget;
    }

    return {
        onMotionCommand({ origin, velocity, poses }) {
            if (origin === 'mission') {
                // Vận tốc nhiệm vụ hiện là mô phỏng, không phải lệnh lái: chỉ gửi đích, joystick 0.
                if (Array.isArray(poses) && poses.length) {
                    const stamp = now();
                    enter('auto', poses.map(pose => poseToPoseStamped(
                        { x: pose.x, y: pose.y, theta: pose.yaw },
                        { frameId: pose.frameId ?? CMD_IN_FRAME_ID, stamp })));
                }
                if (mode === 'auto') publish(ZERO);
                return;
            }
            if (origin === 'teleop') {
                // Lệnh 0 không bao giờ đổi mode; chỉ lệnh lái khác 0 mới chọn slam/manual.
                if (!isZero(velocity)) {
                    const driveMode = mappingActive ? 'slam' : 'manual';
                    if (mode !== driveMode) enter(driveMode);
                }
                publish(velocity);
                return;
            }
            if (origin === 'cancel') {
                // Hủy nhiệm vụ cũng là bấm dừng.
                enter('stop');
                publish(ZERO);
                return;
            }
            if (origin === 'stop') {
                // Dừng nội bộ (kết thúc nhiệm vụ, tắt server) giữ nguyên mode hiện tại.
                publish(ZERO);
            }
        },
        // Gọi mỗi lần trạng thái robot đổi; chỉ lúc mới vào phiên tạo bản đồ mới phát slam.
        onRobotState(state) {
            navigationActive = Boolean(state?.activeMissionId) || state?.mode === 'navigating';
            const active = state?.mode === 'mapping';
            if (active && !mappingActive) {
                mappingActive = true;
                enter('slam');
                publish(ZERO);
            } else if (!active) {
                mappingActive = false;
            }
        },
        emergencyStop() {
            enter('stop');
            publish(ZERO);
        },
        // Người dùng chọn mode lái (nhận quyền lái): slam hoặc manual, joystick 0.
        selectMode(nextMode) {
            if (nextMode !== 'slam' && nextMode !== 'manual') return;
            enter(nextMode);
            publish(ZERO);
        },
        // Cho phép chỉnh ước lượng trước nhiệm vụ auto tiếp theo; không đổi giữa nhiệm vụ.
        setOriginalPosition(raw) {
            if (disposed) throw Object.assign(new Error('SERVICE_DISPOSED'), { code: 'SERVICE_DISPOSED', status: 503 });
            const parsed = OriginalPositionSchema.parse(raw);
            if (navigationActive) throw conflict('ORIGINAL_POSITION_DURING_MISSION');
            originalPosition = Object.freeze({ ...parsed });
            return { ...originalPosition };
        },
        getOriginalPosition: () => (originalPosition ? { ...originalPosition } : null),
        getMode: () => mode,
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const publisher of publishers) {
                try { publisher.dispose?.(); } catch { /* cô lập */ }
            }
        },
    };
}
