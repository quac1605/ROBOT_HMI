import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapGridEventGate } from '../../../frontend/src/utils/mapGridEventGate.js';

function createDummyValidSnapshot(mapId) {
  return {
    source: 'mock',
    mode: 'snapshot',
    encoding: 'occupancy-0-100-v1',
    context: { kind: 'saved', mapId, mapRevision: 'rev-1' },
    gridRevision: 1,
    grid: {
      header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
      info: {
        map_load_time: { sec: 1, nanosec: 0 },
        resolution: 0.05,
        width: 2,
        height: 2,
        origin: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      },
      data: [0, 0, 0, 0],
    },
  };
}

test('Gate bỏ qua response đến muộn của generation cũ', () => {
  let receivedSnapshot = null;
  const gate = createMapGridEventGate({
    onSnapshot: (snap) => { receivedSnapshot = snap; },
  });

  gate.setContext({ kind: 'saved', mapId: 'map-1', mapRevision: 'rev-1' }, 'sub-1');
  const gen1 = gate.getGeneration();

  // Đổi sang context mới (gen2)
  gate.setContext({ kind: 'saved', mapId: 'map-2', mapRevision: 'rev-1' }, 'sub-2');

  // Response của gen1 về muộn
  const handled = gate.handleInitialResponse(gen1, createDummyValidSnapshot('map-1'));
  assert.equal(handled, false);
  assert.equal(receivedSnapshot, null);
});

test('Gate bỏ qua initial response nếu subscription event đã tới trước', () => {
  let receivedCount = 0;
  const gate = createMapGridEventGate({
    onSnapshot: () => { receivedCount += 1; },
  });

  const ctx = { kind: 'saved', mapId: 'map-1', mapRevision: 'rev-1' };
  gate.setContext(ctx, 'sub-1');
  const gen = gate.getGeneration();

  // Event stream đến trước
  gate.handleEvent(gen, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-1',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: createDummyValidSnapshot('map-1'),
  });
  assert.equal(receivedCount, 1);

  // Response của getMapGrid về sau
  const handled = gate.handleInitialResponse(gen, createDummyValidSnapshot('map-1'));
  assert.equal(handled, false);
  assert.equal(receivedCount, 1);
});

test('Gate bỏ qua lỗi initial request đến muộn sau subscription grid hợp lệ', () => {
  const errors = [];
  let snapshots = 0;
  const gate = createMapGridEventGate({
    onSnapshot: () => { snapshots += 1; },
    onError: (error) => errors.push(error),
  });
  const context = { kind: 'saved', mapId: 'map-late-error', mapRevision: 'rev-1' };
  gate.setContext(context, 'sub-late-error');
  const generation = gate.getGeneration();

  assert.equal(gate.handleEvent(generation, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-late-error',
    streamId: 'stream-late-error',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: createDummyValidSnapshot('map-late-error'),
  }), true);
  assert.equal(snapshots, 1);

  const lateError = Object.assign(new Error('initial request failed late'), {
    code: 'FETCH_FAILED',
  });
  assert.equal(gate.handleInitialError(generation, lateError), false);
  assert.deepEqual(errors, []);
});

test('Gate xử lý đúng Stream Epoch và lọc sequence cũ/trùng', () => {
  const snapshots = [];
  const gate = createMapGridEventGate({
    onSnapshot: (s) => snapshots.push(s),
  });

  const ctx = { kind: 'saved', mapId: 'map-1', mapRevision: 'rev-1' };
  gate.setContext(ctx, 'sub-1');
  const gen = gate.getGeneration();

  // Gói 1: epoch 1, seq 5
  gate.handleEvent(gen, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-1',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 5,
    sentAt: new Date().toISOString(),
    payload: createDummyValidSnapshot('map-1'),
  });
  assert.equal(snapshots.length, 1);

  // Gói 2: epoch 1, seq 4 (cũ hơn -> bỏ qua)
  gate.handleEvent(gen, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-1',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 4,
    sentAt: new Date().toISOString(),
    payload: createDummyValidSnapshot('map-1'),
  });
  assert.equal(snapshots.length, 1);

  // Gói 3: epoch 2, seq 1 (epoch mới -> chấp nhận ngay dù seq nhỏ hơn)
  gate.handleEvent(gen, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-1',
    streamId: 'stream-1',
    streamEpoch: 2,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: { ...createDummyValidSnapshot('map-1'), gridRevision: 2 },
  });
  assert.equal(snapshots.length, 2);
});

