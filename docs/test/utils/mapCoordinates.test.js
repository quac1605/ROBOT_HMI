import test from 'node:test';
import assert from 'node:assert/strict';
import {
  worldToGrid,
  gridToWorld,
  worldToSvg,
  svgToWorld,
  isInsideMap,
  worldYawToSvgDegrees,
  resolveVisiblePose,
} from '../../../frontend/src/utils/mapCoordinates.js';

const standardMap = {
  width: 200,
  height: 160,
  resolution: 0.05,
  origin: { x: 0, y: 0, yaw: 0 },
};

const rotatedMap = {
  width: 200,
  height: 160,
  resolution: 0.05,
  origin: { x: 10, y: -3, yaw: Math.PI / 2 },
};

test('TC-9.2-200X160: Origin (0,0,0), world (1,2) -> grid (20,40) -> svg (20,120)', () => {
  const grid = worldToGrid({ x: 1, y: 2 }, standardMap);
  assert.ok(Math.abs(grid.u - 20) < 1e-6, `u phải bằng 20, nhận được ${grid.u}`);
  assert.ok(Math.abs(grid.v - 40) < 1e-6, `v phải bằng 40, nhận được ${grid.v}`);

  const svg = worldToSvg({ x: 1, y: 2 }, standardMap);
  assert.ok(Math.abs(svg.x - 20) < 1e-6, `svg.x phải bằng 20, nhận được ${svg.x}`);
  assert.ok(Math.abs(svg.y - 120) < 1e-6, `svg.y phải bằng 120, nhận được ${svg.y}`);
});

test('TC-9.3-ROTATED: Origin (10,-3, pi/2), grid (20,40) -> world (8,-2) và ngược lại', () => {
  const world = gridToWorld({ u: 20, v: 40 }, rotatedMap);
  assert.ok(Math.abs(world.x - 8) < 1e-6, `world.x phải bằng 8, nhận được ${world.x}`);
  assert.ok(Math.abs(world.y - (-2)) < 1e-6, `world.y phải bằng -2, nhận được ${world.y}`);

  const gridAgain = worldToGrid(world, rotatedMap);
  assert.ok(Math.abs(gridAgain.u - 20) < 1e-6, `grid.u phải bằng 20, nhận được ${gridAgain.u}`);
  assert.ok(Math.abs(gridAgain.v - 40) < 1e-6, `grid.v phải bằng 40, nhận được ${gridAgain.v}`);
});

test('TC-9.4-BOUNDS-ROUNDTRIP: Round-trip World -> SVG -> World có sai số dưới 1e-9', () => {
  const original = { x: 3.456, y: 5.678 };
  const svg = worldToSvg(original, standardMap);
  const restored = svgToWorld(svg, standardMap);

  assert.ok(Math.abs(restored.x - original.x) < 1e-9, 'Khứ hồi x phải dưới 1e-9');
  assert.ok(Math.abs(restored.y - original.y) < 1e-9, 'Khứ hồi y phải dưới 1e-9');
});

test('TC-9.4-BOUNDS-1: isInsideMap nhận diện đúng trong và ngoài ranh giới', () => {
  assert.equal(isInsideMap({ x: 5, y: 4 }, standardMap), true);
  assert.equal(isInsideMap({ x: -1, y: 4 }, standardMap), false);
  assert.equal(isInsideMap({ x: 11, y: 4 }, standardMap), false); // vượt quá 10m
});

test('TC-9.4-BOUNDS-2: Điểm sát biên dưới của map xoay 90° (8, -3) phải được chấp nhận', () => {
  // Điểm (8, -3) trong rotatedMap tương ứng u = 0, v = 40. Do sai số cos(pi/2), u có thể là -2.45e-15.
  assert.equal(isInsideMap({ x: 8, y: -3 }, rotatedMap), true);
});

test('TC-9.4-BOUNDS-3: Biên trên và biên phải nghiêm ngặt không được tính vào map', () => {
  // Biên phải chuẩn u = 200 (x = 10 trong standardMap)
  assert.equal(isInsideMap({ x: 10, y: 4 }, standardMap), false);
  // Biên trên chuẩn v = 160 (y = 8 trong standardMap)
  assert.equal(isInsideMap({ x: 5, y: 8 }, standardMap), false);

  // Trên rotatedMap (origin: (10, -3, pi/2)):
  // (8, 7) tương ứng u = 200 (biên phải) -> phải loại bỏ
  assert.equal(isInsideMap({ x: 8, y: 7 }, rotatedMap), false);
  // (2, -2) tương ứng v = 160 (biên trên) -> phải loại bỏ
  assert.equal(isInsideMap({ x: 2, y: -2 }, rotatedMap), false);
});

