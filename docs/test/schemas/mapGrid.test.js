import test from 'node:test';
import assert from 'node:assert/strict';
import {
  preflightMapGrid,
  parseMapGridSnapshot,
  parseRawMapMessage,
  MapGridSnapshotSchema,
  MapGridEventEnvelopeSchema,
  ShallowMapGridEventEnvelopeSchema,
  MAX_MAP_DIMENSION,
  MAX_MAP_CELLS,
} from '../../../frontend/src/schemas/mapGrid.js';

function createValidRawSnapshot(width = 2, height = 2, data = [0, 0, 0, 0]) {
  return {
    source: 'mock',
    mode: 'snapshot',
    encoding: 'occupancy-0-100-v1',
    context: { kind: 'saved', mapId: 'test-map', mapRevision: 'rev-1' },
    gridRevision: 1,
    grid: {
      header: { frame_id: 'map', stamp: { sec: 10, nanosec: 0 } },
      info: {
        map_load_time: { sec: 10, nanosec: 0 },
        resolution: 0.05,
        width,
        height,
        origin: {
          position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      data,
    },
  };
}

test('preflightMapGrid từ chối dữ liệu không phải object hoặc thiếu grid.info', () => {
  assert.throws(() => preflightMapGrid(null), (err) => err.code === 'INVALID_MAP_DATA');
  assert.throws(() => preflightMapGrid('not-object'), (err) => err.code === 'INVALID_MAP_DATA');
  assert.throws(() => preflightMapGrid({}), (err) => err.code === 'INVALID_MAP_DATA');
  assert.throws(() => preflightMapGrid({ grid: {} }), (err) => err.code === 'INVALID_MAP_DATA');
});

test('preflightMapGrid từ chối width/height không phải số nguyên dương', () => {
  const raw1 = createValidRawSnapshot(0, 2, []);
  assert.throws(() => preflightMapGrid(raw1), (err) => err.code === 'INVALID_MAP_DATA');

  const raw2 = createValidRawSnapshot(2.5, 2, [0, 0, 0, 0]);
  assert.throws(() => preflightMapGrid(raw2), (err) => err.code === 'INVALID_MAP_DATA');

  const raw3 = createValidRawSnapshot(-5, 2, [0, 0, 0, 0]);
  assert.throws(() => preflightMapGrid(raw3), (err) => err.code === 'INVALID_MAP_DATA');
});

test('preflightMapGrid từ chối bản đồ vượt giới hạn dimension hoặc tổng số ô (MAP_TOO_LARGE)', () => {
  // Dimension vượt MAX_MAP_DIMENSION (4096)
  const rawOversizeDim = createValidRawSnapshot(MAX_MAP_DIMENSION + 1, 1, []);
  assert.throws(() => preflightMapGrid(rawOversizeDim), (err) => err.code === 'MAP_TOO_LARGE');

  // Tổng số ô vượt MAX_MAP_CELLS (262,144)
  assert.equal(MAX_MAP_CELLS, 262144);
  const rawOversizeCells = createValidRawSnapshot(513, 513, []);
  assert.throws(() => preflightMapGrid(rawOversizeCells), (err) => err.code === 'MAP_TOO_LARGE');
});

test('preflightMapGrid từ chối khi data.length không khớp width * height', () => {
  const raw = createValidRawSnapshot(2, 2, [0, 0, 0]); // 3 ô thay vì 4
  assert.throws(() => preflightMapGrid(raw), (err) => err.code === 'INVALID_MAP_DATA');
});

test('preflightMapGrid từ chối ô ngoài phạm vi [-1, 100] hoặc không phải số nguyên', () => {
  assert.throws(
    () => preflightMapGrid(createValidRawSnapshot(2, 1, [-2, 0])),
    (err) => err.code === 'INVALID_MAP_DATA'
  );
  assert.throws(
    () => preflightMapGrid(createValidRawSnapshot(2, 1, [101, 0])),
    (err) => err.code === 'INVALID_MAP_DATA'
  );
  assert.throws(
    () => preflightMapGrid(createValidRawSnapshot(2, 1, [0.5, 0])),
    (err) => err.code === 'INVALID_MAP_DATA'
  );
});

test('preflightMapGrid chấp nhận bản đồ hợp lệ', () => {
  const raw = createValidRawSnapshot(2, 2, [-1, 0, 50, 100]);
  assert.equal(preflightMapGrid(raw), true);
});

test('MapGridSnapshotSchema parse thành công snapshot hợp lệ', () => {
  const raw = createValidRawSnapshot(2, 2, [-1, 0, 50, 100]);
  const result = MapGridSnapshotSchema.safeParse(raw);
  assert.equal(result.success, true);
});

test('MapGridSnapshotSchema từ chối frame_id rỗng hoặc chỉ có khoảng trắng', () => {
  for (const frameId of ['', '   ']) {
    const raw = createValidRawSnapshot(2, 2, [-1, 0, 50, 100]);
    raw.grid.header.frame_id = frameId;
    assert.equal(MapGridSnapshotSchema.safeParse(raw).success, false);
  }
});

test('parseMapGridSnapshot giữ strict metadata và cell validation trên hot path', () => {
  const valid = createValidRawSnapshot(2, 2, [-1, 0, 50, 100]);
  valid.context.mapId = '  test-map  ';
  const parsed = parseMapGridSnapshot(valid);
  assert.equal(parsed.context.mapId, 'test-map');
  assert.deepEqual(parsed.grid.data, [-1, 0, 50, 100]);

  const invalidMetadata = createValidRawSnapshot(2, 2, [-1, 0, 50, 100]);
  invalidMetadata.grid.header.frame_id = '   ';
  assert.throws(
    () => parseMapGridSnapshot(invalidMetadata),
    (err) => err.code === 'INVALID_MAP_DATA'
  );

  const invalidCell = createValidRawSnapshot(2, 2, [-1, 0, 50, 101]);
  assert.throws(
    () => parseMapGridSnapshot(invalidCell),
    (err) => err.code === 'INVALID_MAP_DATA'
  );
});

test('MapGridEventEnvelopeSchema phân loại đúng cả 3 loại event', () => {
  const gridEnv = {
    version: 1,
    type: 'map.grid',
    subscriptionId: 'sub-1',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: createValidRawSnapshot(2, 2, [-1, 0, 50, 100]),
  };
  assert.equal(MapGridEventEnvelopeSchema.safeParse(gridEnv).success, true);

  const statusEnv = {
    version: 1,
    type: 'map.status',
    subscriptionId: 'sub-1',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 2,
    sentAt: new Date().toISOString(),
    payload: {
      context: { kind: 'saved', mapId: 'test-map', mapRevision: 'rev-1' },
      state: 'ready',
      sourceState: 'live',
      lastSourceUpdateAgeMs: 150,
    },
  };
  assert.equal(MapGridEventEnvelopeSchema.safeParse(statusEnv).success, true);

  const errorEnv = {
    version: 1,
    type: 'map.error',
    subscriptionId: 'sub-1',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 3,
    sentAt: new Date().toISOString(),
    payload: {
      context: { kind: 'saved', mapId: 'test-map', mapRevision: 'rev-1' },
      error: { code: 'SESSION_NOT_FOUND', message: 'Phiên không tồn tại' },
    },
  };
  assert.equal(MapGridEventEnvelopeSchema.safeParse(errorEnv).success, true);
});

test('TC-VAL-01: parseRawMapMessage từ chối chuỗi UTF-8 vượt quá 2 MiB trước khi parse JSON', () => {
  // Chuỗi lớn hơn 2 MiB
  const largeString = 'a'.repeat(2 * 1024 * 1024 + 10);
  assert.throws(
    () => parseRawMapMessage(largeString),
    (err) => err.code === 'MAP_TOO_LARGE'
  );
});

test('TC-VAL-02: parseRawMapMessage parse thành công chuỗi JSON hợp lệ trong giới hạn 2 MiB', () => {
  const jsonStr = JSON.stringify({ hello: 'world' });
  const result = parseRawMapMessage(jsonStr);
  assert.deepEqual(result, { hello: 'world' });
});

test('TC-VAL-03: preflightMapGrid từ chối trường lạ ngoài contract (strict preflight)', () => {
  const snapshotWithGarbage = createValidRawSnapshot(2, 2, [0, 0, 0, 0]);
  snapshotWithGarbage.extraMaliciousField = 'evil';
  assert.throws(
    () => preflightMapGrid(snapshotWithGarbage),
    (err) => err.code === 'INVALID_MAP_DATA' && err.message.includes('Trường không cho phép')
  );
});

test('TC-VAL-04: preflightMapGrid từ chối metadata vượt trần 16 KiB', () => {
  const snapshotHugeMeta = createValidRawSnapshot(2, 2, [0, 0, 0, 0]);
  snapshotHugeMeta.grid.header.frame_id = 'x'.repeat(17 * 1024);
  assert.throws(
    () => preflightMapGrid(snapshotHugeMeta),
    (err) => err.code === 'MAP_TOO_LARGE' && err.message.includes('metadata')
  );
});

test('TC-VAL-05: preflightMapGrid từ chối getter/accessor', () => {
  const badObj = createValidRawSnapshot(2, 2, [0, 0, 0, 0]);
  Object.defineProperty(badObj, 'hack', {
    get() {
      return 123;
    },
    enumerable: true,
  });
  assert.throws(
    () => preflightMapGrid(badObj),
    (err) => err.code === 'INVALID_MAP_DATA'
  );
});

test('TC-VAL-06: ShallowMapGridEventEnvelopeSchema từ chối trường lạ trên envelope', () => {
  const envWithGarbage = {
    version: 1,
    type: 'map.status',
    subscriptionId: 'sub-1',
    streamId: 'stream-1',
    streamEpoch: 1,
    sequence: 1,
    sentAt: new Date().toISOString(),
    payload: { status: 'ok' },
    garbageField: 'should_fail',
  };
  const parsed = ShallowMapGridEventEnvelopeSchema.safeParse(envWithGarbage);
  assert.equal(parsed.success, false);
});
