export function createMockTelemetry() {
  let scenario = 'online';
  let timer = null;
  let x = 4.12;
  const listeners = new Set();

  function getSnapshot() {
    const connected = scenario !== 'offline';
    return {
      robotId: 'robot-01',
      mode: 'idle',
      rosConnected: connected,
      localization: {
        status: !connected ? 'unknown' : scenario === 'lost' ? 'lost' : 'tracking',
        reason: scenario === 'lost' ? 'Tình huống giả lập mất định vị' : null,
      },
      activeMap: { id: 'map-demo', revision: 'rev-1' },
      pose: { frameId: 'map', x, y: 1.8, yaw: 0.415388 },
      velocity: { linearX: 0, angularZ: 0 },
      batteryPercent: scenario === 'unknown-battery' ? null : 78,
      activeMissionId: null,
      motionInhibited: scenario === 'lost' || !connected,
      motionInhibitReason: scenario === 'lost' ? 'LOCALIZATION_LOST' : !connected ? 'ROS_UNAVAILABLE' : null,
      physicalEstopActive: false,
      sourceStamp: null,
      receivedAt: new Date().toISOString(),
    };
  }

  function emit() {
    if (scenario === 'stale') return;
    const snapshot = getSnapshot();
    listeners.forEach((listener) => listener(structuredClone(snapshot)));
  }

  function subscribe(listener) {
    listeners.add(listener);
    if (scenario !== 'stale') listener(getSnapshot());
    if (!timer) timer = setInterval(emit, 200);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }

  return {
    getSnapshot,
    subscribe,
    getScenario() {
      return scenario;
    },
    setScenario(next) {
      const valid = ['online', 'offline', 'stale', 'lost', 'unknown-battery'];
      if (!valid.includes(next)) throw new Error('Scenario không hợp lệ');
      scenario = next;
      emit();
    },
    setPositionX(nextX) { x = nextX; emit(); },
  };
}