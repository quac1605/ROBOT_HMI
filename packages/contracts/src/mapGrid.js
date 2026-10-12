import { z } from 'zod';

// Giới hạn profile thử nghiệm tối đa
export const MAX_MAP_DIMENSION = 4096;
export const MAX_MAP_CELLS = 512 * 512; // 262,144 ô
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024; // 2 MiB
export const MAX_METADATA_BYTES = 16 * 1024; // 16 KiB

/**
 * Đếm số byte UTF-8 của chuỗi có early exit ngay khi vượt quá limit.
 * Surrogate pair tính là 4 bytes. Unpaired surrogate tính là 3 bytes (theo UTF-8 replacement).
 */
export function boundedUtf8StringLength(str, limit = MAX_MESSAGE_BYTES) {
  if (typeof str !== 'string') return 0;
  let bytes = 0;
  const len = str.length;
  for (let i = 0; i < len; i += 1) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: kiểm tra tiếp theo có low surrogate không
      if (i + 1 < len) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          i += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }

    if (bytes > limit) {
      return bytes;
    }
  }
  return bytes;
}

/**
 * Đo độ dài byte UTF-8 thật của một đối tượng khi serialize JSON.
 */
export function utf8JsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function mapTooLarge(msg = 'Dung lượng bản đồ vượt quá giới hạn 2 MiB') {
  const err = new Error(msg);
  err.code = 'MAP_TOO_LARGE';
  return err;
}

function invalidMapData(msg = 'Dữ liệu bản đồ không hợp lệ', cause = null) {
  const err = new Error(msg);
  err.code = 'INVALID_MAP_DATA';
  if (cause) err.cause = cause;
  return err;
}

/**
 * Parse chuỗi hoặc ArrayBuffer thô từ transport, kiểm tra byte cap trước khi parse JSON.
 */
export function parseRawMapMessage(raw) {
  let text;
  if (typeof raw === 'string') {
    const bytes = boundedUtf8StringLength(raw, MAX_MESSAGE_BYTES);
    if (bytes > MAX_MESSAGE_BYTES) throw mapTooLarge(`Kích thước message (${bytes} bytes) vượt quá 2 MiB`);
    text = raw;
  } else {
    const view =
      raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : ArrayBuffer.isView(raw)
          ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
          : null;
    if (!view) throw invalidMapData('Raw message phải là string, ArrayBuffer hoặc ArrayBufferView');
    if (view.byteLength > MAX_MESSAGE_BYTES) {
      throw mapTooLarge(`Kích thước binary (${view.byteLength} bytes) vượt quá 2 MiB`);
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(view);
    } catch (cause) {
      throw invalidMapData('UTF-8 không hợp lệ', cause);
    }
  }

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw invalidMapData('JSON không hợp lệ', cause);
  }
}

/**
 * Kiểm tra nhanh cấu trúc thô và kích thước (Object Path Preflight)
 * Chặn sớm trước khi deep Zod parse hoặc cấp phát mảng lớn.
 */
