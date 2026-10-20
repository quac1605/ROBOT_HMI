/**
 * backend/src/ros/rosStatusSpec.js
 *
 * ĐỌC VÀ KIỂM TRA HỢP ĐỒNG TRẠNG THÁI ROS (config/ros_status.yaml).
 * Fail-fast: sai cấu trúc thì throw lúc khởi động, không chạy với spec nửa vời.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const DEFAULT_ROS_STATUS_SPEC_PATH = fileURLToPath(new URL('../../config/ros_status.yaml', import.meta.url));

const TopicSpec = z.object({
    topic: z.string().regex(/^\/[A-Za-z0-9_/]+$/),
    throttle_ms: z.number().int().min(0).default(0),
    timeout_ms: z.number().int().positive(),
});

const RosStatusSpecSchema = z.object({
    version: z.literal(1),
    bridge: z.object({
        protocol: z.literal('rosbridge_v2'),
        reconnect_ms: z.number().int().positive(),
    }),
    publish_rate_hz: z.number().positive().max(50),
    status: z.object({
        pose: TopicSpec.extend({
            type: z.literal('nav_msgs/msg/Odometry'),
            default_frame_id: z.string().trim().min(1).max(128),
        }),
        velocity: TopicSpec.extend({
            type: z.literal('geometry_msgs/msg/Twist'),
        }),
    }),
});

export function parseRosStatusSpec(raw) {
    const result = RosStatusSpecSchema.safeParse(raw);
    if (!result.success) {
        const fields = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new Error(`ROS_STATUS_SPEC_INVALID: [${fields}]`);
    }
    return Object.freeze(result.data);
}

export function loadRosStatusSpec(specPath = DEFAULT_ROS_STATUS_SPEC_PATH) {
    return parseRosStatusSpec(parseYaml(readFileSync(specPath, 'utf8')));
}
