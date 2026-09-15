import { occupancyToRgba } from './occupancyToRgba.js';
import { defaultRasterRuntime } from './rasterRuntime.js';

const NO_PENDING = Symbol('NO_PENDING');
const activeControllers = new Set();

// Registry trong module (không ghi window/globalThis) để DEV test controls có
// thể quan sát lifecycle thật của controller mà không can thiệp pipeline.
export function getActiveRasterDebugStates() {
  return [...activeControllers].map((controller) => controller.getDebugState());
}

function deepFreeze(obj) {
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function rasterError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createOccupancyRasterController({
  runtime = defaultRasterRuntime,
  onPublish,
  onError,
} = {}) {
  let alive = true;
  let latestGeneration = 0;
  let nextPresentationId = 0;
  let activeTask = null;
  let pendingLatest = NO_PENDING;
  let candidate = null;
  let displayed = null;
  let latestPublished = null;
  const retired = new Map();
  const ownedUrls = new Set();

  function report(cause, fallback = 'RASTER_ERROR') {
    if (!alive) return;
    try {
      onError?.({
        code: cause?.code || fallback,
        message: cause?.message || 'Không thể tạo raster bản đồ',
      });
    } catch {
      // Consumer error không được thoát khỏi async callback
    }
  }

  function own(url) {
    ownedUrls.add(url);
    return url;
  }

  function release(url) {
    if (!url || !ownedUrls.delete(url)) return;
    try {
      runtime.revokeObjectURL(url);
    } catch (cause) {
      report(cause, 'RASTER_URL_REVOKE_ERROR');
    }
  }

  function publish(raster) {
    const presentation = { id: ++nextPresentationId, raster };
    try {
      onPublish?.(presentation);
      latestPublished = raster
        ? {
          context: structuredClone(raster.context),
          gridRevision: raster.gridRevision,
          token: raster.token,
        }
        : null;
      return true;
    } catch (cause) {
      report(cause, 'RASTER_COMMIT_ERROR');
      return false;
    }
  }

  function pump() {
    if (!alive || activeTask || pendingLatest === NO_PENDING) return;
    const request = pendingLatest;
    pendingLatest = NO_PENDING;
    void run(request);
  }

  async function run(request) {
    const abortController = new AbortController();
    const task = { ...request, abortController, phase: 'encoding', url: null };
    activeTask = task;

    try {
      const { grid, generation } = task;
      const { width, height } = grid.geometry;
      const canvas = runtime.createCanvas();
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw rasterError('RASTER_CANVAS_ERROR', 'Không thể khởi tạo Canvas 2D context');

      const rgba = occupancyToRgba({ width, height, cells: grid.cells });
      ctx.putImageData(runtime.createImageData(rgba, width, height), 0, 0);

      // Không abort một toBlob đã bắt đầu. canvas.toBlob() không có API hủy native;
      // nếu giải phóng active slot sớm thì snapshot kế tiếp có thể khởi động một
      // encode thứ hai song song dù state của controller chỉ báo một task.
      const blob = await runtime.toBlob(canvas, abortController.signal);
      if (!alive || generation !== latestGeneration) return;

      task.url = own(runtime.createObjectURL(blob));
      task.phase = 'decoding';
      await runtime.decodeUrl(task.url, abortController.signal);
      if (!alive || generation !== latestGeneration) return;

      const next = deepFreeze({
        context: structuredClone(grid.context),
        gridRevision: grid.gridRevision,
        geometry: structuredClone(grid.geometry),
        objectUrl: task.url,
        token: `${generation}:${grid.gridRevision}`,
      });

      const previousCandidate = candidate;
      if (previousCandidate && previousCandidate !== displayed) {
        retired.set(previousCandidate.objectUrl, previousCandidate);
      }
      candidate = next;

      if (!publish(next)) {
        candidate = previousCandidate;
        if (previousCandidate) retired.delete(previousCandidate.objectUrl);
        release(task.url);
        for (const raster of retired.values()) {
          if (raster !== displayed && raster !== candidate) {
            release(raster.objectUrl);
          }
        }
        retired.clear();
      } else {
        task.url = null; // Ownership chuyển sang candidate/displayed lifecycle
      }
    } catch (cause) {
      if (alive && task.generation === latestGeneration && cause?.name !== 'AbortError') {
        report(cause);
      }
    } finally {
      release(task.url);
      if (activeTask === task) activeTask = null;
      pump();
    }
  }

  const controller = {
    updateGrid(grid) {
      if (!alive) return;
      const generation = ++latestGeneration;

      if (grid == null) {
        pendingLatest = NO_PENDING;
        // Decode có thể hủy thật; native toBlob thì phải được để callback kết thúc
        // trước khi active slot được nhường cho request khác.
        if (activeTask?.phase === 'decoding') activeTask.abortController.abort();
        if (candidate && candidate !== displayed) {
          retired.set(candidate.objectUrl, candidate);
        }
        candidate = null;
        publish(null); // DOM acknowledgement sẽ release displayed/retired
        return;
      }

      pendingLatest = { generation, grid };
      // Chỉ hủy phase có cancellation thật. Generation guard sẽ loại kết quả
      // toBlob cũ, rồi pump đúng snapshot mới nhất đang chờ.
      if (activeTask?.phase === 'decoding') activeTask.abortController.abort();
      pump();
    },

    acknowledgeLoaded(token) {
      if (!alive || candidate?.token !== token) return;
      for (const raster of retired.values()) release(raster.objectUrl);
      retired.clear();
      if (displayed && displayed !== candidate) release(displayed.objectUrl);
      displayed = candidate;
    },

    acknowledgeImageError(token, cause) {
      if (!alive || candidate?.token !== token) return;
      const failed = candidate;
      release(failed.objectUrl);
      if (failed === displayed) {
        candidate = null;
        displayed = null;
      } else {
        candidate = displayed;
      }
      for (const raster of retired.values()) {
        if (raster !== displayed) release(raster.objectUrl);
      }
      retired.clear();
      publish(displayed); // Rollback last-good hoặc clear nếu displayed cũng lỗi
      report(cause, 'IMAGE_DECODE_FAILED');
    },

    acknowledgeCleared() {
      if (!alive || candidate) return;
      if (displayed) release(displayed.objectUrl);
      displayed = null;
      for (const raster of retired.values()) release(raster.objectUrl);
      retired.clear();
    },

    getDebugState() {
      return {
        activeTasks: activeTask ? 1 : 0,
        activePhase: activeTask?.phase ?? null,
        pendingCount: pendingLatest === NO_PENDING ? 0 : 1,
        ownedUrlCount: ownedUrls.size,
        latestPublished: latestPublished ? structuredClone(latestPublished) : null,
        runtimeCounters: typeof runtime.getCounters === 'function'
          ? runtime.getCounters()
          : null,
      };
    },

    dispose() {
      if (!alive) return;
      alive = false;
      latestGeneration += 1;
      pendingLatest = NO_PENDING;
      activeTask?.abortController.abort();
      for (const url of [...ownedUrls]) release(url);
      activeTask = null;
      candidate = null;
      displayed = null;
      retired.clear();
      activeControllers.delete(controller);
    },
  };

  activeControllers.add(controller);
  return controller;
}
