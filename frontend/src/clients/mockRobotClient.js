import { createSharedRobotState } from './sharedRobotState.js';
import { createMockTelemetry } from './mockTelemetry.js';
import { createMockMapGrid } from './mockMapGrid.js';
import { createMockMappingService } from './mockMapping.js';
import { createMockMapRepository } from './mockMapRepository.js';
import { createIdempotencyRegistry } from '../utils/idempotencyRegistry.js';
import { createMockJobService } from './mockJobs.js';
import { createMockMapActivationService } from './mockMapActivation.js';
import { createMockRouteService } from './mockRoutes.js';
import { createMockMissionService } from './mockMissions.js';
import { RobotStateSchema } from '../schemas/robotState.js';
import {
  ListMapsResponseSchema, GetMapResponseSchema, GetActiveMappingSessionResponseSchema,
  StartMappingResponseSchema, FinishMappingResponseSchema, JobSchema
} from '../schemas/mapping.js';
import {
  AcquireControlRequestSchema, AcquireControlResponseSchema,
  ReleaseControlRequestSchema, ReleaseControlResponseSchema,
  RequestStopRequestSchema, RequestStopResponseSchema,
  TeleopVelocityMessageSchema, ControlEventEnvelopeSchema,
  GetControlStateResponseSchema,
} from '../schemas/control.js';
import {
  CameraQuerySchema, ListCamerasResponseSchema,
  GetCameraStreamResponseSchema,
} from '../schemas/camera.js';
import { createMockMotionSource } from './mockMotionSource.js';
import { MapGridSnapshotSchema, preflightMapGrid } from '../schemas/mapGrid.js';
import { NavigationJobEventSchema } from '../schemas/job.js';
import {
  ActivateMapResponseSchema, PreviewRouteResponseSchema, SaveRouteResponseSchema,
  ListRoutesResponseSchema, CreateMissionResponseSchema, GetMissionResponseSchema,
  GetActiveMissionResponseSchema, CancelMissionResponseSchema, MissionEventEnvelopeSchema,
  NavigationPathEnvelopeSchema, NavigationPathQuerySchema, preflightNavigationPath
} from '../schemas/mission.js';
import { navigationError } from '../utils/navigationPolicy.js';
import { createMotionAdmissionGate } from '../utils/motionAdmissionGate.js';
import { createMockCameraService } from './mockCamera.js';
import { createMockControlService } from './mockControl.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function initialState() {
  return {
    robotId: 'robot-01', mode: 'idle', rosConnected: true,
    localization: { status: 'tracking', reason: null },
    activeMap: { id: 'map-demo', revision: 'rev-1' },
    activeMappingSessionId: null, activeMissionId: null,
    motionInhibited: false, motionInhibitReason: null,
    pose: { frameId: 'map', x: 4.12, y: 1.8, yaw: 0.415388 },
    poseSourceUpdateAgeMs: 0, velocity: { linearX: 0, angularZ: 0 },
    batteryPercent: 78, physicalEstopActive: false, receivedAt: new Date().toISOString(),
  };
}
function loadUser() {
  try {
    if (typeof window === 'undefined') return null;
    const stored = JSON.parse(window.localStorage.getItem('mock_robot_client_user') || 'null');
    return stored?.id === 'demo-admin' && stored?.username === 'admin' ? stored : null;
  } catch { return null; }
}
function persistUser(user) {
  try {
    if (typeof window === 'undefined') return;
    if (user) window.localStorage.setItem('mock_robot_client_user', JSON.stringify(user));
    else window.localStorage.removeItem('mock_robot_client_user');
  } catch { /* Storage có thể bị browser chặn; auth in-memory vẫn dùng được. */ }
}

