import { normalizeOccupancyGrid } from './normalizeOccupancyGrid.js';
import {
  ShallowMapGridEventEnvelopeSchema,
  MapGridEventEnvelopeSchema,
} from '../schemas/mapGrid.js';

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function geometriesEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.frameId === b.frameId &&
    a.width === b.width &&
    a.height === b.height &&
    Math.abs(a.resolution - b.resolution) < 1e-6 &&
    Math.abs(a.origin.x - b.origin.x) < 1e-5 &&
    Math.abs(a.origin.y - b.origin.y) < 1e-5 &&
    Math.abs(a.origin.yaw - b.origin.yaw) < 1e-5
  );
}

/**
 * Khởi tạo bộ điều phối sự kiện bản đồ (Pure Event Gate)
 * Quản lý generation, epoch, sequence, streamId và monotonic revision.
 */
export function createMapGridEventGate({ onSnapshot, onStatus, onError, onValidSnapshot }) {
  let activeContext = null;
  let activeSubscriptionId = null;
  let expectedFrameId = null;
  let expectedGeometry = null;
  let currentGeneration = 0;
  let activeStreamId = null;
  let currentEpoch = -1;
  let lastSequence = -1;
  let lastGoodGridRevision = -1;
  let lastGoodNormalizedGrid = null;
  let hasReceivedGridEvent = false;
  let lockedFrameId = null;

  return {
    setContext(context, subscriptionId, expectedGeometryOrFrame = null) {
      currentGeneration += 1;
      activeContext = context ? JSON.parse(JSON.stringify(context)) : null;
      activeSubscriptionId = subscriptionId;
      if (expectedGeometryOrFrame && typeof expectedGeometryOrFrame === 'object') {
        expectedGeometry = expectedGeometryOrFrame;
        expectedFrameId = expectedGeometryOrFrame.frameId || null;
      } else {
        expectedGeometry = null;
        expectedFrameId = expectedGeometryOrFrame;
      }
      activeStreamId = null;
      currentEpoch = -1;
      lastSequence = -1;
      lastGoodGridRevision = -1;
      lastGoodNormalizedGrid = null;
      hasReceivedGridEvent = false;
      lockedFrameId = null;
    },

    handleInitialResponse(generation, payload) {
      if (generation !== currentGeneration) return false;
      if (hasReceivedGridEvent) return false;

      try {
        const normalized = normalizeOccupancyGrid(payload);

        // Kiểm tra khớp context
        if (activeContext) {
          if (normalized.context.kind !== activeContext.kind) return false;
          if (
            normalized.context.kind === 'saved' &&
            (normalized.context.mapId !== activeContext.mapId ||
              normalized.context.mapRevision !== activeContext.mapRevision)
          ) {
            return false;
          }
          if (
            normalized.context.kind === 'mapping' &&
            normalized.context.mappingSessionId !== activeContext.mappingSessionId
          ) {
            return false;
          }
        }

        if (expectedGeometry && !geometriesEqual(normalized.geometry, expectedGeometry)) {
          const err = new Error('Dữ liệu lưới không khớp metadata hình học của bản đồ');
          err.code = 'MAP_METADATA_GRID_MISMATCH';
          throw err;
        }
        if (expectedFrameId && normalized.geometry.frameId !== expectedFrameId) {
          const err = new Error(
            `Frame ID của bản đồ ban đầu (${normalized.geometry.frameId}) không khớp expected (${expectedFrameId})`
          );
          err.code = 'MAP_FRAME_MISMATCH';
          throw err;
        }

        lockedFrameId = normalized.geometry.frameId;
        lastGoodGridRevision = normalized.gridRevision;
        lastGoodNormalizedGrid = normalized;
        onSnapshot?.(normalized);
        return true;
      } catch (err) {
        onError?.({ code: err.code || 'INVALID_MAP_DATA', message: err.message });
        return false;
      }
    },

    handleInitialError(generation, cause) {
      // Một subscription grid hợp lệ mới hơn là authoritative. Lỗi của request
      // initial đến muộn không được phủ cảnh báo giả lên last-good snapshot.
      if (generation !== currentGeneration || hasReceivedGridEvent) return false;
      onError?.({
        code: cause?.code || 'FETCH_ERROR',
        message: cause?.message || 'Không thể tải snapshot bản đồ ban đầu',
      });
      return true;
    },

    handleEvent(generation, rawEvent) {
      // 1. Generation check
      if (generation !== currentGeneration) return false;

      // 2. Strict shallow envelope check
      const shallowResult = ShallowMapGridEventEnvelopeSchema.safeParse(rawEvent);
      if (!shallowResult.success) {
        onError?.({
          code: 'INVALID_ENVELOPE',
          message: shallowResult.error.issues[0]?.message || 'Lỗi envelope',
        });
        return false;
      }
      let event = shallowResult.data;

      // 3. SubscriptionId check
      if (activeSubscriptionId && event.subscriptionId !== activeSubscriptionId) {
        return false;
      }

      // 4. Validate payload trước khi thay đổi stream cursor. map.grid cần
      // preflight riêng để chặn payload lớn trước deep Zod allocation.
      let normalizedGrid = null;
      if (event.type === 'map.grid') {
        try {
          normalizedGrid = normalizeOccupancyGrid(event.payload);

          if (expectedGeometry && !geometriesEqual(normalizedGrid.geometry, expectedGeometry)) {
            const err = new Error('Dữ liệu lưới không khớp metadata hình học của bản đồ');
            err.code = 'MAP_METADATA_GRID_MISMATCH';
            throw err;
          }
          const frameToMatch = lockedFrameId || expectedFrameId;
          if (frameToMatch && normalizedGrid.geometry.frameId !== frameToMatch) {
            const err = new Error(
              `Frame ID không khớp: ${normalizedGrid.geometry.frameId} !== ${frameToMatch}`
            );
            err.code = 'MAP_FRAME_MISMATCH';
            throw err;
          }
        } catch (err) {
          onError?.({ code: err.code || 'INVALID_MAP_DATA', message: err.message });
          return false;
        }
      } else {
        const deepResult = MapGridEventEnvelopeSchema.safeParse(rawEvent);
        if (!deepResult.success) {
          onError?.({
            code: 'INVALID_ENVELOPE',
            message: deepResult.error.issues[0]?.message || 'Payload event không hợp lệ',
          });
          return false;
        }
        event = deepResult.data;
      }

      // 5. Exact context check
      const eventCtx = event.type === 'map.grid'
        ? normalizedGrid?.context
        : event.payload?.context;
      if (!eventCtx) {
        onError?.({ code: 'INVALID_ENVELOPE', message: 'Payload thiếu trường context' });
        return false;
      }

      if (activeContext) {
        if (eventCtx.kind !== activeContext.kind) return false;
        if (
          eventCtx.kind === 'saved' &&
          (eventCtx.mapId !== activeContext.mapId ||
            eventCtx.mapRevision !== activeContext.mapRevision)
        ) {
          return false;
        }
        if (
          eventCtx.kind === 'mapping' &&
          eventCtx.mappingSessionId !== activeContext.mappingSessionId
        ) {
          return false;
        }
      }

      // 6. Latch streamId đầu tiên chỉ sau khi payload đã hợp lệ
      if (!activeStreamId) {
        activeStreamId = event.streamId;
      } else if (event.streamId !== activeStreamId) {
        onError?.({
          code: 'STREAM_ID_MISMATCH',
          message: `StreamId (${event.streamId}) không khớp stream đang nhận (${activeStreamId})`,
        });
        return false;
      }

      // 7. Epoch check
      if (event.streamEpoch < currentEpoch) return false;
      if (event.streamEpoch > currentEpoch) {
        currentEpoch = event.streamEpoch;
        lastSequence = -1;
      }

      // 8. Sequence check & transport cursor advance
      if (event.sequence <= lastSequence) return false;
      lastSequence = event.sequence;

      // 9. Type-specific payload handling
      if (event.type === 'map.status') {
        onStatus?.(event.payload);
        return true;
      }

      if (event.type === 'map.error') {
        onError?.(event.payload.error);
        return true;
      }

      if (event.type === 'map.grid') {
        try {
          const normalized = normalizedGrid;
          if (!lockedFrameId) {
            if (expectedFrameId && normalized.geometry.frameId !== expectedFrameId) {
              const err = new Error(
                `Frame ID không khớp: ${normalized.geometry.frameId} !== ${expectedFrameId}`
              );
              err.code = 'MAP_FRAME_MISMATCH';
              throw err;
            }
            lockedFrameId = normalized.geometry.frameId;
          } else if (normalized.geometry.frameId !== lockedFrameId) {
            const err = new Error(
              `Frame ID không khớp: ${normalized.geometry.frameId} !== ${lockedFrameId}`
            );
            err.code = 'MAP_FRAME_MISMATCH';
            throw err;
          }

          // 10. Monotonic gridRevision policy
          if (normalized.gridRevision < lastGoodGridRevision) {
            // Regression revision -> bỏ qua
            return false;
          }

          if (normalized.gridRevision === lastGoodGridRevision) {
            // Cùng revision: so sánh nội dung exact
            if (
              geometriesEqual(normalized.geometry, lastGoodNormalizedGrid?.geometry) &&
              arraysEqual(normalized.cells, lastGoodNormalizedGrid?.cells)
            ) {
              // Exact dedupe: không reraster, nhưng vẫn là một snapshot hợp lệ
              // có thể xác nhận nguồn đã phục hồi sau một event lỗi trước đó.
              onValidSnapshot?.(normalized);
              return true;
            }
            const err = new Error(`Cùng gridRevision (${normalized.gridRevision}) nhưng nội dung bản đồ khác nhau`);
            err.code = 'GRID_REVISION_CONFLICT';
            throw err;
          }

          // 11. Commit last-good và phát onSnapshot
          hasReceivedGridEvent = true;
          lastGoodGridRevision = normalized.gridRevision;
          lastGoodNormalizedGrid = normalized;
          onSnapshot?.(normalized);
          return true;
        } catch (err) {
          onError?.({ code: err.code || 'INVALID_MAP_DATA', message: err.message });
          // TUYỆT ĐỐI KHÔNG gọi lại onSnapshot(lastGoodNormalizedGrid)!
          return false;
        }
      }

      return false;
    },

    getGeneration: () => currentGeneration,
    getLastGoodGrid: () => lastGoodNormalizedGrid,
    getLastGoodGridRevision: () => lastGoodGridRevision,
  };
}
