export function worldToGrid({ x, y }, map) {
  const dx = x - map.origin.x;
  const dy = y - map.origin.y;
  const c = Math.cos(map.origin.yaw);
  const s = Math.sin(map.origin.yaw);
  const u = (c * dx + s * dy) / map.resolution;
  const v = (-s * dx + c * dy) / map.resolution;
  return { u, v };
}

export function gridToWorld({ u, v }, map) {
  const c = Math.cos(map.origin.yaw);
  const s = Math.sin(map.origin.yaw);
  return {
    x: map.origin.x + map.resolution * (c * u - s * v),
    y: map.origin.y + map.resolution * (s * u + c * v),
  };
}

export function worldToSvg(point, map) {
  const { u, v } = worldToGrid(point, map);
  return { x: u, y: map.height - v };
}

export function svgToWorld(point, map) {
  return gridToWorld({ u: point.x, v: map.height - point.y }, map);
}

const EPSILON = 1e-9;

export function isInsideMap(point, map) {
  const { u, v } = worldToGrid(point, map);
  return (
    u >= -EPSILON &&
    u < map.width &&
    v >= -EPSILON &&
    v < map.height
  );
}

export function worldYawToSvgDegrees(worldYaw, mapOriginYaw = 0) {
  return -(worldYaw - mapOriginYaw) * (180 / Math.PI);
}

export function resolveVisiblePose(snapshot, mapContext) {
  if (!snapshot?.pose || !mapContext) return null;
  if (snapshot.pose.frameId !== mapContext.frameId) return null;

  // Trường hợp 1: Ngữ cảnh bản đồ đã lưu (Saved map context)
  const mapId = mapContext.mapId || mapContext.id;
  const mapRevision = mapContext.mapRevision || mapContext.revision;

  if (mapId) {
    if (snapshot.activeMappingSessionId) return null;
    if (snapshot.activeMap?.id !== mapId || snapshot.activeMap?.revision !== mapRevision) {
      return null;
    }
    return snapshot.pose;
  }

  // Trường hợp 2: Ngữ cảnh bản đồ đang tạo live (Live mapping context)
  const sessionId = mapContext.mappingSessionId;
  if (sessionId) {
    if (snapshot.activeMap) return null;
    if (snapshot.activeMappingSessionId !== sessionId) return null;
    return snapshot.pose;
  }

  return null;
}