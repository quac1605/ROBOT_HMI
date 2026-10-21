/**
 * backend/src/services/cmdInService.js
 *
 * CHỌN MODE VÀ DỰNG GÓI /cmd_in TỪ CÁC LỆNH CHUYỂN ĐỘNG ĐÃ ĐƯỢC CHẤP NHẬN.
 *
 * Service chỉ nhận lệnh sau bước kiểm tra quyền (adapter, controlAuthority),
 * nên lệnh bị từ chối không bao giờ ra /cmd_in.
 * Vận tốc vào dùng cùng kiểu với /cmd_out (VelocitySchema: { linearX, angularZ }).
 */
import { buildCmdInMessage } from '@robot-hmi/contracts/cmdIn';
import { ZERO, isZero } from '@robot-hmi/control-domain/controlPolicy';

export function createCmdInService({ publishers = [], logger = null } = {}) {
    // null: chưa có lệnh điều khiển nào kể từ khi khởi động, không phát gì.
    let mode = null;
    let disposed = false;

    function publish(velocity) {
        if (disposed || mode === null) return;
        const message = buildCmdInMessage({ mode, velocity });
        for (const publisher of publishers) {
            // Một publisher lỗi không được chặn publisher khác hay đường điều khiển.
            try { publisher.publish(message); }
            catch (error) { logger?.warn?.({ err: error }, 'cmd_in publish failed'); }
        }
    }

    return {
        onMotionCommand({ origin, velocity }) {
            if (origin === 'mission') {
                // Vận tốc nhiệm vụ hiện là mô phỏng, không phải lệnh lái: không đưa xuống robot.
                mode = 'auto';
                publish(ZERO);
                return;
            }
            if (origin === 'teleop') {
                // Giữ emergency qua các lệnh 0 sau yêu cầu dừng; chỉ lệnh lái khác 0 mới về manual.
                if (mode !== 'emergency' || !isZero(velocity)) mode = 'manual';
                publish(velocity);
                return;
            }
            if (origin === 'stop') {
                // Dừng nội bộ (kết thúc, hủy nhiệm vụ, tắt server) giữ nguyên mode hiện tại.
                publish(ZERO);
            }
        },
        emergencyStop() {
            mode = 'emergency';
            publish(ZERO);
        },
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
