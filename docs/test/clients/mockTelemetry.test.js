import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockTelemetry } from '../../../frontend/src/clients/mockTelemetry.js';
import { createSharedRobotState } from '../../../frontend/src/clients/sharedRobotState.js';

function initialState() {
  return {
    robotId: 'robot-test',
    mode: 'idle',
    rosConnected: true,
    localization: { status: 'tracking', reason: null },
    activeMap: { id: 'map-test', revision: 'rev-1' },
    activeMappingSessionId: null,
    pose: { frameId: 'map', x: 1, y: 1, yaw: 0 },
    poseSourceUpdateAgeMs: 0,
    velocity: { linearX: 0, angularZ: 0 },
    batteryPercent: 100,
    physicalEstopActive: false,
    receivedAt: new Date().toISOString(),
  };
}

test('pose heartbeat cập nhật receipt nhưng không làm mới tuổi nguồn pose', async () => {
  const shared = createSharedRobotState(initialState());
  const telemetry = createMockTelemetry({ sharedRobotState: shared });
  const unsubscribe = telemetry.subscribe(() => {});

  telemetry.setScenario('online');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const fresh = shared.getSnapshot();
  assert.ok(fresh.poseSourceUpdateAgeMs < 150);

  telemetry.setScenario('pose-heartbeat');
  const heartbeatStart = shared.getSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 450));
  const heartbeatLater = shared.getSnapshot();
  assert.notEqual(heartbeatLater.receivedAt, heartbeatStart.receivedAt);
  assert.ok(heartbeatLater.poseSourceUpdateAgeMs >= heartbeatStart.poseSourceUpdateAgeMs + 300);

  telemetry.setScenario('online');
  const recovered = shared.getSnapshot();
  assert.ok(recovered.poseSourceUpdateAgeMs < 100);

  unsubscribe();
  telemetry.dispose();
});

test('beginMappingSession đặt lại pose source thay vì dùng tọa độ saved-map cũ', () => {
  const shared = createSharedRobotState(initialState());
  shared.update({ mode: 'mapping', activeMap: null, activeMappingSessionId: 'sess-new' });
  const telemetry = createMockTelemetry({ sharedRobotState: shared });
  telemetry.beginMappingSession();
  telemetry.setScenario('online');

  assert.deepEqual(shared.getSnapshot().pose, {
    frameId: 'map',
    x: 2,
    y: 2,
    yaw: 0,
  });
  telemetry.dispose();
});