test('Gate bỏ qua event sai subscriptionId hoặc sai context', () => {
  let count = 0;
  const gate = createMapGridEventGate({
    onSnapshot: () => { count += 1; },
  });

  const ctx = { kind: 'saved', mapId: 'map-target', mapRevision: 'rev-1' };
  gate.setContext(ctx, 'sub-target');
  const gen = gate.getGeneration();

  // Sai subscriptionId
  gate.handleEvent(gen, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-wrong',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: createDummyValidSnapshot('map-target'),
  });
  assert.equal(count, 0);

  // Sai context mapId
  gate.handleEvent(gen, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-target',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 2,
    sentAt: new Date().toISOString(),
    payload: createDummyValidSnapshot('map-other'),
  });
  assert.equal(count, 0);
});

test('map.status đến trước không làm mất initial grid hợp lệ', () => {
  let receivedSnapshot = null;
  let receivedStatus = null;
  const gate = createMapGridEventGate({
    onSnapshot: (s) => { receivedSnapshot = s; },
    onStatus: (st) => { receivedStatus = st; },
  });

  const ctx = { kind: 'saved', mapId: 'map-race', mapRevision: 'rev-1' };
  gate.setContext(ctx, 'sub-race');
  const gen = gate.getGeneration();

  // 1. map.status đến trước
  gate.handleEvent(gen, {
    version: 1,
    type: 'map.status',
    subscriptionId: 'sub-race',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: {
      context: ctx,
      state: 'ready',
      sourceState: 'live',
      lastSourceUpdateAgeMs: 50,
    },
  });
  assert.ok(receivedStatus);

  // 2. Initial response đến sau -> Vẫn phải được chấp nhận vì chưa có map.grid
  const handled = gate.handleInitialResponse(gen, createDummyValidSnapshot('map-race'));
  assert.equal(handled, true);
  assert.ok(receivedSnapshot);
});

test('Grid lỗi hoặc sai frameId giữ nguyên last-good snapshot', () => {
  let lastSnapshot = null;
  let caughtError = null;
  const gate = createMapGridEventGate({
    onSnapshot: (s) => { lastSnapshot = s; },
    onError: (err) => { caughtError = err; },
  });

  const ctx = { kind: 'saved', mapId: 'map-frame', mapRevision: 'rev-1' };
  gate.setContext(ctx, 'sub-frame');
  const gen = gate.getGeneration();

  // 1. Grid đầu tiên thành công với frame_id: 'map'
  gate.handleEvent(gen, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-frame',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: createDummyValidSnapshot('map-frame'),
  });
  assert.equal(lastSnapshot.geometry.frameId, 'map');

  // 2. Grid thứ hai gửi sai frame_id: 'odom' -> MAP_FRAME_MISMATCH
  const wrongFrameSnapshot = createDummyValidSnapshot('map-frame');
  wrongFrameSnapshot.grid.header.frame_id = 'odom';

  gate.handleEvent(gen, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-frame',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 2,
    sentAt: new Date().toISOString(),
    payload: wrongFrameSnapshot,
  });

  assert.equal(caughtError.code, 'MAP_FRAME_MISMATCH');
  // Snapshot hiển thị vẫn là last-good ban đầu ('map')
  assert.equal(lastSnapshot.geometry.frameId, 'map');
  assert.equal(gate.getLastGoodGrid().geometry.frameId, 'map');
});

