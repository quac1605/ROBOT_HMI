/**
 * backend/test/rosStatus.live.test.mjs
 *
 * KIỂM THỬ VỚI ROS 2 THẬT: một bên ĐẨY /odom, /cmd_out (đóng vai robot), một bên ĐÓN (backend runtime).
 * Cả hai đi qua rosbridge_server thật, message chạy qua ROS 2 (không dùng rosbridge giả).
 *
 * Chạy (cần rosbridge đang mở, ví dụ trong container ros:jazzy):
 *   ROSBRIDGE_URL=ws://127.0.0.1:9090 npm run test:ros-live
 * Không đặt ROSBRIDGE_URL thì toàn bộ test được bỏ qua (skip).
 * Lưu ý: tắt các lệnh `ros2 topic pub /odom` hoặc `/cmd_out` khác trước khi chạy, tránh lẫn dữ liệu.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { RobotStateSchema } from '@robot-hmi/contracts/robotState';
import { createRobotRuntime } from '../src/runtime.js';
import { loadRosStatusSpec } from '../src/ros/rosStatusSpec.js';
import { createFakeRegistry, odometry, twist, waitFor } from './helpers/rosStatusFixtures.mjs';

const ROSBRIDGE_URL = process.env.ROSBRIDGE_URL;
const SKIP = !ROSBRIDGE_URL && 'Đặt ROSBRIDGE_URL (ví dụ ws://127.0.0.1:9090) để chạy test với ROS thật';
const spec = loadRosStatusSpec();
const POSE = spec.status.pose;
const VELOCITY = spec.status.velocity;
const LIVE_WAIT_MS = 8000;

/** Bên ĐẨY: một node rosbridge riêng, advertise rồi publish đều đặn như robot thật. */
async function connectRobotPublisher(url) {
    const ws = new WebSocket(url);
    await Promise.race([
        once(ws, 'open'),
        once(ws, 'error').then(([error]) => { throw new Error(`Không kết nối được rosbridge ${url}: ${error.message}`); }),
    ]);
    const loops = new Map();
    const send = op => ws.send(JSON.stringify(op));
    send({ op: 'advertise', id: 'hmi-test:odom', topic: POSE.topic, type: POSE.type });
    send({ op: 'advertise', id: 'hmi-test:cmd_out', topic: VELOCITY.topic, type: VELOCITY.type });

    return {
        /** Phát liên tục message (10 Hz) lên topic cho tới khi stop(topic). */
        stream(topic, msg) {
            clearInterval(loops.get(topic));
            const publish = () => send({ op: 'publish', topic, msg });
            publish();
            loops.set(topic, setInterval(publish, 100));
        },
        stop(topic) {
            clearInterval(loops.get(topic));
            loops.delete(topic);
        },
        async close() {
            for (const loop of loops.values()) clearInterval(loop);
            send({ op: 'unadvertise', id: 'hmi-test:odom', topic: POSE.topic });
            send({ op: 'unadvertise', id: 'hmi-test:cmd_out', topic: VELOCITY.topic });
            ws.close();
            await once(ws, 'close');
        },
    };
}

test('ROS 2 thật: robot đẩy /odom + /cmd_out, backend đón và phát robot.state', { skip: SKIP }, async t => {
    // Bên ĐÓN: backend runtime đầy đủ, đọc spec config/ros_status.yaml, nối rosbridge thật.
    const registry = createFakeRegistry();
    const runtime = createRobotRuntime({
        pool: { query: async () => { throw new Error('DB không dùng trong test này'); } },
        config: { ROSBRIDGE_URL },
        lifecycle: { authBootEpoch: 'epoch-live', onRevoke: () => () => {} },
        connectionRegistry: registry,
        mapPersistence: { getReadyMap: async () => null },
        assetStore: {},
    });
    const robot = await connectRobotPublisher(ROSBRIDGE_URL);
    t.after(async () => { await robot.close(); runtime.dispose(); });
    const state = () => runtime.sharedRobotState.getSnapshot();

    await t.test(`đẩy ${POSE.topic} (x=1.5, y=-0.8, yaw=45°) và ${VELOCITY.topic} (0.3 m/s, 0.2 rad/s)`, async () => {
        robot.stream(POSE.topic, odometry({ x: 1.5, y: -0.8, yaw: Math.PI / 4 }));
        robot.stream(VELOCITY.topic, twist(0.3, 0.2));

        const payload = await waitFor(() => {
            const s = registry.lastState();
            return s?.rosConnected && s.pose?.x === 1.5 && s.velocity.linearX === 0.3 ? s : null;
        }, { timeoutMs: LIVE_WAIT_MS, label: 'robot.state mang dữ liệu từ ROS' });

        assert.equal(registry.frames.at(-1).type, 'robot.state');
        assert.doesNotThrow(() => RobotStateSchema.parse(payload));
        assert.equal(payload.pose.frameId, 'odom');
        assert.equal(payload.pose.y, -0.8);
        assert.ok(Math.abs(payload.pose.yaw - Math.PI / 4) < 1e-6, `yaw = ${payload.pose.yaw}`);
        assert.deepEqual(payload.velocity, { linearX: 0.3, angularZ: 0.2 });
        assert.ok(payload.poseSourceUpdateAgeMs <= POSE.timeout_ms);
    });

    await t.test('đổi giá trị đang phát -> backend cập nhật theo', async () => {
        robot.stream(POSE.topic, odometry({ x: 3, y: 2, yaw: -Math.PI / 2 }));
        robot.stream(VELOCITY.topic, twist(-0.1, -0.5));
        await waitFor(() => {
            const s = state();
            return s.pose?.x === 3 && Math.abs(s.pose.yaw + Math.PI / 2) < 1e-6
                && s.velocity.linearX === -0.1 && s.velocity.angularZ === -0.5;
        }, { timeoutMs: LIVE_WAIT_MS, label: 'giá trị mới từ ROS' });
    });

    await t.test(`dừng ${VELOCITY.topic} -> vận tốc về 0 sau ${VELOCITY.timeout_ms} ms, vẫn online`, async () => {
        robot.stop(VELOCITY.topic);
        await waitFor(() => {
            const s = state();
            return s.rosConnected && s.velocity.linearX === 0 && s.velocity.angularZ === 0;
        }, { timeoutMs: VELOCITY.timeout_ms + LIVE_WAIT_MS, label: 'vận tốc về 0' });
    });

    await t.test(`dừng ${POSE.topic} -> rosConnected=false, giữ pose cuối`, async () => {
        robot.stop(POSE.topic);
        const lost = await waitFor(() => (state().rosConnected === false ? state() : null),
            { timeoutMs: POSE.timeout_ms + LIVE_WAIT_MS, label: 'rosConnected=false' });
        assert.equal(lost.pose.x, 3);
        assert.ok(lost.poseSourceUpdateAgeMs > POSE.timeout_ms);
    });

    await t.test(`phát lại ${POSE.topic} -> online trở lại`, async () => {
        robot.stream(POSE.topic, odometry({ x: 0.5, y: 0.5, yaw: 0 }));
        await waitFor(() => state().rosConnected && state().pose.x === 0.5,
            { timeoutMs: LIVE_WAIT_MS, label: 'online lại' });
    });
});
