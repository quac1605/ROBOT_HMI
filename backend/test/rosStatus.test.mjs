/**
 * backend/test/rosStatus.test.mjs
 *
 * KIỂM THỬ TRẠNG THÁI ROBOT TỪ ROS 2 (/odom -> pose, /cmd_out -> velocity).
 * Dùng rosbridge server giả (WebSocket, giao thức rosbridge v2) nên không cần cài ROS hay Postgres.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { RobotStateSchema } from '@robot-hmi/contracts/robotState';
import { loadConfig } from '../src/config.js';
import { createBackendRobotState, createRobotRuntime } from '../src/runtime.js';
import { createRobotStateService } from '../src/services/robotStateService.js';
import { createRosStatusService } from '../src/services/rosStatusService.js';
import { createRosbridgeClient } from '../src/ros/rosbridgeClient.js';
import { odometryToPose, twistToVelocity } from '../src/ros/rosStatusMessages.js';
import { loadRosStatusSpec, parseRosStatusSpec } from '../src/ros/rosStatusSpec.js';
import { createFakeRegistry, odometry, twist, waitFor } from './helpers/rosStatusFixtures.mjs';

// Spec rút ngắn thời gian để test chạy nhanh; topic/kiểu message giữ như file thật.
const FAST_SPEC = parseRosStatusSpec({
    version: 1,
    bridge: { protocol: 'rosbridge_v2', reconnect_ms: 100 },
    publish_rate_hz: 50,
    status: {
        pose: { topic: '/odom', type: 'nav_msgs/msg/Odometry', default_frame_id: 'odom', throttle_ms: 0, timeout_ms: 300 },
        velocity: { topic: '/cmd_out', type: 'geometry_msgs/msg/Twist', throttle_ms: 0, timeout_ms: 300 },
    },
});

/** rosbridge giả: ghi lại các op 'subscribe' và cho phép publish xuống client. */
async function startFakeRosbridge(port = 0) {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });
    await new Promise(resolve => wss.once('listening', resolve));
    const subscribeOps = [];
    wss.on('connection', ws => {
        ws.on('message', data => {
            const op = JSON.parse(String(data));
            if (op.op === 'subscribe') subscribeOps.push(op);
        });
    });
    return {
        port: wss.address().port,
        url: `ws://127.0.0.1:${wss.address().port}`,
        subscribeOps,
        publish(topic, msg) {
            for (const client of wss.clients) client.send(JSON.stringify({ op: 'publish', topic, msg }));
        },
        sendRaw(text) {
            for (const client of wss.clients) client.send(text);
        },
        async close() {
            for (const client of wss.clients) client.terminate();
            await new Promise(resolve => wss.close(resolve));
        },
    };
}

test('odometryToPose: quaternion -> yaw (rad), giữ frame_id, quaternion chưa chuẩn hóa vẫn đúng', () => {
    const pose = odometryToPose(odometry({ x: 1.25, y: -3.5, yaw: Math.PI / 2, frameId: 'odom' }));
    assert.equal(pose.frameId, 'odom');
    assert.equal(pose.x, 1.25);
    assert.equal(pose.y, -3.5);
    assert.ok(Math.abs(pose.yaw - Math.PI / 2) < 1e-9);

    const back = odometryToPose(odometry({ x: 0, y: 0, yaw: -2.5 }));
    assert.ok(Math.abs(back.yaw + 2.5) < 1e-9);

    const scaled = odometry({ x: 0, y: 0, yaw: 0.7 });
    const q = scaled.pose.pose.orientation;
    Object.assign(q, { z: q.z * 3, w: q.w * 3 });
    assert.ok(Math.abs(odometryToPose(scaled).yaw - 0.7) < 1e-9);

    // frame_id rỗng -> dùng default trong spec
    assert.equal(odometryToPose(odometry({ x: 0, y: 0, yaw: 0, frameId: '  ' }), 'odom').frameId, 'odom');
});

test('odometryToPose / twistToVelocity: message sai trả về null', () => {
    assert.equal(odometryToPose(null), null);
    assert.equal(odometryToPose({ pose: { pose: { position: { x: 1 } } } }), null);
    const nan = odometry({ x: 0, y: 0, yaw: 0 });
    nan.pose.pose.position.x = Number.NaN;
    assert.equal(odometryToPose(nan), null);
    const zeroQuat = odometry({ x: 0, y: 0, yaw: 0 });
    zeroQuat.pose.pose.orientation = { x: 0, y: 0, z: 0, w: 0 };
    assert.equal(odometryToPose(zeroQuat), null);

    assert.deepEqual(twistToVelocity(twist(0.4, -0.2)), { linearX: 0.4, angularZ: -0.2 });
    assert.equal(twistToVelocity({ linear: { x: 'nhanh' }, angular: { z: 0 } }), null);
    assert.equal(twistToVelocity(undefined), null);
});

