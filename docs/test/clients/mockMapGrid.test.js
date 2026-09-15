import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockMapGrid } from '../../../frontend/src/clients/mockMapGrid.js';
import { createMockMapRepository } from '../../../frontend/src/clients/mockMapRepository.js';

test('TC-GRID-01: mockMapGrid trả về bản sao độc lập (không bị mutate)', async () => {
  const mapRepository = createMockMapRepository();
  const service = createMockMapGrid({ mapRepository });
  const ctx = { kind: 'saved', mapId: 'map-demo', mapRevision: 'rev-1' };

  const grid1 = await service.getMapGrid(ctx);
  grid1.grid.info.resolution = 999; // Cố tình sửa thuộc tính

  const grid2 = await service.getMapGrid(ctx);
  assert.notEqual(grid2.grid.info.resolution, 999);
  assert.equal(grid2.grid.info.resolution, 0.05);

  service.dispose();
});

test('TC-GRID-02: mockMapGrid hủy timer đăng ký an toàn khi unsubscribe ngay lập tức', async () => {
  const service = createMockMapGrid();
  const ctx = { kind: 'saved', mapId: 'map-demo', mapRevision: 'rev-1' };

  let received = false;
  const unsub = service.subscribeMapGrid(ctx, () => {
    received = true;
  });

  // Hủy đăng ký ngay lập tức
  unsub();

  // Đợi 30ms (vượt quá timer 10ms của mock)
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(received, false);

  service.dispose();
});

test('TC-GRID-03: Hai subscribers cùng session dùng chung 1 producer timer; unsubscribe A không ảnh hưởng B', async () => {
  const service = createMockMapGrid();
  const sessionId = 'session-multi-sub';
  service.createLiveSession(sessionId);
  service.advanceSourceStep(sessionId); // Khởi tạo frame đầu tiên để session ở trạng thái ready

  const ctx = { kind: 'mapping', mappingSessionId: sessionId };
  let countA = 0;
  let countB = 0;

  const unsubA = service.subscribeMapGrid(ctx, (evt) => {
    if (evt.type === 'map.grid') countA += 1;
  });

  const unsubB = service.subscribeMapGrid(ctx, (evt) => {
    if (evt.type === 'map.grid') countB += 1;
  });

  // Đợi initial delivery (~20ms)
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(countA, 1);
  assert.equal(countB, 1);

  // Unsubscribe A
  unsubA();

  // Chờ producer tick tiếp theo (500ms)
  await new Promise((r) => setTimeout(r, 550));

  // B vẫn tiếp tục nhận được grid mới
  assert.equal(countA, 1);
  assert.ok(countB >= 2);

  unsubB();
  service.dispose();
});

test('TC-GRID-04: Subscribe vào fake session không tạo session mới và trả SESSION_NOT_FOUND', async () => {
  const service = createMockMapGrid();
  const fakeCtx = { kind: 'mapping', mappingSessionId: 'non-existent-session' };

  let receivedError = null;
  const unsub = service.subscribeMapGrid(fakeCtx, (evt) => {
    if (evt.type === 'map.error') {
      receivedError = evt.payload.error;
    }
  });

  await new Promise((r) => setTimeout(r, 30));
  assert.ok(receivedError);
  assert.equal(receivedError.code, 'SESSION_NOT_FOUND');

  // getMapGrid trên fake session vẫn reject
  await assert.rejects(async () => {
    await service.getMapGrid(fakeCtx);
  }, (err) => err.code === 'SESSION_NOT_FOUND');

  unsub();
  service.dispose();
});

test('TC-GRID-05: Động cơ khám phá SLAM chuyển ô unknown (-1) thành free (0) và tăng revision', async () => {
  const service = createMockMapGrid();
  const sessionId = 'session-slam-explore';
  const session = service.createLiveSession(sessionId);

  const initialUnknownCount = session.grid.grid.data.filter((c) => c === -1).length;
  assert.equal(initialUnknownCount, 200 * 160); // Ban đầu 100% ô là Unknown

  // Tiến 1 bước khám phá
  service.advanceSourceStep(sessionId);

  const afterStepUnknownCount = session.grid.grid.data.filter((c) => c === -1).length;
  const freeCount = session.grid.grid.data.filter((c) => c === 0).length;

  assert.ok(afterStepUnknownCount < initialUnknownCount);
  assert.ok(freeCount > 0);
  assert.ok(session.grid.gridRevision >= 2);

  service.dispose();
});

