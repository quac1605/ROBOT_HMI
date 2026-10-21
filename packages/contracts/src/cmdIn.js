/**
 * packages/contracts/src/cmdIn.js
 *
 * GÓI LỆNH /cmd_in BACKEND PHÁT XUỐNG ROBOT (ROS 2: std_msgs/msg/String, data là JSON).
 */
import { z } from 'zod';
import { VelocitySchema } from './control.js';

export const CMD_IN_TOPIC = '/cmd_in';
export const CMD_IN_ROS_TYPE = 'std_msgs/msg/String';

// emergency: yêu cầu dừng; auto: nhiệm vụ đi đến đích; manual: lái tay bằng joystick.
export const CmdInModeSchema = z.enum(['emergency', 'auto', 'manual']);

export const CmdInMessageSchema = z.object({
    // Để dành cho đích đến; định dạng chưa thống nhất với nhóm robot.
    target: z.null(),
    mode: CmdInModeSchema,
    velocity: z.object({
        linear: z.number().finite(),   // m/s, dương là tiến (= linear.x của Twist /cmd_out)
        angular: z.number().finite(),  // rad/s, dương là quay trái (= angular.z của Twist /cmd_out)
    }).strict(),
}).strict();

// Đổi -0 thành 0 cho gói gọn.
const plain = value => (value === 0 ? 0 : value);

/**
 * Dựng gói /cmd_in từ vận tốc cùng kiểu với /cmd_out (VelocitySchema: { linearX, angularZ }).
 * Đây là chỗ duy nhất đổi sang tên trường của gói, nên hai chiều luôn khớp đơn vị và dấu.
 */
export function buildCmdInMessage({ mode, velocity }) {
    const { linearX, angularZ } = VelocitySchema.parse(velocity);
    return CmdInMessageSchema.parse({
        target: null,
        mode,
        velocity: { linear: plain(linearX), angular: plain(angularZ) },
    });
}
