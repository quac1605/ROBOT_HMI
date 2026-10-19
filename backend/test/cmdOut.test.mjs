/**
 * backend/test/cmdOut.test.mjs
 *
 * KIỂM THỬ GÓI /cmd_out: CHỌN MODE, GHÉP VỚI ADAPTER + controlAuthority, PUBLISHER rosbridge, CONFIG.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMotionAdmissionGate } from '@robot-hmi/control-domain/motionAdmissionGate';
import { createControlAuthority } from '@robot-hmi/control-domain/controlAuthority';
import { WebSocketServer } from 'ws';
import { CmdOutMessageSchema, buildCmdOutMessage } from '@robot-hmi/contracts/cmdOut';
import { createCmdOutService } from '../src/services/cmdOutService.js';
import { createMockRosAdapter } from '../src/ros/mockRosAdapter.js';
import { createRosbridgeCmdOutPublisher } from '../src/ros/rosbridgeCmdOutPublisher.js';
import { createRosbridgeClient } from '../src/ros/rosbridgeClient.js';
import { twistToVelocity } from '../src/ros/rosStatusMessages.js';
import { createRobotRuntime } from '../src/runtime.js';
import { createFakeRegistry, twist, waitFor } from './helpers/rosStatusFixtures.mjs';
import { loadConfig } from '../src/config.js';

const ZERO = { linearX: 0, angularZ: 0 };
const packet = (mode, linear = 0, angular = 0) => ({ target: null, mode, velocity: { linear, angular } });

function recorder() {
    const sent = [];
    return { sent, publisher: { publish: message => sent.push(structuredClone(message)) } };
}

// --- cmdOutService: quy tắc chọn mode ---

test('không phát gì trước lệnh điều khiển đầu tiên', () => {
    const { sent, publisher } = recorder();
    const service = createCmdOutService({ publishers: [publisher] });
    service.onMotionCommand({ origin: 'stop', velocity: ZERO });
    assert.deepEqual(sent, []);
});

test('teleop là manual và mang đúng vận tốc', () => {
    const { sent, publisher } = recorder();
    const service = createCmdOutService({ publishers: [publisher] });
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0, angularZ: 0.3 } });
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: -0.3, angularZ: 0 } });
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO });
    assert.deepEqual(sent, [packet('manual', 0, 0.3), packet('manual', -0.3, 0), packet('manual')]);
    for (const message of sent) CmdOutMessageSchema.parse(message);
});

test('emergency được giữ qua lệnh 0, lệnh lái khác 0 đưa về manual', () => {
    const { sent, publisher } = recorder();
    const service = createCmdOutService({ publishers: [publisher] });
    service.emergencyStop();
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO });
    service.onMotionCommand({ origin: 'stop', velocity: ZERO });
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0.3, angularZ: 0 } });
    assert.deepEqual(sent, [packet('emergency'), packet('emergency'), packet('emergency'), packet('manual', 0.3, 0)]);
});

test('nhiệm vụ là auto, vận tốc luôn 0; dừng nội bộ giữ auto; emergency về auto khi có nhiệm vụ mới', () => {
    const { sent, publisher } = recorder();
    const service = createCmdOutService({ publishers: [publisher] });
    service.emergencyStop();
    service.onMotionCommand({ origin: 'mission', velocity: ZERO });
    service.onMotionCommand({ origin: 'mission', velocity: { linearX: 0.3, angularZ: 0.05 } });
    service.onMotionCommand({ origin: 'stop', velocity: ZERO });
    assert.deepEqual(sent, [packet('emergency'), packet('auto'), packet('auto'), packet('auto')]);
});

test('publisher lỗi không chặn publisher khác', () => {
    const { sent, publisher } = recorder();
    const broken = { publish() { throw new Error('boom'); } };
    const service = createCmdOutService({ publishers: [broken, publisher] });
    service.emergencyStop();
    assert.deepEqual(sent, [packet('emergency')]);
});

// --- Ghép adapter + controlAuthority + cmdOutService như runtime.js ---

function createStack() {
    const { sent, publisher } = recorder();
    const cmdOut = createCmdOutService({ publishers: [publisher] });
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
        onMotionCommand: command => cmdOut.onMotionCommand(command),
    });
    const authority = createControlAuthority({
        sharedRobotState,
        telemetry: { getControlState: () => ({ snapshot: sharedRobotState.getSnapshot(), transportStale: false }) },
        motionGate: createMotionAdmissionGate(),
        motionSource: adapter,
        onStopRequested: () => cmdOut.emergencyStop(),
    });
    const sessionId = authority.createSession('s1');
    const heartbeats = [];
    authority.subscribeControl(sessionId, envelope => {
        if (envelope.type === 'control.heartbeat') heartbeats.push(envelope.payload);
    });
    return {
        sent, adapter, authority, sessionId, cmdOut,
        token: () => heartbeats.at(-1).freshnessToken,
        dispose() { authority.dispose(); adapter.dispose(); cmdOut.dispose(); },
    };
}

test('lái tay qua controlAuthority ra manual; lệnh bị từ chối không ra /cmd_out', async t => {
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

    assert.deepEqual(stack.sent, [packet('manual', 0.2, 0)]);
});

test('yêu cầu dừng phát emergency trước mọi lệnh 0 do thu hồi quyền lái', async t => {
    const stack = createStack();
    t.after(() => stack.dispose());
    stack.adapter.sample();
    const lease = await stack.authority.acquireControl({ requestId: 'r1' }, stack.sessionId);
    stack.authority.sendVelocity({
        leaseId: lease.leaseId, freshnessToken: stack.token(), sequence: 1, linearX: 0.2, angularZ: 0,
    }, stack.sessionId);

    await stack.authority.requestStop({ requestId: 'stop-1' }, stack.sessionId);

    const [first, ...rest] = stack.sent;
    assert.deepEqual(first, packet('manual', 0.2, 0));
    assert.ok(rest.length >= 2);
    assert.deepEqual(rest[0], packet('emergency'));
    for (const message of rest) assert.deepEqual(message, packet('emergency'));
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

test('vòng đời nhiệm vụ qua adapter phát auto vận tốc 0', t => {
    const stack = createStack();
    t.after(() => stack.dispose());
    const handle = stack.adapter.beginMission('m1');
    stack.adapter.writeMissionVelocity(handle, { linearX: 0.3, angularZ: 0.05 });
    stack.adapter.finishMission(handle);
    const second = stack.adapter.beginMission('m2');
    stack.adapter.cancelMission(second);
    assert.equal(stack.sent.length, 5);
    for (const message of stack.sent) assert.deepEqual(message, packet('auto'));
});

// --- Kiểu vận tốc dùng chung với /cmd_in ---

test('/cmd_out dùng cùng kiểu vận tốc với /cmd_in: Twist -> VelocitySchema -> gói giữ nguyên số liệu', () => {
    for (const [v, w] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3], [0.12, -0.45]]) {
        const velocity = twistToVelocity(twist(v, w));
        assert.deepEqual(velocity, { linearX: v, angularZ: w });
        assert.deepEqual(buildCmdOutMessage({ mode: 'manual', velocity }), packet('manual', v, w));
    }
    // Định dạng gói không đổi: đúng 3 trường, -0 thành 0.
    assert.deepEqual(Object.keys(buildCmdOutMessage({ mode: 'auto', velocity: ZERO })), ['target', 'mode', 'velocity']);
    assert.deepEqual(buildCmdOutMessage({ mode: 'emergency', velocity: { linearX: -0, angularZ: -0 } }),
        packet('emergency'));
    // Vận tốc sai kiểu bị chặn như /cmd_in.
    assert.throws(() => buildCmdOutMessage({ mode: 'manual', velocity: { linear: 0.3, angular: 0 } }));
    assert.throws(() => buildCmdOutMessage({ mode: 'manual', velocity: { linearX: Number.NaN, angularZ: 0 } }));
});

// --- rosbridgeCmdOutPublisher trên client dùng chung, WebSocket giả ---

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
    const publisher = createRosbridgeCmdOutPublisher({ client });
    client.start();

    publisher.publish(packet('manual', 0.3, 0)); // chưa nối: bỏ
    sockets[0].emit('open');
    assert.deepEqual(sockets[0].frames[0],
        { op: 'advertise', id: 'hmi:/cmd_out', topic: '/cmd_out', type: 'std_msgs/msg/String' });
    // Gói mới nhất được gửi lại khi nối, nhưng vận tốc khác 0 cũ bị đưa về 0.
    assert.deepEqual(JSON.parse(sockets[0].frames[1].msg.data), packet('manual'));

    publisher.publish(packet('emergency'));
    assert.deepEqual(sockets[0].frames[2], {
        op: 'publish', topic: '/cmd_out', msg: { data: JSON.stringify(packet('emergency')) },
    });

    sockets[0].emit('close');
    publisher.publish(packet('auto'));
    assert.equal(sockets[0].frames.length, 3);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 1000);

    timers[0].fn();
    sockets[1].emit('open');
    assert.deepEqual(JSON.parse(sockets[1].frames[1].msg.data), packet('auto'));
    publisher.dispose();
    client.dispose();
});

// --- runtime: một kết nối rosbridge cho cả /cmd_out và /odom, /cmd_in ---

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

test('runtime mở đúng một kết nối rosbridge: subscribe /odom, /cmd_in và advertise, publish /cmd_out', async t => {
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
        ['advertise', '/cmd_out'], ['subscribe', '/cmd_in'], ['subscribe', '/odom'],
    ]);

    runtime.cmdOutService.emergencyStop();
    const published = await waitFor(() => ops.find(op => op.op === 'publish'), { label: 'publish /cmd_out' });
    assert.equal(published.topic, '/cmd_out');
    assert.deepEqual(JSON.parse(published.msg.data), packet('emergency'));
    assert.equal(bridge.connections.length, 1);
});

// --- config ---

const baseEnv = {
    APP_ORIGIN: 'http://127.0.0.1:5173',
    DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
    SESSION_SECRET: '0123456789abcdef'.repeat(4),
    DATA_DIR: '/tmp/robot-hmi',
};

test('config không còn biến riêng cho /cmd_out (dùng chung ROSBRIDGE_URL)', () => {
    const config = loadConfig({ ...baseEnv, CMD_OUT_ROSBRIDGE_URL: 'ws://127.0.0.1:9090' });
    assert.equal('CMD_OUT_ROSBRIDGE_URL' in config, false);
});
