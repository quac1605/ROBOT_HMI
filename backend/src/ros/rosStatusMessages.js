/**
 * backend/src/ros/rosStatusMessages.js
 *
 * CHUYỂN MESSAGE ROS 2 (dạng JSON từ rosbridge) SANG TRƯỜNG CỦA RobotStateSchema.
 * Message sai/thiếu trường trả về null để caller bỏ qua, không làm hỏng snapshot.
 */
import { VelocitySchema } from '@robot-hmi/contracts/control';

const finite = Number.isFinite;

/** nav_msgs/msg/Odometry -> { frameId, x, y, yaw } (yaw: rad, (-pi, pi]). */
export function odometryToPose(msg, defaultFrameId = 'odom') {
    const position = msg?.pose?.pose?.position;
    const q = msg?.pose?.pose?.orientation;
    if (!finite(position?.x) || !finite(position?.y)) return null;
    if (![q?.x, q?.y, q?.z, q?.w].every(finite)) return null;

    const norm = Math.hypot(q.x, q.y, q.z, q.w);
    if (!Number.isFinite(norm) || norm === 0) return null;
    const [x, y, z, w] = [q.x / norm, q.y / norm, q.z / norm, q.w / norm];
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));

    const frame = typeof msg.header?.frame_id === 'string' ? msg.header.frame_id.trim() : '';
    return {
        frameId: frame && frame.length <= 128 ? frame : defaultFrameId,
        x: position.x,
        y: position.y,
        yaw,
    };
}

/**
 * geometry_msgs/msg/Twist -> VelocitySchema { linearX, angularZ }.
 * Cùng kiểu vận tốc mà /cmd_out dùng (buildCmdOutMessage), nên hai chiều khớp đơn vị và dấu.
 */
export function twistToVelocity(msg) {
    const result = VelocitySchema.safeParse({ linearX: msg?.linear?.x, angularZ: msg?.angular?.z });
    return result.success ? result.data : null;
}
