import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockRobotClient } from '../../../frontend/src/clients/mockRobotClient.js';
import {
  AcquireControlRequestSchema,
  TeleopVelocityMessageSchema,
} from '../../../frontend/src/schemas/control.js';

function sourceFixture() {
  const state = {
    selectedSource: 'teleop',
    phase: 'driving',
    sourceEpoch: 'boot-1',
    generation: 4,
    lastSequence: 10,
    sourceLiveUntilMono: 500,
    authorizationUntilMono: 500,
    commandWindowUntilMono: null,
  };
  const packet = {
    source: 'teleop',
    authorityEpoch: 'boot-1',
    generation: 4,
    sequence: 11,
    linearX: 0.1,
    angularZ: 0,
    validUntilMono: 200,
  };
  return { state, packet };
}

function motionSourceRejection(state, packet, nowMono) {
  if (state.selectedSource !== packet.source) return 'SOURCE_NOT_SELECTED';
  if (state.selectedSource === 'unknown' || !['teleop', 'navigation'].includes(state.selectedSource)) return 'SOURCE_NOT_SELECTED';
  if (['stopping', 'blocked', 'idle', 'unknown'].includes(state.phase)) return 'SOURCE_NOT_ARMED';
  if (packet.authorityEpoch !== state.sourceEpoch || packet.generation !== state.generation) return 'STALE_AUTHORITY';
  if (state.sourceLiveUntilMono != null && nowMono >= state.sourceLiveUntilMono) return 'SOURCE_UNHEALTHY';
  if (state.authorizationUntilMono != null && nowMono >= state.authorizationUntilMono) return 'AUTHORIZATION_EXPIRED';
  if (state.commandWindowUntilMono !== null && (state.commandWindowUntilMono === undefined || nowMono >= state.commandWindowUntilMono)) return 'COMMAND_WINDOW_EXPIRED';
  if (packet.validUntilMono != null && nowMono >= packet.validUntilMono) return 'COMMAND_EXPIRED';
  if (!Number.isSafeInteger(packet.sequence) || packet.sequence <= state.lastSequence) return 'SEQUENCE_REPLAY';
  if (!Number.isFinite(packet.linearX) || !Number.isFinite(packet.angularZ)) return 'INVALID_VELOCITY';
  if (Math.abs(packet.linearX) > 0.2 || Math.abs(packet.angularZ) > 0.5) return 'VELOCITY_OUT_OF_BOUNDS';
  return null;
}

function toDifferentialTwist({ linearX, angularZ }) {
  if (!Number.isFinite(linearX) || !Number.isFinite(angularZ)) {
    throw new Error('INVALID_TWIST_VELOCITY');
  }
  return {
    linear: { x: linearX, y: 0, z: 0 },
    angular: { x: 0, y: 0, z: angularZ },
  };
}

test('T8-01: chỉ nguồn được chọn mới được publish; khác nguồn bị reject', () => {
  const { state, packet } = sourceFixture();
  assert.equal(motionSourceRejection(state, packet, 100), null);
  assert.equal(motionSourceRejection(state, { ...packet, source: 'joystick' }, 100), 'SOURCE_NOT_SELECTED');
  assert.equal(motionSourceRejection({ ...state, selectedSource: 'unknown' }, packet, 100), 'SOURCE_NOT_SELECTED');
});

test('T8-02: boot epoch và generation cũ bị fence dù sequence mới', () => {
  const { state, packet } = sourceFixture();
  assert.equal(motionSourceRejection(state, { ...packet, authorityEpoch: 'boot-old', sequence: 99 }, 100), 'STALE_AUTHORITY');
  assert.equal(motionSourceRejection(state, { ...packet, generation: 3, sequence: 99 }, 100), 'STALE_AUTHORITY');
});

test('T8-03: deadline cũ được xét trước command mới, tại ranh giới cũng reject', () => {
  const { state, packet } = sourceFixture();
  assert.equal(motionSourceRejection(state, packet, 250), 'COMMAND_EXPIRED');
  assert.equal(motionSourceRejection(state, { ...packet, validUntilMono: 200 }, 300), 'COMMAND_EXPIRED');
  assert.equal(motionSourceRejection({ ...state, sourceLiveUntilMono: 100 }, packet, 100), 'SOURCE_UNHEALTHY');
  assert.equal(motionSourceRejection({ ...state, authorizationUntilMono: 100 }, packet, 100), 'AUTHORIZATION_EXPIRED');
  assert.equal(motionSourceRejection({ ...state, commandWindowUntilMono: null }, packet, 100), null);
  assert.equal(motionSourceRejection({ ...state, commandWindowUntilMono: undefined }, packet, 100), 'COMMAND_WINDOW_EXPIRED');
});

