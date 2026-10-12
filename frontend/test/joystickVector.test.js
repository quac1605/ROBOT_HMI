import test from 'node:test';
import assert from 'node:assert/strict';
import { joystickVector, fixedVectorForDirection } from '../src/utils/joystickVector.js';

const zero = { linearX: 0, angularZ: 0 };
test('joystick: bốn hướng dùng đúng tốc độ cố định và đúng dấu thân robot', () => {
  assert.deepEqual(joystickVector(0, -0.3), { linearX: 0.3, angularZ: 0 });
  assert.deepEqual(joystickVector(0, -1), { linearX: 0.3, angularZ: 0 });
  assert.deepEqual(joystickVector(0, 1), { linearX: -0.3, angularZ: 0 });
  assert.deepEqual(joystickVector(-1, 0), { linearX: 0, angularZ: 0.3 });
  assert.deepEqual(joystickVector(1, 0), { linearX: 0, angularZ: -0.3 });
  assert.deepEqual(fixedVectorForDirection('forward'), joystickVector(0, -1));
});
test('joystick: vùng tâm, NaN, Infinity và phân giác trả zero', () => {
  for (const [x, y] of [[0, 0], [0.2, 0], [NaN, 1], [1, Infinity], [1, 1], [-1, 1]]) {
    assert.deepEqual(joystickVector(x, y), zero);
  }
});
