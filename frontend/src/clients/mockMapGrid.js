import { createDemoGrid200x160 } from './demoOccupancyGrid.js';

const DEMO_STALE_MS = 2000;

export function createMockMapGrid({
  mapRepository,
  now = () => performance.now(),
  staleAfterMs = DEMO_STALE_MS,
} = {}) {
  let streamEpoch = 1;
  let sequence = 0;
  const streamId = 'map-grid-stream-default';
  const serviceTimers = new Set();
  let isDisposed = false;

  const liveSessions = new Map();

  function getSourceStatus(session) {
    if (session.scenario === 'offline') {
      return { sourceState: 'offline', lastSourceUpdateAgeMs: null };
    }

    const lastSourceUpdateAgeMs = session.lastSourceUpdateAt == null
      ? null
      : Math.max(0, Math.round(now() - session.lastSourceUpdateAt));

    return {
      sourceState:
        lastSourceUpdateAgeMs != null && lastSourceUpdateAgeMs > staleAfterMs
          ? 'stale'
          : 'live',
      lastSourceUpdateAgeMs,
    };
  }

  function envelope(type, subscriptionId, payload) {
    sequence += 1;
    return {
      version: 1,
      type,
      subscriptionId,
      streamId,
      streamEpoch,
      sequence,
      sentAt: new Date().toISOString(),
      payload: structuredClone(payload),
    };
  }

  function createInitialUnknownGrid(mappingSessionId) {
    const width = 200;
    const height = 160;
    return {
      source: 'mock',
      mode: 'snapshot',
      encoding: 'occupancy-0-100-v1',
      context: { kind: 'mapping', mappingSessionId },
      gridRevision: 1,
      grid: {
        header: { frame_id: 'map', stamp: { sec: 1000, nanosec: 0 } },
        info: {
          map_load_time: { sec: 1000, nanosec: 0 },
          resolution: 0.05,
          width,
          height,
          origin: {
            position: { x: 0, y: 0, z: 0 },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
          },
        },
        data: new Array(width * height).fill(-1), // Toàn bộ ban đầu là Unknown (-1)
      },
    };
  }

  function produceExplorationStep(session) {
    session.step += 1;
    const { grid } = session;
    const { width, height } = grid.grid.info;
    const data = [...grid.grid.data];
    let changed = false;

    // Quỹ đạo robot di chuyển tâm phòng (100, 80)
    const angle = (session.step * Math.PI) / 8;
    const robotCol = Math.round(100 + 40 * Math.cos(angle));
    const robotRow = Math.round(80 + 30 * Math.sin(angle));
    const radius = 25; // 25 ô (1.25m)

    // Khám phá free (0) quanh robot
    const minRow = Math.max(10, robotRow - radius);
    const maxRow = Math.min(height - 11, robotRow + radius);
    const minCol = Math.max(10, robotCol - radius);
    const maxCol = Math.min(width - 11, robotCol + radius);

    for (let r = minRow; r <= maxRow; r += 1) {
      for (let c = minCol; c <= maxCol; c += 1) {
        const d = Math.hypot(c - robotCol, r - robotRow);
        if (d <= radius) {
          const idx = c + r * width;
          if (data[idx] === -1) {
            data[idx] = 0; // Unknown -> Free
            changed = true;
          }
        }
      }
    }

    // Tường bao quanh phòng (khi quét chạm mép)
    for (let r = 10; r < height - 10; r += 1) {
      for (let c = 10; c < width - 10; c += 1) {
        if (c === 10 || c === width - 11 || r === 10 || r === height - 11) {
          const idx = c + r * width;
          // Nếu ô lân cận đã free thì lộ tường
          const nearFree =
            (data[idx + 1] === 0) ||
            (data[idx - 1] === 0) ||
            (data[idx + width] === 0) ||
            (data[idx - width] === 0);
          if (nearFree && data[idx] !== 100) {
            data[idx] = 100;
            changed = true;
          }
        }
      }
    }

    // Obstacle correction tại step 6
    if (session.step === 6) {
      // Đặt 1 cụm vật cản di chuyển ở giữa phòng
      for (let r = 75; r < 85; r += 1) {
        for (let c = 95; c < 105; c += 1) {
          const idx = c + r * width;
          if (data[idx] !== 100) {
            data[idx] = 100;
            changed = true;
          }
        }
      }
    }

    if (changed) {
      grid.grid.data = data;
      grid.gridRevision += 1;
    }

    session.lastSourceUpdateAt = now();
    session.status = 'ready';
    return changed;
  }

  function createLiveSession(mappingSessionId) {
    if (liveSessions.has(mappingSessionId)) {
      return liveSessions.get(mappingSessionId);
    }

    const session = {
      active: true,
      mappingSessionId,
      grid: createInitialUnknownGrid(mappingSessionId),
      step: 0,
      subscribers: new Map(),
      producerTimer: null,
      lastSourceUpdateAt: null, // Chưa có sample đầu tiên -> waiting
      status: 'waiting',
      scenario: 'live', // 'live' | 'pause' | 'offline' | 'wrong_frame' | 'expand_geometry' | 'change_resolution'
    };

    // Chu kỳ 500ms
    session.producerTimer = setInterval(() => {
      if (isDisposed || !session.active) return;

      const subscribersList = [...session.subscribers.values()];

      if (session.scenario === 'offline') {
        subscribersList.forEach((sub) => {
          if (!sub.active) return;
          sub.deliver(() =>
            envelope('map.status', sub.subscriptionId, {
              context: { kind: 'mapping', mappingSessionId },
              state: session.status,
              sourceState: 'offline',
              lastSourceUpdateAgeMs: null,
            })
          );
        });
        return;
      }

      if (session.scenario === 'pause') {
        const { sourceState, lastSourceUpdateAgeMs } = getSourceStatus(session);

        subscribersList.forEach((sub) => {
          if (!sub.active) return;
          sub.deliver(() =>
            envelope('map.status', sub.subscriptionId, {
              context: { kind: 'mapping', mappingSessionId },
              state: session.status,
              sourceState,
              lastSourceUpdateAgeMs,
            })
          );
        });
        return;
      }

      if (session.scenario === 'wrong_frame') {
        produceExplorationStep(session);
        // Phát bản sao với frame_id = 'odom', không làm hỏng grid gốc
        const badSnapshot = structuredClone(session.grid);
        badSnapshot.grid.header.frame_id = 'odom';

        subscribersList.forEach((sub) => {
          if (!sub.active) return;
          sub.deliver(() =>
            envelope('map.grid', sub.subscriptionId, badSnapshot)
          );
        });
        return;
      }

      // Live exploration thông thường
      produceExplorationStep(session);

      subscribersList.forEach((sub) => {
        if (!sub.active) return;
        sub.deliver(() =>
          envelope('map.status', sub.subscriptionId, {
            context: { kind: 'mapping', mappingSessionId },
            state: 'ready',
            sourceState: 'live',
            lastSourceUpdateAgeMs: 0,
          })
        );
        sub.deliver(() =>
          envelope('map.grid', sub.subscriptionId, session.grid)
        );
      });
    }, 500);

    if (session.producerTimer?.unref) {
      session.producerTimer.unref();
    }

    liveSessions.set(mappingSessionId, session);
    return session;
  }

  return {
    createLiveSession,

    async getMapGrid(context) {
      if (context.kind === 'saved') {
        if (mapRepository) {
          return mapRepository.getMapGrid(context.mapId, context.mapRevision);
        }
        // Fallback demo nếu không có repo
        return createDemoGrid200x160();
      }

      if (context.kind === 'mapping') {
        const session = liveSessions.get(context.mappingSessionId);
        if (!session) {
          const err = new Error(`Không tìm thấy phiên mapping ${context.mappingSessionId}`);
          err.code = 'SESSION_NOT_FOUND';
          throw err;
        }
        if (session.lastSourceUpdateAt === null && session.status === 'waiting') {
          const err = new Error(`Phiên mapping ${context.mappingSessionId} chưa có frame đầu`);
          err.code = 'MAP_NOT_READY';
          throw err;
        }
        return structuredClone(session.grid);
      }

      throw new Error(`Context kind không hợp lệ: ${context.kind}`);
    },

    subscribeMapGrid(context, listener, options = {}) {
      if (isDisposed) return () => {};

      let closed = false;
      const subscriptionId = options?.subscriptionId || `sub-${Math.random().toString(36).substring(2, 9)}`;
      const subTimers = new Set();

      function trackTimeout(fn, ms) {
        if (closed || isDisposed) return null;
        const handle = setTimeout(() => {
          subTimers.delete(handle);
          serviceTimers.delete(handle);
          if (!closed && !isDisposed) {
            fn();
          }
        }, ms);
        subTimers.add(handle);
        serviceTimers.add(handle);
        if (handle?.unref) handle.unref();
        return handle;
      }

      function deliver(makeEvent) {
        if (closed || isDisposed) return false;
        try {
          listener(makeEvent());
          return true;
        } catch (err) {
          console.error('Lỗi listener trong subscribeMapGrid:', err);
          return false;
        }
      }

      const subRecord = {
        subscriptionId,
        active: true,
        deliver,
        close: () => {
          if (closed) return;
          closed = true;
          subRecord.active = false;
          for (const handle of subTimers) {
            clearTimeout(handle);
            serviceTimers.delete(handle);
          }
          subTimers.clear();
        },
      };

      if (context.kind === 'saved') {
        trackTimeout(async () => {
          try {
            const grid = mapRepository
              ? await mapRepository.getMapGrid(context.mapId, context.mapRevision)
              : createDemoGrid200x160();

            deliver(() =>
              envelope('map.status', subscriptionId, {
                context,
                state: 'ready',
                sourceState: 'saved',
                lastSourceUpdateAgeMs: null,
              })
            );
            deliver(() => envelope('map.grid', subscriptionId, grid));
          } catch (err) {
            deliver(() =>
              envelope('map.error', subscriptionId, {
                context,
                error: { code: 'MAP_NOT_FOUND', message: err.message },
              })
            );
          }
        }, 10);

        return () => subRecord.close();
      }

      if (context.kind === 'mapping') {
        const session = liveSessions.get(context.mappingSessionId);
        if (!session) {
          trackTimeout(() => {
            deliver(() =>
              envelope('map.error', subscriptionId, {
                context,
                error: {
                  code: 'SESSION_NOT_FOUND',
                  message: `Phiên mapping ${context.mappingSessionId} không tồn tại`,
                },
              })
            );
          }, 10);
          return () => subRecord.close();
        }

        session.subscribers.set(subscriptionId, subRecord);

        // Bắn trạng thái ban đầu
        trackTimeout(() => {
          const { sourceState, lastSourceUpdateAgeMs } = getSourceStatus(session);

          deliver(() =>
            envelope('map.status', subscriptionId, {
              context,
              state: session.status,
              sourceState,
              lastSourceUpdateAgeMs,
            })
          );
          if (session.status === 'ready') {
            deliver(() => envelope('map.grid', subscriptionId, session.grid));
          }
        }, 10);

        return () => {
          subRecord.close();
          session.subscribers.delete(subscriptionId);
        };
      }

      return () => subRecord.close();
    },

    setSessionScenario(sessionId, scenario) {
      const session = liveSessions.get(sessionId);
      if (!session) return;
      session.scenario = scenario;

      if (scenario === 'expand_geometry') {
        const width = 220;
        const height = 180;
        session.grid.grid.info.width = width;
        session.grid.grid.info.height = height;
        session.grid.grid.info.origin.position = { x: -5.5, y: -4.5, z: 0 };
        session.grid.grid.data = new Array(width * height).fill(0);
        session.grid.gridRevision += 1;
        session.lastSourceUpdateAt = now();
        session.scenario = 'live';
      } else if (scenario === 'change_resolution') {
        const width = 100;
        const height = 80;
        session.grid.grid.info.resolution = 0.10;
        session.grid.grid.info.width = width;
        session.grid.grid.info.height = height;
        session.grid.grid.data = new Array(width * height).fill(0);
        session.grid.gridRevision += 1;
        session.lastSourceUpdateAt = now();
        session.scenario = 'live';
      }
    },

    getSessionScenario(sessionId) {
      return liveSessions.get(sessionId)?.scenario || 'live';
    },

    advanceSourceStep(sessionId) {
      const session = liveSessions.get(sessionId);
      if (session) {
        produceExplorationStep(session);
      }
    },

    emitSessionNow(sessionId) {
      const session = liveSessions.get(sessionId);
      if (!session || isDisposed || !session.active) return false;
      const { sourceState, lastSourceUpdateAgeMs } = getSourceStatus(session);

      for (const sub of session.subscribers.values()) {
        if (!sub.active) continue;
        sub.deliver(() =>
          envelope('map.status', sub.subscriptionId, {
            context: { kind: 'mapping', mappingSessionId: session.mappingSessionId },
            state: session.status,
            sourceState,
            lastSourceUpdateAgeMs,
          })
        );
        if (sourceState !== 'offline' && session.status === 'ready') {
          sub.deliver(() => envelope('map.grid', sub.subscriptionId, session.grid));
        }
      }
      return true;
    },

    getLiveSessionSnapshot(sessionId) {
      const session = liveSessions.get(sessionId);
      return session ? structuredClone(session.grid) : null;
    },

    replaceLiveSessionGrid(sessionId, snapshot) {
      const session = liveSessions.get(sessionId);
      if (!session) throw new Error(`Không tìm thấy phiên mapping ${sessionId}`);
      if (
        snapshot?.context?.kind !== 'mapping' ||
        snapshot.context.mappingSessionId !== sessionId
      ) {
        const err = new Error('Snapshot thay thế không khớp mapping session');
        err.code = 'MAP_CONTEXT_MISMATCH';
        throw err;
      }
      session.grid = structuredClone(snapshot);
      session.status = 'ready';
      session.lastSourceUpdateAt = now();
      return structuredClone(session.grid);
    },

    getDebugState() {
      return {
        disposed: isDisposed,
        serviceTimerCount: serviceTimers.size,
        liveSessions: [...liveSessions.values()].map((session) => ({
          mappingSessionId: session.mappingSessionId,
          active: session.active,
          status: session.status,
          scenario: session.scenario,
          subscriberCount: session.subscribers.size,
          gridRevision: session.grid.gridRevision,
        })),
      };
    },

    removeLiveSession(sessionId) {
      const session = liveSessions.get(sessionId);
      if (session) {
        session.active = false;
        if (session.producerTimer) clearInterval(session.producerTimer);
        for (const sub of session.subscribers.values()) {
          sub.close();
        }
        session.subscribers.clear();
        liveSessions.delete(sessionId);
      }
    },

    dispose() {
      if (isDisposed) return;
      isDisposed = true;
      streamEpoch += 1;
      for (const handle of serviceTimers) {
        clearTimeout(handle);
      }
      serviceTimers.clear();

      for (const session of liveSessions.values()) {
        session.active = false;
        if (session.producerTimer) clearInterval(session.producerTimer);
        for (const sub of session.subscribers.values()) {
          sub.close();
        }
        session.subscribers.clear();
      }
      liveSessions.clear();
    },
  };
}
