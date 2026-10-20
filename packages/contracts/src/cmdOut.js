/**
 * packages/contracts/src/cmdOut.js
 *
 * GÓI LỆNH /cmd_out BACKEND PHÁT XUỐNG ROBOT (ROS 2: std_msgs/msg/String, data là JSON).
 */
import { z } from 'zod';
import { VelocitySchema } from './control.js';

export const CMD_OUT_TOPIC = '/cmd_out';
export const CMD_OUT_ROS_TYPE = 'std_msgs/msg/String';

// emergency: yêu cầu dừng; auto: nhiệm vụ đi đến đích; manual: lái tay bằng joystick.
export const CmdOutModeSchema = z.enum(['emergency', 'auto', 'manual']);

export const CmdOutMessageSchema = z.object({
    // Để dành cho đích đến; định dạng chưa thống nhất với nhóm robot.
    target: z.null(),
    mode: CmdOutModeSchema,
    velocity: z.object({
        linear: z.number().finite(),   // m/s, dương là tiến (= linear.x của Twist /cmd_in)
        angular: z.number().finite(),  // rad/s, dương là quay trái (= angular.z của Twist /cmd_in)
    }).strict(),
}).strict();

// Đổi -0 thành 0 cho gói gọn.
const plain = value => (value === 0 ? 0 : value);

/**
 * Dựng gói /cmd_out từ vận tốc cùng kiểu với /cmd_in (VelocitySchema: { linearX, angularZ }).
 * Đây là chỗ duy nhất đổi sang tên trường của gói, nên hai chiều luôn khớp đơn vị và dấu.
 */
export function buildCmdOutMessage({ mode, velocity }) {
    const { linearX, angularZ } = VelocitySchema.parse(velocity);
    return CmdOutMessageSchema.parse({
        target: null,
        mode,
        velocity: { linear: plain(linearX), angular: plain(angularZ) },
    });
}
