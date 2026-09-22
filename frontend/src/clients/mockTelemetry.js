import { navigationError } from '../utils/navigationPolicy.js';

// Đây là nguồn pose mô phỏng CHUNG. Mission/activation phải dùng commitPose(),
// không tự cập nhật pose rồi để telemetry phát lại một vị trí khác.
export function createMockTelemetry({ sharedRobotState }) {
  const initialPose = { frameId: 'map', x: 4.12, y: 1.8, yaw: 0.415388 };
  const contextKey = state => state.activeMappingSessionId
    ? JSON.stringify(['mapping', state.activeMappingSessionId])
    : JSON.stringify(['saved', state.activeMap?.id, state.activeMap?.revision]);
  let sourcePose = structuredClone(sharedRobotState.getSnapshot().pose || initialPose);
  let sourceContext = contextKey(sharedRobotState.getSnapshot());
  let lastSourceUpdateAt = performance.now();
  let scenario = 'online';
  let timer = null;
  let disposed = false;
  const subscribers = new Set();

  function assertActive() {
    if (disposed) throw navigationError('SERVICE_DISPOSED', 'Telemetry đã dispose.');
  }

  function derive() {
    const state = sharedRobotState.getSnapshot();
    const connected = scenario !== 'offline';
    const lost = scenario === 'lost';
    const freshSource = ['online', 'unknown-battery'].includes(scenario);
    const hasContext = state.mode === 'mapping'
      ? Boolean(state.activeMappingSessionId)
      : Boolean(state.activeMap && !state.activeMappingSessionId && state.mode !== 'localizing');
    const hasPose = connected && !lost && hasContext && sourceContext === contextKey(state);
    const ownReasons = ['LOCALIZATION_LOST', 'ROS_UNAVAILABLE'];
    const externalInhibit = Boolean(state.motionInhibited && !ownReasons.includes(state.motionInhibitReason));
    return {
      ...state,
      rosConnected: connected,
      localization: {
        status: !connected || !hasContext ? 'unknown' : lost ? 'lost' : 'tracking',
        reason: lost ? 'Tình huống giả lập mất định vị' : null,
      },
      motionInhibited: externalInhibit || lost || !connected,
      motionInhibitReason: externalInhibit ? state.motionInhibitReason
        : lost ? 'LOCALIZATION_LOST' : !connected ? 'ROS_UNAVAILABLE' : null,
      batteryPercent: scenario === 'unknown-battery' ? null : 78,
      pose: hasPose ? structuredClone(sourcePose) : null,
      poseSourceUpdateAgeMs: hasPose
        ? freshSource ? 0 : Math.max(0, Math.round(performance.now() - lastSourceUpdateAt))
        : null,
    };
  }

  function emit() {
    if (disposed || scenario === 'stale') return;
    if (['online', 'unknown-battery'].includes(scenario)) lastSourceUpdateAt = performance.now();
    sharedRobotState.update({ ...derive(), receivedAt: new Date().toISOString() });
  }

  function subscribe(listener) {
    assertActive();
    const unsubscribe = sharedRobotState.subscribe(listener);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      subscribers.delete(close);
      unsubscribe();
      if (!subscribers.size && timer) { clearInterval(timer); timer = null; }
    };
    subscribers.add(close);
    if (!timer) {
      timer = setInterval(emit, 200);
      timer.unref?.();
    }
    return close;
  }

  return {
    subscribe,
    getSnapshot: () => sharedRobotState.getSnapshot(),
    getScenario: () => scenario,
    // Dùng clock/source thật của mock, không tin tuổi pose do UI giữ lại.
    getControlState() {
      assertActive();
      return { snapshot: derive(), transportStale: scenario === 'stale' };
    },
    commitPose(pose, robotPatch = {}) {
      assertActive();
      // Fault injection freezes the localization SOURCE, even while a mission
      // proposes new positions. A command is not a confirmed pose sample.
      // Caller must not commit progress/activation when confirmation is absent.
      if (scenario === 'pose-heartbeat') return false;
      sourcePose = { frameId: 'map', ...structuredClone(pose) };
      sourceContext = contextKey({ ...sharedRobotState.getSnapshot(), ...robotPatch });
      lastSourceUpdateAt = performance.now();
      sharedRobotState.update({
        ...robotPatch, pose: structuredClone(sourcePose), poseSourceUpdateAgeMs: 0,
        receivedAt: new Date().toISOString(),
      });
      return true;
    },
    setScenario(next) {
      assertActive();
      if (!['online', 'offline', 'lost', 'stale', 'unknown-battery', 'pose-heartbeat'].includes(next)) {
        throw navigationError('INVALID_SCENARIO', 'Scenario không hợp lệ.');
      }
      scenario = next;
      emit();
    },
    setPose(next) {
      assertActive();
      if (next) sourcePose = { frameId: 'map', ...structuredClone(next) };
      sourceContext = contextKey(sharedRobotState.getSnapshot());
      lastSourceUpdateAt = performance.now();
      emit();
    },
    setPositionX(x) { this.setPose({ ...sourcePose, x }); },
    beginMappingSession() {
      assertActive();
      sourcePose = { frameId: 'map', x: 2, y: 2, yaw: 0 };
      sourceContext = contextKey(sharedRobotState.getSnapshot());
      lastSourceUpdateAt = performance.now();
      // Không emit trước khi mapping service xác nhận mode='mapping'.
    },
    reset() {
      if (disposed) return;
      for (const close of [...subscribers]) close();
      if (timer) clearInterval(timer);
      timer = null;
      scenario = 'online';
      sourcePose = structuredClone(initialPose);
      sourceContext = JSON.stringify(['saved', 'map-demo', 'rev-1']);
      lastSourceUpdateAt = performance.now();
    },
    dispose() { this.reset(); disposed = true; },
  };
}
