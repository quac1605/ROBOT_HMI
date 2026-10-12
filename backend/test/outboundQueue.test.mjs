import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutboundQueue, APP_BUFFER_BUDGET } from '../src/realtime/outboundQueue.js';
import { createConnectionRegistry } from '../src/realtime/connectionRegistry.js';

function fakeSocket() {
  const sent = [];
  const callbacks = [];
  return {
    readyState: 1, bufferedAmount: 0, sent, callbacks,
    send(json, callback) { sent.push(JSON.parse(json)); callbacks.push(callback); },
  };
}

test('M6 outbound: coalesce only robot.state; never drop terminal job transition', () => {
  const ws = fakeSocket();
  const failures = [];
  const queue = createOutboundQueue({ ws, kind: 'app', onFailure: reason => failures.push(reason) });
  assert.equal(queue.enqueue({ type: 'robot.state', payload: { sequence: 1 } }), true);
  queue.enqueue({ type: 'robot.state', payload: { sequence: 2 } });
  queue.enqueue({ type: 'job.updated', payload: { status: 'completed' } });
  queue.enqueue({ type: 'robot.state', payload: { sequence: 3 } });
  assert.equal(queue.pendingCount, 2);
  ws.callbacks.shift()();
  ws.callbacks.shift()();
  ws.callbacks.shift()();
  assert.deepEqual(ws.sent.map(frame => [frame.type, frame.payload.sequence ?? frame.payload.status]), [
    ['robot.state', 1], ['job.updated', 'completed'], ['robot.state', 3],
  ]);
  assert.deepEqual(failures, []);
});

test('M6 outbound: slow app socket fails closed and clears pending', () => {
  const ws = fakeSocket();
  const failures = [];
  const queue = createOutboundQueue({ ws, kind: 'app', onFailure: reason => failures.push(reason) });
  queue.enqueue({ type: 'mission.updated', payload: { status: 'executing' } });
  queue.enqueue({ type: 'mission.updated', payload: { status: 'succeeded' } });
  ws.bufferedAmount = APP_BUFFER_BUDGET + 1;
  assert.equal(queue.enqueue({ type: 'robot.state', payload: {} }), false);
  assert.deepEqual(failures, ['SLOW_CONSUMER']);
  assert.equal(queue.pendingCount, 0);
  ws.callbacks.shift()();
  assert.equal(ws.sent.length, 1);
  assert.equal(queue.enqueue({ type: 'control.velocity' }), false);
});

test('M6 outbound: map keeps only the newest pending grid with its subscription context', () => {
  const ws = fakeSocket();
  const failures = [];
  const queue = createOutboundQueue({ ws, kind: 'map', onFailure: reason => failures.push(reason) });
  const context = { kind: 'saved', mapId: 'map-1', mapRevision: 'rev-1' };
  const snapshot = {
    source: 'mock', mode: 'snapshot', encoding: 'occupancy-0-100-v1',
    context, gridRevision: 1,
    grid: {
      header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
      info: { map_load_time: { sec: 1, nanosec: 0 }, resolution: 0.05,
        width: 1, height: 1, origin: { position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 } } },
      data: [0],
    },
  };
  const frame = revision => ({ version: 1, type: 'map.grid',
    subscriptionId: 'sub-1', streamId: 'grid-1', streamEpoch: 1,
    sequence: revision, sentAt: '2026-10-02T00:00:00.000Z',
    payload: { ...snapshot, gridRevision: revision } });
  queue.enqueue(frame(1));
  queue.enqueue(frame(2));
  queue.enqueue(frame(3));
  assert.equal(queue.pendingCount, 1);
  ws.callbacks.shift()();
  ws.callbacks.shift()();
  assert.deepEqual(ws.sent.map(event => event.payload.gridRevision), [1, 3]);
  assert.deepEqual(failures, []);
  assert.throws(() => queue.enqueue({ ...frame(4), payload: {
    ...snapshot, grid: { ...snapshot.grid, data: [101] }, gridRevision: 4,
  } }), error => error.code === 'INVALID_MAP_DATA');
});

test('M6 registry: slow consumer revokes its owner synchronously before TCP close', () => {
  const ws = { ...fakeSocket(), close() { this.readyState = 2; }, terminate() {} };
  const registry = createConnectionRegistry();
  const effects = [];
  registry.register({ connectionId: 'conn-1', sessionId: 'sid-1', kind: 'app',
    ws, watcher: { assertFresh() {} }, subscriptions: new Set(),
    onRevoke: reason => effects.push(reason) });
  ws.bufferedAmount = APP_BUFFER_BUDGET + 1;
  assert.equal(registry.send('conn-1', { type: 'robot.state', payload: {} }), false);
  assert.deepEqual(effects, ['SLOW_CONSUMER']);
  assert.equal(registry.get('conn-1'), undefined);
});
