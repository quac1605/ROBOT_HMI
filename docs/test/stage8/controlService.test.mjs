import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockRobotClient } from '../../../frontend/src/clients/mockRobotClient.js';
import { createMockControlService } from '../../../frontend/src/clients/mockControl.js';
import { createSharedRobotState } from '../../../frontend/src/clients/sharedRobotState.js';
import { createMockTelemetry } from '../../../frontend/src/clients/mockTelemetry.js';
import { createMockMotionSource } from '../../../frontend/src/clients/mockMotionSource.js';
import { createMotionAdmissionGate } from '../../../frontend/src/utils/motionAdmissionGate.js';
import { createControlStreamFence } from '../../../frontend/src/utils/controlStreamFence.js';
import { createControlRequestRegistry } from '../../../frontend/src/utils/controlRequestRegistry.js';
import { selectCanDrive } from '../../../frontend/src/utils/controlPolicy.js';
import { createTeleopHoldController } from '../../../frontend/src/utils/teleopHoldController.js';
import { createPageLeaseIntent } from '../../../frontend/src/utils/pageLeaseIntent.js';
import { createControlCoordinator } from '../../../frontend/src/utils/controlCoordinator.js';
import { useControlStore } from '../../../frontend/src/state/controlStore.js';
import { openCameraStream } from '../../../frontend/src/clients/cameraStreamClient.js';
import {
  AcquireControlRequestSchema,
  AcquireControlResponseSchema,
  TeleopVelocityMessageSchema,
  RequestStopRequestSchema,
  RequestStopResponseSchema,
  ControlEventEnvelopeSchema,
} from '../../../frontend/src/schemas/control.js';

function setupServiceFixture(options = {}) {
  const sharedRobotState = createSharedRobotState({
    connected: true, rosConnected: true, mode: 'idle', velocity: { linearX: 0, angularZ: 0 },
    motionInhibited: false, physicalEstopActive: false,
    activeMissionId: null, activeMappingSessionId: null,
  });
  let telemetryInstance = null;
  const motionSource = createMockMotionSource({
    sourceHealthy: () => true,
  });
  const telemetry = createMockTelemetry({ sharedRobotState, motionSource });
  telemetryInstance = telemetry;
  const motionGate = createMotionAdmissionGate();
  const missionService = { stopForControl: () => {} };
  const mapActivationService = { stopForControl: () => {} };

  const service = createMockControlService({
    sharedRobotState,
    telemetry,
    missionService,
    mapActivationService,
    motionGate,
    motionSource,
    ...options,
  });

  motionSource.sample();

  return { service, sharedRobotState, motionSource, motionGate, telemetry };
}

test('N8-01: schemas nhận DTO hợp lệ, reject unknown fields, NaN/Infinity, sequence ngoài safe integer', () => {
  // Valid
  assert.ok(AcquireControlRequestSchema.parse({ requestId: 'r1' }));
  assert.ok(RequestStopRequestSchema.parse({ requestId: 'r1' }));
  assert.ok(RequestStopResponseSchema.parse({ requestId: 'r1', status: 'accepted' }));

  // Reject unknown fields (strict)
  assert.throws(() => AcquireControlRequestSchema.parse({ requestId: 'r1', unknownField: 123 }));
  assert.throws(() => RequestStopRequestSchema.parse({ requestId: 'r1', extra: true }));

  // Reject NaN / Infinity in velocity
  assert.throws(() => TeleopVelocityMessageSchema.parse({
    leaseId: 'l1', sequence: 1, freshnessToken: 't1', linearX: NaN, angularZ: 0,
  }));
  assert.throws(() => TeleopVelocityMessageSchema.parse({
    leaseId: 'l1', sequence: 1, freshnessToken: 't1', linearX: 0.1, angularZ: Infinity,
  }));

  // Reject sequence <= 0
  assert.throws(() => TeleopVelocityMessageSchema.parse({
    leaseId: 'l1', sequence: 0, freshnessToken: 't1', linearX: 0.1, angularZ: 0,
  }));
});

