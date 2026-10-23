import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeleopHoldController } from '../src/utils/teleopHoldController.js';

test('turning manual off fences the local velocity loop before lease release', () => {
  const sent = [];
  const stops = [];
  let tick;
  const hold = createTeleopHoldController({
    getLatest: () => ({
      allowed: true, freshnessToken: 'fresh',
      lease: { leaseId: 'lease-1', controlGeneration: 1,
        limits: { maxLinearX: 0.3, maxAngularZ: 0.5 } },
    }),
    sendVelocity: message => sent.push(message),
    requestStop: reason => stops.push(reason),
    setEvery: callback => { tick = callback; return 1; },
    clearEvery: () => {},
  });
  assert.equal(hold.start('keyboard', { linearX: 0.2, angularZ: 0 }), true);
  assert.equal(sent.length, 1);
  hold.cancel();
  tick();
  assert.equal(hold.isActive(), false);
  assert.equal(sent.length, 1);
  assert.deepEqual(stops, []);
  hold.dispose();
});