export function preflightMapGrid(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidMapData('Payload bản đồ phải là plain object');
  }

  // 1. Kiểm tra đối tượng thuần (chỉ cho phép own properties, không accessor)
  const allowedKeys = new Set(['source', 'mode', 'encoding', 'context', 'gridRevision', 'grid']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw invalidMapData(`Trường không cho phép trong snapshot: ${key}`);
    }
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc || typeof desc.get === 'function' || typeof desc.set === 'function') {
      throw invalidMapData(`Trường ${key} không được là getter/setter`);
    }
  }

  const { grid } = raw;
  if (!grid || typeof grid !== 'object' || Array.isArray(grid) || !grid.info) {
    throw invalidMapData('Thiếu cấu trúc grid hoặc grid.info');
  }

  const allowedGridKeys = new Set(['header', 'info', 'data']);
  for (const key of Object.keys(grid)) {
    if (!allowedGridKeys.has(key)) {
      throw invalidMapData(`Trường không cho phép trong grid: ${key}`);
    }
  }

  const { width, height } = grid.info;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw invalidMapData('Dimensions width và height phải là số nguyên dương');
  }

  // 2. Division-safe dimension check
  if (
    width > MAX_MAP_DIMENSION ||
    height > MAX_MAP_DIMENSION ||
    height > MAX_MAP_CELLS ||
    width > Math.floor(MAX_MAP_CELLS / height)
  ) {
    throw mapTooLarge(`Kích thước bản đồ (${width}x${height}) vượt quá giới hạn tối đa cho phép`);
  }

  const totalCells = width * height;
  if (!Array.isArray(grid.data) || grid.data.length !== totalCells) {
    throw invalidMapData(`data.length (${grid.data?.length}) không khớp với width * height (${totalCells})`);
  }

  // 3. Metadata whitelist & exact UTF-8 size measurement
  const metadataOnly = {
    source: raw.source,
    mode: raw.mode,
    encoding: raw.encoding,
    context: raw.context,
    gridRevision: raw.gridRevision,
    header: grid.header,
    info: grid.info,
  };

  const metaBytes = utf8JsonBytes(metadataOnly);
  if (metaBytes > MAX_METADATA_BYTES) {
    throw mapTooLarge(`Dung lượng metadata (${metaBytes} bytes) vượt quá trần 16 KiB`);
  }

  // 4. Bounded loop kiểm tra từng cell integer [-1, 100]
  for (let i = 0; i < totalCells; i += 1) {
    const val = grid.data[i];
    if (typeof val !== 'number' || !Number.isInteger(val) || val < -1 || val > 100) {
      throw invalidMapData(`Ô thứ ${i} có giá trị không hợp lệ: ${val}`);
    }
  }

  // 5. Đo exact UTF-8 byte length toàn bộ snapshot
  const totalBytes = utf8JsonBytes(raw);
  if (totalBytes > MAX_MESSAGE_BYTES) {
    throw mapTooLarge(`Dung lượng toàn bộ snapshot (${totalBytes} bytes) vượt quá trần 2 MiB`);
  }

  return true;
}

export const MapContextSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('saved'),
      mapId: z.string().trim().min(1).max(128),
      mapRevision: z.string().trim().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal('mapping'),
      mappingSessionId: z.string().trim().min(1).max(128),
    })
    .strict(),
]);

export const RosStampSchema = z
  .object({
    sec: z.number().int(),
    nanosec: z.number().int().min(0).max(999999999),
  })
  .strict();

export const QuaternionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
    w: z.number().finite(),
  })
  .strict();

export const RosOriginSchema = z
  .object({
    position: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
      })
      .strict(),
    orientation: QuaternionSchema,
  })
  .strict();

export const RosOccupancyGridSchema = z
  .object({
    header: z
      .object({
        frame_id: z.string().trim().min(1).max(128),
        stamp: RosStampSchema,
      })
      .strict(),
    info: z
      .object({
        map_load_time: RosStampSchema,
        resolution: z.number().positive().finite(),
        width: z.number().int().positive().max(MAX_MAP_DIMENSION),
        height: z.number().int().positive().max(MAX_MAP_DIMENSION),
        origin: RosOriginSchema,
      })
      .strict(),
    data: z.array(z.number().int().min(-1).max(100)),
  })
  .strict()
  .refine(
    (grid) => grid.info.width * grid.info.height === grid.data.length,
    { message: 'data.length phải bằng width * height', path: ['data'] }
  )
  .refine(
    (grid) => grid.data.length <= MAX_MAP_CELLS,
    { message: `Số lượng ô vượt quá giới hạn (${MAX_MAP_CELLS})`, path: ['data'] }
  );