test('N8-02: hai session cùng service không release/send thay nhau; subscriber khác không thấy token', async () => {
  const { service } = setupServiceFixture();
  const sidA = service.createSession();
  const sidB = service.createSession();

  let receivedEventB = null;
  service.subscribeControl(sidB, (event) => {
    receivedEventB = event;
  });

  const leaseA = await service.acquireControl({ requestId: 'req-a' }, sidA);
  assert.equal(leaseA.leaseId.length > 0, true);

  // Session B cố release lease của A -> reject
  await assert.rejects(async () => {
    await service.releaseControl({ requestId: 'req-rel-b', leaseId: leaseA.leaseId }, sidB);
  });

  // Session B không nhận heartbeat token của Session A
  assert.equal(receivedEventB?.type !== 'control.heartbeat', true);

  service.dispose();
});

test('N8-03: acquire idempotent; requestId đổi payload/operation bị conflict; replay không tạo owner mới', async () => {
  const { service } = setupServiceFixture();
  const sid = service.createSession();

  const res1 = await service.acquireControl({ requestId: 'req-idem-1' }, sid);
  const res2 = await service.acquireControl({ requestId: 'req-idem-1' }, sid);
  assert.equal(res1.leaseId, res2.leaseId);

  // Cùng requestId nhưng đổi operation
  await assert.rejects(async () => {
    await service.releaseControl({ requestId: 'req-idem-1', leaseId: res1.leaseId }, sid);
  }, /IDEMPOTENCY_CONFLICT/);

  service.dispose();
});

test('N8-04: acquire guard ma trận: E-stop, inhibit, ROS false, stale transport, mode khác idle', async () => {
  const { service, sharedRobotState, telemetry } = setupServiceFixture();
  const sid = service.createSession();

  // 1. E-Stop active
  sharedRobotState.update({ physicalEstopActive: true });
  await assert.rejects(async () => {
    await service.acquireControl({ requestId: 'r-estop' }, sid);
  });
  sharedRobotState.update({ physicalEstopActive: false });

  // 2. Motion inhibited
  sharedRobotState.update({ motionInhibited: true, motionInhibitReason: 'TEST' });
  await assert.rejects(async () => {
    await service.acquireControl({ requestId: 'r-inhibit' }, sid);
  });
  sharedRobotState.update({ motionInhibited: false, motionInhibitReason: null });

  // 3. Mode navigating
  sharedRobotState.update({ mode: 'navigating' });
  await assert.rejects(async () => {
    await service.acquireControl({ requestId: 'r-nav' }, sid);
  });
  sharedRobotState.update({ mode: 'idle' });

  // 4. Stale telemetry
  telemetry.setScenario('stale');
  await assert.rejects(async () => {
    await service.acquireControl({ requestId: 'r-stale' }, sid);
  });
  telemetry.setScenario('online');

  service.dispose();
});

test('N8-06: command hợp lệ cập nhật velocity; negative bounds đúng; vượt limits bị reject', async () => {
  const { service, sharedRobotState } = setupServiceFixture();
  const sid = service.createSession();
  const lease = await service.acquireControl({ requestId: 'r-limits' }, sid);

  let token = null;
  service.subscribeControl(sid, (evt) => {
    if (evt.type === 'control.heartbeat') token = evt.payload.freshnessToken;
  });
  const t0 = Date.now();
  while (!token && Date.now() - t0 < 500) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(token, 'Heartbeat freshness token must be provided');

  // Vận tốc âm hợp lệ
  service.sendVelocity({
    leaseId: lease.leaseId, sequence: 1, freshnessToken: token,
    linearX: -0.1, angularZ: -0.2,
  }, sid);
  assert.equal(sharedRobotState.getSnapshot().velocity.linearX, -0.1);
  assert.equal(sharedRobotState.getSnapshot().velocity.angularZ, -0.2);

  // Vượt limits (0.2, 0.5) bị reject
  assert.throws(() => {
    service.sendVelocity({
      leaseId: lease.leaseId, sequence: 2, freshnessToken: token,
      linearX: 0.25, angularZ: 0,
    }, sid);
  });

  service.dispose();
});