test('ros_status.yaml: spec thật hợp lệ, đúng /odom và /cmd_out', () => {
    const spec = loadRosStatusSpec();
    assert.equal(spec.status.pose.topic, '/odom');
    assert.equal(spec.status.pose.type, 'nav_msgs/msg/Odometry');
    assert.equal(spec.status.velocity.topic, '/cmd_out');
    assert.equal(spec.status.velocity.type, 'geometry_msgs/msg/Twist');
    assert.equal(spec.publish_rate_hz, 10);
});

test('ros_status.yaml: spec sai cấu trúc bị từ chối ngay', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ros-spec-'));
    const file = path.join(dir, 'bad.yaml');
    writeFileSync(file, 'version: 1\nbridge: { protocol: rosbridge_v2, reconnect_ms: 1000 }\npublish_rate_hz: 10\n'
        + 'status:\n  pose: { topic: odom, type: nav_msgs/msg/Odometry, default_frame_id: odom, timeout_ms: 1000 }\n'
        + '  velocity: { topic: /cmd_out, type: geometry_msgs/msg/TwistStamped, timeout_ms: 1000 }\n');
    assert.throws(() => loadRosStatusSpec(file),
        /ROS_STATUS_SPEC_INVALID.*status\.pose\.topic.*status\.velocity\.type/);
});

test('config: ROSBRIDGE_URL tùy chọn, chỉ nhận ws:// hoặc wss://', () => {
    const env = {
        APP_ORIGIN: 'http://127.0.0.1:5173',
        DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
        SESSION_SECRET: 'ab12'.repeat(16),
        DATA_DIR: '/tmp/robot-hmi',
    };
    assert.equal(loadConfig(env).ROSBRIDGE_URL, undefined);
    assert.equal(loadConfig({ ...env, ROSBRIDGE_URL: '' }).ROSBRIDGE_URL, undefined);
    assert.equal(loadConfig({ ...env, ROSBRIDGE_URL: 'ws://192.168.1.10:9090' }).ROSBRIDGE_URL, 'ws://192.168.1.10:9090');
    assert.throws(() => loadConfig({ ...env, ROSBRIDGE_URL: 'http://192.168.1.10:9090' }),
        /CONFIG_VALIDATION_FAILED.*ROSBRIDGE_URL/);
});

