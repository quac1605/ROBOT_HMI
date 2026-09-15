import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedRobotState } from '../../../frontend/src/clients/sharedRobotState.js';

test('sharedRobotState cô lập hoàn toàn patch object không bị mutate từ bên ngoài', () => {
  const state = createSharedRobotState({ mode: 'idle', pose: { x: 0, y: 0, yaw: 0 } });

  const patch = { pose: { x: 5, y: 10, yaw: 1.57 } };
  state.update(patch);

  // Cố ý mutate patch ban đầu
  patch.pose.x = 999;

  // Internal state không bị ảnh hưởng
  assert.equal(state.getSnapshot().pose.x, 5);
});

test('sharedRobotState cô lập functional updater', () => {
  const state = createSharedRobotState({ count: 1, nested: { value: 'A' } });

  state.update((prev) => {
    prev.nested.value = 'MUTATE_ATTEMPT'; // Mutate tham số đầu vào
    return { count: prev.count + 1 };
  });

  const snapshot = state.getSnapshot();
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.nested.value, 'A'); // Không bị mutate
});

test('sharedRobotState cô lập từng listener: Listener A mutate không ảnh hưởng Listener B', () => {
  const state = createSharedRobotState({ mode: 'idle', status: 'ok' });

  let snapA = null;
  let snapB = null;

  const unsubA = state.subscribe((s) => {
    snapA = s;
    snapA.status = 'HACKED_BY_A'; // Mutate snapshot nhận được
  });

  const unsubB = state.subscribe((s) => {
    snapB = s;
  });

  state.update({ mode: 'mapping' });

  assert.equal(snapA.status, 'HACKED_BY_A');
  assert.equal(snapB.status, 'ok'); // Listener B vẫn nhận nguyên vẹn 'ok'
  assert.equal(state.getSnapshot().status, 'ok'); // Internal state vẫn 'ok'

  unsubA();
  unsubB();
});

test('sharedRobotState cô lập input của reset()', () => {
  const state = createSharedRobotState({ mode: 'idle' });

  const resetTarget = { mode: 'teleop', battery: 90 };
  state.reset(resetTarget);

  resetTarget.battery = 10;
  assert.equal(state.getSnapshot().battery, 90);
});

test('listener ném ở initial delivery không bị giữ lại khi subscribe thất bại', () => {
  const state = createSharedRobotState({ mode: 'idle' });
  let calls = 0;

  assert.throws(() => {
    state.subscribe(() => {
      calls += 1;
      throw new Error('consumer failed');
    });
  }, /consumer failed/);

  state.update({ mode: 'mapping' });
  assert.equal(calls, 1);
});

test('reset cô lập lỗi listener và vẫn phát snapshot cho listener kế tiếp', () => {
  const state = createSharedRobotState({ mode: 'idle' });
  let firstCalls = 0;
  let secondSnapshot = null;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    state.subscribe(() => {
      firstCalls += 1;
      if (firstCalls > 1) throw new Error('reset consumer failed');
    });
    state.subscribe((snapshot) => {
      secondSnapshot = snapshot;
    });

    assert.doesNotThrow(() => state.reset({ mode: 'teleop' }));
    assert.deepEqual(secondSnapshot, { mode: 'teleop' });
  } finally {
    console.error = originalConsoleError;
  }
});
