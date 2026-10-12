import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForMappingStop } from '../src/utils/waitForMappingStop.js';

function store(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getState: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setState(next) { value = next; for (const listener of listeners) listener(value); },
    listenerCount: () => listeners.size,
  };
}
function fixture() {
  const confirmation = {
    requestId: 'stop-1', controlGeneration: 2, evidenceKind: 'mock-source-observation',
    sourceEpoch: 'mock-boot-1', sourceSequence: 3, observedAt: '2026-10-07T00:00:00.000Z',
    velocity: { linearX: 0, angularZ: 0 },
  };
  const controlStore = store({
    ready: true, lease: null, controlProfile: 'mock', controlGeneration: 2,
    stopUnconfirmed: true,
    stopState: { requestId: 'stop-1', controlGeneration: 2, status: 'accepted', confirmation: null },
  });
  const mappingStore = store({ session: { mappingSessionId: 'map-session-1', status: 'mapping' } });
  const abort = new AbortController();
  const wait = () => waitForMappingStop({
    requestId: 'stop-1', mappingSessionId: 'map-session-1', controlStore, mappingStore,
    signal: abort.signal,
  });
  const confirm = (patch = {}) => controlStore.setState({
    ...controlStore.getState(), stopUnconfirmed: false,
    stopState: { requestId: 'stop-1', controlGeneration: 2, status: 'confirmed', confirmation },
    ...patch,
  });
  return { controlStore, mappingStore, abort, wait, confirm, confirmation };
}

test('finish wait: accepted không đủ; confirmed đúng ID/generation/profile giải phóng subscription', async () => {
  const f = fixture();
  const pending = f.wait();
  let resolved = false;
  pending.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  f.confirm();
  assert.deepEqual(await pending, f.confirmation);
  assert.equal(f.controlStore.listenerCount(), 0);
  assert.equal(f.mappingStore.listenerCount(), 0);
});

test('finish wait: confirmed đến trước HTTP response vẫn được nhận', async () => {
  const f = fixture();
  f.confirm();
  assert.deepEqual(await f.wait(), f.confirmation);
});

test('finish wait: generation không khớp không hoàn tất; abort đóng hết listener', async () => {
  const f = fixture();
  const pending = f.wait();
  f.confirm({ controlGeneration: 3 });
  const rejected = assert.rejects(pending, /rời trang|hủy thao tác/);
  f.abort.abort();
  await rejected;
  assert.equal(f.controlStore.listenerCount(), 0);
  assert.equal(f.mappingStore.listenerCount(), 0);
});

test('finish wait: session cũ bị thay thế thì không gửi lưu vào session mới', async () => {
  const f = fixture();
  const pending = f.wait();
  const rejected = assert.rejects(pending, /Phiên mapping đã thay đổi/);
  f.mappingStore.setState({ session: { mappingSessionId: 'map-session-2', status: 'mapping' } });
  await rejected;
});
