/**
 * packages/contracts/src/cmdIn.js
 *
 * GÓI LỆNH /cmd_in BACKEND PHÁT XUỐNG ROBOT (ROS 2: robot_hmi_msgs/msg/CmdIn,
 * định nghĩa trong ros2_ws/src/robot_hmi_msgs/msg/CmdIn.msg).
 *
 * Trong backend gói dùng dạng JSON dưới đây (null = không có); toRosCmdIn() đổi sang message ROS:
 * {
 *   target: PoseStamped[] | null,          // chỉ mode auto mới có, các mode khác là null
 *   mode: 'slam' | 'manual' | 'auto' | 'stop',
 *   joystick: { linear, angular },         // m/s, rad/s; auto và stop luôn là 0
 *   original_position: { x, y, theta } | null,  // vị trí ban đầu, nhập một lần trước nhiệm vụ auto đầu tiên
 * }
 */
import { z } from 'zod';
import { VelocitySchema } from './control.js';

export const CMD_IN_TOPIC = '/cmd_in';
export const CMD_IN_ROS_TYPE = 'robot_hmi_msgs/msg/CmdIn';
export const CMD_IN_FRAME_ID = 'map';

// slam: đang tạo bản đồ; manual: lái tay bằng joystick; auto: đi đến các đích; stop: yêu cầu dừng.
export const CmdInModeSchema = z.enum(['slam', 'manual', 'auto', 'stop']);

const finite = z.number().finite();

// Vị trí 2D: x, y (m) trong frame map, theta (rad, ngược chiều kim đồng hồ là dương).
export const PlanarPoseSchema = z.object({ x: finite, y: finite, theta: finite }).strict();
export const OriginalPositionSchema = PlanarPoseSchema;

export const SetOriginalPositionRequestSchema = OriginalPositionSchema;
export const OriginalPositionResponseSchema = z.object({
    originalPosition: OriginalPositionSchema.nullable(),
}).strict();

// Cùng cấu trúc geometry_msgs/msg/PoseStamped của ROS 2 (header.stamp là builtin_interfaces/Time).
export const PoseStampedSchema = z.object({
    header: z.object({
        stamp: z.object({
            sec: z.number().int().nonnegative(),
            nanosec: z.number().int().nonnegative().max(999_999_999),
        }).strict(),
        frame_id: z.string().min(1),
    }).strict(),
    pose: z.object({
        position: z.object({ x: finite, y: finite, z: finite }).strict(),
        orientation: z.object({ x: finite, y: finite, z: finite, w: finite }).strict(),
    }).strict(),
}).strict();

export const CmdInMessageSchema = z.object({
    target: z.array(PoseStampedSchema).min(1).max(100).nullable(),
    mode: CmdInModeSchema,
    joystick: z.object({
        linear: finite,   // m/s, dương là tiến (= linear.x của Twist /cmd_out)
        angular: finite,  // rad/s, dương là quay trái (= angular.z của Twist /cmd_out)
    }).strict(),
    original_position: OriginalPositionSchema.nullable(),
}).strict().superRefine((value, context) => {
    if ((value.mode === 'auto') !== (value.target !== null)) {
        context.addIssue({ code: 'custom', path: ['target'], message: 'Chỉ mode auto mới mang target.' });
    }
    if (['auto', 'stop'].includes(value.mode) && (value.joystick.linear !== 0 || value.joystick.angular !== 0)) {
        context.addIssue({ code: 'custom', path: ['joystick'], message: 'Mode auto và stop phải có joystick bằng 0.' });
    }
});

// Đổi -0 thành 0 cho gói gọn.
const plain = value => (value === 0 ? 0 : value);

/** Góc quay quanh trục z (rad) → quaternion { x, y, z, w }. */
export function yawToQuaternion(theta) {
    const half = theta / 2;
    return { x: 0, y: 0, z: plain(Math.sin(half)), w: plain(Math.cos(half)) };
}

/** Thời điểm (ms epoch) → builtin_interfaces/Time { sec, nanosec }. */
export function toRosTime(epochMs) {
    const sec = Math.floor(epochMs / 1000);
    const nanosec = Math.min(999_999_999, Math.round((epochMs - sec * 1000) * 1e6));
    return { sec, nanosec };
}

/**
 * Chuyển x, y (m) và góc quay theta (rad) thành geometry_msgs/msg/PoseStamped.
 * z luôn là 0 (robot chạy trên mặt phẳng).
 */
export function poseToPoseStamped({ x, y, theta }, { frameId = CMD_IN_FRAME_ID, stamp = Date.now() } = {}) {
    const pose = PlanarPoseSchema.parse({ x, y, theta });
    return PoseStampedSchema.parse({
        header: { stamp: toRosTime(stamp), frame_id: frameId },
        pose: {
            position: { x: plain(pose.x), y: plain(pose.y), z: 0 },
            orientation: yawToQuaternion(pose.theta),
        },
    });
}

/**
 * Dựng gói /cmd_in.
 * velocity cùng kiểu với /cmd_out (VelocitySchema: { linearX, angularZ }); đây là chỗ duy nhất
 * đổi sang tên trường của gói, nên hai chiều luôn khớp đơn vị và dấu.
 * target là mảng PoseStamped (đã dựng bằng poseToPoseStamped) hoặc null.
 */
export function buildCmdInMessage({ mode, velocity, target = null, originalPosition = null }) {
    const { linearX, angularZ } = VelocitySchema.parse(velocity);
    return CmdInMessageSchema.parse({
        target,
        mode,
        joystick: { linear: plain(linearX), angular: plain(angularZ) },
        original_position: originalPosition,
    });
}

/**
 * Gói /cmd_in (dạng JSON ở trên) → message robot_hmi_msgs/msg/CmdIn cho rosbridge.
 * ROS không có null: target null thành mảng rỗng; original_position null thành
 * has_original_position = false và x, y, theta = 0.
 */
export function toRosCmdIn(message) {
    const checked = CmdInMessageSchema.parse(message);
    const original = checked.original_position;
    return {
        target: checked.target ?? [],
        mode: checked.mode,
        joystick: { ...checked.joystick },
        has_original_position: original !== null,
        original_position: original ? { ...original } : { x: 0, y: 0, theta: 0 },
    };
}
