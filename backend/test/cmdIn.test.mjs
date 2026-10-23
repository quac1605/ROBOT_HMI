import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import express from 'express';
import {
    CmdInMessageSchema, buildCmdInMessage, poseToPoseStamped, yawToQuaternion,
    toRosCmdIn, EMPTY_ORIGINAL_POSE,
} from '@robot-hmi/contracts/cmdIn';
import { createMotionAdmissionGate } from '@robot-hmi/control-domain/motionAdmissionGate';
import { createControlAuthority } from '@robot-hmi/control-domain/controlAuthority';
import { createCmdInService } from '../src/services/cmdInService.js';
import { createMockRosAdapter } from '../src/ros/mockRosAdapter.js';
import { createRosbridgeCmdInPublisher } from '../src/ros/rosbridgeCmdInPublisher.js';
import { createRosbridgeClient } from '../src/ros/rosbridgeClient.js';
import { createRobotRuntime } from '../src/runtime.js';
import { createNavigationRouter } from '../src/routes/navigationRouter.js';
import { createFakeRegistry, waitFor } from './helpers/rosStatusFixtures.mjs';

const ZERO = { linearX: 0, angularZ: 0 };
const NOW = 1_761_000_000_123;
const packet = (mode, v_m = 0, v_rad = 0, target = [], original_poss = EMPTY_ORIGINAL_POSE) => ({
    target, mode, joystick: { v_m, v_rad }, original_poss,
});
const poses = [{ frameId: 'map', x: 1, y: 2, yaw: Math.PI / 2 }, { frameId: 'map', x: -0.5, y: 3, yaw: 0 }];
const stamped = points => points.map(p => poseToPoseStamped({ x: p.x, y: p.y, theta: p.yaw }, { stamp: NOW }));
function fixture() {
    const sent = [];
    const service = createCmdInService({ publishers: [{ publish: message => sent.push(structuredClone(message)) }], now: () => NOW });
    return { service, sent };
}

test('ROS contract: four uppercase modes, exact fields and quaternion', () => {
    for (const mode of ['MANUAL', 'AUTO', 'STOP', 'SLAM']) {
        assert.deepEqual(toRosCmdIn(buildCmdInMessage({ mode, velocity: ZERO })), packet(mode));
    }
    assert.throws(() => buildCmdInMessage({ mode: 'manual', velocity: ZERO }));
    assert.throws(() => toRosCmdIn({ ...packet('STOP'), has_original_position: false }));
    assert.throws(() => buildCmdInMessage({ mode: 'STOP', velocity: { linearX: 0.1, angularZ: 0 } }));
    assert.throws(() => buildCmdInMessage({ mode: 'MANUAL', velocity: ZERO, target: stamped(poses) }));
    const pose = poseToPoseStamped({ x: 1.5, y: -2, theta: Math.PI / 2 }, { stamp: NOW });
    assert.equal(pose.header.frame_id, 'map');
    assert.deepEqual(pose.header.stamp, { sec: 1_761_000_000, nanosec: 123_000_000 });
    assert.deepEqual(pose.pose.position, { x: 1.5, y: -2, z: 0 });
    assert.deepEqual(pose.pose.orientation, yawToQuaternion(Math.PI / 2));
    assert.deepEqual(EMPTY_ORIGINAL_POSE.header.stamp, { sec: 0, nanosec: 0 });
});

test('SLAM begins with zero, carries joystick velocity, then STOP', () => {
    const { service, sent } = fixture();
    assert.deepEqual(sent, []);
    service.onRobotState({ mode: 'mapping' });
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0.3, angularZ: -0.2 } });
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO });
    service.onRobotState({ mode: 'idle' });
    assert.deepEqual(sent, [packet('SLAM'), packet('SLAM', 0.3, -0.2), packet('SLAM'), packet('STOP')]);
});