test('TC-9.4-BOUNDS-4: Điểm sát mép trong của biên trên/phải (< width, < height) phải được chấp nhận', () => {
  // u = 199.9999999995 (< 200) trong standardMap tương ứng x = 199.9999999995 * 0.05
  const nearRightX = 199.9999999995 * 0.05;
  assert.equal(isInsideMap({ x: nearRightX, y: 4 }, standardMap), true);

  // v = 159.9999999995 (< 160) trong standardMap tương ứng y = 159.9999999995 * 0.05
  const nearTopY = 159.9999999995 * 0.05;
  assert.equal(isInsideMap({ x: 5, y: nearTopY }, standardMap), true);
});

test('C5-02: worldYawToSvgDegrees chuyển đổi chuẩn xác với cả +π/2 và -π/2 (4 cases)', () => {
  // Case 1: origin +π/2, world yaw +π/2 -> 0°
  const deg1 = worldYawToSvgDegrees(Math.PI / 2, Math.PI / 2);
  assert.ok(Math.abs(deg1 - 0) < 1e-6, `Kỳ vọng 0°, nhận được ${deg1}`);

  // Case 2: origin +π/2, world yaw 0 -> +90° (-(0 - π/2)*180/π = 90)
  const deg2 = worldYawToSvgDegrees(0, Math.PI / 2);
  assert.ok(Math.abs(deg2 - 90) < 1e-6, `Kỳ vọng 90°, nhận được ${deg2}`);

  // Case 3: origin -π/2, world yaw -π/2 -> 0°
  const deg3 = worldYawToSvgDegrees(-Math.PI / 2, -Math.PI / 2);
  assert.ok(Math.abs(deg3 - 0) < 1e-6, `Kỳ vọng 0°, nhận được ${deg3}`);

  // Case 4: origin -π/2, world yaw 0 -> -90° (-(0 - (-π/2))*180/π = -90)
  const deg4 = worldYawToSvgDegrees(0, -Math.PI / 2);
  assert.ok(Math.abs(deg4 - (-90)) < 1e-6, `Kỳ vọng -90°, nhận được ${deg4}`);
});

test('C5-01: resolveVisiblePose chặn hiển thị robot khi sai context map dù cùng frameId', () => {
  const snapshotDemo = {
    pose: { frameId: 'map', x: 2.0, y: 3.0, yaw: 0.5 },
    activeMap: { id: 'map-demo', revision: 'rev-1' },
    activeMappingSessionId: null,
  };

  const contextMapDemo = { id: 'map-demo', revision: 'rev-1', frameId: 'map' };
  const contextMapRotated = { id: 'map-rotated', revision: 'rev-1', frameId: 'map' };

  // Khớp chính xác -> hiển thị pose
  assert.deepEqual(resolveVisiblePose(snapshotDemo, contextMapDemo), snapshotDemo.pose);

  // Cùng frameId='map' nhưng sai id bản đồ -> phải trả về null
  assert.equal(resolveVisiblePose(snapshotDemo, contextMapRotated), null);

  // Sai revision -> phải trả về null
  assert.equal(resolveVisiblePose(snapshotDemo, { id: 'map-demo', revision: 'rev-2', frameId: 'map' }), null);

  // Sai frameId -> phải trả về null
  assert.equal(resolveVisiblePose(snapshotDemo, { id: 'map-demo', revision: 'rev-1', frameId: 'odom' }), null);

  // Đang trong session mapping -> không được hiện trên saved map viewer
  const snapshotInMapping = {
    ...snapshotDemo,
    activeMappingSessionId: 'sess-123',
  };
  assert.equal(resolveVisiblePose(snapshotInMapping, contextMapDemo), null);

  // Ngữ cảnh Live Mapping
  const liveSnapshot = {
    pose: { frameId: 'map', x: 1.0, y: 1.0, yaw: 0 },
    activeMap: null,
    activeMappingSessionId: 'sess-abc',
  };
  const liveContext = { mappingSessionId: 'sess-abc', frameId: 'map' };
  const wrongLiveContext = { mappingSessionId: 'sess-xyz', frameId: 'map' };

  assert.deepEqual(resolveVisiblePose(liveSnapshot, liveContext), liveSnapshot.pose);
  assert.equal(resolveVisiblePose(liveSnapshot, wrongLiveContext), null);
});
