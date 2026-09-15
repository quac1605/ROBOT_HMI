import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockRobotClient } from '../../../frontend/src/clients/mockRobotClient.js';
import { createMapGridEventGate } from '../../../frontend/src/utils/mapGridEventGate.js';
import { JobSchema } from '../../../frontend/src/schemas/mapping.js';

test('Integration Probe 1: Khớp subscriptionId tuyệt đối giữa Client và Event Gate', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  const ctx = { kind: 'saved', mapId: 'map-demo', mapRevision: 'rev-1' };
  const subId = `sub-probe-${Date.now()}`;

  let snapshotsReceived = 0;
  let statusesReceived = 0;
  let errorsReceived = 0;

  const gate = createMapGridEventGate({
    onSnapshot: () => { snapshotsReceived += 1; },
    onStatus: () => { statusesReceived += 1; },
    onError: () => { errorsReceived += 1; },
  });

  gate.setContext(ctx, subId);
  const gen = gate.getGeneration();

  // Truyền đúng subscriptionId qua options
  const unsub = client.subscribeMapGrid(
    ctx,
    (rawEvent) => {
      gate.handleEvent(gen, rawEvent);
    },
    { subscriptionId: subId }
  );

  // Đợi mock delivery (~25ms)
  await new Promise((r) => setTimeout(r, 40));

  // Gate phải chấp nhận cả status và grid, không bị loại do sai subscriptionId
  assert.equal(statusesReceived, 1);
  assert.equal(snapshotsReceived, 1);
  assert.equal(errorsReceived, 0);

  unsub();
  await client.logout();
});

test('Integration Probe 2: Luồng SLAM hoàn chỉnh, getJob() không ném ZodError và trả mapRevision', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  // 1. Start Mapping
  const startResp = await client.startMapping({
    name: 'Bản đồ Thử nghiệm Probe',
    requestId: `req-start-${Date.now()}`,
  });
  assert.ok(startResp.mappingSessionId);

  // 2. getMapGrid khi chưa có frame đầu trả MAP_NOT_READY
  await assert.rejects(
    async () =>
      client.getMapGrid({
        kind: 'mapping',
        mappingSessionId: startResp.mappingSessionId,
      }),
    (err) => err.code === 'MAP_NOT_READY'
  );

  // Đợi robot chuyển sang trạng thái mapping và producer sinh frame đầu (550ms)
  await new Promise((r) => setTimeout(r, 550));

  // Sau khi có frame đầu, getMapGrid trả về grid hợp lệ
  const initialGrid = await client.getMapGrid({
    kind: 'mapping',
    mappingSessionId: startResp.mappingSessionId,
  });
  assert.equal(initialGrid.context.kind, 'mapping');

  // 3. Finish Mapping
  const finishResp = await client.finishMapping({
    mappingSessionId: startResp.mappingSessionId,
    name: 'Bản đồ Thử nghiệm Probe',
    requestId: `req-finish-${Date.now()}`,
  });
  assert.ok(finishResp.jobId);

  // Đợi job hoàn tất (550ms)
  await new Promise((r) => setTimeout(r, 550));

  // 4. getJob() phải parse thành công không ném ZodError
  const job = await client.getJob(finishResp.jobId);
  assert.equal(job.status, 'completed');
  assert.ok(job.result);
  assert.ok(job.result.mapId);
  assert.ok(job.result.mapRevision); // mapRevision đúng theo JobSchema

  const validatedJob = JobSchema.parse(job);
  assert.equal(validatedJob.result.mapRevision, 'rev-1');

  // 5. Danh mục map mới xuất hiện map vừa lưu
  const maps = await client.listMaps();
  assert.ok(maps.some((m) => m.id === job.result.mapId));

  await client.logout();
});

test('Integration Probe 3: Chặn finish đồng thời và bảo vệ auth sau logout', async () => {
  const client = createMockRobotClient();
  await client.login({ username: 'admin', password: 'demo-only' });

  const startResp = await client.startMapping({
    name: 'Lock Test',
    requestId: `req-start-lock`,
  });

  await new Promise((r) => setTimeout(r, 450));

  // Finish lần 1
  await client.finishMapping({
    mappingSessionId: startResp.mappingSessionId,
    name: 'Lock Test',
    requestId: 'req-finish-1',
  });

  // Finish lần 2 với requestId khác trong khi đang finishing -> Bị chặn
  await assert.rejects(async () => {
    await client.finishMapping({
      mappingSessionId: startResp.mappingSessionId,
      name: 'Lock Test',
      requestId: 'req-finish-2',
    });
  }, (err) => err.code === 'FINISH_ALREADY_IN_PROGRESS');

  await new Promise((r) => setTimeout(r, 550));

  // Logout và kiểm tra auth
  await client.logout();
  await assert.rejects(async () => client.listMaps(), (err) => err.code === 'UNAUTHENTICATED');
});