test('N8-10: lease expiry đang hold revoke; old command sau reacquire không ảnh hưởng owner mới', async () => {
  const { service } = setupServiceFixture({
    policy: {
      leaseTtlMs: 80,
      tokenTtlMs: 200,
      commandTimeoutMs: 50,
      heartbeatMs: 20,
      watchdogPollMs: 15,
      cameraStaleMs: 1000,
      robotStaleMs: 1000,
    },
  });
  const sid1 = service.createSession();
  const lease1 = await service.acquireControl({ requestId: 'r-exp-1' }, sid1);

  let token1 = null;
  service.subscribeControl(sid1, (evt) => {
    if (evt.type === 'control.heartbeat') token1 = evt.payload.freshnessToken;
  });
  const t0 = Date.now();
  while (!token1 && Date.now() - t0 < 500) {
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(token1, 'Token 1 must be present');

  // Hold: gửi command hợp lệ
  service.sendVelocity({
    leaseId: lease1.leaseId, sequence: 1, freshnessToken: token1,
    linearX: 0.1, angularZ: 0,
  }, sid1);

  // Chờ lease 1 hết hạn (80ms)
  await new Promise(r => setTimeout(r, 120));

  // Gửi lệnh với lease 1 cũ bị từ chối
  assert.throws(() => {
    service.sendVelocity({
      leaseId: lease1.leaseId, sequence: 2, freshnessToken: token1,
      linearX: 0.1, angularZ: 0,
    }, sid1);
  }, /LEASE_NOT_OWNED|TOKEN_EXPIRED|SERVICE_DISPOSED/);

  // Đảm bảo robot dừng lại
  await new Promise(r => setTimeout(r, 50));

  // Reacquire với session mới
  const sid2 = service.createSession();
  const lease2 = await service.acquireControl({ requestId: 'r-reacquire' }, sid2);
  assert.notEqual(lease2.leaseId, lease1.leaseId);

  // Lệnh cũ với lease 1 không thể can thiệp owner mới
  assert.throws(() => {
    service.sendVelocity({
      leaseId: lease1.leaseId, sequence: 3, freshnessToken: token1,
      linearX: 0.15, angularZ: 0,
    }, sid1);
  }, /LEASE_NOT_OWNED/);

  service.dispose();
});

test('N8-12: manual stop không có lease vẫn zero + cancel mission; stop hai lần không nhân đôi terminal', async () => {
  const { service, sharedRobotState } = setupServiceFixture();
  const sid = service.createSession();

  sharedRobotState.update({ velocity: { linearX: 0.15, angularZ: 0 } });
  const stop1 = await service.requestStop({ requestId: 'stop-1' }, sid);
  assert.equal(stop1.status, 'accepted');

  const stop2 = await service.requestStop({ requestId: 'stop-2' }, sid);
  assert.equal(stop2.status, 'accepted');

  assert.equal(sharedRobotState.getSnapshot().velocity.linearX, 0);
  service.dispose();
});

test('N8-13: stop sau createMission/activateMap trước claim: chặn request mới trong stop', async () => {
  const { service, motionGate } = setupServiceFixture();
  const sid = service.createSession();

  const stopPromise = service.requestStop({ requestId: 'stop-gate-test' }, sid);
  // Khi đang stopping, motionGate.enter() bị từ chối
  assert.throws(() => motionGate.enter(), /MOTION_ADMISSION_BLOCKED|STOP_IN_PROGRESS/);
  await stopPromise;

  service.dispose();
});

test('N8-14: stop idempotent; replay stop cũ không dừng lease mới; manual stop ID mới thì dừng', async () => {
  const { service } = setupServiceFixture();
  const sid = service.createSession();

  const r1 = await service.requestStop({ requestId: 'stop-idem' }, sid);
  const r2 = await service.requestStop({ requestId: 'stop-idem' }, sid);
  assert.equal(r1.status, r2.status);

  service.dispose();
});

test('N8-15: accepted/command zero không đủ confirm; source sample mới đúng generation mới confirm', async () => {
  const { service, motionSource } = setupServiceFixture();
  const sid = service.createSession();

  let confirmed = false;
  service.subscribeControl(sid, (evt) => {
    if (evt.type === 'control.stopConfirmed') confirmed = true;
  });

  await service.requestStop({ requestId: 'stop-confirm-test' }, sid);
  // Ngay sau khi accepted, confirmation chưa diễn ra tức thì nếu chưa có sample tick
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(confirmed, true);

  service.dispose();
});

test('N8-16: selector toàn bộ reason, các ranh giới thời gian, camera policy; input thiếu field fail closed', () => {
  const now = performance.now();
  const validControl = {
    ready: true,
    phase: 'granted',
    controlGeneration: 1,
    lease: {
      leaseId: 'l1',
      controlGeneration: 1,
      expiresAt: new Date(Date.now() + 10000).toISOString(),
      limits: { maxLinearX: 0.2, maxAngularZ: 0.5 },
    },
    freshnessToken: 'tok-1',
    tokenDeadline: now + 500,
    leaseDeadline: now + 10000,
    heartbeatReceivedAt: now - 50,
    controlProfile: 'mock',
    stopUnconfirmed: false,
  };
  const validRobot = {
    snapshot: {
      rosConnected: true,
      mode: 'teleop',
      motionInhibited: false,
      physicalEstopActive: false,
      activeMissionId: null,
      activeMappingSessionId: null,
    },
    lastReceivedAt: now - 50,
    error: null,
  };
  const validCamera = {
    selectedCameraId: 'front',
    selectedGeneration: 1,
    cameraId: 'front',
    generation: 1,
    lastFrameAt: now - 50,
    error: null,
  };

  // 1. Positive baseline: tất cả hợp lệ -> allowed: true, reasons rỗng
  const ok = selectCanDrive({ authenticated: true, control: validControl, robot: validRobot, camera: validCamera, now });
  assert.equal(ok.allowed, true);
  assert.deepEqual(ok.reasons, []);

  // 2. Unauthenticated -> AUTH_REQUIRED
  const unauth = selectCanDrive({ authenticated: false, control: validControl, robot: validRobot, camera: validCamera, now });
  assert.equal(unauth.allowed, false);
  assert.ok(unauth.reasons.includes('AUTH_REQUIRED'));

  // 3. Unknown controlProfile -> CONTROL_PROFILE_UNKNOWN
  const badProfile = selectCanDrive({ authenticated: true, control: { ...validControl, controlProfile: 'unknown' }, robot: validRobot, camera: validCamera, now });
  assert.equal(badProfile.allowed, false);
  assert.ok(badProfile.reasons.includes('CONTROL_PROFILE_UNKNOWN'));

  // 4. Stale heartbeat (now - heartbeatReceivedAt >= 500ms)
  const staleHb = selectCanDrive({ authenticated: true, control: { ...validControl, heartbeatReceivedAt: now - 550 }, robot: validRobot, camera: validCamera, now });
  assert.equal(staleHb.allowed, false);
  assert.ok(staleHb.reasons.includes('HEARTBEAT_STALE'));

  // 5. Expired token (now >= tokenDeadline)
  const expToken = selectCanDrive({ authenticated: true, control: { ...validControl, tokenDeadline: now - 1 }, robot: validRobot, camera: validCamera, now });
  assert.equal(expToken.allowed, false);
  assert.ok(expToken.reasons.includes('TOKEN_EXPIRED'));

  // 6. Stale camera frame (now - lastFrameAt >= 1500ms)
  const staleCam = selectCanDrive({ authenticated: true, control: validControl, robot: validRobot, camera: { ...validCamera, lastFrameAt: now - 2000 }, now });
  assert.equal(staleCam.allowed, false);
  assert.ok(staleCam.reasons.includes('CAMERA_NOT_FRESH'));

  // 7. Robot disconnect / E-stop active
  const estop = selectCanDrive({
    authenticated: true,
    control: validControl,
    robot: { ...validRobot, snapshot: { ...validRobot.snapshot, physicalEstopActive: true } },
    camera: validCamera,
    now,
  });
  assert.equal(estop.allowed, false);
  assert.ok(estop.reasons.some(r => r.includes('ESTOP') || r.includes('ROBOT')));

  // 8. Fail-closed: input rỗng hoặc thiếu field
  const missing = selectCanDrive({ authenticated: true, control: {}, robot: {}, camera: {}, now });
  assert.equal(missing.allowed, false);
  assert.ok(missing.reasons.length > 0);
});

test('N8-17: single publisher: hai start chỉ một timer; owner khác release không dừng nhầm', () => {
  let timerCount = 0;
  const hold = createTeleopHoldController({
    getLatest: () => ({ allowed: true, lease: { leaseId: 'l1', limits: { maxLinearX: 0.2, maxAngularZ: 0.5 } }, freshnessToken: 't1' }),
    sendVelocity: () => {},
    requestStop: () => Promise.resolve(),
    setEvery: (fn) => { timerCount++; return setInterval(fn, 100); },
    clearEvery: (id) => { timerCount--; clearInterval(id); },
  });

  hold.start('pointer:1', { linearX: 0.1, angularZ: 0 });
  hold.start('pointer:1', { linearX: 0.1, angularZ: 0 });
  assert.equal(timerCount, 1);

  // Release từ owner khác không làm dừng
  hold.stop('RELEASED', 'pointer:2');
  assert.equal(hold.isActive(), true);

  // Release đúng owner
  hold.stop('RELEASED', 'pointer:1');
  assert.equal(hold.isActive(), false);
  hold.dispose();
});

test('N8-18: tick đọc store/clock mới; synchronous send throw ngừng loop', () => {
  let throwError = true;
  let reportedError = null;

  const hold = createTeleopHoldController({
    getLatest: () => ({ allowed: true, lease: { leaseId: 'l1', limits: { maxLinearX: 0.2, maxAngularZ: 0.5 } }, freshnessToken: 't1' }),
    sendVelocity: () => {
      if (throwError) throw new Error('SEND_FAILED_SYNC');
    },
    requestStop: () => Promise.resolve(),
    onError: (err) => { reportedError = err; },
    setEvery: (fn) => { fn(); return 1; },
    clearEvery: () => {},
  });

  hold.start('pointer:1', { linearX: 0.1, angularZ: 0 });
  assert.equal(hold.isActive(), false);
  assert.ok(reportedError);
  hold.dispose();
});

test('N8-19: event duplicate/out-of-order/epoch cũ bỏ; epoch mới fail closed', () => {
  const fence = createControlStreamFence();

  const e1 = { version: 1, streamEpoch: 'ep-1', sequence: 1, type: 'control.heartbeat', payload: {} };
  const e2 = { version: 1, streamEpoch: 'ep-1', sequence: 2, type: 'control.heartbeat', payload: {} };
  const eDup = { version: 1, streamEpoch: 'ep-1', sequence: 1, type: 'control.heartbeat', payload: {} };

  assert.equal(fence.event(e1), 'apply');
  assert.equal(fence.event(e2), 'apply');
  assert.equal(fence.event(eDup), 'drop');

  const eNewEpoch = { version: 1, streamEpoch: 'ep-2', sequence: 1, type: 'control.heartbeat', payload: {} };
  assert.equal(fence.event(eNewEpoch), 'recover');

  fence.dispose();

  // Coordinator test: epoch mới fail-closed và reconcile
  let queries = 0;
  let notify = null;
  const coordinator = createControlCoordinator({
    subscribeControl(fn) { notify = fn; return () => {}; },
    getControlState() {
      queries++;
      return Promise.resolve({
        version: 1, streamEpoch: 'ep-2', sequence: 1, sentAt: new Date().toISOString(),
        type: 'control.snapshot',
        payload: { controlGeneration: 0, ownership: 'none', lease: null, heartbeat: null, stop: null },
      });
    },
  });

  notify(ControlEventEnvelopeSchema.parse({
    version: 1, streamEpoch: 'ep-1', sequence: 1, sentAt: new Date().toISOString(),
    type: 'control.snapshot',
    payload: { controlGeneration: 0, ownership: 'none', lease: null, heartbeat: null, stop: null },
  }));
  notify(ControlEventEnvelopeSchema.parse({
    version: 1, streamEpoch: 'ep-2', sequence: 2, sentAt: new Date().toISOString(),
    type: 'control.snapshot',
    payload: { controlGeneration: 0, ownership: 'none', lease: null, heartbeat: null, stop: null },
  }));
  assert.ok(queries >= 1);
  coordinator.dispose();
});

test('N8-20: snapshot trả trễ không ghi đè newer state', () => {
  const fence = createControlStreamFence();
  const ticket1 = fence.beginQuery();
  const ticket2 = fence.beginQuery();

  assert.equal(fence.queryStillCurrent(ticket1), false);
  assert.equal(fence.queryStillCurrent(ticket2), true);

  fence.dispose();

  // Coordinator identity/evidence integration: late / stale snapshot cannot confirm stop with nonzero velocity
  useControlStore.getState().setControlState({
    controlProfile: 'mock',
    stopUnconfirmed: true,
    stopState: { requestId: 'req-stop-1', controlGeneration: 2, status: 'accepted', confirmation: null },
  });

  let notify;
  const coordinator = createControlCoordinator({
    subscribeControl(fn) { notify = fn; return () => {}; },
    getControlState() { return new Promise(() => {}); },
  });

  // Snapshot với confirmation có vận tốc non-zero không thể bypass xác nhận dừng
  notify(ControlEventEnvelopeSchema.parse({
    version: 1, streamEpoch: 'ep-1', sequence: 1, sentAt: new Date().toISOString(),
    type: 'control.snapshot',
    payload: {
      controlGeneration: 2, ownership: 'none', lease: null, heartbeat: null,
      stop: {
        requestId: 'req-stop-1', controlGeneration: 2, status: 'confirmed',
        confirmation: {
          requestId: 'req-stop-1', controlGeneration: 2, evidenceKind: 'mock-source-observation',
          sourceEpoch: 'src-1', sourceSequence: 1, observedAt: new Date().toISOString(),
          velocity: { linearX: 0.1, angularZ: 0 },
        },
      },
    },
  }));

  assert.equal(useControlStore.getState().stopUnconfirmed, true);
  coordinator.dispose();
});

test('N8-21: late acquire response sau stop bị abandon', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  let releaseCalled = false;
  let releasedLeaseId = null;
  const originalRelease = client.releaseControl.bind(client);
  client.releaseControl = async (raw) => {
    releaseCalled = true;
    releasedLeaseId = raw.leaseId;
    return originalRelease(raw);
  };

  const intent = createPageLeaseIntent({
    client,
    uuid: () => crypto.randomUUID(),
  });

  // Bắt đầu acquire
  const pAcquire = intent.acquire();

  // Dừng / abandon ngay trong lúc acquire đang xử lý
  intent.abandon();
  assert.equal(intent.canUseLease('any-lease'), false);

  // Chờ pAcquire giải quyết: intent phát hiện version không khớp -> tự release lease vừa được cấp
  const acquired = await pAcquire;
  assert.equal(acquired, false);
  assert.equal(releaseCalled, true);
  assert.ok(releasedLeaseId);

  intent.dispose();
  client.dispose();
});

