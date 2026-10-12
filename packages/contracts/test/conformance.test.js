import test from 'node:test';
import assert from 'node:assert/strict';

import { RobotStateSchema } from '../src/robotState.js';
import {
  CameraQuerySchema,
  GetCameraStreamResponseSchema,
  ListCamerasResponseSchema,
} from '../src/camera.js';
import { JobSchema, NavigationJobEventSchema } from '../src/job.js';
import {
  FinishMappingRequestSchema,
  FinishMappingResponseSchema,
  GetActiveMappingSessionResponseSchema,
  GetMapResponseSchema,
  ListMapsResponseSchema,
  StartMappingRequestSchema,
  StartMappingResponseSchema,
} from '../src/mapping.js';
import {
  ActivateMapRequestSchema,
  ActivateMapResponseSchema,
  CancelMissionRequestSchema,
  CancelMissionResponseSchema,
  CreateMissionResponseSchema,
  GetActiveMissionResponseSchema,
  GetMissionResponseSchema,
  ListRoutesQuerySchema,
  ListRoutesResponseSchema,
  MissionEventEnvelopeSchema,
  MissionRequestSchema,
  NavigationPathEnvelopeSchema,
  NavigationPathQuerySchema,
  PreviewRouteRequestSchema,
  PreviewRouteResponseSchema,
  SaveRouteRequestSchema,
  SaveRouteResponseSchema,
} from '../src/mission.js';
import {
  AcquireControlRequestSchema,
  AcquireControlResponseSchema,
  ControlEventEnvelopeSchema,
  ControlHeartbeatSchema,
  ControlSnapshotSchema,
  GetControlStateResponseSchema,
  ReleaseControlRequestSchema,
  ReleaseControlResponseSchema,
  RequestStopRequestSchema,
  RequestStopResponseSchema,
  StopConfirmationSchema,
  TeleopVelocityMessageSchema,
} from '../src/control.js';
import {
  MapGridEventEnvelopeSchema,
  MapGridSnapshotSchema,
  parseMapGridSnapshot,
} from '../src/mapGrid.js';

const iso = '2030-01-02T03:04:05.000Z';
const requestId = '00000000-0000-4000-8000-000000000001';

function accepts(schema, value, label) {
  const result = schema.safeParse(value);
  assert.equal(result.success, true, result.success ? label : `${label}: ${result.error}`);
}

function rejects(schema, value, label) {
  assert.equal(schema.safeParse(value).success, false, label);
}

const robotState = {
  robotId: 'robot-1',
  mode: 'idle',
  rosConnected: true,
  localization: { status: 'tracking', reason: null },
  pose: { frameId: 'map', x: 1, y: 2, yaw: 0 },
  poseSourceUpdateAgeMs: 10,
  velocity: { linearX: 0, angularZ: 0 },
  batteryPercent: 80,
  physicalEstopActive: false,
  motionInhibited: false,
  motionInhibitReason: null,
  receivedAt: iso,
  activeMap: { id: 'map-1', revision: 'rev-1' },
  activeMappingSessionId: null,
  activeMissionId: null,
};

const mapMetadata = {
  id: 'map-1',
  revision: 'rev-1',
  name: 'Kho A',
  status: 'ready',
  frameId: 'map',
  width: 2,
  height: 2,
  resolution: 0.05,
  origin: { x: 0, y: 0, yaw: 0 },
  assets: [
    { type: 'grid_json', source: 'mock', storage: 'memory', status: 'ready' },
  ],
  capabilities: {
    hasOccupancyGrid: true,
    hasSlamState: false,
    canResumeMapping: false,
    canLocalize: true,
    canNavigate: true,
  },
  createdAt: iso,
};

const mappingSession = {
  mappingSessionId: 'mapping-1',
  name: 'Kho A',
  status: 'mapping',
  startedAt: iso,
};

const missionPose = { frameId: 'map', x: 1, y: 2, yaw: 0 };
const mission = {
  missionId: 'mission-1',
  requestId,
  kind: 'navigate_to_pose',
  mapId: 'map-1',
  mapRevision: 'rev-1',
  poses: [missionPose],
  status: 'executing',
  currentPoseIndex: 0,
  distanceRemainingM: 1.5,
  error: null,
  createdAt: iso,
  updatedAt: iso,
};

