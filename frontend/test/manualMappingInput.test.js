import test from 'node:test';
import assert from 'node:assert/strict';
import { joystickVector } from '../src/utils/joystickVector.js';
import { createTeleopHoldController } from '../src/utils/teleopHoldController.js';

test('MJ-I01: bốn hướng dùng đúng tốc độ 0.3, độ kéo không đổi tốc độ', () => {
  for (const magnitude of [0.4, 1]) {
    assert.deepEqual(joystickVector(0, -magnitude), { linearX: 0.3, angularZ: 0 });
    assert.deepEqual(joystickVector(0, magnitude), { linearX: -0.3, angularZ: 0 });
    assert.deepEqual(joystickVector(-magnitude, 0), { linearX: 0, angularZ: 0.3 });
    assert.deepEqual(joystickVector(magnitude, 0), { linearX: 0, angularZ: -0.3 });
  }
  assert.deepEqual(joystickVector(0, 0), { linearX: 0, angularZ: 0 });
  assert.deepEqual(joystickVector(0.01, 0.01), { linearX: 0, angularZ: 0 });
  assert.deepEqual(joystickVector(NaN, 0), { linearX: 0, angularZ: 0 });
});

test('MJ-I02: cập nhật hướng giữ một timer, một owner và không queue vector', () => {
  let tick;
  let timerCount = 0;
  let stops = 0;
  let allowed = true;
  const sent = [];
  const hold = createTeleopHoldController({
    getLatest: () => ({
      allowed,
      lease: { leaseId: 'lease-mapping', limits: { maxLinearX: 0.3, maxAngularZ: 0.3 } },
      freshnessToken: 'token-current',
    }),
    sendVelocity: dto => { sent.push(structuredClone(dto)); },
    requestStop: () => { stops += 1; },
    setEvery: callback => { tick = callback; timerCount += 1; return 42; },
    clearEvery: timer => { assert.equal(timer, 42); timerCount -= 1; },
  });
  try {
    assert.equal(hold.start('pointer:1', joystickVector(0, -1)), true);
    assert.equal(hold.start('pointer:2', joystickVector(0, 1)), false);
    assert.equal(hold.update('pointer:2', joystickVector(1, 0)), false);
    assert.equal(timerCount, 1);
    assert.equal(sent.length, 1); // Chỉ immediate send đầu tiên.

    hold.update('pointer:1', joystickVector(-1, 0));
    hold.update('pointer:1', joystickVector(1, 0));
    assert.equal(sent.length, 1); // Pointermove không tạo sends ngoài cadence.
    tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].linearX, 0);
    assert.equal(sent[1].angularZ, -0.3); // Chỉ vector mới nhất được dùng.
    assert.equal(sent[1].sequence, sent[0].sequence + 1);

    allowed = false; // Mô phỏng revoke/context stale mà không chờ React render.
    tick();
    assert.equal(stops, 1);
    assert.equal(timerCount, 0);
    tick(); // Callback timer cũ đến muộn không hồi sinh command.
    assert.equal(sent.length, 2);
    assert.equal(hold.update('pointer:1', joystickVector(0, -1)), false);
  } finally {
    hold.dispose();
  }
});

test('MJ-I03: về tâm kết thúc lượt giữ và yêu cầu stop đúng một lần', () => {
  let sends = 0;
  let stops = 0;
  const hold = createTeleopHoldController({
    getLatest: () => ({ allowed: true, freshnessToken: 'token',
      lease: { leaseId: 'lease', limits: { maxLinearX: 0.3, maxAngularZ: 0.3 } } }),
    sendVelocity: () => { sends += 1; },
    requestStop: () => { stops += 1; },
    setEvery: () => 42,
    clearEvery: () => {},
  });
  try {
    assert.equal(hold.start('pointer:1', joystickVector(0, -1)), true);
    assert.equal(hold.update('pointer:1', joystickVector(0, 0)), false);
    assert.equal(stops, 1);
    assert.equal(hold.isActive(), false);
    assert.equal(hold.update('pointer:1', joystickVector(0, -1)), false);
    hold.stop('POINTER_UP', 'pointer:1');
    assert.equal(sends, 1);
    assert.equal(stops, 1);
  } finally {
    hold.dispose();
  }
});
