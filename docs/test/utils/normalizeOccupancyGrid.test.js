import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOccupancyGrid, quaternionToEuler } from '../../../frontend/src/utils/normalizeOccupancyGrid.js';

test('quaternionToEuler tính chuẩn xác các góc yaw 2D', () => {
  // Yaw = 0 (x=0, y=0, z=0, w=1)
  const euler0 = quaternionToEuler({ x: 0, y: 0, z: 0, w: 1 });
  assert.ok(Math.abs(euler0.yaw) < 1e-4);

  // Yaw = +PI/2 (~1.570796, z=sin(pi/4)=0.7071, w=cos(pi/4)=0.7071)
  const euler90 = quaternionToEuler({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 });
  assert.ok(Math.abs(euler90.yaw - Math.PI / 2) < 1e-4);

  // Yaw = -PI/2 (~ -1.570796)
  const eulerNeg90 = quaternionToEuler({ x: 0, y: 0, z: -Math.SQRT1_2, w: Math.SQRT1_2 });
  assert.ok(Math.abs(eulerNeg90.yaw - (-Math.PI / 2)) < 1e-4);

  // Yaw = PI (~ 3.14159, z=1, w=0)
  const euler180 = quaternionToEuler({ x: 0, y: 0, z: 1, w: 0 });
  assert.ok(Math.abs(Math.abs(euler180.yaw) - Math.PI) < 1e-4);
});

test('quaternionToEuler từ chối quaternion chưa chuẩn hóa (norm != 1)', () => {
  assert.throws(() => {
    quaternionToEuler({ x: 0, y: 0, z: 2, w: 2 });
  }, (err) => err.code === 'INVALID_MAP_DATA');
});

test('normalizeOccupancyGrid từ chối bản đồ có độ nghiêng roll 3D', () => {
  const rollSnapshot = {
    source: 'mock',
    mode: 'snapshot',
    encoding: 'occupancy-0-100-v1',
    context: { kind: 'saved', mapId: 'roll-map', mapRevision: 'rev-1' },
    gridRevision: 1,
    grid: {
      header: { frame_id: 'map', stamp: { sec: 100, nanosec: 500 } },
      info: {
        map_load_time: { sec: 100, nanosec: 500 },
        resolution: 0.05,
        width: 2,
        height: 2,
        origin: {
          position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0.2588, y: 0, z: 0, w: 0.9659 }, // Roll ~ 30 deg
        },
      },
      data: [0, 0, 0, 0],
    },
  };

  assert.throws(() => {
    normalizeOccupancyGrid(rollSnapshot);
  }, (err) => err.code === 'UNSUPPORTED_MAP_ORIENTATION');
});

test('normalizeOccupancyGrid chuẩn hóa đúng geometry và timestamps', () => {
  const validSnapshot = {
    source: 'mock',
    mode: 'snapshot',
    encoding: 'occupancy-0-100-v1',
    context: { kind: 'saved', mapId: 'time-map', mapRevision: 'rev-1' },
    gridRevision: 2,
    grid: {
      header: { frame_id: 'map', stamp: { sec: 12345, nanosec: 678000 } },
      info: {
        map_load_time: { sec: 12340, nanosec: 0 },
        resolution: 0.1,
        width: 2,
        height: 2,
        origin: {
          position: { x: 1.5, y: -2.5, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      data: [0, 50, 100, -1],
    },
  };

  const norm = normalizeOccupancyGrid(validSnapshot);
  assert.equal(norm.geometry.frameId, 'map');
  assert.equal(norm.geometry.resolution, 0.1);
  assert.equal(norm.geometry.origin.x, 1.5);
  assert.equal(norm.geometry.origin.y, -2.5);
  assert.equal(norm.geometry.origin.yaw, 0);
  assert.equal(norm.cells.length, 4);
});

test('normalizeOccupancyGrid từ chối bản đồ có độ nghiêng 3D (roll/pitch)', () => {
  // Quaternion có pitch nghiêng 30 độ quanh trục Y
  const tiltedSnapshot = {
    source: 'mock',
    mode: 'snapshot',
    encoding: 'occupancy-0-100-v1',
    context: { kind: 'saved', mapId: 'tilted-map', mapRevision: 'rev-1' },
    gridRevision: 1,
    grid: {
      header: { frame_id: 'map', stamp: { sec: 100, nanosec: 0 } },
      info: {
        map_load_time: { sec: 100, nanosec: 0 },
        resolution: 0.05,
        width: 2,
        height: 2,
        origin: {
          position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0.2588, z: 0, w: 0.9659 }, // Pitch ~ 30 deg
        },
      },
      data: [0, 0, 0, 0],
    },
  };

  assert.throws(() => {
    normalizeOccupancyGrid(tiltedSnapshot);
  }, (err) => err.code === 'UNSUPPORTED_MAP_ORIENTATION');
});

test('normalizeOccupancyGrid từ chối khi data.length không khớp width * height', () => {
  const invalidGrid = {
    source: 'mock',
    mode: 'snapshot',
    encoding: 'occupancy-0-100-v1',
    context: { kind: 'saved', mapId: 'err-map', mapRevision: 'rev-1' },
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
      data: [0, 0, 0], // Thiếu 1 phần tử
    },
  };

  assert.throws(() => {
    normalizeOccupancyGrid(invalidGrid);
  }, (err) => err.code === 'INVALID_MAP_DATA');
});
