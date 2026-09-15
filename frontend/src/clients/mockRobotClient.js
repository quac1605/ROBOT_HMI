import { createSharedRobotState } from './sharedRobotState.js';
import { createMockTelemetry } from './mockTelemetry.js';
import { createMockMapGrid } from './mockMapGrid.js';
import { createMockMappingService } from './mockMapping.js';
import { createMockMapRepository } from './mockMapRepository.js';
import {
  ListMapsResponseSchema,
  GetMapResponseSchema,
  GetActiveMappingSessionResponseSchema,
  StartMappingResponseSchema,
  FinishMappingResponseSchema,
  JobSchema,
} from '../schemas/mapping.js';
import { MapGridSnapshotSchema, preflightMapGrid } from '../schemas/mapGrid.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createInitialRobotSnapshot() {
  return {
    robotId: 'robot-01',
    mode: 'idle',
    rosConnected: true,
    localization: { status: 'tracking', reason: null },
    activeMap: { id: 'map-demo', revision: 'rev-1' },
    activeMappingSessionId: null,
    pose: { frameId: 'map', x: 4.12, y: 1.8, yaw: 0.415388 },
    poseSourceUpdateAgeMs: 0,
    velocity: { linearX: 0, angularZ: 0 },
    batteryPercent: 78,
    physicalEstopActive: false,
    receivedAt: new Date().toISOString(),
  };
}

export function createMockRobotClient() {
  let user = null;
  let disposed = false;
  let lifecycleEpoch = 0;
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem('mock_robot_client_user');
      if (stored) {
        user = JSON.parse(stored);
      }
    } catch {
      // ignore
    }
  }
  const activeSubscriptions = new Map();

  const sharedRobotState = createSharedRobotState(createInitialRobotSnapshot());

  const mapRepository = createMockMapRepository();
  const mapGridService = createMockMapGrid({ mapRepository });
  const telemetry = createMockTelemetry({ sharedRobotState });
  const mappingService = createMockMappingService({
    sharedRobotState,
    mapGridService,
    mapRepository,
    onMappingStarted: () => telemetry.beginMappingSession(),
  });

  function appError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function requireUsable() {
    if (disposed) {
      throw appError('CLIENT_DISPOSED', 'RobotClient đã bị hủy');
    }
  }

  function requireAuthenticated() {
    requireUsable();
    if (!user) {
      throw appError('UNAUTHENTICATED', 'Yêu cầu đăng nhập để thực hiện thao tác này');
    }
  }

  function clearStoredUser() {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.removeItem('mock_robot_client_user');
      } catch {
        // ignore
      }
    }
  }

  function closeAllSubscriptions() {
    activeSubscriptions.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch (err) {
        console.error('Lỗi khi hủy subscription:', err);
      }
    });
    activeSubscriptions.clear();
  }

  function resetUserWorkflow() {
    closeAllSubscriptions();
    mappingService.reset();
    telemetry.reset();
    sharedRobotState.reset(createInitialRobotSnapshot());
  }

  function registerSubscription(unsubFn) {
    requireUsable();
    const subId = `sub-${Math.random().toString(36).substring(2, 9)}`;
    activeSubscriptions.set(subId, unsubFn);
    return () => {
      if (activeSubscriptions.has(subId)) {
        unsubFn();
        activeSubscriptions.delete(subId);
      }
    };
  }

  return {
    kind: 'mock',
    async login({ username, password }) {
      requireUsable();
      const epoch = ++lifecycleEpoch;
      await delay(300);
      requireUsable();
      if (epoch !== lifecycleEpoch) {
        throw appError('AUTH_OPERATION_SUPERSEDED', 'Yêu cầu đăng nhập đã bị thay thế');
      }
      if (username !== 'admin' || password !== 'demo-only') {
        throw new Error('Sai tài khoản hoặc mật khẩu demo.');
      }
      user = { id: 'demo-admin', username: 'admin' };
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem('mock_robot_client_user', JSON.stringify(user));
        } catch {
          // ignore
        }
      }
      return { user: { ...user } };
    },
    async getSession() {
      requireUsable();
      if (!user && typeof window !== 'undefined') {
        try {
          const stored = window.localStorage.getItem('mock_robot_client_user');
          if (stored) {
            user = JSON.parse(stored);
          }
        } catch {
          // ignore
        }
      }
      return { user: user ? { ...user } : null };
    },
    async logout() {
      requireUsable();
      const epoch = ++lifecycleEpoch;
      await delay(100);
      if (disposed || epoch !== lifecycleEpoch) return;
      // Logout is a service boundary: revoke listeners, cancel unfinished jobs
      // and discard an unsaved mapping session before another user can log in.
      resetUserWorkflow();
      user = null;
      clearStoredUser();
    },

    // Telemetry - Bắt buộc xác thực
    async getRobotState() {
      requireAuthenticated();
      return sharedRobotState.getSnapshot();
    },
    subscribeRobotState(listener) {
      requireAuthenticated();
      const unsub = telemetry.subscribe(listener);
      return registerSubscription(unsub);
    },
    setDemoScenario(name) {
      requireAuthenticated();
      telemetry.setScenario(name);
    },
    getDemoScenario() {
      requireAuthenticated();
      return telemetry.getScenario();
    },
    // Chuyển tiếp options.subscriptionId xuống service
    subscribeMapGrid(context, listener, options = {}) {
      requireAuthenticated();
      const unsub = mapGridService.subscribeMapGrid(context, listener, options);
      return registerSubscription(unsub);
    },

    // 9 Phương thức của Chặng 6 có kiểm tra Auth & Validate Zod Schema
    async listMaps() {
      requireAuthenticated();
      const raw = await mappingService.listMaps();
      return ListMapsResponseSchema.parse(raw);
    },

    async getMap(mapId, revision) {
      requireAuthenticated();
      const raw = await mappingService.getMap(mapId, revision);
      return GetMapResponseSchema.parse(raw);
    },

    async getMapGrid(context) {
      requireAuthenticated();
      const raw = await mapGridService.getMapGrid(context);
      preflightMapGrid(raw);
      return MapGridSnapshotSchema.parse(raw);
    },

    async getActiveMappingSession() {
      requireAuthenticated();
      const raw = await mappingService.getActiveMappingSession();
      return GetActiveMappingSessionResponseSchema.parse(raw);
    },

    async startMapping(args) {
      requireAuthenticated();
      const raw = await mappingService.startMapping(args, user.id);
      return StartMappingResponseSchema.parse(raw);
    },

    async finishMapping(args) {
      requireAuthenticated();
      const raw = await mappingService.finishMapping(args, user.id);
      return FinishMappingResponseSchema.parse(raw);
    },

    subscribeJobs(listener) {
      requireAuthenticated();
      const unsub = mappingService.subscribeJobs(listener);
      return registerSubscription(unsub);
    },

    async getJob(jobId) {
      requireAuthenticated();
      const raw = await mappingService.getJob(jobId);
      return JobSchema.parse(raw);
    },

    dispose() {
      if (disposed) return;
      lifecycleEpoch += 1;
      closeAllSubscriptions();
      mappingService.dispose();
      mapGridService.dispose();
      telemetry.dispose();
      sharedRobotState.reset(createInitialRobotSnapshot());
      user = null;
      clearStoredUser();
      disposed = true;
    },

    _mapGridService: mapGridService,
    _mappingService: mappingService,
    _telemetry: telemetry,
    _mapRepository: mapRepository,
    _sharedRobotState: sharedRobotState,
  };
}
