import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockMappingSource } from '../../packages/control-domain/src/mockMappingSource.js';

test('manual mapping: measured samples move pose; idle ticks do not invent travel', () => {
  let nowMs = 0;
  const source = createMockMappingSource({ now: () => nowMs });
  source.start('S');
  assert.equal(source.get('S'), null, 'Start chưa phải observation từ motion source');
  let seq = 0;
  function sample(v, w, dt = 50) {
    nowMs += dt;
    return source.ingest({
      sourceEpoch: 'E', sourceSequence: ++seq, observedMono: nowMs,
      observedAt: new Date(nowMs).toISOString(),
      velocity: { linearX: v, angularZ: w },
    });
  }
  sample(0, 0);
  const first = source.get('S');
  for (let i = 0; i < 20; i++) sample(0, 0);
  assert.deepEqual(source.get('S').pose, first.pose);
  assert.deepEqual(source.get('S').snapshot.grid.data, first.snapshot.grid.data);
  for (let i = 0; i < 20; i++) sample(0.3, 0);
  const moved = source.get('S');
  assert.ok(Math.abs(moved.pose.x - 2.3) < 1e-9);
  assert.equal(moved.pose.y, 2);
  assert.ok(moved.snapshot.gridRevision > first.snapshot.gridRevision);
  const oldPose = moved.pose;
  sample(0.3, 0, 3000); // Gap nguồn: không tính thêm 0.9 m tưởng tượng.
  assert.deepEqual(source.get('S').pose, oldPose);
  nowMs += 2100;
  assert.equal(source.get('S').sourceState, 'stale');
  assert.ok(source.get('S').lastSourceUpdateAgeMs >= 2100);
  source.stop('S');
  assert.throws(() => source.get('S'), { code: 'MAPPING_GRID_UNAVAILABLE' });
  source.dispose();
});

test('mapping source: replay cannot move robot or refresh age, reads are cloned', () => {
  let nowMs = 100;
  const source = createMockMappingSource({ now: () => nowMs });
  source.start('S', { sourceEpoch: 'E', sourceSequence: 4 });
  assert.equal(source.get('S'), null, 'Cursor cũ không được làm nguồn map mới có vẻ fresh');
  const event = {
    sourceEpoch: 'E', sourceSequence: 5, observedMono: 100,
    observedAt: new Date(100).toISOString(), velocity: { linearX: 0, angularZ: 0 },
  };
  assert.equal(source.ingest(event), true);
  const copy = source.get('S');
  copy.pose.x = 999;
  copy.snapshot.grid.data[0] = 100;
  nowMs = 200;
  assert.equal(source.ingest(event), false);
  assert.equal(source.get('S').pose.x, 2);
  assert.equal(source.get('S').snapshot.grid.data[0], -1);
  assert.equal(source.get('S').lastSourceUpdateAgeMs, 100);
  source.dispose();
});
