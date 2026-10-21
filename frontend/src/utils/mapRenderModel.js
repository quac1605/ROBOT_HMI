export function normalizeYaw(yaw) {
  if (typeof yaw !== 'number' || !Number.isFinite(yaw)) return 0;
  let angle = yaw % (2 * Math.PI);
  if (angle <= -Math.PI) angle += 2 * Math.PI;
  if (angle > Math.PI) angle -= 2 * Math.PI;
  return Math.abs(angle) < 1e-6 ? 0 : angle;
}

export function mapContextKey(context) {
  if (!context) return '';
  if (context.kind === 'ros') return '["ros","/map"]';
  return JSON.stringify(
    context.kind === 'saved'
      ? ['saved', context.mapId, context.mapRevision]
      : ['mapping', context.mappingSessionId]
  );
}

export function sameMapContext(a, b) {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'saved') {
    return a.mapId === b.mapId && a.mapRevision === b.mapRevision;
  }
  return a.kind === 'mapping' && a.mappingSessionId === b.mappingSessionId;
}

export function geometryKey(g) {
  if (!g) return '';
  return JSON.stringify([
    g.frameId,
    g.width,
    g.height,
    g.resolution,
    g.origin?.x ?? 0,
    g.origin?.y ?? 0,
    normalizeYaw(g.origin?.yaw ?? 0),
  ]);
}

export function sameGeometry(a, b) {
  if (!a || !b) return false;
  return (
    a.frameId === b.frameId &&
    a.width === b.width &&
    a.height === b.height &&
    Math.abs(a.resolution - b.resolution) < 1e-6 &&
    Math.abs((a.origin?.x ?? 0) - (b.origin?.x ?? 0)) < 1e-5 &&
    Math.abs((a.origin?.y ?? 0) - (b.origin?.y ?? 0)) < 1e-5 &&
    Math.abs(normalizeYaw(a.origin?.yaw ?? 0) - normalizeYaw(b.origin?.yaw ?? 0)) < 1e-5
  );
}