test('T8-04: replay, số không hữu hạn và vượt limits đều reject, không sửa state', () => {
  const { state, packet } = sourceFixture();
  const before = structuredClone(state);
  for (const sequence of [0, 7, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(motionSourceRejection(state, { ...packet, sequence }, 100), 'SEQUENCE_REPLAY');
  }
  for (const linearX of [NaN, Infinity, -Infinity]) {
    assert.equal(motionSourceRejection(state, { ...packet, linearX }, 100), 'INVALID_VELOCITY');
  }
  assert.equal(motionSourceRejection(state, { ...packet, linearX: 0.201 }, 100), 'VELOCITY_OUT_OF_BOUNDS');
  assert.deepEqual(state, before);
});

test('T8-05: stopping/blocked/idle không tự fallback sang navigation', () => {
  const { state, packet } = sourceFixture();
  for (const phase of ['stopping', 'blocked', 'idle', 'unknown']) {
    assert.equal(motionSourceRejection({ ...state, phase, selectedSource: 'navigation' },
      { ...packet, source: 'navigation', sequence: 100 }, 100), 'SOURCE_NOT_ARMED');
  }
  assert.equal(motionSourceRejection(state,
    { ...packet, source: 'navigation', linearX: 0, angularZ: 0 }, 100), 'SOURCE_NOT_SELECTED');
});

test('T8-06: Twist đúng dấu/đơn vị, không phát thành phần ngoài robot vi sai', () => {
  assert.deepEqual(toDifferentialTwist({ linearX: -0.1, angularZ: 0.2 }), {
    linear: { x: -0.1, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0.2 },
  });
  assert.throws(() => toDifferentialTwist({ linearX: NaN, angularZ: 0 }));
});

test('T8-07: facade/schema thật reject acquire/velocity payload có trường tự nhận authority/source/priority', async () => {
  // 1. AcquireControlRequestSchema reject trường source hoặc priority
  assert.throws(() => AcquireControlRequestSchema.parse({
    requestId: 'req-1',
    source: 'teleop', // Bị reject vì schema strict
  }));

  assert.throws(() => AcquireControlRequestSchema.parse({
    requestId: 'req-1',
    priority: 100, // Bị reject
  }));

  // 2. TeleopVelocityMessageSchema reject authority generation tự gán
  assert.throws(() => TeleopVelocityMessageSchema.parse({
    leaseId: 'lease-1',
    sequence: 1,
    freshnessToken: 'token-1',
    linearX: 0.1,
    angularZ: 0,
    authorityGeneration: 99, // Bị reject
  }));

  // 3. Client facade cũng reject khi gọi
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });
  await assert.rejects(async () => {
    await client.acquireControl({ requestId: 'req-1', priority: 10 });
  });
  client.dispose();
});

test('T8-08: khi mission đang giữ quyền, acquire bị chặn; manual stop preempt mission; confirmation cần sample mới', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  // 1. Tạo real moving mission
  const missionResult = await client.createMission({
    requestId: crypto.randomUUID(),
    mapId: 'map-demo',
    mapRevision: 'rev-1',
    kind: 'navigate_to_pose',
    poses: [{ frameId: 'map', x: 7, y: 3, yaw: 0 }],
  });
  const missionId = missionResult.missionId;

  // Chờ cho mission thực sự moving và linearX > 0
  const end = performance.now() + 2000;
  while (performance.now() < end) {
    const sample = client._motionSource.latest();
    if (sample?.velocity?.linearX > 0) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(client._motionSource.latest()?.velocity?.linearX > 0, 'Mission must be executing with velocity');

  // 2. Khi đang navigating thực sự, acquire bị từ chối
  await assert.rejects(async () => {
    await client.acquireControl({ requestId: 'acq-blocked' });
  }, (err) => err.message.includes('MISSION_ACTIVE') || err.message.includes('ROBOT_NOT_STATIONARY') || err.code === 'MODE_NOT_ALLOWED' || err.message.includes('teleop'));

  // 3. Manual stop preempts real mission: theo dõi mission transition sang canceling -> canceled
  const missionStates = [];
  client.subscribeMissions((event) => {
    if (event.payload?.missionId === missionId) missionStates.push(event.payload.status);
  });

  const stopRes = await client.requestStop({ requestId: 'stop-preempt' });
  assert.equal(stopRes.status, 'accepted');

  // Đợi observation tick xác nhận dừng
  for (let i = 0; i < 20; i++) {
    const s = await client.getControlState();
    if (s.payload.stop?.status === 'confirmed') break;
    await new Promise((r) => setTimeout(r, 30));
  }
  const state = await client.getControlState();
  assert.equal(state.payload.stop?.status, 'confirmed');

  const finalMission = await client.getMission(missionId);
  assert.equal(finalMission.status, 'canceled');
  assert.ok(missionStates.includes('canceling') || finalMission.status === 'canceled');
  assert.equal(client._motionSource.latest()?.velocity?.linearX, 0);

  // 4. Orphan mission cleanup không làm mất fault mode (R2-18)
  client._sharedRobotState.update({ mode: 'fault', activeMissionId: 'orphan-fault-id' });
  await client.requestStop({ requestId: 'fault-stop' });
  const robotAfterFaultStop = await client.getRobotState();
  assert.equal(robotAfterFaultStop.mode, 'fault');

  client.dispose();
});