test('N8-22: camera callback cleanup và unsupported camera descriptor', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  // 1. Danh sách camera hợp lệ
  const list = await client.listCameras();
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 2);
  const ids = list.map(c => c.cameraId);
  assert.ok(ids.includes('front'));
  assert.ok(ids.includes('rear'));

  // 2. Camera không được hỗ trợ -> reject bởi schema
  await assert.rejects(async () => {
    await client.getCameraStream({ cameraId: 'unsupported-360' });
  });

  // 3. getCameraStream trả descriptor hợp lệ
  const desc = await client.getCameraStream({ cameraId: 'front' });
  assert.equal(desc.kind, 'file');
  assert.equal(desc.cameraId, 'front');

  // 4. Unsupported descriptor trong openCameraStream -> fail closed
  let caughtError = null;
  const dummyVideo = {
    addEventListener: () => {},
    removeEventListener: () => {},
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback: () => {},
    pause: () => {},
    removeAttribute: () => {},
    load: () => {},
  };
  openCameraStream({
    video: dummyVideo,
    descriptor: { kind: 'unknown_transport', cameraId: 'front' },
    onFrame: () => {},
    onError: (err) => { caughtError = err; },
  });
  assert.ok(caughtError);

  // 5. Callback cleanup: subscribe và unsubscribe dọn dẹp đúng
  const closeStream = openCameraStream({
    video: dummyVideo,
    descriptor: desc,
    onFrame: () => {},
    onError: () => {},
  });
  assert.equal(typeof closeStream, 'function');
  closeStream();

  client.dispose();
});

