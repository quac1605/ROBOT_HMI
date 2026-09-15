import { createMockRobotClient } from './mockRobotClient.js';
import { defaultRasterRuntime } from '../utils/rasterRuntime.js';
import { getActiveRasterDebugStates } from '../utils/occupancyRasterController.js';

const mode = import.meta.env.VITE_ROBOT_CLIENT;
if (mode !== 'mock') {
  throw new Error('Chặng này cần VITE_ROBOT_CLIENT=mock trong file .env.local');
}

// Khởi tạo Singleton client dùng chung xuyên suốt app
export const robotClient = createMockRobotClient();

const enableStage6Controls =
  import.meta.env.DEV &&
  import.meta.env.VITE_ENABLE_STAGE6_TEST_CONTROLS === 'true';

if (enableStage6Controls && typeof window !== 'undefined') {
  const controls = Object.freeze({
    setMapScenario: (sessionId, scenario) =>
      robotClient._mapGridService?.setSessionScenario(sessionId, scenario),
    advanceSourceStep: (sessionId) =>
      robotClient._mapGridService?.advanceSourceStep(sessionId),
    emitSessionNow: (sessionId) =>
      robotClient._mapGridService?.emitSessionNow(sessionId),
    getLiveSessionSnapshot: (sessionId) =>
      robotClient._mapGridService?.getLiveSessionSnapshot(sessionId),
    replaceLiveSessionGrid: (sessionId, snapshot) =>
      robotClient._mapGridService?.replaceLiveSessionGrid(sessionId, snapshot),
    getMapGridDebugState: () =>
      robotClient._mapGridService?.getDebugState(),
    failNextSaveForSession: (sessionId) =>
      robotClient._mappingService?.failNextSaveForSession(sessionId),
    getActiveMappingSession: () => robotClient.getActiveMappingSession(),
    getRobotState: () => robotClient.getRobotState(),
    listMaps: () => robotClient.listMaps(),
    getMapGrid: (context) => robotClient.getMapGrid(context),
    getJob: (jobId) => robotClient.getJob(jobId),
    startMapping: (request) => robotClient.startMapping(request),
    finishMapping: (request) => robotClient.finishMapping(request),
    setTelemetryScenario: (scenario) => robotClient.setDemoScenario(scenario),
    setTelemetryPose: (pose) => robotClient._telemetry?.setPose(pose),
    patchRobotState: (patch) => robotClient._sharedRobotState?.update(patch),
    setBlobDelayMs: (ms) => defaultRasterRuntime.setBlobDelayMs(ms),
    setBlobNullOnce: (flag = true) => defaultRasterRuntime.setBlobNullOnce(flag),
    setDecodeFailureOnce: (flag = true) =>
      defaultRasterRuntime.setDecodeFailureOnce(flag),
    getRasterCounters: () => defaultRasterRuntime.getCounters(),
    getRasterDebugStates: () => getActiveRasterDebugStates(),
    resetRasterCounters: () => defaultRasterRuntime.resetCounters(),
  });
  Object.defineProperty(window, '__STAGE6_TEST_CONTROLS__', {
    configurable: true,
    value: controls,
  });
}