test('Luồng: rosbridge /odom + /cmd_out -> sharedRobotState -> frame robot.state cho frontend', async t => {
    const bridge = await startFakeRosbridge();
    const sharedRobotState = createBackendRobotState();
    const registry = createFakeRegistry();
    const stateService = createRobotStateService({ sharedRobotState, registry, lifecycle: { authBootEpoch: 'epoch-test' } });
    const service = createRosStatusService({
        sharedRobotState,
        spec: FAST_SPEC,
        client: createRosbridgeClient({ url: bridge.url, reconnectMs: FAST_SPEC.bridge.reconnect_ms }),
        mapFrameId: () => 'map',
    });
    t.after(async () => { service.dispose(); stateService.dispose(); await bridge.close(); });
    service.start();

    // 1. Backend đăng ký đúng topic và kiểu message trong spec
    await waitFor(() => bridge.subscribeOps.length === 4, { label: 'subscribe ops' });
    assert.deepEqual(bridge.subscribeOps.map(op => [op.topic, op.type]).sort(), [
        ['/cmd_out', 'geometry_msgs/msg/Twist'],
        ['/odom', 'nav_msgs/msg/Odometry'],
        ['/tf', 'tf2_msgs/msg/TFMessage'],
        ['/tf_static', 'tf2_msgs/msg/TFMessage'],
    ]);
    assert.equal(bridge.subscribeOps.find(op => op.topic === '/tf_static').qos.durability, 'transient_local');

    // 2. Chưa có /odom: chưa coi là đã kết nối ROS, pose null, vận tốc 0
    assert.equal(sharedRobotState.getSnapshot().rosConnected, false);
    assert.equal(sharedRobotState.getSnapshot().pose, null);

    // 3. Có dữ liệu -> state và frame robot.state mang đúng số liệu
    bridge.publish('/odom', odometry({ x: 2.5, y: -1.2, yaw: Math.PI / 4 }));
    bridge.publish('/cmd_out', twist(0.35, -0.6));
    const payload = await waitFor(() => {
        const state = registry.lastState();
        return state?.rosConnected && state.velocity.linearX === 0.35 ? state : null;
    }, { label: 'robot.state có pose + velocity' });

    assert.equal(registry.frames.at(-1).type, 'robot.state');
    assert.doesNotThrow(() => RobotStateSchema.parse(payload));
    assert.equal(payload.pose.frameId, 'odom');
    assert.equal(payload.pose.x, 2.5);
    assert.equal(payload.pose.y, -1.2);
    assert.ok(Math.abs(payload.pose.yaw - Math.PI / 4) < 1e-9);
    assert.deepEqual(payload.velocity, { linearX: 0.35, angularZ: -0.6 });
    assert.ok(payload.poseSourceUpdateAgeMs >= 0 && payload.poseSourceUpdateAgeMs <= FAST_SPEC.status.pose.timeout_ms);
    assert.equal(payload.mapPose, null, 'không vẽ /odom lên /map khi chưa có TF');

    bridge.publish('/tf', { transforms: [{
        header: { frame_id: 'map' }, child_frame_id: 'odom',
        transform: {
            translation: { x: 1, y: 2, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
    }] });
    const mapped = await waitFor(() => sharedRobotState.getSnapshot().mapPose,
        { label: 'mapPose từ /odom + /tf' });
    assert.equal(mapped.frameId, 'map');
    assert.ok(Math.abs(mapped.x - 3.5) < 1e-9);
    assert.ok(Math.abs(mapped.y - 0.8) < 1e-9);
    assert.ok(Math.abs(mapped.yaw - Math.PI / 4) < 1e-9);

    // 4. Message hỏng bị bỏ qua, không ghi đè số liệu tốt
    bridge.publish('/odom', { pose: { pose: { position: { x: 'abc' } } } });
    bridge.publish('/cmd_out', { linear: {} });
    bridge.sendRaw('{not json');
    await waitFor(() => service.getStatus().droppedMessages === 2, { label: 'đếm message hỏng' });
    assert.equal(sharedRobotState.getSnapshot().pose.x, 2.5);

    // 5. Sequence frame tăng đều (heartbeat theo publish_rate_hz)
    const sequences = registry.frames.map(f => f.sequence);
    assert.ok(sequences.every((s, i) => i === 0 || s > sequences[i - 1]));
});

test('Luồng: /cmd_out im lặng -> vận tốc 0; /odom im lặng -> rosConnected=false nhưng giữ pose cuối', async t => {
    const bridge = await startFakeRosbridge();
    const sharedRobotState = createBackendRobotState();
    const service = createRosStatusService({
        sharedRobotState,
        spec: FAST_SPEC,
        client: createRosbridgeClient({ url: bridge.url, reconnectMs: 100 }),
        mapFrameId: () => 'map',
    });
    t.after(async () => { service.dispose(); await bridge.close(); });
    service.start();
    await waitFor(() => bridge.subscribeOps.length === 4, { label: 'subscribe ops' });

    bridge.publish('/cmd_out', twist(0.5, 0.1));
    // Giữ /odom đều đặn để chỉ /cmd_out quá hạn
    const keepOdom = setInterval(() => bridge.publish('/odom', odometry({ x: 1, y: 1, yaw: 0 })), 50);
    t.after(() => clearInterval(keepOdom));

    await waitFor(() => sharedRobotState.getSnapshot().velocity.linearX === 0.5, { label: 'nhận vận tốc' });
    await waitFor(() => {
        const s = sharedRobotState.getSnapshot();
        return s.rosConnected && s.velocity.linearX === 0 && s.velocity.angularZ === 0;
    }, { label: 'vận tốc về 0 sau timeout /cmd_out' });

    clearInterval(keepOdom);
    const lost = await waitFor(() => {
        const s = sharedRobotState.getSnapshot();
        return s.rosConnected === false ? s : null;
    }, { label: 'rosConnected=false sau timeout /odom' });
    assert.deepEqual(lost.pose, { frameId: 'odom', x: 1, y: 1, yaw: 0 });
    assert.ok(lost.poseSourceUpdateAgeMs > FAST_SPEC.status.pose.timeout_ms);
});

test('Luồng: rosbridge rớt -> rosConnected=false; bật lại -> tự kết nối và subscribe lại', async t => {
    let bridge = await startFakeRosbridge();
    const port = bridge.port;
    const sharedRobotState = createBackendRobotState();
    const service = createRosStatusService({
        sharedRobotState,
        spec: FAST_SPEC,
        client: createRosbridgeClient({ url: bridge.url, reconnectMs: 100 }),
        mapFrameId: () => 'map',
    });
    t.after(async () => { service.dispose(); await bridge.close(); });
    service.start();
    await waitFor(() => bridge.subscribeOps.length === 4, { label: 'subscribe lần đầu' });
    bridge.publish('/odom', odometry({ x: 3, y: 4, yaw: 1 }));
    await waitFor(() => sharedRobotState.getSnapshot().rosConnected, { label: 'online' });

    bridge.publish('/tf_static', { transforms: [{
        header: { frame_id: 'map' }, child_frame_id: 'odom',
        transform: {
            translation: { x: 1, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
    }] });
    await waitFor(() => sharedRobotState.getSnapshot().mapPose?.x === 4,
        { label: 'mapPose trước khi reconnect' });

    await bridge.close();
    await waitFor(() => sharedRobotState.getSnapshot().rosConnected === false, { label: 'offline khi mất bridge' });
    assert.equal(sharedRobotState.getSnapshot().mapPose, null);

    bridge = await startFakeRosbridge(port);
    await waitFor(() => bridge.subscribeOps.length === 4, { label: 'subscribe lại sau reconnect' });
    bridge.publish('/odom', odometry({ x: 5, y: 6, yaw: 0 }));
    await waitFor(() => {
        const s = sharedRobotState.getSnapshot();
        return s.rosConnected && s.pose.x === 5;
    }, { label: 'online lại với pose mới' });
    assert.equal(sharedRobotState.getSnapshot().mapPose, null,
        'TF của kết nối cũ không được dùng sau khi reconnect');
});

test('Runtime: có ROSBRIDGE_URL thì createRobotRuntime đẩy /odom, /cmd_out lên robot.state', async t => {
    const bridge = await startFakeRosbridge();
    const registry = createFakeRegistry();
    const runtime = createRobotRuntime({
        pool: { query: async () => { throw new Error('DB không dùng trong test này'); } },
        config: { ROSBRIDGE_URL: bridge.url },
        logger: undefined,
        lifecycle: { authBootEpoch: 'epoch-test', onRevoke: () => () => {} },
        connectionRegistry: registry,
        mapPersistence: { getReadyMap: async () => null },
        assetStore: {},
    });
    t.after(async () => { runtime.dispose(); await bridge.close(); });
    assert.ok(runtime.rosStatusService, 'runtime phải bật rosStatusService khi có ROSBRIDGE_URL');

    await waitFor(() => bridge.subscribeOps.length === 4, { label: 'subscribe ops' });
    bridge.publish('/odom', odometry({ x: -0.75, y: 0.5, yaw: -Math.PI / 2 }));
    bridge.publish('/cmd_out', twist(0.2, 0.3));
    const payload = await waitFor(() => {
        const state = registry.lastState();
        return state?.rosConnected && state.velocity.angularZ === 0.3 ? state : null;
    }, { label: 'robot.state từ runtime' });
    assert.equal(payload.pose.x, -0.75);
    assert.ok(Math.abs(payload.pose.yaw + Math.PI / 2) < 1e-9);
    assert.deepEqual(runtime.robotStateService.getRobotState().velocity, { linearX: 0.2, angularZ: 0.3 });
});

test('Runtime: không có ROSBRIDGE_URL thì giữ nguyên hành vi mock (không mở kết nối ROS)', () => {
    const runtime = createRobotRuntime({
        pool: { query: async () => { throw new Error('DB không dùng trong test này'); } },
        config: {},
        logger: undefined,
        lifecycle: { authBootEpoch: 'epoch-test', onRevoke: () => () => {} },
        connectionRegistry: createFakeRegistry(),
        mapPersistence: { getReadyMap: async () => null },
        assetStore: {},
    });
    try {
        assert.equal(runtime.rosStatusService, null);
        assert.equal(runtime.sharedRobotState.getSnapshot().rosConnected, false);
    } finally { runtime.dispose(); }
});
