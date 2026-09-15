export function createMockTelemetry({ sharedRobotState }) {
  const initialPose = { frameId: 'map', x: 4.12, y: 1.8, yaw: 0.415388 };
  let scenario = 'online';
  let timer = null;
  let x = initialPose.x;
  let y = initialPose.y;
  let yaw = initialPose.yaw;
  let lastPoseSourceUpdateAt = performance.now();
  let disposed = false;
  const subscribers = new Set();

  function assertActive() {
    if (disposed) {
      const err = new Error('Telemetry service đã bị hủy');
      err.code = 'SERVICE_DISPOSED';
      throw err;
    }
  }

  function updateTelemetry() {
    const connected = scenario !== 'offline';
    const state = sharedRobotState.getSnapshot();

    const hasLiveContext = state.mode === 'mapping' && Boolean(state.activeMappingSessionId);
    const hasSavedContext = Boolean(state.activeMap?.id && state.activeMap?.revision);
    const canPublishPose = connected && scenario !== 'lost' && (hasLiveContext || hasSavedContext);

    let pose = null;
    let poseSourceUpdateAgeMs = null;

    if (canPublishPose) {
      pose = { frameId: 'map', x, y, yaw };
      poseSourceUpdateAgeMs = lastPoseSourceUpdateAt != null
        ? Math.round(performance.now() - lastPoseSourceUpdateAt)
        : null;
    }

    sharedRobotState.update({
      rosConnected: connected,
      localization: {
        status: !connected ? 'unknown' : scenario === 'lost' ? 'lost' : 'tracking',
        reason: scenario === 'lost' ? 'Tình huống giả lập mất định vị' : null,
      },
      batteryPercent: scenario === 'unknown-battery' ? null : 78,
      motionInhibited: scenario === 'lost' || !connected,
      motionInhibitReason: scenario === 'lost' ? 'LOCALIZATION_LOST' : !connected ? 'ROS_UNAVAILABLE' : null,
      pose,
      poseSourceUpdateAgeMs,
      receivedAt: new Date().toISOString(),
    });
  }

  function emit() {
    if (disposed || scenario === 'stale') return;
    // online/unknown-battery mô phỏng sample pose thật. pose-heartbeat chỉ
    // chuyển transport heartbeat nên tuổi nguồn pose phải tiếp tục tăng.
    if (scenario === 'online' || scenario === 'unknown-battery') {
      lastPoseSourceUpdateAt = performance.now();
    }
    updateTelemetry();
  }

  function subscribe(listener) {
    assertActive();
    const unsubscribeSharedState = sharedRobotState.subscribe(listener);
    const subscriber = {
      closed: false,
      close() {
        if (subscriber.closed) return;
        subscriber.closed = true;
        subscribers.delete(subscriber);
        unsubscribeSharedState();
        if (subscribers.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      },
    };
    subscribers.add(subscriber);

    if (!timer) {
      timer = setInterval(emit, 200);
      if (timer?.unref) timer.unref();
    }

    return () => subscriber.close();
  }

  return {
    getSnapshot: () => sharedRobotState.getSnapshot(),
    subscribe,
    getScenario: () => scenario,
    setScenario(next) {
      assertActive();
      const valid = ['online', 'offline', 'stale', 'lost', 'unknown-battery', 'pose-heartbeat'];
      if (!valid.includes(next)) throw new Error('Scenario không hợp lệ');
      scenario = next;
      if (next === 'online') {
        lastPoseSourceUpdateAt = performance.now();
      }
      emit();
    },
    setPositionX(nextX) {
      assertActive();
      x = nextX;
      lastPoseSourceUpdateAt = performance.now();
      emit();
    },
    setPose(nextPose) {
      assertActive();
      if (nextPose) {
        x = nextPose.x;
        y = nextPose.y;
        yaw = nextPose.yaw;
        lastPoseSourceUpdateAt = performance.now();
      }
      emit();
    },

    beginMappingSession() {
      assertActive();
      // A mapping session owns a new pose source.  Do not carry the position
      // cached for the previously active saved map into this context.
      x = 2.0;
      y = 2.0;
      yaw = 0;
      lastPoseSourceUpdateAt = performance.now();
    },

    reset() {
      if (disposed) return;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      for (const subscriber of [...subscribers]) subscriber.close();
      scenario = 'online';
      x = initialPose.x;
      y = initialPose.y;
      yaw = initialPose.yaw;
      lastPoseSourceUpdateAt = performance.now();
    },

    dispose() {
      if (disposed) return;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      for (const subscriber of [...subscribers]) subscriber.close();
      disposed = true;
    },
  };
}