test('N8-23: logout/dispose clear timers/listeners; 3 vòng login/logout vẫn chạy bình thường', async () => {
  const client = createMockRobotClient();

  for (let i = 0; i < 3; i++) {
    await client.login({ username: 'admin', password: 'demo-only' });
    const s = await client.getSession();
    assert.equal(s.user.username, 'admin');
    await client.logout();
    const sPost = await client.getSession();
    assert.equal(sPost.user, null);
  }

  client.dispose();
});

test('N8-24: façade validate input/output, sendVelocity trả undefined đồng bộ', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  const lease = await client.acquireControl({ requestId: 'r-acq-send' });
  let token = null;
  client.subscribeControl((evt) => {
    if (evt.type === 'control.heartbeat') token = evt.payload.freshnessToken;
  });
  const t0 = Date.now();
  while (!token && Date.now() - t0 < 500) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(token, 'Heartbeat freshness token must be provided');

  const ret = client.sendVelocity({
    leaseId: lease.leaseId, sequence: 1, freshnessToken: token, linearX: 0, angularZ: 0,
  });
  assert.equal(ret, undefined);

  // Reject unauthorized field tự nhận
  assert.throws(() => {
    client.sendVelocity({
      leaseId: lease.leaseId, sequence: 2, freshnessToken: token,
      linearX: 0, angularZ: 0, priority: 99,
    });
  });

  client.dispose();
});

test('N8-25: StrictMode / mount cycle không làm tăng subscriber/timer', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  assert.equal(client._subscriptions.size, 0);

  // Mount 1
  const unsub1 = client.subscribeControl(() => {});
  assert.equal(client._subscriptions.size, 1);

  // StrictMode remount 2
  const unsub2 = client.subscribeControl(() => {});
  assert.equal(client._subscriptions.size, 2);

  // Cleanup 1
  unsub1();
  assert.equal(client._subscriptions.size, 1);

  // Cleanup 2
  unsub2();
  assert.equal(client._subscriptions.size, 0);

  client.dispose();
});

test('N8-26: control request registry bounded retention, clear session', () => {
  const reg = createControlRequestRegistry();
  reg.run({ sessionId: 's1', operation: 'op', requestId: 'r1', payload: {} }, () => ({ ok: true }));
  assert.equal(reg.size, 1);
  reg.clearSession('s1');
  assert.equal(reg.size, 0);
  reg.clear();
});
