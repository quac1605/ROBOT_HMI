/**
 * backend/test/cmdIn.test.mjs
 *
 * KIỂM THỬ GÓI /cmd_in: CHỌN MODE, GHÉP VỚI ADAPTER + controlAuthority, PUBLISHER rosbridge, CONFIG.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMotionAdmissionGate } from '@robot-hmi/control-domain/motionAdmissionGate';
import { createControlAuthority } from '@robot-hmi/control-domain/controlAuthority';
import { WebSocketServer } from 'ws';
import {
    CmdInMessageSchema, buildCmdInMessage, poseToPoseStamped, yawToQuaternion, toRosTime, toRosCmdIn,
} from '@robot-hmi/contracts/cmdIn';
import { createCmdInService } from '../src/services/cmdInService.js';
import { createMockRosAdapter } from '../src/ros/mockRosAdapter.js';
import { createRosbridgeCmdInPublisher } from '../src/ros/rosbridgeCmdInPublisher.js';
import { createRosbridgeClient } from '../src/ros/rosbridgeClient.js';
import { twistToVelocity } from '../src/ros/rosStatusMessages.js';
import { createRobotRuntime } from '../src/runtime.js';
import { createFakeRegistry, twist, waitFor } from './helpers/rosStatusFixtures.mjs';
import { loadConfig } from '../src/config.js';

const ZERO = { linearX: 0, angularZ: 0 };
const NOW = 1_761_000_000_123; // ms epoch cố định cho header.stamp
const packet = (mode, linear = 0, angular = 0, { target = null, original = null } = {}) => ({
    target, mode, joystick: { linear, angular }, original_position: original,
});
const POSES = [
    { frameId: 'map', x: 1, y: 2, yaw: Math.PI / 2 },
    { frameId: 'map', x: -0.5, y: 3, yaw: 0 },
];
const targetsOf = poses => poses.map(pose => poseToPoseStamped({ x: pose.x, y: pose.y, theta: pose.yaw }, { stamp: NOW }));

function recorder() {
    const sent = [];
    return { sent, publisher: { publish: message => sent.push(structuredClone(message)) } };
}

function serviceWith(publisher) {
    return createCmdInService({ publishers: [publisher], now: () => NOW });
}

// --- cmdInService: quy tắc chọn mode ---

test('không phát gì trước lệnh điều khiển đầu tiên', () => {
    const { sent, publisher } = recorder();
    const service = serviceWith(publisher);
    service.onMotionCommand({ origin: 'stop', velocity: ZERO });
    assert.deepEqual(sent, []);
});

test('teleop là manual và mang đúng vận tốc', () => {
    const { sent, publisher } = recorder();
    const service = serviceWith(publisher);
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0, angularZ: 0.3 } });
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: -0.3, angularZ: 0 } });
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO });
    assert.deepEqual(sent, [packet('manual', 0, 0.3), packet('manual', -0.3, 0), packet('manual')]);
    for (const message of sent) CmdInMessageSchema.parse(message);
});

test('stop được giữ qua lệnh 0, lệnh lái khác 0 đưa về manual', () => {
    const { sent, publisher } = recorder();
    const service = serviceWith(publisher);
    service.emergencyStop();
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO });
    service.onMotionCommand({ origin: 'stop', velocity: ZERO });
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0.3, angularZ: 0 } });
    assert.deepEqual(sent, [packet('stop'), packet('stop'), packet('stop'), packet('manual', 0.3, 0)]);
});

test('nhiệm vụ là auto mang target PoseStamped, joystick luôn 0; dừng nội bộ giữ auto; hủy là stop', () => {
    const { sent, publisher } = recorder();
    const service = serviceWith(publisher);
    service.emergencyStop();
    service.onMotionCommand({ origin: 'mission', velocity: ZERO, poses: POSES });
    service.onMotionCommand({ origin: 'mission', velocity: { linearX: 0.3, angularZ: 0.05 } });
    service.onMotionCommand({ origin: 'stop', velocity: ZERO });
    service.onMotionCommand({ origin: 'cancel', velocity: ZERO });
    const auto = packet('auto', 0, 0, { target: targetsOf(POSES) });
    assert.deepEqual(sent, [packet('stop'), auto, auto, auto, packet('stop')]);
    for (const message of sent) CmdInMessageSchema.parse(message);
});

test('lệnh vận tốc 0 không đổi mode; chọn mode lái mới đổi', () => {
    const { sent, publisher } = recorder();
    const service = serviceWith(publisher);
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO }); // chưa chọn mode: im lặng
    service.onMotionCommand({ origin: 'mission', velocity: ZERO, poses: POSES });
    service.onMotionCommand({ origin: 'stop', velocity: ZERO });     // kết thúc nhiệm vụ: giữ auto
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO });   // trả/hết hạn quyền lái: giữ auto
    service.selectMode('manual');
    service.onRobotState({ mode: 'mapping' });
    service.onRobotState({ mode: 'idle' });                           // kết thúc phiên bản đồ: giữ slam
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO });
    service.selectMode('auto');                                       // không phải mode lái: bỏ qua
    const auto = packet('auto', 0, 0, { target: targetsOf(POSES) });
    assert.deepEqual(sent, [auto, auto, auto, packet('manual'), packet('slam'), packet('slam')]);
});

test('vào phiên tạo bản đồ phát slam; joystick trong phiên là slam, ngoài phiên là manual', () => {
    const { sent, publisher } = recorder();
    const service = serviceWith(publisher);
    service.onRobotState({ mode: 'idle' });
    service.onRobotState({ mode: 'mapping' });
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0.3, angularZ: 0 } });
    service.emergencyStop();
    // Trạng thái robot cập nhật liên tục trong phiên không được kéo stop về slam.
    service.onRobotState({ mode: 'mapping' });
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO });
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0, angularZ: -0.3 } });
    service.onRobotState({ mode: 'idle' });
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0.3, angularZ: 0 } });
    assert.deepEqual(sent, [
        packet('slam'), packet('slam', 0.3, 0), packet('stop'), packet('stop'),
        packet('slam', 0, -0.3), packet('manual', 0.3, 0),
    ]);
});

test('vị trí ban đầu chỉ nhập một lần và đi kèm mọi gói sau đó', () => {
    const { sent, publisher } = recorder();
    const service = serviceWith(publisher);
    assert.equal(service.getOriginalPosition(), null);
    assert.throws(() => service.setOriginalPosition({ x: 1, y: 2 }));
    assert.throws(() => service.setOriginalPosition({ x: 1, y: 2, theta: Number.NaN }));
    const original = { x: 0.5, y: -1, theta: 0.25 };
    assert.deepEqual(service.setOriginalPosition(original), original);
    assert.throws(() => service.setOriginalPosition({ x: 9, y: 9, theta: 0 }),
        error => error.code === 'ORIGINAL_POSITION_ALREADY_SET' && error.status === 409);
    assert.deepEqual(service.getOriginalPosition(), original);

    service.onMotionCommand({ origin: 'mission', velocity: ZERO, poses: POSES.slice(0, 1) });
    service.emergencyStop();
    assert.deepEqual(sent, [
        packet('auto', 0, 0, { target: targetsOf(POSES.slice(0, 1)), original }),
        packet('stop', 0, 0, { original }),
    ]);
});

test('publisher lỗi không chặn publisher khác', () => {
    const { sent, publisher } = recorder();
    const broken = { publish() { throw new Error('boom'); } };
    const service = createCmdInService({ publishers: [broken, publisher] });
    service.emergencyStop();
    assert.deepEqual(sent, [packet('stop')]);
});

// --- Ghép adapter + controlAuthority + cmdInService như runtime.js ---

function createStack() {
    const { sent, publisher } = recorder();
    const cmdIn = serviceWith(publisher);
    let state = {
        mode: 'idle', rosConnected: true, physicalEstopActive: false, motionInhibited: false,
        motionInhibitReason: null, activeMissionId: null, activeMappingSessionId: null, velocity: ZERO,
    };
    const sharedRobotState = {
        getSnapshot: () => structuredClone(state),
        update(patch) { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; },
    };
    // Timer nguồn đo do test điều khiển bằng adapter.sample().
    const adapter = createMockRosAdapter({
        setEvery: () => null, clearEvery: () => {},
        onMotionCommand: command => cmdIn.onMotionCommand(command),
    });
    const authority = createControlAuthority({
        sharedRobotState,
        telemetry: { getControlState: () => ({ snapshot: sharedRobotState.getSnapshot(), transportStale: false }) },
        motionGate: createMotionAdmissionGate(),
        motionSource: adapter,
        onStopRequested: request => { if (!request?.keepMode) cmdIn.emergencyStop(); },
        onControlClaimed: context => cmdIn.selectMode(context.kind === 'mapping' ? 'slam' : 'manual'),
    });
    const sessionId = authority.createSession('s1');
    const heartbeats = [];
    authority.subscribeControl(sessionId, envelope => {
        if (envelope.type === 'control.heartbeat') heartbeats.push(envelope.payload);
    });
    return {
        sent, adapter, authority, sessionId, cmdIn,
        token: () => heartbeats.at(-1).freshnessToken,
        dispose() { authority.dispose(); adapter.dispose(); cmdIn.dispose(); },
    };
}

test('lái tay qua controlAuthority ra manual; lệnh bị từ chối không ra /cmd_in', async t => {
    const stack = createStack();
    t.after(() => stack.dispose());
    stack.adapter.sample();
    const lease = await stack.authority.acquireControl({ requestId: 'r1' }, stack.sessionId);
    const base = { leaseId: lease.leaseId, freshnessToken: stack.token() };

    stack.authority.sendVelocity({ ...base, sequence: 1, linearX: 0.2, angularZ: 0 }, stack.sessionId);
    assert.throws(() => stack.authority.sendVelocity(
        { ...base, freshnessToken: 'sai-token', sequence: 2, linearX: 0.2, angularZ: 0 }, stack.sessionId));
    assert.throws(() => stack.authority.sendVelocity(
        { ...base, sequence: 3, linearX: 5, angularZ: 0 }, stack.sessionId));

    // Nhận quyền lái là chọn manual (joystick 0), rồi đúng một lệnh hợp lệ.
    assert.deepEqual(stack.sent, [packet('manual'), packet('manual', 0.2, 0)]);
});

test('nhả joystick (keepMode) dừng robot nhưng giữ mode; nút dừng mới chuyển sang stop', async t => {
    const stack = createStack();
    t.after(() => stack.dispose());
    stack.adapter.sample();
    const lease = await stack.authority.acquireControl({ requestId: 'r1' }, stack.sessionId);
    stack.authority.sendVelocity({
        leaseId: lease.leaseId, freshnessToken: stack.token(), sequence: 1, linearX: 0.2, angularZ: 0,
    }, stack.sessionId);
    const before = stack.sent.length;
    await stack.authority.requestStop({ requestId: 'release-1', keepMode: true }, stack.sessionId);
    const afterRelease = stack.sent.slice(before);
    assert.ok(afterRelease.length >= 1);
    for (const message of afterRelease) assert.deepEqual(message, packet('manual'));
});

test('yêu cầu dừng phát stop trước mọi lệnh 0 do thu hồi quyền lái', async t => {
    const stack = createStack();
    t.after(() => stack.dispose());
    stack.adapter.sample();
    const lease = await stack.authority.acquireControl({ requestId: 'r1' }, stack.sessionId);
    stack.authority.sendVelocity({
        leaseId: lease.leaseId, freshnessToken: stack.token(), sequence: 1, linearX: 0.2, angularZ: 0,
    }, stack.sessionId);

    await stack.authority.requestStop({ requestId: 'stop-1' }, stack.sessionId);

    const [claimed, first, ...rest] = stack.sent;
    assert.deepEqual(claimed, packet('manual'));
    assert.deepEqual(first, packet('manual', 0.2, 0));
    assert.ok(rest.length >= 2);
    assert.deepEqual(rest[0], packet('stop'));
    for (const message of rest) assert.deepEqual(message, packet('stop'));
});

test('trả quyền lái phát manual vận tốc 0', async t => {
    const stack = createStack();
    t.after(() => stack.dispose());
    stack.adapter.sample();
    const lease = await stack.authority.acquireControl({ requestId: 'r1' }, stack.sessionId);
    stack.authority.sendVelocity({
        leaseId: lease.leaseId, freshnessToken: stack.token(), sequence: 1, linearX: 0.2, angularZ: 0,
    }, stack.sessionId);
    await stack.authority.releaseControl({ requestId: 'r2', leaseId: lease.leaseId }, stack.sessionId);
    assert.deepEqual(stack.sent.at(-1), packet('manual'));
});

test('vòng đời nhiệm vụ qua adapter: auto mang target, joystick 0; hủy nhiệm vụ là stop', t => {
    const stack = createStack();
    t.after(() => stack.dispose());
    const handle = stack.adapter.beginMission('m1', POSES);
    stack.adapter.writeMissionVelocity(handle, { linearX: 0.3, angularZ: 0.05 });
    stack.adapter.finishMission(handle);
    const second = stack.adapter.beginMission('m2', POSES.slice(1));
    stack.adapter.cancelMission(second);
    const first = packet('auto', 0, 0, { target: targetsOf(POSES) });
    assert.deepEqual(stack.sent, [
        first, first, first,
        packet('auto', 0, 0, { target: targetsOf(POSES.slice(1)) }),
        packet('stop'),
    ]);
});

// --- Chuyển x, y, theta sang geometry_msgs/msg/PoseStamped ---

test('poseToPoseStamped dựng đúng header, position và quaternion', () => {
    assert.deepEqual(poseToPoseStamped({ x: 1.5, y: -2, theta: Math.PI / 2 }, { stamp: NOW }), {
        header: { stamp: { sec: 1_761_000_000, nanosec: 123_000_000 }, frame_id: 'map' },
        pose: {
            position: { x: 1.5, y: -2, z: 0 },
            orientation: { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) },
        },
    });
    assert.deepEqual(yawToQuaternion(0), { x: 0, y: 0, z: 0, w: 1 });
    const q = yawToQuaternion(Math.PI);
    assert.ok(Math.abs(q.z - 1) < 1e-12 && Math.abs(q.w) < 1e-12);
    // Quay ngược lại được góc ban đầu.
    for (const theta of [-3, -1.2, 0.4, 2.9]) {
        const { z, w } = yawToQuaternion(theta);
        assert.ok(Math.abs(2 * Math.atan2(z, w) - theta) < 1e-12);
    }
    assert.deepEqual(toRosTime(999), { sec: 0, nanosec: 999_000_000 });
    assert.equal(poseToPoseStamped({ x: 0, y: 0, theta: 0 }, { frameId: 'odom', stamp: 0 }).header.frame_id, 'odom');
    assert.throws(() => poseToPoseStamped({ x: Number.NaN, y: 0, theta: 0 }));
});

test('toRosCmdIn: null thành mảng rỗng / has_original_position = false', () => {
    assert.deepEqual(toRosCmdIn(packet('manual', 0.3, 0)), {
        target: [], mode: 'manual', joystick: { linear: 0.3, angular: 0 },
        has_original_position: false, original_position: { x: 0, y: 0, theta: 0 },
    });
    const target = targetsOf(POSES);
    const original = { x: 0.5, y: -1, theta: 0.25 };
    assert.deepEqual(toRosCmdIn(packet('auto', 0, 0, { target, original })), {
        target, mode: 'auto', joystick: { linear: 0, angular: 0 },
        has_original_position: true, original_position: original,
    });
    assert.throws(() => toRosCmdIn({ ...packet('stop'), extra: 1 }));
});

test('gói chỉ mang target khi mode auto', () => {
    const target = targetsOf(POSES);
    assert.throws(() => buildCmdInMessage({ mode: 'auto', velocity: ZERO }));
    assert.throws(() => buildCmdInMessage({ mode: 'manual', velocity: ZERO, target }));
    assert.throws(() => buildCmdInMessage({ mode: 'stop', velocity: { linearX: 0.1, angularZ: 0 } }));
    assert.throws(() => buildCmdInMessage({ mode: 'emergency', velocity: ZERO }));
    assert.deepEqual(buildCmdInMessage({ mode: 'auto', velocity: ZERO, target }), packet('auto', 0, 0, { target }));
});

// --- Kiểu vận tốc dùng chung với /cmd_out ---

test('/cmd_in dùng cùng kiểu vận tốc với /cmd_out: Twist -> VelocitySchema -> gói giữ nguyên số liệu', () => {
    for (const [v, w] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3], [0.12, -0.45]]) {
        const velocity = twistToVelocity(twist(v, w));
        assert.deepEqual(velocity, { linearX: v, angularZ: w });
        assert.deepEqual(buildCmdInMessage({ mode: 'manual', velocity }), packet('manual', v, w));
    }
    // Định dạng gói: đúng 4 trường, -0 thành 0.
    assert.deepEqual(Object.keys(buildCmdInMessage({ mode: 'slam', velocity: ZERO })),
        ['target', 'mode', 'joystick', 'original_position']);
    assert.deepEqual(buildCmdInMessage({ mode: 'stop', velocity: { linearX: -0, angularZ: -0 } }),
        packet('stop'));
    // Vận tốc sai kiểu bị chặn như /cmd_out.
    assert.throws(() => buildCmdInMessage({ mode: 'manual', velocity: { linear: 0.3, angular: 0 } }));
    assert.throws(() => buildCmdInMessage({ mode: 'manual', velocity: { linearX: Number.NaN, angularZ: 0 } }));
});

// --- rosbridgeCmdInPublisher trên client dùng chung, WebSocket giả ---

function fakeSockets() {
    const sockets = [];
    class FakeSocket extends EventEmitter {
        constructor(url) { super(); this.url = url; this.frames = []; sockets.push(this); }
        send(data) { this.frames.push(JSON.parse(data)); }
        terminate() { this.emit('close'); }
    }
    return { sockets, FakeSocket };
}

test('publisher advertise khi nối, bỏ gói lúc mất kết nối, nối lại thì phát gói cuối với vận tốc 0', () => {
    const { sockets, FakeSocket } = fakeSockets();
    const timers = [];
    const client = createRosbridgeClient({
        url: 'ws://127.0.0.1:9090', reconnectMs: 1000, WebSocketImpl: FakeSocket,
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimer: () => {},
    });
    const publisher = createRosbridgeCmdInPublisher({ client });
    client.start();

    publisher.publish(packet('manual', 0.3, 0)); // chưa nối: bỏ
    sockets[0].emit('open');
    assert.deepEqual(sockets[0].frames[0],
        { op: 'advertise', id: 'hmi:/cmd_in', topic: '/cmd_in', type: 'robot_hmi_msgs/msg/CmdIn' });
    // Gói mới nhất được gửi lại khi nối, nhưng vận tốc khác 0 cũ bị đưa về 0.
    assert.deepEqual(sockets[0].frames[1].msg, toRosCmdIn(packet('manual')));

    publisher.publish(packet('stop'));
    assert.deepEqual(sockets[0].frames[2], {
        op: 'publish', topic: '/cmd_in', msg: toRosCmdIn(packet('stop')),
    });

    sockets[0].emit('close');
    const auto = packet('auto', 0, 0, { target: targetsOf(POSES), original: { x: 0, y: 0, theta: 0 } });
    publisher.publish(auto);
    assert.equal(sockets[0].frames.length, 3);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 1000);

    timers[0].fn();
    sockets[1].emit('open');
    // target và original_position được phát lại nguyên vẹn.
    assert.deepEqual(sockets[1].frames[1].msg, toRosCmdIn(auto));
    publisher.dispose();
    client.dispose();
});

// --- runtime: một kết nối rosbridge cho cả /cmd_in và /odom, /cmd_out ---

async function startFakeRosbridge() {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise(resolve => wss.once('listening', resolve));
    const connections = [];
    wss.on('connection', ws => {
        const ops = [];
        connections.push(ops);
        ws.on('message', data => ops.push(JSON.parse(String(data))));
    });
    return {
        url: `ws://127.0.0.1:${wss.address().port}`,
        connections,
        async close() {
            for (const client of wss.clients) client.terminate();
            await new Promise(resolve => wss.close(resolve));
        },
    };
}

test('runtime mở đúng một kết nối rosbridge: subscribe /odom, /cmd_out và advertise, publish /cmd_in', async t => {
    const bridge = await startFakeRosbridge();
    const runtime = createRobotRuntime({
        pool: { query: async () => { throw new Error('DB không dùng trong test này'); } },
        config: { ROSBRIDGE_URL: bridge.url },
        lifecycle: { authBootEpoch: 'epoch-test', onRevoke: () => () => {} },
        connectionRegistry: createFakeRegistry(),
        mapPersistence: { getReadyMap: async () => null },
        assetStore: {},
    });
    t.after(async () => { runtime.dispose(); await bridge.close(); });

    await waitFor(() => bridge.connections[0]?.length === 3, { label: 'subscribe + advertise' });
    const ops = bridge.connections[0];
    assert.deepEqual(ops.map(op => [op.op, op.topic]).sort(), [
        ['advertise', '/cmd_in'], ['subscribe', '/cmd_out'], ['subscribe', '/odom'],
    ]);

    runtime.cmdInService.emergencyStop();
    const published = await waitFor(() => ops.find(op => op.op === 'publish'), { label: 'publish /cmd_in' });
    assert.equal(published.topic, '/cmd_in');
    assert.deepEqual(published.msg, toRosCmdIn(packet('stop')));
    assert.equal(bridge.connections.length, 1);
});

// --- config ---

const baseEnv = {
    APP_ORIGIN: 'http://127.0.0.1:5173',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
    SESSION_SECRET: '0123456789abcdef'.repeat(4),
    DATA_DIR: '/tmp/robot-hmi',
};

test('config không còn biến riêng cho /cmd_in (dùng chung ROSBRIDGE_URL)', () => {
    const config = loadConfig({ ...baseEnv, CMD_IN_ROSBRIDGE_URL: 'ws://127.0.0.1:9090' });
    assert.equal('CMD_IN_ROSBRIDGE_URL' in config, false);
});
