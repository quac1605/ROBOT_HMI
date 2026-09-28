import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlLeaseCore } from '../../../frontend/src/utils/controlLeaseCore.js';

function fixture() {
  let time = 0, mode = 'idle', serial = 0;
  let velocity = { linearX: 0, angularZ: 0 };
  const core = createControlLeaseCore({
    now: () => time, wallNow: () => 1800000000000 + time,
    uuid: () => `test-${++serial}`,
    checkAcquire: () => mode === 'idle' ? null : 'MODE_BLOCKED',
    checkDrive: () => mode === 'teleop' ? null : 'MODE_BLOCKED',
    setVelocity: value => { velocity = { ...value }; },
    claimMode: () => { mode = 'teleop'; },
    releaseMode: () => { if (mode === 'teleop') mode = 'idle'; },
  });
  return { core, at: value => { time = value; }, mode: value => { mode = value; },
    currentMode: () => mode, velocity: () => velocity,
    send(lease, token, sequence, linearX = .1) {
      core.send('session-a', { leaseId: lease.leaseId, sequence, freshnessToken: token, linearX, angularZ: 0 });
    } };
}

test('N8-05: watchdog không arm trước command đầu; TTL vẫn revoke', () => {
  const f = fixture(), lease = f.core.acquire('session-a');
  f.at(1000); f.core.tick();
  assert.equal(f.core.view('session-a').lease?.leaseId, lease.leaseId);
  f.at(14999); f.core.tick();
  assert.equal(f.core.view('session-a').lease?.leaseId, lease.leaseId);
  f.at(15000); f.core.tick();
  assert.equal(f.core.view('session-a').ownership, 'none');
  assert.deepEqual(f.velocity(), { linearX: 0, angularZ: 0 });
  assert.equal(f.core.takeRevocations()[0]?.reason, 'LEASE_EXPIRED');
});
test('N8-09: command sau deadline không hồi sinh dù timer chưa chạy', () => {
  const f = fixture(), lease = f.core.acquire('session-a');
  const token = f.core.heartbeat('session-a').freshnessToken;
  f.send(lease, token, 1);
  f.at(300); // Cố ý không gọi tick. Token vẫn còn hạn 500 ms.
  assert.throws(() => f.send(lease, token, 2), { code: 'LEASE_NOT_OWNED' });
  assert.deepEqual(f.velocity(), { linearX: 0, angularZ: 0 });
  assert.equal(f.core.takeRevocations()[0]?.reason, 'WATCHDOG_TIMEOUT');
});
test('N8-07: sequence replay không nuôi watchdog', () => {
  const f = fixture(), lease = f.core.acquire('session-a');
  const token = f.core.heartbeat('session-a').freshnessToken;
  f.send(lease, token, 1); f.at(250);
  assert.throws(() => f.send(lease, token, 1), { code: 'SEQUENCE_REPLAY' });
  f.at(300); f.core.tick();
  assert.equal(f.core.view('session-a').ownership, 'none');
  assert.deepEqual(f.velocity(), { linearX: 0, angularZ: 0 });
  assert.equal(f.core.takeRevocations()[0]?.reason, 'WATCHDOG_TIMEOUT');
});
test('N8-08: token cũ còn TTL dùng được sau token mới phát', () => {
  const f = fixture(), lease = f.core.acquire('session-a');
  const first = f.core.heartbeat('session-a').freshnessToken;
  f.at(100);
  const second = f.core.heartbeat('session-a').freshnessToken;
  assert.notEqual(first, second);
  f.send(lease, first, 1);
  assert.equal(f.velocity().linearX, .1);
});
test('N8-11: revoke không biến fault thành idle', () => {
  const f = fixture(), lease = f.core.acquire('session-a');
  f.send(lease, f.core.heartbeat('session-a').freshnessToken, 1);
  f.mode('fault'); f.core.tick();
  assert.equal(f.core.view('session-a').ownership, 'none');
  assert.equal(f.currentMode(), 'fault');
  assert.deepEqual(f.velocity(), { linearX: 0, angularZ: 0 });
  assert.throws(() => f.core.acquire('session-a'), { code: 'MODE_BLOCKED' });
});
