import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRosMapPose } from '../src/utils/rosMapPose.js';

const geometry = {
  frameId: 'map', width: 100, height: 100, resolution: 0.1,
  origin: { x: -5, y: -5, yaw: 0 },
};
const odom = {
  rosConnected: true,
  poseSourceUpdateAgeMs: 20,
  pose: { frameId: 'odom', x: 1, y: 2, yaw: Math.PI / 4 },
};

test('uses only a pose transformed into the live map frame', () => {
  assert.equal(resolveRosMapPose(odom, geometry).reason, 'missing-transform');
  const transformed = { frameId: 'map', x: -2, y: 3, yaw: Math.PI / 2 };
  assert.deepEqual(resolveRosMapPose({ ...odom, mapPose: transformed }, geometry), {
    pose: transformed, reason: null,
  });
});

test('hides robot if /odom is stale or transformed pose is outside the grid', () => {
  const mapPose = { frameId: 'map', x: 1, y: 2, yaw: 0 };
  assert.equal(resolveRosMapPose({ ...odom, mapPose }, geometry, { transportStale: true }).pose, null);
  assert.equal(resolveRosMapPose({ ...odom, mapPose, poseSourceUpdateAgeMs: 3000 }, geometry).pose, null);
  assert.equal(resolveRosMapPose({ ...odom, mapPose: { ...mapPose, x: 20 } }, geometry).reason, 'outside-map');
});