test('MANUAL switch drives, release is zero, explicit release returns AUTO', () => {
    const { service, sent } = fixture();
    service.setMode('MANUAL');
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0.2, angularZ: 0.1 } });
    service.onMotionCommand({ origin: 'teleop', velocity: ZERO });
    service.setMode('AUTO');
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0.2, angularZ: 0 } });
    assert.deepEqual(sent, [packet('MANUAL'), packet('MANUAL', 0.2, 0.1), packet('MANUAL'), packet('AUTO'), packet('AUTO')]);
});

test('AUTO immediately publishes original_poss and target; STOP clears targets and velocity', () => {
    const { service, sent } = fixture();
    assert.equal(service.getOriginalPosition(), null);
    assert.throws(() => service.setOriginalPose({ x: 1, y: 2 }));
    const original = { x: 0.5, y: -1, theta: 0.25 };
    assert.deepEqual(service.setOriginalPose(original), original);
    const originalStamped = poseToPoseStamped(original, { stamp: NOW });
    assert.deepEqual(sent.at(-1), packet('AUTO', 0, 0, [], originalStamped));
    assert.deepEqual(service.setTarget([{ x: 1, y: 2, theta: Math.PI / 2 }]), stamped(poses.slice(0, 1)));
    assert.deepEqual(sent.at(-1), packet('AUTO', 0, 0, stamped(poses.slice(0, 1)), originalStamped));
    assert.deepEqual(service.setTarget(stamped(poses)), stamped(poses));
    assert.deepEqual(sent.at(-1).target, stamped(poses));
    service.onMotionCommand({ origin: 'mission', poses });
    assert.deepEqual(sent.at(-1), packet('AUTO', 0, 0, stamped(poses), originalStamped));
    service.emergencyStop();
    assert.deepEqual(sent.at(-1), packet('STOP', 0, 0, [], originalStamped));
    service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 1, angularZ: 1 } });
    assert.deepEqual(sent.at(-1), packet('STOP', 0, 0, [], originalStamped));
    for (const message of sent) CmdInMessageSchema.parse(message);
});

test('target and original pose cannot change during mission', () => {
    const { service } = fixture();
    service.onRobotState({ mode: 'navigating', activeMissionId: 'mission-1' });
    assert.throws(() => service.setTarget([{ x: 1, y: 2, theta: 0 }]), error => error.code === 'TARGET_DURING_MISSION');
    assert.throws(() => service.setOriginalPose({ x: 1, y: 2, theta: 0 }), error => error.code === 'ORIGINAL_POSITION_DURING_MISSION');
});

test('mission cancellation sends STOP', () => {
    const { service, sent } = fixture();
    service.onMotionCommand({ origin: 'mission', poses });
    service.onMotionCommand({ origin: 'cancel' });
    assert.deepEqual(sent, [packet('AUTO', 0, 0, stamped(poses)), packet('STOP')]);
});

