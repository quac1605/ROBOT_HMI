export function resolvePoseQuality(snapshot, {
  transportStale = false,
  sourceStaleAfterMs = 2000,
} = {}) {
  if (!snapshot?.rosConnected) return 'offline';
  if (snapshot.localization?.status !== 'tracking') return 'lost';
  if (transportStale) return 'stale';

  if (snapshot.pose) {
    const sourceAge = snapshot.poseSourceUpdateAgeMs;
    if (!Number.isFinite(sourceAge) || sourceAge > sourceStaleAfterMs) {
      return 'stale';
    }
  }

  return 'reliable';
}