test('TC-GRID-06: Kịch bản wrong_frame clone frame_id odom mà không mutate grid gốc', async () => {
  const service = createMockMapGrid();
  const sessionId = 'session-wrong-frame';
  service.createLiveSession(sessionId);

  service.setSessionScenario(sessionId, 'wrong_frame');

  let receivedFrameId = null;
  const unsub = service.subscribeMapGrid({ kind: 'mapping', mappingSessionId: sessionId }, (evt) => {
    if (evt.type === 'map.grid') {
      receivedFrameId = evt.payload.grid.header.frame_id;
    }
  });

  // Chờ producer tick
  await new Promise((r) => setTimeout(r, 550));

  assert.equal(receivedFrameId, 'odom');

  // Grid gốc trong cache vẫn phải giữ frame_id 'map'
  const cachedGrid = await service.getMapGrid({ kind: 'mapping', mappingSessionId: sessionId });
  assert.equal(cachedGrid.grid.header.frame_id, 'map');

  unsub();
  service.dispose();
});

test('TC-GRID-07: Kịch bản expand_geometry mở rộng kích thước lên 220x180 đúng 39,600 ô', async () => {
  const service = createMockMapGrid();
  const sessionId = 'session-expand';
  service.createLiveSession(sessionId);

  service.setSessionScenario(sessionId, 'expand_geometry');

  const expanded = await service.getMapGrid({ kind: 'mapping', mappingSessionId: sessionId });
  assert.equal(expanded.grid.info.width, 220);
  assert.equal(expanded.grid.info.height, 180);
  assert.equal(expanded.grid.data.length, 220 * 180);
  assert.equal(expanded.grid.info.origin.position.x, -5.5);
  assert.equal(expanded.grid.info.origin.position.y, -4.5);

  service.dispose();
});

test('TC-GRID-08: dispose() dọn dẹp sạch sẽ toàn bộ live sessions và producer timers', async () => {
  const service = createMockMapGrid();
  service.createLiveSession('session-to-dispose');

  service.dispose();

  // Gọi getMapGrid sau khi dispose phải throw
  await assert.rejects(async () => {
    await service.getMapGrid({ kind: 'mapping', mappingSessionId: 'session-to-dispose' });
  }, (err) => err.code === 'SESSION_NOT_FOUND');
});

test('TC-GRID-09: đổi nhãn scenario về live không giả mạo source update', async () => {
  let nowMs = 1000;
  const service = createMockMapGrid({ now: () => nowMs });
  const sessionId = 'session-source-age';
  service.createLiveSession(sessionId);
  service.advanceSourceStep(sessionId);
  service.setSessionScenario(sessionId, 'pause');

  const statuses = [];
  const unsubscribe = service.subscribeMapGrid(
    { kind: 'mapping', mappingSessionId: sessionId },
    (event) => {
      if (event.type === 'map.status') statuses.push(event.payload);
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  nowMs += 2501;
  service.emitSessionNow(sessionId);
  const before = statuses.at(-1);
  const revisionBefore = service.getLiveSessionSnapshot(sessionId).gridRevision;

  service.setSessionScenario(sessionId, 'live');
  service.emitSessionNow(sessionId);
  const after = statuses.at(-1);
  const revisionAfter = service.getLiveSessionSnapshot(sessionId).gridRevision;

  assert.equal(before.sourceState, 'stale');
  assert.equal(before.lastSourceUpdateAgeMs, 2501);
  assert.equal(after.sourceState, 'stale');
  assert.ok(after.lastSourceUpdateAgeMs >= before.lastSourceUpdateAgeMs);
  assert.equal(revisionAfter, revisionBefore);

  service.advanceSourceStep(sessionId);
  service.emitSessionNow(sessionId);
  const recovered = statuses.at(-1);
  assert.equal(recovered.sourceState, 'live');
  assert.equal(recovered.lastSourceUpdateAgeMs, 0);

  unsubscribe();
  service.dispose();
});