test('Payload status sai bị từ chối trước khi poison stream cursor', () => {
  const statuses = [];
  const errors = [];
  const gate = createMapGridEventGate({
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
  });
  const context = { kind: 'saved', mapId: 'map-status', mapRevision: 'rev-1' };
  gate.setContext(context, 'sub-status');
  const generation = gate.getGeneration();

  const malformedHandled = gate.handleEvent(generation, {
    version: 1,
    type: 'map.status',
    subscriptionId: 'sub-status',
    streamId: 'stream-attacker',
    streamEpoch: 1,
    sequence: 999,
    sentAt: new Date().toISOString(),
    payload: {
      context,
      state: 'BOGUS',
      sourceState: 'INVALID',
      lastSourceUpdateAgeMs: -1,
    },
  });

  assert.equal(malformedHandled, false);
  assert.equal(statuses.length, 0);
  assert.equal(errors.at(-1)?.code, 'INVALID_ENVELOPE');

  // Vì event lỗi không được phép latch stream/sequence, event hợp lệ thấp hơn vẫn nhận.
  const validHandled = gate.handleEvent(generation, {
    version: 1,
    type: 'map.status',
    subscriptionId: 'sub-status',
    streamId: 'stream-valid',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: {
      context,
      state: 'ready',
      sourceState: 'saved',
      lastSourceUpdateAgeMs: null,
    },
  });

  assert.equal(validHandled, true);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].sourceState, 'saved');
});

test('Live mapping từ chối cả frame sai đầu tiên khi đã khai báo expectedFrameId', () => {
  let snapshot = null;
  let error = null;
  const context = { kind: 'mapping', mappingSessionId: 'sess-frame' };
  const gate = createMapGridEventGate({
    onSnapshot: (next) => { snapshot = next; },
    onError: (next) => { error = next; },
  });
  gate.setContext(context, 'sub-live-frame', 'map');
  const generation = gate.getGeneration();
  const wrong = createDummyValidSnapshot('unused');
  wrong.context = context;
  wrong.grid.header.frame_id = 'odom';

  assert.equal(gate.handleEvent(generation, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-live-frame',
    streamId: 'stream-wrong',
    streamEpoch: 1,
    sequence: 10,
    sentAt: new Date().toISOString(),
    payload: wrong,
  }), false);
  assert.equal(snapshot, null);
  assert.equal(error?.code, 'MAP_FRAME_MISMATCH');

  const valid = createDummyValidSnapshot('unused');
  valid.context = context;
  assert.equal(gate.handleEvent(generation, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-live-frame',
    streamId: 'stream-valid',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: valid,
  }), true);
  assert.equal(snapshot?.geometry.frameId, 'map');
});

test('Exact grid dedupe xác nhận phục hồi lỗi nhưng không yêu cầu raster lại', () => {
  const context = { kind: 'saved', mapId: 'map-recovery', mapRevision: 'rev-1' };
  let snapshotCount = 0;
  let activeError = null;
  let recoveryCount = 0;
  const gate = createMapGridEventGate({
    onSnapshot: () => {
      snapshotCount += 1;
      activeError = null;
    },
    onError: (error) => {
      activeError = error;
    },
    onValidSnapshot: () => {
      recoveryCount += 1;
      activeError = null;
    },
  });
  gate.setContext(context, 'sub-recovery');
  const generation = gate.getGeneration();
  const snapshot = createDummyValidSnapshot('map-recovery');

  assert.equal(gate.handleEvent(generation, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-recovery',
    streamId: 'stream-recovery',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: snapshot,
  }), true);

  assert.equal(gate.handleEvent(generation, {
    version: 1,
    type: 'map.error',
    subscriptionId: 'sub-recovery',
    streamId: 'stream-recovery',
    streamEpoch: 1,
    sequence: 2,
    sentAt: new Date().toISOString(),
    payload: {
      context,
      error: { code: 'SOURCE_GLITCH', message: 'Nguồn gián đoạn tạm thời' },
    },
  }), true);
  assert.equal(activeError?.code, 'SOURCE_GLITCH');

  assert.equal(gate.handleEvent(generation, {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-recovery',
    streamId: 'stream-recovery',
    streamEpoch: 1,
    sequence: 3,
    sentAt: new Date().toISOString(),
    payload: structuredClone(snapshot),
  }), true);

  assert.equal(snapshotCount, 1);
  assert.equal(recoveryCount, 1);
  assert.equal(activeError, null);
});
