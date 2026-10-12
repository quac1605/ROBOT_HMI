const fail = code => Object.assign(new Error(code), { code, status: 503 });
const clone = value => structuredClone(value);

export function createMockMappingSource({
  now = () => performance.now(), staleAfterMs = 2000,
} = {}) {
  let current = null;
  let disposed = false;
  const listeners = new Set();

  function usable() {
    if (disposed) throw fail('SERVICE_DISPOSED');
  }

  function requireSession(id) {
    usable();
    if (!current || current.id !== id) throw fail('MAPPING_GRID_UNAVAILABLE');
    return current;
  }

  function observation(session) {
    // Session được tạo chưa chứng minh rằng sensor/motion source đã phát mẫu.
    // Không đưa grid/pose với nhãn live ra ngoài chỉ vì Start đã chạy.
    if (!session.last) return null;
    const age = Math.max(0, now() - session.last.observedMono);
    return {
      mappingSessionId: session.id,
      pose: clone(session.pose),
      snapshot: clone(session.snapshot),
      sourceEpoch: session.last.sourceEpoch,
      sourceSequence: session.last.sourceSequence,
      observedMono: session.last.observedMono,
      sourceState: age >= staleAfterMs ? 'stale' : 'live',
      lastSourceUpdateAgeMs: Math.round(age),
    };
  }

  function reveal(session) {
    const { info, data } = session.snapshot.grid;
    const cx = Math.floor(session.pose.x / info.resolution);
    const cy = Math.floor(session.pose.y / info.resolution);
    const radius = 25; // Mô phỏng vùng lidar 1.25 m, không phải hardware spec.
    let changed = false;
    for (let y = Math.max(10, cy - radius); y <= Math.min(info.height - 11, cy + radius); y++) {
      for (let x = Math.max(10, cx - radius); x <= Math.min(info.width - 11, cx + radius); x++) {
        if (Math.hypot(x - cx, y - cy) > radius) continue;
        const value = x === 10 || y === 10 ||
          x === info.width - 11 || y === info.height - 11 ? 100 : 0;
        const index = x + y * info.width;
        if (data[index] !== value) { data[index] = value; changed = true; }
      }
    }
    if (changed) session.snapshot.gridRevision++;
    return changed;
  }

  function ingest(sample) {
    usable();
    const s = current;
    if (!s || typeof sample?.sourceEpoch !== 'string' ||
        !Number.isSafeInteger(sample.sourceSequence) || sample.sourceSequence < 0 ||
        !Number.isFinite(sample.observedMono) || sample.observedMono > now() ||
        !Number.isFinite(sample.velocity?.linearX) ||
        !Number.isFinite(sample.velocity?.angularZ)) return false;
    if (s.retired.has(sample.sourceEpoch)) return false;
    const previous = s.last;
    const cursor = previous || s.startCursor;
    if (cursor?.sourceEpoch === sample.sourceEpoch &&
        sample.sourceSequence <= cursor.sourceSequence) return false;
    if (previous && sample.observedMono <= previous.observedMono) return false;

    // Epoch mới hoặc gap nguồn không tạo chuyển động bù cho khoảng mất dữ liệu.
    const sameEpoch = previous?.sourceEpoch === sample.sourceEpoch;
    if (previous && !sameEpoch) s.retired.add(previous.sourceEpoch);
    const dt = sameEpoch ? (sample.observedMono - previous.observedMono) / 1000 : 0;
    if (dt > 0 && dt <= 0.25) {
      const { linearX: v, angularZ: w } = sample.velocity;
      const theta = s.pose.yaw;
      if (Math.abs(w) < 1e-9) {
        s.pose.x += v * dt * Math.cos(theta);
        s.pose.y += v * dt * Math.sin(theta);
      } else {
        s.pose.x += v / w * (Math.sin(theta + w * dt) - Math.sin(theta));
        s.pose.y -= v / w * (Math.cos(theta + w * dt) - Math.cos(theta));
      }
      s.pose.yaw = Math.atan2(Math.sin(theta + w * dt), Math.cos(theta + w * dt));
    }
    s.last = clone(sample);
    reveal(s);
    const wall = Date.parse(sample.observedAt);
    if (Number.isFinite(wall)) {
      s.snapshot.grid.header.stamp = {
        sec: Math.floor(wall / 1000), nanosec: (wall % 1000) * 1e6,
      };
    }
    for (const listener of [...listeners]) {
      try { listener(observation(s)); } catch { /* Một observer không ngắt producer. */ }
    }
    return true;
  }

  return {
    start(id, startCursor = null) {
      usable();
      if (typeof id !== 'string' || !id || current) throw fail('MAPPING_ACTIVE_OR_UNKNOWN');
      current = {
        id, startCursor: clone(startCursor), last: null, retired: new Set(),
        pose: { frameId: 'map', x: 2, y: 2, yaw: 0 },
        snapshot: {
          source: 'mock', mode: 'snapshot', encoding: 'occupancy-0-100-v1',
          context: { kind: 'mapping', mappingSessionId: id }, gridRevision: 1,
          grid: {
            header: { frame_id: 'map', stamp: { sec: 0, nanosec: 0 } },
            info: {
              map_load_time: { sec: 0, nanosec: 0 },
              width: 200, height: 160, resolution: 0.05,
              origin: {
                position: { x: 0, y: 0, z: 0 },
                orientation: { x: 0, y: 0, z: 0, w: 1 },
              },
            },
            data: new Array(200 * 160).fill(-1),
          },
        },
      };
    },
    ingest,
    get(id) { return observation(requireSession(id)); },
    stop(id) {
      if (current?.id !== id) return false;
      current = null;
      return true;
    },
    subscribe(listener) {
      usable();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() { current = null; listeners.clear(); disposed = true; },
  };
}
