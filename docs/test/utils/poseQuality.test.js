import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePoseQuality } from '../../../frontend/src/utils/poseQuality.js';

function snapshot(overrides = {}) {
  return {
    rosConnected: true,
    localization: { status: 'tracking', reason: null },
    pose: { frameId: 'map', x: 1, y: 2, yaw: 0 },
    poseSourceUpdateAgeMs: 0,
    ...overrides,
  };
}

test('pose quality phân biệt transport heartbeat và tuổi nguồn pose', () => {
  assert.equal(resolvePoseQuality(snapshot()), 'reliable');
  assert.equal(resolvePoseQuality(snapshot({ poseSourceUpdateAgeMs: 2001 })), 'stale');
  assert.equal(resolvePoseQuality(snapshot({ poseSourceUpdateAgeMs: null })), 'stale');
  assert.equal(resolvePoseQuality(snapshot(), { transportStale: true }), 'stale');
});

test('offline và localization lost có ưu tiên cao hơn freshness', () => {
  assert.equal(resolvePoseQuality(snapshot({ rosConnected: false })), 'offline');
  assert.equal(resolvePoseQuality(snapshot({
    localization: { status: 'lost', reason: 'test' },
  })), 'lost');
});
