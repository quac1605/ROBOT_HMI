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
import { MapGridSnapshotSchema, preflightMapGrid } from '../schemas/mapGrid.js';
import { NavigationJobEventSchema } from '../schemas/job.js';
import {
  ActivateMapResponseSchema, PreviewRouteResponseSchema, SaveRouteResponseSchema,
  ListRoutesResponseSchema, CreateMissionResponseSchema, GetMissionResponseSchema,
  GetActiveMissionResponseSchema, CancelMissionResponseSchema, MissionEventEnvelopeSchema,
  NavigationPathEnvelopeSchema, NavigationPathQuerySchema, preflightNavigationPath
} from '../schemas/mission.js';
import { navigationError } from '../utils/navigationPolicy.js';

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
  const subscriptions = new Set();
  const sharedRobotState = createSharedRobotState(initialState());
  const idempotency = createIdempotencyRegistry();
  const jobService = createMockJobService();
  const mapRepository = createMockMapRepository();
  const mapGridService = createMockMapGrid({ mapRepository });
  const telemetry = createMockTelemetry({ sharedRobotState });
  // Không chuyển job Chặng 6 sang service mới trong bản sửa này.
  const mappingService = createMockMappingService({
    sharedRobotState, mapGridService, mapRepository,
    onMappingStarted: () => telemetry.beginMappingSession(),
  });
  const mapActivationService = createMockMapActivationService({
    sharedRobotState, telemetry, jobService, mapRepository, idempotency,
  });
  const routeService = createMockRouteService({ jobService, mapRepository, idempotency });
  const missionService = createMockMissionService({ sharedRobotState, telemetry, mapRepository, idempotency });

  function requireUsable() {
    if (disposed) throw navigationError('CLIENT_DISPOSED', 'RobotClient đã dispose.');
  }
  function requireAuthenticated() {
    requireUsable();
    if (!user) throw navigationError('UNAUTHENTICATED', 'Yêu cầu đăng nhập.');
    return user.id;
  }
  async function validatedCall(schema, work) {
    const principalId = requireAuthenticated();
    const epoch = lifecycleEpoch;
    const raw = await work(principalId);
    requireAuthenticated();
    if (epoch !== lifecycleEpoch) throw navigationError('OPERATION_SUPERSEDED', 'Phản hồi thuộc phiên cũ.');
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
    // Producer/timer phải dừng trước khi xóa resource hoặc reset state.
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
      // A login attempt is not a session replacement. In particular a failed
      // re-login must not revoke subscriptions while the robot is navigating.
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
      missionService.dispose();
      mapActivationService.dispose();
      routeService.dispose();
      mappingService.dispose();
      mapGridService.dispose();
      jobService.dispose();
      idempotency.clear();
      telemetry.dispose();
      sharedRobotState.reset(initialState());
      user = null;
      persistUser(null);
    },
    _mapGridService: mapGridService, _mappingService: mappingService, _telemetry: telemetry,
    _mapRepository: mapRepository, _sharedRobotState: sharedRobotState, _jobService: jobService,
    _missionService: missionService, _routeService: routeService, _mapActivationService: mapActivationService,
  };
}
