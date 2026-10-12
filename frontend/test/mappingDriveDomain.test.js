import test from 'node:test';
import assert from 'node:assert/strict';
import { AcquireControlRequestSchema } from '../../packages/contracts/src/control.js';
import { createMappingDriveGate } from '../../packages/control-domain/src/mappingDriveGate.js';
import { createControlLeaseCore } from '../../packages/control-domain/src/controlLeaseCore.js';
import { createControlAuthority } from '../../packages/control-domain/src/controlAuthority.js';
import { selectCanDrive } from '../../packages/control-domain/src/controlPolicy.js';
import { createMotionAdmissionGate } from '../../packages/control-domain/src/motionAdmissionGate.js';
import { createMockMotionSource } from '../../packages/control-domain/src/mockMotionSource.js';
import { createSharedRobotState } from '../src/clients/sharedRobotState.js';
import { createMappingService } from '../../backend/src/services/mappingService.js';

const mapping = { kind: 'mapping', mappingSessionId: 'S' };

test('mapping context strict; legacy default; no authority injection', () => {
  assert.deepEqual(AcquireControlRequestSchema.parse({ requestId: 'r' }).context, { kind: 'manual' });
  assert.deepEqual(AcquireControlRequestSchema.parse({ requestId: 'r', context: mapping }).context, mapping);
  for (const context of [
    { kind: 'mapping' }, { kind: 'mapping', mappingSessionId: '' },
    { ...mapping, priority: 100 }, { kind: 'unknown' },
  ]) assert.equal(AcquireControlRequestSchema.safeParse({ requestId: 'r', context }).success, false);
  assert.equal(AcquireControlRequestSchema.safeParse({ requestId: 'r', context: mapping, authority: true }).success, false);
});

test('lifecycle: active only; failed save permits save retry, never drive', () => {
  const gate = createMappingDriveGate();
  assert.equal(gate.canDrive('S'), false);
  gate.beginSession('S');
  assert.equal(gate.canDrive('S'), false);
  assert.throws(() => gate.beginSession('T'), { code: 'MAPPING_ACTIVE_OR_UNKNOWN' });
  gate.activateSession('S');
  assert.equal(gate.canDrive('S'), true);
  assert.equal(gate.canDrive('T'), false);
  const view = gate.getState();
  view.phase = 'finishing';
  assert.equal(gate.canDrive('S'), true);
  gate.beginFinish('S');
  assert.equal(gate.canDrive('S'), false);
  assert.throws(() => gate.beginFinish('S'), { code: 'MAPPING_PHASE_BLOCKED' });
  gate.finishFailed('S');
  assert.equal(gate.canDrive('S'), false);
  gate.beginFinish('S');
  gate.finishSucceeded('S');
  gate.beginSession('T');
  assert.equal(gate.clearSession('S'), false);
  assert.equal(gate.getState().mappingSessionId, 'T');
});

test('mapping lease: fixed vectors, private context, wrong owner, deadline unchanged', () => {
  let clock = 0;
  let next = 0;
  const sent = [];
  const core = createControlLeaseCore({
    now: () => clock, wallNow: () => clock, uuid: () => `id-${++next}`,
    checkAcquire: () => null, checkDrive: () => null,
    claimMode: () => {}, releaseMode: () => {},
    setVelocity: v => sent.push(structuredClone(v)),
  });
  try {
    const context = structuredClone(mapping);
    const lease = core.acquire('owner', context);
    assert.deepEqual(lease.limits, { maxLinearX: 0.3, maxAngularZ: 0.3 });
    context.mappingSessionId = 'changed';
    lease.context.mappingSessionId = 'changed-too';
    assert.equal(core.view('owner').lease.context.mappingSessionId, 'S');
    const hb = core.heartbeat('owner');
    const command = v => ({ leaseId: lease.leaseId, sequence: 1, freshnessToken: hb.freshnessToken, ...v });
    assert.throws(() => core.send('other', command({ linearX: 0.3, angularZ: 0 })), { code: 'LEASE_NOT_OWNED' });
    assert.throws(() => core.send('owner', command({ linearX: 0.15, angularZ: 0 })), { code: 'VELOCITY_NOT_FIXED' });
    assert.throws(() => core.send('owner', command({ linearX: 0.3, angularZ: 0.3 })), { code: 'VELOCITY_NOT_FIXED' });
    assert.throws(() => core.send('owner', command({ linearX: 0.31, angularZ: 0 })), { code: 'VELOCITY_OUT_OF_BOUNDS' });
    core.send('owner', command({ linearX: 0.3, angularZ: 0 }));
    assert.deepEqual(sent.at(-1), { linearX: 0.3, angularZ: 0 });
    assert.throws(() => core.send('owner', command({ linearX: 0.3, angularZ: 0 })), { code: 'SEQUENCE_REPLAY' });
    clock = 300; // Đúng deadline watchdog; tuyệt đối không tăng budget.
    assert.throws(() => core.send('owner', { ...command({ linearX: 0.3, angularZ: 0 }), sequence: 2 }), { code: 'LEASE_NOT_OWNED' });
    assert.deepEqual(sent.at(-1), { linearX: 0, angularZ: 0 });
  } finally { core.dispose(); }
});

