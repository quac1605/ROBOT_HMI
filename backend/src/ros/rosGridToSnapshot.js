import {
  MapContextSchema, parseMapGridSnapshot, MAX_MAP_CELLS, MAX_MAP_DIMENSION,
} from '@robot-hmi/contracts/mapGrid';
import { normalizeOccupancyGrid } from '@robot-hmi/contracts/normalizeOccupancyGrid';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

export function rosGridToSnapshot(message, { context, gridRevision, expectedFrameId }) {
  const validContext = MapContextSchema.parse(context);
  if (!Number.isSafeInteger(gridRevision) || gridRevision < 0) fail('INVALID_GRID_REVISION');
  if (typeof expectedFrameId !== 'string' || !expectedFrameId.trim()) fail('FRAME_REQUIRED');
  if (message?.header?.frame_id !== expectedFrameId) fail('MAP_FRAME_MISMATCH');
  const info = message?.info;
  const width = info?.width;
  const height = info?.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail('INVALID_MAP_DIMENSIONS');
  }
  // Giới hạn trước khi clone/Array.from để không cấp phát theo message tùy ý.
  if (width > MAX_MAP_DIMENSION || height > MAX_MAP_DIMENSION ||
      width > Math.floor(MAX_MAP_CELLS / height)) fail('MAP_TOO_LARGE');
  const data = message.data;
  if ((!Array.isArray(data) && !(data instanceof Int8Array)) ||
      data.length !== width * height) fail('INVALID_MAP_DATA');

  const snapshot = parseMapGridSnapshot({
    source: 'ros',
    mode: 'snapshot',
    encoding: 'occupancy-0-100-v1',
    context: validContext,
    gridRevision,
    grid: {
      header: structuredClone(message.header),
      info: structuredClone(info),
      data: Array.from(data),
    },
  });
  // Cùng implementation đã test ở frontend: reject quaternion không chuẩn,
  // roll/pitch không được hỗ trợ; yaw/origin hợp lệ vẫn giữ nguyên.
  normalizeOccupancyGrid(snapshot);
  return snapshot;
}
