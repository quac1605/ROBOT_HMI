import test from 'node:test';
import assert from 'node:assert/strict';
import {
  worldToGrid,
  gridToWorld,
  worldToSvg,
  svgToWorld,
  isInsideMap,
} from './mapCoordinates.js';

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

test('Mốc 1: Origin (0,0,0), world (1,2) -> grid (20,40) -> svg (20,120)', () => {
  const grid = worldToGrid({ x: 1, y: 2 }, standardMap);
  assert.ok(Math.abs(grid.u - 20) < 1e-6, `u phải bằng 20, nhận được ${grid.u}`);
  assert.ok(Math.abs(grid.v - 40) < 1e-6, `v phải bằng 40, nhận được ${grid.v}`);

  const svg = worldToSvg({ x: 1, y: 2 }, standardMap);
  assert.ok(Math.abs(svg.x - 20) < 1e-6, `svg.x phải bằng 20, nhận được ${svg.x}`);
  assert.ok(Math.abs(svg.y - 120) < 1e-6, `svg.y phải bằng 120, nhận được ${svg.y}`);
});

test('Mốc 2: Origin (10,-3, pi/2), grid (20,40) -> world (8,-2) và ngược lại', () => {
  const world = gridToWorld({ u: 20, v: 40 }, rotatedMap);
  assert.ok(Math.abs(world.x - 8) < 1e-6, `world.x phải bằng 8, nhận được ${world.x}`);
  assert.ok(Math.abs(world.y - (-2)) < 1e-6, `world.y phải bằng -2, nhận được ${world.y}`);

  const gridAgain = worldToGrid(world, rotatedMap);
  assert.ok(Math.abs(gridAgain.u - 20) < 1e-6, `grid.u phải bằng 20, nhận được ${gridAgain.u}`);
  assert.ok(Math.abs(gridAgain.v - 40) < 1e-6, `grid.v phải bằng 40, nhận được ${gridAgain.v}`);
});

test('Mốc 3: Round-trip World -> SVG -> World có sai số dưới 1e-9', () => {
  const original = { x: 3.456, y: 5.678 };
  const svg = worldToSvg(original, standardMap);
  const restored = svgToWorld(svg, standardMap);

  assert.ok(Math.abs(restored.x - original.x) < 1e-9, 'Khứ hồi x phải dưới 1e-9');
  assert.ok(Math.abs(restored.y - original.y) < 1e-9, 'Khứ hồi y phải dưới 1e-9');
});

test('Kiểm tra isInsideMap nhận diện đúng trong và ngoài ranh giới', () => {
  assert.equal(isInsideMap({ x: 5, y: 4 }, standardMap), true);
  assert.equal(isInsideMap({ x: -1, y: 4 }, standardMap), false);
  assert.equal(isInsideMap({ x: 11, y: 4 }, standardMap), false); // vượt quá 10m
});

test('Regression: Điểm sát biên dưới của map xoay 90° (8, -3) phải được chấp nhận', () => {
  // Điểm (8, -3) trong rotatedMap tương ứng u = 0, v = 40. Do sai số cos(pi/2), u có thể là -2.45e-15.
  assert.equal(isInsideMap({ x: 8, y: -3 }, rotatedMap), true);
});

test('Regression: Biên trên và biên phải nghiêm ngặt không được tính vào map', () => {
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

test('Regression: Điểm sát mép trong của biên trên/phải (< width, < height) phải được chấp nhận', () => {
  // u = 199.9999999995 (< 200) trong standardMap tương ứng x = 199.9999999995 * 0.05
  const nearRightX = 199.9999999995 * 0.05;
  assert.equal(isInsideMap({ x: nearRightX, y: 4 }, standardMap), true);

  // v = 159.9999999995 (< 160) trong standardMap tương ứng y = 159.9999999995 * 0.05
  const nearTopY = 159.9999999995 * 0.05;
  assert.equal(isInsideMap({ x: 5, y: nearTopY }, standardMap), true);
});
