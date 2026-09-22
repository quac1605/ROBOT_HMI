// Policy của demo Chặng 7, không phải chứng nhận an toàn cho robot thật.
export const POSE_STALE_MS = 2000;
export const TRANSPORT_STALE_MS = 2000;
export const MAX_TRAJECTORY_POINTS = 2000;
export const ZERO_VELOCITY = Object.freeze({ linearX: 0, angularZ: 0 });

export function navigationError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function errorDto(error) {
  return { code: error?.code || 'NAVIGATION_ERROR', message: error?.message || 'Lỗi điều hướng' };
}

export function savedContext(map) {
  return map ? { kind: 'saved', mapId: map.id, mapRevision: map.revision } : null;
}

export function matchesMap(value, map) {
  return Boolean(value && map && value.mapId === map.id &&
    value.mapRevision === map.revision && (!value.frameId || value.frameId === map.frameId));
}

export function isPending(status) {
  return ['sending', 'uncertain', 'accepted', 'running'].includes(status);
}