function authorityFixture(withGate = true) {
  let clock = 100;
  const state = createSharedRobotState({
    mode: 'mapping', rosConnected: true, physicalEstopActive: false,
    motionInhibited: false, activeMissionId: null, activeMappingSessionId: 'S',
    velocity: { linearX: 0, angularZ: 0 },
  });
  const gate = createMappingDriveGate();
  gate.beginSession('S');
  gate.activateSession('S');
  const source = createMockMotionSource({
    now: () => clock, wallNow: () => clock, sourceHealthy: () => true,
    setEvery: () => null, clearEvery: () => {},
  });
  const motionGate = createMotionAdmissionGate();
  const service = createControlAuthority({
    sharedRobotState: state,
    telemetry: { getControlState: () => ({ snapshot: state.getSnapshot(), transportStale: false }) },
    motionGate, motionSource: source,
    mappingDriveGate: withGate ? gate : null,
    now: () => clock, wallNow: () => clock,
  });
  source.sample();
  const sid = service.createSession('owner');
  return { state, gate, source, service, motionGate, sid,
    sample() { clock += 50; source.sample(); },
    advance(ms) { clock += ms; },
    dispose() { service.dispose(); source.dispose(); },
  };
}

test('authority: mapping keeps mode; finish needs no lease AND fresh measured zero', async () => {
  const f = authorityFixture();
  try {
    const raw = { requestId: 'acquire', context: mapping };
    const lease = await f.service.acquireControl(raw, f.sid);
    assert.equal(f.state.getSnapshot().mode, 'mapping');
    assert.equal((await f.service.acquireControl(raw, f.sid)).leaseId, lease.leaseId);
    await assert.rejects(() => f.service.acquireControl({ ...raw, context: { kind: 'manual' } }, f.sid), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.throws(() => f.service.assertMappingFinishSafe('S'), { code: 'CONTROL_BUSY' });
    await f.service.releaseControl({ requestId: 'release', leaseId: lease.leaseId }, f.sid);
    assert.equal(f.state.getSnapshot().mode, 'mapping');
    // Release có command zero mới, nhưng mẫu cũ chưa đo command revision này.
    assert.throws(() => f.service.assertMappingFinishSafe('S'), { code: 'ROBOT_NOT_STATIONARY' });
    f.sample();
    assert.equal(typeof f.service.assertMappingFinishSafe('S'), 'number');
    f.advance(200);
    assert.throws(() => f.service.assertMappingFinishSafe('S'), { code: 'ROBOT_NOT_STATIONARY' });
    f.sample();
    f.gate.beginFinish('S');
    await assert.rejects(() => f.service.acquireControl({ requestId: 'late', context: mapping }, f.sid), { code: 'MAPPING_PHASE_BLOCKED' });
    f.gate.finishFailed('S');
    assert.equal(typeof f.service.assertMappingFinishSafe('S'), 'number');
    await assert.rejects(() => f.service.acquireControl({ requestId: 'failed-save', context: mapping }, f.sid), { code: 'MAPPING_PHASE_BLOCKED' });
  } finally { f.dispose(); }
});

test('Finish giữ gate trước await DB; tab khác không xin được lease khi lưu lỗi', async () => {
  const f = authorityFixture();
  let releaseDb;
  let signalGate;
  const gateReached = new Promise(resolve => { signalGate = resolve; });
  const dbBarrier = new Promise(resolve => { releaseDb = resolve; });
  const mappingService = createMappingService({
    pool: { query: async () => ({ rowCount: 1, rows: [{ active: true, status: 'mapping' }] }) },
    mapPersistence: {
      async acceptFinish({ beforeAccept }) {
        beforeAccept();
        signalGate();
        await dbBarrier;
        throw Object.assign(new Error('DB_TEST_FAILURE'), { code: 'DB_TEST_FAILURE' });
      },
    },
    adapter: {}, motionGate: f.motionGate, mappingDriveGate: f.gate,
    assertMappingFinishSafe: id => f.service.assertMappingFinishSafe(id),
    sharedRobotState: f.state, jobService: {},
  });
  try {
    const pending = mappingService.finishMapping({
      mappingSessionId: 'S', name: 'S', requestId: 'finish-db-pending',
    }, 'test-principal');
    await gateReached;
    assert.equal(f.gate.getState().phase, 'finishing');
    await assert.rejects(() => f.service.acquireControl({
      requestId: 'late-acquire', context: mapping,
    }, f.sid), { code: 'MAPPING_PHASE_BLOCKED' });
    releaseDb();
    await assert.rejects(pending, { code: 'DB_TEST_FAILURE' });
    assert.equal(f.gate.getState().phase, 'save_failed');
    await assert.rejects(() => f.service.acquireControl({
      requestId: 'after-save-failed', context: mapping,
    }, f.sid), { code: 'MAPPING_PHASE_BLOCKED' });
  } finally { releaseDb(); f.dispose(); }
});

test('Stop trong await accept Finish làm ticket cũ không đọc grid hoặc lưu map', async () => {
  const f = authorityFixture();
  let releaseDb;
  let signalGate;
  let gridReads = 0;
  let failedJob = null;
  const gateReached = new Promise(resolve => { signalGate = resolve; });
  const dbBarrier = new Promise(resolve => { releaseDb = resolve; });
  const mappingService = createMappingService({
    pool: { query: async () => ({ rowCount: 1, rows: [{ active: true, status: 'mapping' }] }) },
    mapPersistence: {
      async acceptFinish({ beforeAccept }) {
        beforeAccept();
        signalGate();
        await dbBarrier;
        return { replayed: false, body: { jobId: 'job-old', status: 'accepted' } };
      },
      async failAcceptedFinish(jobId) { failedJob = jobId; },
    },
    adapter: { getMappingGrid() { gridReads++; throw new Error('SHOULD_NOT_READ'); } },
    motionGate: f.motionGate, mappingDriveGate: f.gate,
    assertMappingFinishSafe: id => f.service.assertMappingFinishSafe(id),
    sharedRobotState: f.state, jobService: {},
  });
  try {
    const pending = mappingService.finishMapping({
      mappingSessionId: 'S', name: 'S', requestId: 'finish-stop-race',
    }, 'test-principal');
    await gateReached;
    assert.equal(f.gate.getState().phase, 'finishing');
    await f.service.requestStop({ requestId: 'stop-during-finish' }, f.sid);
    f.sample(); // Nguồn xác nhận zero nhưng ticket Finish trước Stop vẫn vô hiệu.
    releaseDb();
    await assert.rejects(pending, { code: 'MOTION_ADMISSION_BLOCKED' });
    assert.equal(gridReads, 0);
    assert.equal(failedJob, 'job-old');
    assert.equal(f.gate.getState().phase, 'save_failed');
  } finally { releaseDb(); f.dispose(); }
});

test('missing gate and wrong mapping context fail closed', async () => {
  const f = authorityFixture(false);
  try {
    await assert.rejects(() => f.service.acquireControl({ requestId: 'r', context: mapping }, f.sid), { code: 'MAPPING_PHASE_BLOCKED' });
    assert.throws(() => f.service.assertMappingFinishSafe('S'), { code: 'MAPPING_PHASE_BLOCKED' });
  } finally { f.dispose(); }
  const g = authorityFixture();
  try {
    await assert.rejects(() => g.service.acquireControl({ requestId: 'wrong', context: { kind: 'mapping', mappingSessionId: 'T' } }, g.sid), { code: 'MAPPING_CONTEXT_MISMATCH' });
  } finally { g.dispose(); }
});

test('mapping lease bị thu hồi khi nguồn đo ngừng cập nhật đúng ranh giới freshness', async () => {
  const f = authorityFixture();
  try {
    await f.service.acquireControl({ requestId: 'fresh-source', context: mapping }, f.sid);
    f.source.setFrozen(true);
    f.advance(200);
    const snapshot = await f.service.getControlState(f.sid);
    assert.equal(snapshot.payload.ownership, 'none');
    assert.deepEqual(f.source.getCommand().velocity, { linearX: 0, angularZ: 0 });
  } finally { f.dispose(); }
});

test('lỗi guard sau khi đã lái phải revoke và ghi zero trước watchdog timeout', () => {
  let clock = 0;
  let failGuard = false;
  const commands = [];
  const core = createControlLeaseCore({
    now: () => clock,
    wallNow: () => clock,
    uuid: () => crypto.randomUUID(),
    checkAcquire: () => null,
    checkDrive: () => {
      if (failGuard) throw new Error('TELEMETRY_READ_FAILED');
      return null;
    },
    claimMode: () => {},
    releaseMode: () => {},
    setVelocity: value => commands.push(structuredClone(value)),
  });
  try {
    const lease = core.acquire('owner', mapping);
    const token = core.heartbeat('owner').freshnessToken;
    core.send('owner', {
      leaseId: lease.leaseId, sequence: 1, freshnessToken: token,
      linearX: 0.3, angularZ: 0,
    });
    failGuard = true;
    clock = 25; // Poll đầu tiên, chưa đến watchdog 300 ms.
    core.tick();
    assert.equal(core.view('owner').ownership, 'none');
    assert.deepEqual(commands.at(-1), { linearX: 0, angularZ: 0 });
    assert.equal(core.takeRevocations().at(-1)?.reason, 'DRIVE_GUARD_ERROR');
  } finally { core.dispose(); }
});

test('callback guard thu hồi lease không được để send ghi vận tốc sau revoke', () => {
  let core;
  let revokeDuringSend = false;
  let driveChecks = 0;
  const commands = [];
  core = createControlLeaseCore({
    now: () => 0,
    wallNow: () => 0,
    uuid: () => crypto.randomUUID(),
    checkAcquire: () => null,
    checkDrive: () => {
      if (revokeDuringSend && ++driveChecks === 2) core.stop();
      return null;
    },
    claimMode: () => {},
    releaseMode: () => {},
    setVelocity: value => commands.push(structuredClone(value)),
  });
  try {
    const lease = core.acquire('owner', mapping);
    const token = core.heartbeat('owner').freshnessToken;
    revokeDuringSend = true;
    assert.throws(() => core.send('owner', {
      leaseId: lease.leaseId, sequence: 1, freshnessToken: token,
      linearX: 0.3, angularZ: 0,
    }), { code: 'LEASE_NOT_OWNED' });
    assert.deepEqual(commands, [{ linearX: 0, angularZ: 0 }]);
    assert.equal(core.view('owner').ownership, 'none');
  } finally { core.dispose(); }
});

test('selector mapping chỉ tin camera front/rear được chọn và đúng generation', () => {
  const now = 1000;
  const control = {
    ready: true, phase: 'granted', controlProfile: 'mock', hardwareReady: false,
    stopUnconfirmed: false, controlGeneration: 1,
    lease: {
      leaseId: 'lease', controlGeneration: 1, context: mapping,
      limits: { maxLinearX: 0.3, maxAngularZ: 0.3 },
    },
    leaseDeadline: now + 1000, heartbeatReceivedAt: now,
    freshnessToken: 'fresh', tokenDeadline: now + 100,
  };
  const robot = {
    snapshot: {
      mode: 'mapping', activeMappingSessionId: 'S', activeMissionId: null,
      rosConnected: true, physicalEstopActive: false, motionInhibited: false,
    },
    lastReceivedAt: now, error: null,
  };
  const decision = camera => selectCanDrive({
    authenticated: true, control, robot, camera, now, context: mapping,
  });
  for (const id of ['front', 'rear']) {
    assert.equal(decision({
      selectedCameraId: id, cameraId: id, selectedGeneration: 0,
      generation: 0, lastFrameAt: now, error: null,
    }).allowed, true, `Camera ${id} được chọn hợp lệ độc lập hướng chạy`);
  }
  for (const id of [undefined, 'side']) {
    const result = decision({
      selectedCameraId: id, cameraId: id, selectedGeneration: 0,
      generation: 0, lastFrameAt: now, error: null,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes('CAMERA_NOT_FRESH'));
  }
  const staleGeneration = decision({
    selectedCameraId: 'front', cameraId: 'front', selectedGeneration: 1,
    generation: 0, lastFrameAt: now, error: null,
  });
  assert.equal(staleGeneration.allowed, false);
  assert.ok(staleGeneration.reasons.includes('CAMERA_NOT_FRESH'));
});