export const MapGridSnapshotSchema = z
  .object({
    source: z.enum(['mock', 'ros']),
    mode: z.literal('snapshot'),
    encoding: z.literal('occupancy-0-100-v1'),
    context: MapContextSchema,
    gridRevision: z.number().int().nonnegative(),
    grid: RosOccupancyGridSchema,
  })
  .strict();

// preflightMapGrid đã kiểm tra toàn bộ data[] (array, length, integer và range).
// Schema này vẫn dùng đúng các schema metadata của contract nhưng giữ data là
// unknown để không deep-parse và cấp phát lại hàng trăm nghìn phần tử lần hai.
const PreflightedRosOccupancyGridSchema = z
  .object({
    header: RosOccupancyGridSchema.shape.header,
    info: RosOccupancyGridSchema.shape.info,
    data: z.unknown(),
  })
  .strict();

const PreflightedMapGridSnapshotSchema = z
  .object({
    source: MapGridSnapshotSchema.shape.source,
    mode: MapGridSnapshotSchema.shape.mode,
    encoding: MapGridSnapshotSchema.shape.encoding,
    context: MapGridSnapshotSchema.shape.context,
    gridRevision: MapGridSnapshotSchema.shape.gridRevision,
    grid: PreflightedRosOccupancyGridSchema,
  })
  .strict();

/**
 * Parse snapshot dùng cho hot path sau transport.
 *
 * Hành vi validation tương đương MapGridSnapshotSchema đối với snapshot JSON:
 * preflight kiểm tra kích thước/byte cap/toàn bộ cell; Zod kiểm tra metadata
 * strict và thực hiện các transform như trim string.
 */
export function parseMapGridSnapshot(raw) {
  preflightMapGrid(raw);
  const parsed = PreflightedMapGridSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidMapData(
      `Dữ liệu bản đồ không hợp lệ: ${parsed.error.issues[0]?.message || 'Lỗi schema'}`,
      parsed.error
    );
  }
  return parsed.data;
}

// Shallow Envelope Schema dùng để parse header trước khi preflight payload
export const ShallowMapGridEventEnvelopeSchema = z
  .object({
    version: z.literal(1),
    type: z.enum(['map.grid', 'map.status', 'map.error']),
    subscriptionId: z.string().trim().min(1).max(128),
    streamId: z.string().trim().min(1).max(128),
    streamEpoch: z.number().int().nonnegative(),
    sequence: z.number().int().nonnegative(),
    sentAt: z.string().datetime(),
    payload: z.unknown(),
  })
  .strict();

export const MapGridEventEnvelopeSchema = z.discriminatedUnion('type', [
  z
    .object({
      version: z.literal(1),
      type: z.literal('map.grid'),
      subscriptionId: z.string().trim().min(1).max(128),
      streamId: z.string().trim().min(1).max(128),
      streamEpoch: z.number().int().nonnegative(),
      sequence: z.number().int().nonnegative(),
      sentAt: z.string().datetime(),
      payload: MapGridSnapshotSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal('map.status'),
      subscriptionId: z.string().trim().min(1).max(128),
      streamId: z.string().trim().min(1).max(128),
      streamEpoch: z.number().int().nonnegative(),
      sequence: z.number().int().nonnegative(),
      sentAt: z.string().datetime(),
      payload: z
        .object({
          context: MapContextSchema,
          state: z.enum(['waiting', 'ready']),
          sourceState: z.enum(['live', 'stale', 'offline', 'saved']),
          lastSourceUpdateAgeMs: z.number().finite().nonnegative().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal('map.error'),
      subscriptionId: z.string().trim().min(1).max(128),
      streamId: z.string().trim().min(1).max(128),
      streamEpoch: z.number().int().nonnegative(),
      sequence: z.number().int().nonnegative(),
      sentAt: z.string().datetime(),
      payload: z
        .object({
          context: MapContextSchema,
          error: z
            .object({
              code: z.string().min(1),
              message: z.string().min(1),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
]);
