/** Contract for robot_hmi_msgs/msg/CmdIn on /cmd_in. */
import { z } from 'zod';
import { VelocitySchema } from './control.js';

export const CMD_IN_TOPIC = '/cmd_in';
export const CMD_IN_ROS_TYPE = 'robot_hmi_msgs/msg/CmdIn';
export const CMD_IN_FRAME_ID = 'map';
export const CmdInModeSchema = z.enum(['MANUAL', 'AUTO', 'STOP', 'SLAM']);

const finite = z.number().finite();
export const PlanarPoseSchema = z.object({ x: finite, y: finite, theta: finite }).strict();
export const OriginalPositionSchema = PlanarPoseSchema;
export const OriginalPositionResponseSchema = z.object({ originalPosition: PlanarPoseSchema.nullable() }).strict();
export const SetTargetRequestSchema = z.object({ target: z.array(PlanarPoseSchema).max(100) }).strict();

export const PoseStampedSchema = z.object({
    header: z.object({
        stamp: z.object({ sec: z.number().int().nonnegative(), nanosec: z.number().int().min(0).max(999_999_999) }).strict(),
        frame_id: z.literal(CMD_IN_FRAME_ID),
    }).strict(),
    pose: z.object({
        position: z.object({ x: finite, y: finite, z: finite }).strict(),
        orientation: z.object({ x: finite, y: finite, z: finite, w: finite }).strict(),
    }).strict(),
}).strict();
export const SetOriginalPositionRequestSchema = z.object({
    original_poss: z.union([PlanarPoseSchema, PoseStampedSchema]),
}).strict();
export const TargetResponseSchema = z.object({ target: z.array(PoseStampedSchema).max(100) }).strict();

export const CmdInMessageSchema = z.object({
    target: z.array(PoseStampedSchema).max(100),
    mode: CmdInModeSchema,
    joystick: z.object({ v_m: finite, v_rad: finite }).strict(),
    original_poss: PoseStampedSchema,
}).strict().superRefine((value, context) => {
    if (value.mode !== 'AUTO' && value.target.length) {
        context.addIssue({ code: 'custom', path: ['target'], message: 'Chỉ AUTO được mang target.' });
    }
    if (['AUTO', 'STOP'].includes(value.mode) && (value.joystick.v_m !== 0 || value.joystick.v_rad !== 0)) {
        context.addIssue({ code: 'custom', path: ['joystick'], message: 'AUTO và STOP phải có vận tốc bằng 0.' });
    }
});

const plain = value => (value === 0 ? 0 : value);
export function yawToQuaternion(theta) {
    const angle = finite.parse(theta) / 2;
    return { x: 0, y: 0, z: plain(Math.sin(angle)), w: plain(Math.cos(angle)) };
}
export function toRosTime(epochMs) {
    const sec = Math.floor(epochMs / 1000);
    return { sec, nanosec: Math.min(999_999_999, Math.round((epochMs - sec * 1000) * 1e6)) };
}
export function poseToPoseStamped({ x, y, theta }, { frameId = CMD_IN_FRAME_ID, stamp = Date.now() } = {}) {
    const pose = PlanarPoseSchema.parse({ x, y, theta });
    return PoseStampedSchema.parse({
        header: { stamp: toRosTime(stamp), frame_id: frameId },
        pose: { position: { x: plain(pose.x), y: plain(pose.y), z: 0 }, orientation: yawToQuaternion(pose.theta) },
    });
}
// Timestamp zero marks an unselected original pose without adding an extra ROS field.
export const EMPTY_ORIGINAL_POSE = poseToPoseStamped({ x: 0, y: 0, theta: 0 }, { stamp: 0 });

export function buildCmdInMessage({ mode, velocity = { linearX: 0, angularZ: 0 }, target = [], originalPosition = null }) {
    const { linearX, angularZ } = VelocitySchema.parse(velocity);
    return CmdInMessageSchema.parse({
        target, mode,
        joystick: { v_m: plain(linearX), v_rad: plain(angularZ) },
        original_poss: originalPosition ?? EMPTY_ORIGINAL_POSE,
    });
}
export function toRosCmdIn(message) { return CmdInMessageSchema.parse(message); }