test('navigation API publishes selected target and original pose immediately', async t => {
    const { service, sent } = fixture();
    const app = express();
    app.use(express.json());
    app.use('/api', createNavigationRouter({
        lifecycle: { requireAuth: (_req, _res, next) => next(), requireCsrf: (_req, _res, next) => next(),
            assertRequestSessionCurrent: () => {} },
        cmdInService: service,
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => { service.dispose(); await new Promise(resolve => server.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const put = (path, body) => fetch(base + path, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const pose = await put('/api/navigation/original-position', { original_poss: { x: 0.5, y: -1, theta: 0.25 } });
    assert.equal(pose.status, 200);
    assert.equal((await pose.json()).originalPosition.x, 0.5);
    assert.equal(sent.at(-1).mode, 'AUTO');
    assert.equal(sent.at(-1).original_poss.header.frame_id, 'map');
    const target = await put('/api/navigation/target', { target: [{ x: 1, y: 2, theta: Math.PI / 2 }] });
    assert.equal(target.status, 200);
    assert.equal((await target.json()).target.length, 1);
    assert.equal(sent.at(-1).target.length, 1);
    assert.deepEqual(sent.at(-1).target[0].pose.orientation, yawToQuaternion(Math.PI / 2));
});

test('control authority claim/release switches MANUAL to AUTO after zero command', async t => {
    const { service, sent } = fixture();
    let state = { mode: 'idle', rosConnected: true, physicalEstopActive: false, motionInhibited: false,
        motionInhibitReason: null, activeMissionId: null, activeMappingSessionId: null, velocity: ZERO };
    const sharedRobotState = { getSnapshot: () => structuredClone(state),
        update(patch) { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; } };
    const adapter = createMockRosAdapter({ setEvery: () => null, clearEvery: () => {},
        onMotionCommand: command => service.onMotionCommand(command) });
    const authority = createControlAuthority({ sharedRobotState,
        telemetry: { getControlState: () => ({ snapshot: sharedRobotState.getSnapshot(), transportStale: false }) },
        motionGate: createMotionAdmissionGate(), motionSource: adapter,
        onStopRequested: request => { if (!request?.keepMode) service.emergencyStop(); },
        onControlClaimed: () => service.setMode('MANUAL'),
        onControlReleased: () => service.setMode('AUTO') });
    t.after(() => { authority.dispose(); adapter.dispose(); service.dispose(); });
    const sessionId = authority.createSession('s1');
    adapter.sample();
    const lease = await authority.acquireControl({ requestId: 'claim' }, sessionId);
    assert.deepEqual(sent[0], packet('MANUAL'));
    await authority.releaseControl({ requestId: 'release', leaseId: lease.leaseId }, sessionId);
    assert.deepEqual(sent.at(-1), packet('AUTO'));
    assert.ok(sent.some(message => message.mode === 'MANUAL' && message.joystick.v_m === 0));
});

test('rosbridge publisher replays latest command with zero velocity', () => {
    const sockets = [];
    class FakeSocket extends EventEmitter {
        constructor() { super(); this.frames = []; sockets.push(this); }
        send(data) { this.frames.push(JSON.parse(data)); }
        terminate() { this.emit('close'); }
    }
    const client = createRosbridgeClient({ url: 'ws://127.0.0.1:9090', reconnectMs: 1000,
        WebSocketImpl: FakeSocket, setTimer: () => null, clearTimer: () => {} });
    const publisher = createRosbridgeCmdInPublisher({ client });
    client.start();
    publisher.publish(packet('MANUAL', 0.3));
    sockets[0].emit('open');
    assert.deepEqual(sockets[0].frames[1].msg, packet('MANUAL'));
    publisher.dispose();
    client.dispose();
});

test('runtime uses one rosbridge connection for /cmd_in, /cmd_out, /odom and TF', async t => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise(resolve => wss.once('listening', resolve));
    const connections = [];
    wss.on('connection', ws => {
        const ops = [];
        connections.push(ops);
        ws.on('message', data => ops.push(JSON.parse(String(data))));
    });
    const runtime = createRobotRuntime({
        pool: { query: async () => { throw new Error('not used'); } },
        config: { ROSBRIDGE_URL: `ws://127.0.0.1:${wss.address().port}` },
        lifecycle: { authBootEpoch: 'test', onRevoke: () => () => {} },
        connectionRegistry: createFakeRegistry(), mapPersistence: { getReadyMap: async () => null }, assetStore: {},
    });
    t.after(async () => { runtime.dispose(); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); });
    await waitFor(() => connections[0]?.length === 5, { label: 'rosbridge subscriptions' });
    assert.deepEqual(connections[0].map(op => [op.op, op.topic]).sort(), [
        ['advertise', '/cmd_in'], ['subscribe', '/cmd_out'], ['subscribe', '/odom'],
        ['subscribe', '/tf'], ['subscribe', '/tf_static'],
    ]);
    runtime.cmdInService.emergencyStop();
    const published = await waitFor(() => connections[0].find(op => op.op === 'publish'), { label: '/cmd_in publish' });
    assert.deepEqual(published.msg, packet('STOP'));
});
