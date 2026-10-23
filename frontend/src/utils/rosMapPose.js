import { isInsideMap } from './mapCoordinates.js';

/** Choose a current /odom pose expressed in the OccupancyGrid frame. */
export function resolveRosMapPose(snapshot, geometry, {
  transportStale = false,
  sourceStaleAfterMs = 2000,
} = {}) {
  if (!geometry?.frameId) return { pose: null, reason: 'no-map' };
  if (!snapshot?.pose) return { pose: null, reason: 'no-odom' };

  const age = snapshot.poseSourceUpdateAgeMs;
  if (transportStale || !snapshot.rosConnected || !Number.isFinite(age) ||
      age > sourceStaleAfterMs) {
    return { pose: null, reason: 'stale-odom' };
  }

  const pose = snapshot.pose.frameId === geometry.frameId
    ? snapshot.pose
    : snapshot.mapPose?.frameId === geometry.frameId ? snapshot.mapPose : null;
  if (!pose) return { pose: null, reason: 'missing-transform' };
  if (!isInsideMap(pose, geometry)) return { pose: null, reason: 'outside-map' };
  return { pose, reason: null };
}
