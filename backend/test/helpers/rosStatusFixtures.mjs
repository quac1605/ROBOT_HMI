/**
 * backend/test/helpers/rosStatusFixtures.mjs
 *
 * Dữ liệu và tiện ích dùng chung cho test trạng thái ROS (rosbridge giả và rosbridge thật).
 */
import assert from 'node:assert/strict';

export function odometry({ x, y, yaw, frameId = 'odom' }) {
    return {
        header: { stamp: { sec: 0, nanosec: 0 }, frame_id: frameId },
        child_frame_id: 'base_link',
        pose: {
            pose: {
                position: { x, y, z: 0 },
                orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
            },
            covariance: new Array(36).fill(0),
        },
        twist: { twist: { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } }, covariance: new Array(36).fill(0) },
    };
}

export function twist(linearX, angularZ) {
    return { linear: { x: linearX, y: 0, z: 0 }, angular: { x: 0, y: 0, z: angularZ } };
}

export async function waitFor(predicate, { timeoutMs = 2000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(`Hết thời gian chờ: ${label}`);
}

/** Registry giả thay cho WebSocket tới frontend: giữ lại các frame 'robot.state' đã broadcast. */
export function createFakeRegistry() {
    const frames = [];
    return {
        frames,
        broadcastApp: frame => frames.push(structuredClone(frame)),
        send: () => true,
        lastState: () => frames.at(-1)?.payload,
    };
}
