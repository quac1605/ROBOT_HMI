import test from 'node:test';
import assert from 'node:assert/strict';
import { occupancyToRgba } from '../../../frontend/src/utils/occupancyToRgba.js';

test('occupancyToRgba ánh xạ đúng bảng màu đặc trưng', () => {
  const cells = new Int8Array([-1, 0, 100, 50]);
  const rgba = occupancyToRgba({ width: 2, height: 2, cells });

  // Ô (-1): Unknown -> #b0bec5 [176, 190, 197, 255]
  // Vị trí: col 0, row 0 (ROS) -> Canvas row 1 (dưới cùng), col 0 -> index = (0 + 1 * 2) * 4 = 8
  assert.equal(rgba[8], 176);
  assert.equal(rgba[9], 190);
  assert.equal(rgba[10], 197);
  assert.equal(rgba[11], 255);

  // Ô (0): Free -> Trắng [255, 255, 255, 255]
  // Vị trí: col 1, row 0 (ROS) -> Canvas row 1, col 1 -> index = (1 + 1 * 2) * 4 = 12
  assert.equal(rgba[12], 255);
  assert.equal(rgba[13], 255);
  assert.equal(rgba[14], 255);
  assert.equal(rgba[15], 255);

  // Ô (100): Occupied -> Đen [0, 0, 0, 255]
  // Vị trí: col 0, row 1 (ROS) -> Canvas row 0 (trên cùng), col 0 -> index = 0
  assert.equal(rgba[0], 0);
  assert.equal(rgba[1], 0);
  assert.equal(rgba[2], 0);
  assert.equal(rgba[3], 255);

  // Ô (50): 50% -> Xám [128, 128, 128, 255]
  // Vị trí: col 1, row 1 (ROS) -> Canvas row 0, col 1 -> index = 4
  assert.equal(rgba[4], 128);
  assert.equal(rgba[5], 128);
  assert.equal(rgba[6], 128);
  assert.equal(rgba[7], 255);
});

test('TC-9.1-OFFICIAL-4X3: official fixture 4x3 deep-compare đủ 48 RGBA bytes', () => {
  // Fixture chuẩn từ createDemoGridSnapshot:
  // ROS row 0 (đáy):  [0, 100, -1, 50]
  // ROS row 1 (giữa): [100, 0, 50, -1]
  // ROS row 2 (đỉnh): [-1, 50, 0, 100]
  const cells = new Int8Array([
    0, 100, -1, 50,   // ROS row 0
    100, 0, 50, -1,   // ROS row 1
    -1, 50, 0, 100,   // ROS row 2
  ]);

  const rgba = occupancyToRgba({ width: 4, height: 3, cells });
  assert.equal(rgba.length, 48);

  // Kỳ vọng 48 bytes sau khi flip Y:
  // Canvas row 0 (ROS row 2): [-1, 50, 0, 100] -> Unknown, 128, White, Black
  // Canvas row 1 (ROS row 1): [100, 0, 50, -1] -> Black, White, 128, Unknown
  // Canvas row 2 (ROS row 0): [0, 100, -1, 50] -> White, Black, Unknown, 128
  const expectedRgba = new Uint8ClampedArray([
    // Canvas row 0
    176, 190, 197, 255,   // col 0: -1 -> Unknown
    128, 128, 128, 255,   // col 1: 50 -> 50% gray
    255, 255, 255, 255,   // col 2: 0  -> Free white
    0, 0, 0, 255,         // col 3: 100 -> Occupied black

    // Canvas row 1
    0, 0, 0, 255,         // col 0: 100 -> Occupied black
    255, 255, 255, 255,   // col 1: 0   -> Free white
    128, 128, 128, 255,   // col 2: 50  -> 50% gray
    176, 190, 197, 255,   // col 3: -1  -> Unknown

    // Canvas row 2
    255, 255, 255, 255,   // col 0: 0   -> Free white
    0, 0, 0, 255,         // col 1: 100 -> Occupied black
    176, 190, 197, 255,   // col 2: -1  -> Unknown
    128, 128, 128, 255,   // col 3: 50  -> 50% gray
  ]);

  assert.deepEqual(Array.from(rgba), Array.from(expectedRgba));
});

test('occupancyToRgba ném lỗi khi ô có giá trị ngoài phạm vi [-1, 100]', () => {
  const invalidCells = new Int8Array([0, 101, 0, 0]);
  assert.throws(() => {
    occupancyToRgba({ width: 2, height: 2, cells: invalidCells });
  }, /không hợp lệ/);
});
