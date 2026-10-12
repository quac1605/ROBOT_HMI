import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeleopHoldController } from '../src/utils/teleopHoldController.js';

function setup() {
  let state = {
    allowed: true, freshnessToken: 'token',
    lease: { leaseId: 'lease-1', controlGeneration: 1, limits: { maxLinearX: 0.3, maxAngularZ: 0.3 } },
  };
  let tick = null;
  let timers = 0;
  const sent = [];
  const stops = [];
  const hold = createTeleopHoldController({
    getLatest: () => state,
    sendVelocity: message => { sent.push(message); },
    requestStop: reason => { stops.push(reason); },
    setEvery: callback => { tick = callback; timers++; return 1; },
    clearEvery: () => { tick = null; timers--; },
  });
  return {
    hold, sent, stops, state: () => state,
    setState: next => { state = next; },
    tick: () => tick?.(), timers: () => timers,
  };
}

test('update đổi hướng cùng owner qua một timer, không publish theo pointermove', () => {
  const h = setup();
  assert.equal(h.hold.start('pointer:1', { linearX: 0.3, angularZ: 0 }), true);
  assert.equal(h.hold.start('key:KeyW', { linearX: 0.3, angularZ: 0 }), false);
  assert.equal(h.hold.update('pointer:2', { linearX: 0, angularZ: -0.3 }), false);
  assert.equal(h.hold.update('pointer:1', { linearX: 0, angularZ: 0.3 }), true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers(), 1);
  h.tick();
  assert.equal(h.sent[1].angularZ, 0.3);
  assert.equal(h.sent[1].sequence, 2);
  assert.equal(h.hold.update('pointer:1', { linearX: 0, angularZ: 0 }), false);
  assert.equal(h.timers(), 0);
  assert.equal(h.stops.length, 1);
  h.tick();
  assert.equal(h.sent.length, 2);
});

test('generation đổi dù leaseId giữ nguyên cũng dừng; không clamp tốc độ', () => {
  const h = setup();
  assert.equal(h.hold.start('pointer:1', { linearX: 0.31, angularZ: 0 }), false);
  assert.equal(h.hold.start('pointer:1', { linearX: 0.3, angularZ: 0 }), true);
  h.setState({ ...h.state(), lease: { ...h.state().lease, controlGeneration: 2 } });
  h.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.hold.isActive(), false);
  assert.equal(h.stops.length, 1);
});
