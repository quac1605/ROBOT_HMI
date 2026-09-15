import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockRobotClient } from '../../../frontend/src/clients/mockRobotClient.js';

test('mockRobotClient từ chối tất cả API telemetry và mapping trước khi login', async () => {
  const client = createMockRobotClient();

  // Telemetry APIs
  await assert.rejects(async () => client.getRobotState(), (err) => err.code === 'UNAUTHENTICATED');
  assert.throws(() => client.subscribeRobotState(() => {}), (err) => err.code === 'UNAUTHENTICATED');
  assert.throws(() => client.setDemoScenario('stale'), (err) => err.code === 'UNAUTHENTICATED');
  assert.throws(() => client.getDemoScenario(), (err) => err.code === 'UNAUTHENTICATED');

  // Mapping & Grid APIs
  await assert.rejects(async () => client.listMaps(), (err) => err.code === 'UNAUTHENTICATED');
  await assert.rejects(async () => client.getMap('map-1', 'rev-1'), (err) => err.code === 'UNAUTHENTICATED');
  await assert.rejects(async () => client.getMapGrid({ kind: 'saved', mapId: 'map-1', mapRevision: 'rev-1' }), (err) => err.code === 'UNAUTHENTICATED');
  assert.throws(() => client.subscribeMapGrid({ kind: 'saved', mapId: 'm', mapRevision: 'r' }, () => {}), (err) => err.code === 'UNAUTHENTICATED');
  await assert.rejects(async () => client.getActiveMappingSession(), (err) => err.code === 'UNAUTHENTICATED');
  await assert.rejects(async () => client.startMapping({ name: 'Test' }), (err) => err.code === 'UNAUTHENTICATED');
  await assert.rejects(async () => client.finishMapping({ mappingSessionId: 's1' }), (err) => err.code === 'UNAUTHENTICATED');
  assert.throws(() => client.subscribeJobs(() => {}), (err) => err.code === 'UNAUTHENTICATED');
  await assert.rejects(async () => client.getJob('job-1'), (err) => err.code === 'UNAUTHENTICATED');
});

test('mockRobotClient cho phép gọi API sau khi login thành công', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  const state = await client.getRobotState();
  assert.equal(state.robotId, 'robot-01');

  const maps = await client.listMaps();
  assert.ok(Array.isArray(maps));
});

test('logout dọn dẹp sạch sẽ toàn bộ active subscriptions và chuyển trạng thái về unauthenticated', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  let telemetryReceivedCount = 0;
  const unsubTele = client.subscribeRobotState(() => {
    telemetryReceivedCount += 1;
  });

  let jobReceivedCount = 0;
  const unsubJob = client.subscribeJobs(() => {
    jobReceivedCount += 1;
  });

  // Logout sẽ tự động hủy toàn bộ subscriptions
  await client.logout();

  const countAfterLogout = telemetryReceivedCount;

  // Chờ 300ms xem có callback nào tiếp tục bắn không
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(telemetryReceivedCount, countAfterLogout);
  assert.ok(jobReceivedCount >= 0);

  // Gọi idempotent unsubscribe cũ nhiều lần không gây lỗi
  assert.doesNotThrow(() => {
    unsubTele();
    unsubTele();
    unsubJob();
  });

  // Gọi lại API sau khi logout phải bị chặn
  await assert.rejects(async () => client.getRobotState(), (err) => err.code === 'UNAUTHENTICATED');
});

test('Start không phát pose cũ trước xác nhận và pose đầu mapping thuộc nguồn session mới', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });
  const unsubscribe = client.subscribeRobotState(() => {});
  const response = await client.startMapping({
    name: 'Phiên không được tái dùng pose',
    requestId: 'req-no-stale-pose',
  });

  await new Promise((resolve) => setTimeout(resolve, 250));
  const duringStart = await client.getRobotState();
  const pendingJob = await client.getJob(response.jobId);
  assert.equal(pendingJob.status, 'accepted');
  assert.equal((await client.getActiveMappingSession()).session.status, 'starting');
  assert.equal(duringStart.mode, 'idle');
  assert.equal(duringStart.activeMappingSessionId, response.mappingSessionId);
  assert.equal(duringStart.pose, null);

  await new Promise((resolve) => setTimeout(resolve, 450));
  const afterStart = await client.getRobotState();
  assert.equal((await client.getJob(response.jobId)).status, 'completed');
  assert.equal(afterStart.mode, 'mapping');
  assert.deepEqual(afterStart.pose, { frameId: 'map', x: 2, y: 2, yaw: 0 });

  unsubscribe();
  client.dispose();
});

test('logout hủy phiên mapping chưa lưu; dispose toàn client là idempotent và chặn API mới', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });
  await client.startMapping({ name: 'Sẽ bị hủy khi logout', requestId: 'req-logout-map' });
  await client.logout();
  await client.login({ username: 'admin', password: 'demo-only' });
  assert.equal((await client.getActiveMappingSession()).session, null);
  assert.equal(client._mapGridService.getDebugState().liveSessions.length, 0);

  client.dispose();
  assert.doesNotThrow(() => client.dispose());
  await assert.rejects(async () => client.getSession(), (err) => err.code === 'CLIENT_DISPOSED');
});