export function createMockRobotClient() {
  let user = loadUser();
  let disposed = false;
  let lifecycleEpoch = 0;
  let loginSequence = 0;
  let controlSessionId = null; // Session nội bộ của client hiện tại
  const subscriptions = new Set();
  const sharedRobotState = createSharedRobotState(initialState());
  const idempotency = createIdempotencyRegistry();
  const jobService = createMockJobService();
  const mapRepository = createMockMapRepository();
  const mapGridService = createMockMapGrid({ mapRepository });

  // 1. Motion Gate dùng CHUNG cho toàn bộ hệ thống
  const motionGate = createMotionAdmissionGate();

  // 2. Motion Source mô phỏng cảm biến vận tốc độc lập
  let telemetryInstance = null;
  const motionSource = createMockMotionSource({
    sourceHealthy: () => {
      if (!telemetryInstance) return false;
      const state = telemetryInstance.getControlState();
      return !state.transportStale && (state.snapshot.connected === true || state.snapshot.rosConnected === true);
    },
  });

  // 3. Telemetry nhận motionSource
  const telemetry = createMockTelemetry({ sharedRobotState, motionSource });
  telemetryInstance = telemetry;
  motionSource.sample();

  // 4. Các dịch vụ bản đồ, định vị và nhiệm vụ nhận motionGate
  const mappingService = createMockMappingService({
    sharedRobotState, mapGridService, mapRepository,
    onMappingStarted: () => telemetry.beginMappingSession(),
  });
  const mapActivationService = createMockMapActivationService({
    sharedRobotState, telemetry, jobService, mapRepository, idempotency, motionGate,
  });
  const routeService = createMockRouteService({ jobService, mapRepository, idempotency });
  const missionService = createMockMissionService({
    sharedRobotState, telemetry, mapRepository, idempotency, motionGate, motionSource,
  });

  const cameraService = createMockCameraService();

  // 5. Control Service nhận cả motionGate và motionSource
  const controlService = createMockControlService({
    sharedRobotState, telemetry, missionService, mapActivationService, motionGate, motionSource,
  });

  // 6. Cấp session cho user đã lưu sẵn (nếu có) sau khi controlService đã tồn tại
  if (user) {
    controlSessionId = controlService.createSession();
  }

  function requireUsable() {
    if (disposed) throw navigationError('CLIENT_DISPOSED', 'RobotClient đã dispose.');
  }
  function requireAuthenticated() {
    requireUsable();
    if (!user) throw navigationError('UNAUTHENTICATED', 'Yêu cầu đăng nhập.');
    return user.id;
  }
  function requireControlSession() {
    requireAuthenticated();
    if (!controlSessionId) {
      throw navigationError('UNAUTHENTICATED', 'Chưa có phiên điều khiển.');
    }
    return controlSessionId;
  }
  async function validatedCall(schema, work) {
    const principalId = requireAuthenticated();
    const epoch = lifecycleEpoch;
    const raw = await work(principalId);
    requireAuthenticated();
    if (epoch !== lifecycleEpoch) throw navigationError('OPERATION_SUPERSEDED', 'Phản hồi thuộc phiên cũ.');
    return schema.parse(raw);
  }
  async function controlCall(schema, work) {
    const sid = requireControlSession();
    const epoch = lifecycleEpoch;
    const raw = await work(sid);
    requireControlSession();
    if (epoch !== lifecycleEpoch || sid !== controlSessionId) {
      throw navigationError('OPERATION_SUPERSEDED', 'Phản hồi thuộc phiên cũ.');
    }
    return schema.parse(raw);
  }
  function register(factory) {
    requireAuthenticated();
    const epoch = lifecycleEpoch;
    let closed = false;
    const unsubscribe = factory(() => !closed && !disposed && epoch === lifecycleEpoch && Boolean(user));
    const close = () => {
      if (closed) return;
      closed = true;
      subscriptions.delete(close);
      unsubscribe();
    };
    subscriptions.add(close);
    return close;
  }
  function closeAllSubscriptions() {
    for (const close of [...subscriptions]) close();
  }
  function resetUserWorkflow() {
    closeAllSubscriptions();
    if (controlSessionId) {
      controlService.revokeSession(controlSessionId);
      controlSessionId = null;
    }
    missionService.clear();
    mapActivationService.clear();
    routeService.clear();
    mappingService.reset();
    idempotency.clear();
    jobService.clear();
    telemetry.reset();
    sharedRobotState.reset(initialState());
  }

  return {
    kind: 'mock',
    async login({ username, password }) {
      requireUsable();
      const attempt = ++loginSequence;
      const epoch = lifecycleEpoch;
      await delay(300);
      requireUsable();
      if (attempt !== loginSequence || epoch !== lifecycleEpoch) {
        throw navigationError('AUTH_OPERATION_SUPERSEDED', 'Login đã bị thay thế.');
      }
      if (username !== 'admin' || password !== 'demo-only') throw new Error('Sai tài khoản hoặc mật khẩu demo.');
      if (!user) lifecycleEpoch += 1;
      user = { id: 'demo-admin', username: 'admin' };
      persistUser(user);
      if (!controlSessionId) {
        controlSessionId = controlService.createSession();
      }
      return { user: { ...user } };
    },
    async getSession() { requireUsable(); return { user: user ? { ...user } : null }; },
    async logout() {
      requireUsable();
      loginSequence += 1;
      lifecycleEpoch += 1;
      user = null;
      persistUser(null);
      resetUserWorkflow();
      await delay(100);
    },
    getRobotState() { return validatedCall(RobotStateSchema, () => sharedRobotState.getSnapshot()); },
    subscribeRobotState(listener) {
      return register(active => telemetry.subscribe(raw => { if (active()) listener(RobotStateSchema.parse(raw)); }));
    },
    setDemoScenario(name) { requireAuthenticated(); telemetry.setScenario(name); },
    getDemoScenario() { requireAuthenticated(); return telemetry.getScenario(); },
    setDemoMissionScenario(name) { requireAuthenticated(); missionService.setScenario(name); },
    listMaps() { return validatedCall(ListMapsResponseSchema, () => mappingService.listMaps()); },
    getMap(id, revision) { return validatedCall(GetMapResponseSchema, () => mappingService.getMap(id, revision)); },
    getMapGrid(context) {
      return validatedCall(MapGridSnapshotSchema, async () => {
        const raw = await mapGridService.getMapGrid(context);
        preflightMapGrid(raw);
        return raw;
      });
    },
    subscribeMapGrid(context, listener, options = {}) {
      return register(active => mapGridService.subscribeMapGrid(context, event => {
        if (active()) listener(event);
      }, options));
    },
    getActiveMappingSession() {
      return validatedCall(GetActiveMappingSessionResponseSchema, () => mappingService.getActiveMappingSession());
    },
    startMapping(args) { return validatedCall(StartMappingResponseSchema, principal => mappingService.startMapping(args, principal)); },
    finishMapping(args) { return validatedCall(FinishMappingResponseSchema, principal => mappingService.finishMapping(args, principal)); },
    subscribeJobs(listener) {
      return register(active => {
        const first = mappingService.subscribeJobs(raw => { if (active()) listener(JobSchema.parse(raw)); });
        const second = jobService.subscribeJobs(raw => { if (active()) listener(NavigationJobEventSchema.parse(raw)); });
        return () => { first(); second(); };
      });
    },
    getJob(jobId) {
      return validatedCall(JobSchema, async () => {
        try { return await mappingService.getJob(jobId); }
        catch (error) {
          if (error.code !== 'JOB_NOT_FOUND') throw error;
          return jobService.getJob(jobId);
        }
      });
    },
    activateMap(args) { return validatedCall(ActivateMapResponseSchema, principal => mapActivationService.activateMap(args, principal)); },
    previewRoute(args) { return validatedCall(PreviewRouteResponseSchema, principal => routeService.previewRoute(args, principal)); },
    saveRoute(args) { return validatedCall(SaveRouteResponseSchema, principal => routeService.saveRoute(args, principal)); },
    listRoutes(query) { return validatedCall(ListRoutesResponseSchema, () => routeService.listRoutes(query)); },
    createMission(args) { return validatedCall(CreateMissionResponseSchema, principal => missionService.createMission(args, principal)); },
    getMission(id) { return validatedCall(GetMissionResponseSchema, () => missionService.getMission(id)); },
    getActiveMission() { return validatedCall(GetActiveMissionResponseSchema, () => missionService.getActiveMission()); },
    cancelMission(args) { return validatedCall(CancelMissionResponseSchema, principal => missionService.cancelMission(args, principal)); },
    subscribeMissions(listener) {
      return register(active => missionService.subscribeMissions(raw => {
        if (active()) listener(MissionEventEnvelopeSchema.parse(raw));
      }));
    },
    subscribeNavigationPath(query, listener) {
      requireAuthenticated();
      const checked = NavigationPathQuerySchema.parse(query);
      return register(active => missionService.subscribeNavigationPath(checked, raw => {
        if (!active()) return;
        preflightNavigationPath(raw);
        listener(NavigationPathEnvelopeSchema.parse(raw));
      }));
    },
    dispose() {
      if (disposed) return;
      loginSequence += 1;
      lifecycleEpoch += 1;
      disposed = true;
      closeAllSubscriptions();
      if (controlSessionId) {
        controlService.revokeSession(controlSessionId);
        controlSessionId = null;
      }
      missionService.dispose();
      mapActivationService.dispose();
      routeService.dispose();
      mappingService.dispose();
      mapGridService.dispose();
      jobService.dispose();
      controlService.dispose();
      motionSource.dispose();
      telemetry.dispose();
      idempotency.clear();
      sharedRobotState.reset(initialState());
      user = null;
      persistUser(null);
    },
    // Camera API
    listCameras() {
      return validatedCall(ListCamerasResponseSchema, () => cameraService.listCameras());
    },
    getCameraStream(raw) {
      return validatedCall(GetCameraStreamResponseSchema,
        () => cameraService.getCameraStream(CameraQuerySchema.parse(raw)));
    },

    // Control API
    acquireControl(raw) {
      return controlCall(AcquireControlResponseSchema,
        sid => controlService.acquireControl(AcquireControlRequestSchema.parse(raw), sid));
    },
    releaseControl(raw) {
      return controlCall(ReleaseControlResponseSchema,
        sid => controlService.releaseControl(ReleaseControlRequestSchema.parse(raw), sid));
    },
    requestStop(raw) {
      return controlCall(RequestStopResponseSchema,
        sid => controlService.requestStop(RequestStopRequestSchema.parse(raw), sid));
    },
    sendVelocity(raw) {
      const sid = requireControlSession();
      controlService.sendVelocity(TeleopVelocityMessageSchema.parse(raw), sid);
      // Synchronous void return - Không async / không return Promise
    },
    subscribeControl(listener) {
      const sid = requireControlSession();
      return register(active => controlService.subscribeControl(sid, raw => {
        if (active()) listener(ControlEventEnvelopeSchema.parse(raw));
      }));
    },
    getControlState() {
      return controlCall(GetControlStateResponseSchema,
        sid => controlService.getControlState(sid));
    },

    controlProfile: 'mock',

    _mapGridService: mapGridService, _mappingService: mappingService, _telemetry: telemetry,
    _mapRepository: mapRepository, _sharedRobotState: sharedRobotState, _jobService: jobService,
    _missionService: missionService, _routeService: routeService, _mapActivationService: mapActivationService,
    _motionSource: motionSource, _controlService: controlService, _motionGate: motionGate,
    _subscriptions: subscriptions,
  };
}