const route = {
  routeId: 'route-1',
  name: 'Tuyến A',
  mapId: 'map-1',
  mapRevision: 'rev-1',
  poses: [missionPose],
  createdAt: iso,
};

const lease = {
  leaseId: 'lease-1',
  expiresAt: iso,
  limits: { maxLinearX: 0.2, maxAngularZ: 0.5 },
  controlGeneration: 1,
};

const heartbeat = {
  leaseId: 'lease-1',
  controlGeneration: 1,
  leaseExpiresAt: iso,
  leaseRemainingMs: 1000,
  freshnessToken: 'token-1',
  tokenExpiresAt: iso,
  tokenValidForMs: 500,
};

const stopConfirmation = {
  requestId: 'stop-1',
  controlGeneration: 1,
  evidenceKind: 'mock-source-observation',
  sourceEpoch: 'source-1',
  sourceSequence: 2,
  observedAt: iso,
  velocity: { linearX: 0, angularZ: 0 },
};

const controlSnapshot = {
  controlGeneration: 1,
  ownership: 'self',
  lease,
  heartbeat,
  stop: {
    requestId: 'stop-1',
    controlGeneration: 1,
    status: 'confirmed',
    confirmation: stopConfirmation,
  },
};

const mapGridSnapshot = {
  source: 'mock',
  mode: 'snapshot',
  encoding: 'occupancy-0-100-v1',
  context: { kind: 'saved', mapId: 'map-1', mapRevision: 'rev-1' },
  gridRevision: 1,
  grid: {
    header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
    info: {
      map_load_time: { sec: 1, nanosec: 0 },
      resolution: 0.05,
      width: 2,
      height: 2,
      origin: {
        position: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    },
    data: [-1, 0, 50, 100],
  },
};

const streamHeader = {
  version: 1,
  streamEpoch: 'stream-1',
  sequence: 1,
  sentAt: iso,
};

test('M1-CONTRACT-01: robot state và camera request/response có fixture hai chiều', () => {
  accepts(RobotStateSchema, robotState, 'robot state hợp lệ');
  rejects(RobotStateSchema, { ...robotState, unexpected: true }, 'robot state phải strict');

  accepts(CameraQuerySchema, { cameraId: 'front' }, 'camera query hợp lệ');
  rejects(CameraQuerySchema, { cameraId: 'front', source: 'user' }, 'camera query không nhận field lạ');

  const cameras = [
    { cameraId: 'front', label: 'Camera trước', position: 'front', available: true },
    { cameraId: 'rear', label: 'Camera sau', position: 'rear', available: true },
  ];
  accepts(ListCamerasResponseSchema, cameras, 'camera list hợp lệ');
  rejects(ListCamerasResponseSchema, [cameras[0], cameras[0]], 'camera list không nhận ID trùng');

  accepts(GetCameraStreamResponseSchema,
    { kind: 'file', cameraId: 'front', url: '/demo/front.mp4' }, 'file stream hợp lệ');
  rejects(GetCameraStreamResponseSchema,
    { kind: 'file', cameraId: 'front', url: '/demo/rear.mp4' }, 'file stream không được tráo camera');
  accepts(GetCameraStreamResponseSchema, {
    kind: 'webrtc', cameraId: 'front', whepUrl: 'https://robot.test/whep',
    grantToken: 'grant-1', expiresAt: iso,
  }, 'WebRTC stream hợp lệ');
  rejects(GetCameraStreamResponseSchema, {
    kind: 'webrtc', cameraId: 'front', whepUrl: 'http://robot.test/whep',
  }, 'WebRTC stream phải dùng HTTPS');
});

test('M1-CONTRACT-02: mapping request/response có fixture hai chiều', () => {
  const startRequest = { name: 'Kho A', requestId: 'map-request-1' };
  accepts(StartMappingRequestSchema, startRequest, 'start mapping request hợp lệ');
  rejects(StartMappingRequestSchema, { ...startRequest, authority: 'browser' }, 'start request phải strict');

  const finishRequest = {
    mappingSessionId: 'mapping-1', name: 'Kho A', requestId: 'map-request-2',
  };
  accepts(FinishMappingRequestSchema, finishRequest, 'finish mapping request hợp lệ');
  rejects(FinishMappingRequestSchema, { name: 'Kho A', requestId: 'map-request-2' },
    'finish request phải có session');

  accepts(ListMapsResponseSchema, [mapMetadata], 'list maps response hợp lệ');
  rejects(ListMapsResponseSchema, [{ ...mapMetadata, width: 0 }], 'list maps từ chối geometry sai');
  accepts(GetMapResponseSchema, mapMetadata, 'get map response hợp lệ');
  rejects(GetMapResponseSchema, { ...mapMetadata, absolutePath: '/tmp/map' }, 'map DTO không lộ path');
  accepts(GetActiveMappingSessionResponseSchema, { session: mappingSession }, 'active session hợp lệ');
  rejects(GetActiveMappingSessionResponseSchema,
    { session: { ...mappingSession, status: 'completed' } }, 'active session từ chối status lạ');
  accepts(StartMappingResponseSchema,
    { mappingSessionId: 'mapping-1', jobId: 'job-1', status: 'accepted' }, 'start response hợp lệ');
  rejects(StartMappingResponseSchema,
    { mappingSessionId: 'mapping-1', jobId: 'job-1', status: 'running' }, 'start response sai status');
  accepts(FinishMappingResponseSchema,
    { jobId: 'job-2', status: 'accepted' }, 'finish response hợp lệ');
  rejects(FinishMappingResponseSchema,
    { jobId: 'job-2', status: 'accepted', mapId: 'early-result' }, 'finish response phải strict');
});

test('M1-CONTRACT-03: job response/event giữ bất biến status và payload', () => {
  const job = {
    jobId: 'job-1',
    type: 'activate_map',
    status: 'completed',
    result: { mapId: 'map-1', mapRevision: 'rev-1', frameId: 'map' },
    error: null,
    createdAt: iso,
  };
  accepts(JobSchema, job, 'job hợp lệ');
  rejects(JobSchema, { ...job, result: null }, 'completed job phải có result');

  const event = { ...streamHeader, type: 'job.updated', payload: job };
  accepts(NavigationJobEventSchema, event, 'job event hợp lệ');
  rejects(NavigationJobEventSchema, { ...event, unexpected: true }, 'job event phải strict');
});

test('M1-CONTRACT-04: mission/route request, response và event có fixture hai chiều', () => {
  const missionRequest = {
    requestId,
    kind: 'navigate_to_pose',
    mapId: 'map-1',
    mapRevision: 'rev-1',
    poses: [missionPose],
  };
  accepts(MissionRequestSchema, missionRequest, 'mission request hợp lệ');
  rejects(MissionRequestSchema,
    { ...missionRequest, poses: [missionPose, missionPose] }, 'navigate_to_pose chỉ nhận một pose');

  const cancelRequest = { missionId: 'mission-1', requestId };
  accepts(CancelMissionRequestSchema, cancelRequest, 'cancel request hợp lệ');
  rejects(CancelMissionRequestSchema, { ...cancelRequest, force: true }, 'cancel request phải strict');

  const previewRequest = {
    requestId, mapId: 'map-1', mapRevision: 'rev-1', poses: [missionPose],
  };
  accepts(PreviewRouteRequestSchema, previewRequest, 'preview request hợp lệ');
  rejects(PreviewRouteRequestSchema, { ...previewRequest, poses: [] }, 'preview cần pose');
  accepts(SaveRouteRequestSchema, { ...previewRequest, name: 'Tuyến A' }, 'save route request hợp lệ');
  rejects(SaveRouteRequestSchema, { ...previewRequest, name: '   ' }, 'route name không được rỗng');
  accepts(ActivateMapRequestSchema,
    { mapId: 'map-1', mapRevision: 'rev-1', requestId }, 'activate request hợp lệ');
  rejects(ActivateMapRequestSchema,
    { mapId: 'map-1', requestId }, 'activate request phải có revision');
  accepts(ListRoutesQuerySchema,
    { mapId: 'map-1', mapRevision: 'rev-1' }, 'list routes query hợp lệ');
  rejects(ListRoutesQuerySchema, { mapId: 'map-1' }, 'list routes query phải có revision');
  accepts(NavigationPathQuerySchema, { missionId: 'mission-1' }, 'path query hợp lệ');
  rejects(NavigationPathQuerySchema,
    { missionId: 'mission-1', mapId: 'map-1' }, 'path query phải strict');

  accepts(CreateMissionResponseSchema,
    { missionId: 'mission-1', status: 'accepted' }, 'create mission response hợp lệ');
  rejects(CreateMissionResponseSchema,
    { missionId: 'mission-1', status: 'executing' }, 'create response sai status');
  accepts(GetMissionResponseSchema, mission, 'get mission response hợp lệ');
  rejects(GetMissionResponseSchema, { ...mission, unexpected: true }, 'mission response phải strict');
  accepts(GetActiveMissionResponseSchema, { mission }, 'active mission response hợp lệ');
  rejects(GetActiveMissionResponseSchema,
    { mission: { ...mission, status: 'succeeded' } }, 'active response không nhận terminal');
  accepts(CancelMissionResponseSchema,
    { missionId: 'mission-1', status: 'canceling' }, 'cancel response hợp lệ');
  rejects(CancelMissionResponseSchema,
    { missionId: 'mission-1', status: 'accepted' }, 'cancel response sai status');

  const acceptedJob = { jobId: 'job-1', status: 'accepted' };
  accepts(ActivateMapResponseSchema, acceptedJob, 'activate response hợp lệ');
  rejects(ActivateMapResponseSchema, { ...acceptedJob, status: 'completed' }, 'activate response sai status');
  accepts(PreviewRouteResponseSchema, acceptedJob, 'preview response hợp lệ');
  rejects(PreviewRouteResponseSchema, { ...acceptedJob, path: [] }, 'preview response phải strict');
  accepts(SaveRouteResponseSchema, route, 'save route response hợp lệ');
  rejects(SaveRouteResponseSchema, { ...route, name: '   ' }, 'save route response cần tên');
  accepts(ListRoutesResponseSchema, [route], 'list routes response hợp lệ');
  rejects(ListRoutesResponseSchema, [{ ...route, poses: [] }], 'list routes response cần pose');

  const missionEvent = { ...streamHeader, type: 'mission.updated', payload: mission };
  accepts(MissionEventEnvelopeSchema, missionEvent, 'mission event hợp lệ');
  rejects(MissionEventEnvelopeSchema,
    { ...missionEvent, transportHint: 'retry' }, 'mission event phải strict');

  const pathEvent = {
    ...streamHeader,
    type: 'navigation.path',
    payload: {
      missionId: 'mission-1',
      mapId: 'map-1',
      mapRevision: 'rev-1',
      frameId: 'map',
      kind: 'planned',
      poses: [{ x: 1, y: 2, yaw: 0 }],
    },
  };
  accepts(NavigationPathEnvelopeSchema, pathEvent, 'navigation path event hợp lệ');
  rejects(NavigationPathEnvelopeSchema,
    { ...pathEvent, payload: { ...pathEvent.payload, frameId: 'odom' } }, 'path phải ở frame map');
});

test('M1-CONTRACT-05: control request/response và mọi event variant có fixture hai chiều', () => {
  accepts(AcquireControlRequestSchema, { requestId: 'acquire-1' }, 'acquire request hợp lệ');
  rejects(AcquireControlRequestSchema,
    { requestId: 'acquire-1', priority: 10 }, 'browser không tự khai priority');
  accepts(AcquireControlResponseSchema, lease, 'acquire response hợp lệ');
  rejects(AcquireControlResponseSchema,
    { ...lease, controlGeneration: 0 }, 'generation phải dương');

  const releaseRequest = { leaseId: 'lease-1', requestId: 'release-1' };
  accepts(ReleaseControlRequestSchema, releaseRequest, 'release request hợp lệ');
  rejects(ReleaseControlRequestSchema, { requestId: 'release-1' }, 'release request phải có lease');
  accepts(ReleaseControlResponseSchema,
    { ...releaseRequest, status: 'released' }, 'release response hợp lệ');
  rejects(ReleaseControlResponseSchema,
    { ...releaseRequest, status: 'accepted' }, 'release response sai status');

  accepts(RequestStopRequestSchema, { requestId: 'stop-1' }, 'stop request hợp lệ');
  rejects(RequestStopRequestSchema,
    { requestId: 'stop-1', confirmed: true }, 'client không tự xác nhận stop');
  accepts(RequestStopResponseSchema,
    { requestId: 'stop-1', status: 'accepted' }, 'stop response hợp lệ');
  rejects(RequestStopResponseSchema,
    { requestId: 'stop-1', status: 'confirmed' }, 'HTTP response không tự confirmed');

  const velocity = {
    leaseId: 'lease-1', sequence: 1, freshnessToken: 'token-1', linearX: 0.1, angularZ: -0.2,
  };
  accepts(TeleopVelocityMessageSchema, velocity, 'velocity message hợp lệ');
  rejects(TeleopVelocityMessageSchema, { ...velocity, sequence: 0 }, 'velocity sequence phải dương');
  accepts(ControlHeartbeatSchema, heartbeat, 'heartbeat hợp lệ');
  rejects(ControlHeartbeatSchema, { ...heartbeat, tokenValidForMs: 0 }, 'token TTL phải dương');
  accepts(StopConfirmationSchema, stopConfirmation, 'stop confirmation hợp lệ');
  rejects(StopConfirmationSchema,
    { ...stopConfirmation, sourceSequence: 0 }, 'stop source sequence phải dương');
  accepts(ControlSnapshotSchema, controlSnapshot, 'control snapshot hợp lệ');
  rejects(ControlSnapshotSchema,
    { ...controlSnapshot, controlGeneration: 2 }, 'snapshot phải khớp lease generation');

  const events = [
    { ...streamHeader, type: 'control.granted', payload: lease },
    { ...streamHeader, type: 'control.heartbeat', payload: heartbeat },
    { ...streamHeader, type: 'control.revoked', payload: {
      leaseId: 'lease-1', controlGeneration: 2, reason: 'STOP_REQUESTED',
    } },
    { ...streamHeader, type: 'control.snapshot', payload: controlSnapshot },
    { ...streamHeader, type: 'control.stopConfirmed', payload: stopConfirmation },
    { ...streamHeader, type: 'teleop.commandResult', payload: {
      leaseId: 'lease-1', commandSequence: 1, success: true, error: null,
    } },
  ];
  for (const event of events) {
    accepts(ControlEventEnvelopeSchema, event, `${event.type} hợp lệ`);
    rejects(ControlEventEnvelopeSchema,
      { ...event, replay: true }, `${event.type} không nhận field lạ`);
  }

  const snapshotResponse = { ...streamHeader, type: 'control.snapshot', payload: controlSnapshot };
  accepts(GetControlStateResponseSchema, snapshotResponse, 'get control state response hợp lệ');
  rejects(GetControlStateResponseSchema,
    { ...snapshotResponse, type: 'control.granted' }, 'get control state phải là snapshot');
});

test('M1-CONTRACT-06: map stream event variants có fixture hai chiều', () => {
  accepts(MapGridSnapshotSchema, mapGridSnapshot, 'map grid snapshot hợp lệ');
  rejects(MapGridSnapshotSchema,
    { ...mapGridSnapshot, grid: { ...mapGridSnapshot.grid, data: [0] } }, 'grid data phải khớp geometry');
  assert.deepEqual(parseMapGridSnapshot(mapGridSnapshot), mapGridSnapshot,
    'hot path phải giữ nguyên DTO hợp lệ');
  assert.throws(
    () => parseMapGridSnapshot({
      ...mapGridSnapshot,
      grid: { ...mapGridSnapshot.grid, data: [-1, 0, 50, 101] },
    }),
    (error) => error.code === 'INVALID_MAP_DATA',
    'hot path phải kiểm tra từng cell'
  );

  const eventHeader = {
    version: 1,
    subscriptionId: 'subscription-1',
    streamId: 'map-stream-1',
    streamEpoch: 1,
    sequence: 1,
    sentAt: iso,
  };
  const events = [
    { ...eventHeader, type: 'map.grid', payload: mapGridSnapshot },
    { ...eventHeader, type: 'map.status', payload: {
      context: mapGridSnapshot.context,
      state: 'ready',
      sourceState: 'live',
      lastSourceUpdateAgeMs: 10,
    } },
    { ...eventHeader, type: 'map.error', payload: {
      context: mapGridSnapshot.context,
      error: { code: 'MAP_SOURCE_LOST', message: 'Nguồn map bị mất' },
    } },
  ];
  for (const event of events) {
    accepts(MapGridEventEnvelopeSchema, event, `${event.type} hợp lệ`);
    rejects(MapGridEventEnvelopeSchema,
      { ...event, retry: true }, `${event.type} không nhận field lạ`);
  }
});
