import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockRobotClient } from '../../../frontend/src/clients/mockRobotClient.js';
import { MissionSchema, MissionRequestSchema, GetActiveMissionResponseSchema,
  NavigationPathEnvelopeSchema, preflightNavigationPath } from '../../../frontend/src/schemas/mission.js';
import { useMissionStore as missions } from '../../../frontend/src/state/missionStore.js';
import { useNavigationWorkflowStore as nav } from '../../../frontend/src/state/navigationWorkflowStore.js';
import { cancelMissionIntent, sendJobIntent } from '../../../frontend/src/utils/navigationCommands.js';
import { canTransitionMission, transitionMission } from '../../../frontend/src/utils/missionState.js';
import { RobotStateSchema } from '../../../frontend/src/schemas/robotState.js';
import { checkMissionPreconditions } from '../../../frontend/src/utils/navigationGuards.js';
import { createNavigationCoordinator } from '../../../frontend/src/utils/navigationCoordinator.js';
import { useMappingWorkflowStore as mapping } from '../../../frontend/src/state/mappingWorkflowStore.js';
import { JobSchema as MappingJobSchema } from '../../../frontend/src/schemas/mapping.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pose = (x = 8, y = 3) => ({ frameId: 'map', x, y, yaw: 0 });
const request = () => ({ requestId: crypto.randomUUID(), kind: 'navigate_to_pose',
  mapId: 'map-demo', mapRevision: 'rev-1', poses: [pose()] });
const activation = () => ({ requestId: crypto.randomUUID(), mapId: 'map-rotated', mapRevision: 'rev-1' });
async function client(t) {
  const c = createMockRobotClient();
  t.after(() => c.dispose());
  await c.login({ username: 'admin', password: 'demo-only' });
  c.subscribeRobotState(() => {});
  return c;
}
async function until(read, condition, timeout = 3500) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await read();
    if (condition(value)) return value;
    await pause(20);
  }
  throw new Error('Independent oracle timeout');
}
function record(status = 'executing') {
  return { ...request(), missionId: 'independent-mission', status, currentPoseIndex: 0,
    distanceRemainingM: 1, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

test('I7-01: heartbeat không làm mới pose khi mission đang chạy; phải fail POSE_STALE', async t => {
  const c = await client(t);
  const accepted = await c.createMission(request());
  await until(() => c.getMission(accepted.missionId), m => m.status === 'executing');
  c.setDemoScenario('pose-heartbeat');
  const frozen = (await c.getRobotState()).pose;
  const result = await until(() => c.getMission(accepted.missionId), m => m.status === 'failed');
  assert.equal(result.error.code, 'POSE_STALE');
  // Service reads its clock each tick; UI DTO age advances on the independent
  // 200ms heartbeat. Wait for that observation, not an assumed timer ordering.
  const end = await until(() => c.getRobotState(), s => s.poseSourceUpdateAgeMs >= 2000);
  assert.deepEqual(end.pose, frozen, 'Không được chế tạo pose mới từ lệnh điều khiển');
  assert.equal(end.velocity.linearX, 0);
  assert.ok(end.poseSourceUpdateAgeMs >= 2000);
});

test('I7-02: activate không được giả xác nhận localization khi nguồn pose bị đóng băng', async t => {
  const c = await client(t);
  c.setDemoScenario('pose-heartbeat');
  const accepted = await c.activateMap(activation());
  const result = await until(() => c.getJob(accepted.jobId), j => ['completed', 'failed'].includes(j.status));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'POSE_SOURCE_UNAVAILABLE');
  assert.equal((await c.getRobotState()).activeMap.id, 'map-demo');
});

test('I7-03: query routes/path phải strict tại facade, không im lặng bỏ field sai', async t => {
  const c = await client(t);
  await assert.rejects(c.listRoutes({ mapId: 'map-demo', mapRevision: 'rev-1', typo: true }), { name: 'ZodError' });
  await assert.rejects(c.listRoutes({ mapId: 'map-demo' }), { name: 'ZodError' });
  assert.throws(() => c.subscribeNavigationPath({ missionId: 'm', wrong: true }, () => {}), { name: 'ZodError' });
});

test('I7-04: snapshot không được chứa kind/index/error mâu thuẫn hoặc active terminal', () => {
  const valid = record();
  assert.equal(MissionSchema.safeParse(valid).success, true);
  for (const invalid of [
    { ...valid, poses: [pose(), pose()] },
    { ...valid, kind: 'navigate_through_poses' },
    { ...valid, currentPoseIndex: 1 },
    { ...valid, status: 'failed', error: null },
    { ...valid, error: { code: 'X', message: 'Không có lỗi trong executing' } },
  ]) assert.equal(MissionSchema.safeParse(invalid).success, false, JSON.stringify(invalid));
  assert.equal(GetActiveMissionResponseSchema.safeParse({ mission: { ...valid, status: 'succeeded' } }).success, false);
});

test('I7-05: cancel terminal event thắng timeout đến muộn, không trả UI về uncertain', async () => {
  missions.getState().clearMission();
  const current = record();
  const envelope = (payload, sequence) => ({ version: 1, type: 'mission.updated', streamEpoch: 'i7',
    sequence, sentAt: new Date().toISOString(), payload });
  missions.getState().ingestMission(envelope(current, 1));
  const c = { cancelMission: async () => {
    missions.getState().ingestMission(envelope({ ...current, status: 'canceled' }, 2));
    throw Object.assign(new Error('HTTP timeout after terminal WS'), { code: 'TIMEOUT' });
  } };
  await cancelMissionIntent(c, { requestId: crypto.randomUUID(), missionId: current.missionId });
  assert.equal(missions.getState().cancelRequest.status, 'acknowledged');
  assert.equal(missions.getState().cancelRequest.error, null);
  missions.getState().clearMission();
});

test('I7-06: completed job event thắng GET timeout, không hồi sinh activation pending', async () => {
  nav.getState().reset();
  const job = { jobId: 'j-i7', type: 'activate_map', status: 'completed', createdAt: new Date().toISOString(),
    error: null, result: { mapId: 'map-rotated', mapRevision: 'rev-1', frameId: 'map' } };
  const c = {
    activateMap: async () => { nav.getState().recordJob(job); return { jobId: job.jobId, status: 'accepted' }; },
    getJob: async () => { throw Object.assign(new Error('GET timeout after completed WS'), { code: 'TIMEOUT' }); },
  };
  await sendJobIntent(c, 'activation', activation());
  assert.equal(nav.getState().activation.status, 'completed');
  assert.equal(nav.getState().activation.error, null);
  nav.getState().reset();
});

for (const [name, patch, code] of [
  ['fault', { mode: 'fault' }, 'ROBOT_FAULT'],
  ['E-stop', { physicalEstopActive: true }, 'ESTOP_NOT_CLEAR'],
  ['inhibit', { motionInhibited: true, motionInhibitReason: 'EXTERNAL_LOCK' }, 'MOTION_INHIBITED'],
]) test('I7-07: runtime ' + name + ' kết thúc mission và zero velocity', async t => {
  const c = await client(t);
  const accepted = await c.createMission(request());
  await until(() => c.getRobotState(), s => s.velocity.linearX > 0);
  c._sharedRobotState.update(patch);
  const result = await until(() => c.getMission(accepted.missionId), m => m.status === 'failed');
  assert.equal(result.error.code, code);
  const stopped = await c.getRobotState();
  assert.equal(stopped.velocity.linearX, 0);
  if (name === 'fault') assert.equal(stopped.mode, 'fault');
  await pause(250);
  assert.deepEqual((await c.getRobotState()).pose, stopped.pose);
});

test('I7-08: hai mission khác requestId chạy đồng thời chỉ một bên giành được robot', async t => {
  const c = await client(t);
  const results = await Promise.allSettled([c.createMission(request()), c.createMission(request())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'MISSION_ACTIVE');
});

test('I7-09: activate vs mapping và mission vs mapping không đồng sở hữu mode', async t => {
  const c = await client(t);
  const results = await Promise.allSettled([c.activateMap(activation()),
    c.startMapping({ name: 'Race mapping', requestId: crypto.randomUUID() })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(c.createMission(request()));
});

test('I7-10: cancel executing/gần đích/sau terminal không hồi sinh timer', async t => {
  const c = await client(t);
  for (const distance of [0.5, 0.015]) {
    const start = (await c.getRobotState()).pose;
    const accepted = await c.createMission({ ...request(), poses: [pose(start.x + distance, start.y)] });
    await until(() => c.getMission(accepted.missionId), m => m.status !== 'accepted');
    await pause(100);
    const args = { missionId: accepted.missionId, requestId: crypto.randomUUID() };
    await Promise.all([c.cancelMission(args), c.cancelMission(args)]);
    const final = await until(() => c.getMission(accepted.missionId), m => ['canceled', 'succeeded'].includes(m.status));
    const stopped = await c.getRobotState();
    await pause(250);
    assert.equal((await c.getMission(accepted.missionId)).status, final.status);
    assert.deepEqual((await c.getRobotState()).pose, stopped.pose);
    assert.equal(stopped.velocity.linearX, 0);
    const replay = await c.cancelMission({ ...args, requestId: crypto.randomUUID() });
    assert.equal(replay.status, final.status);
  }
});

test('I7-11: activation lỗi giữa job giữ map cũ và không chiếm lại fault mode', async t => {
  const c = await client(t);
  const accepted = await c.activateMap(activation());
  c._sharedRobotState.update({ mode: 'fault' });
  const result = await until(() => c.getJob(accepted.jobId), j => j.status === 'failed');
  assert.equal(result.error.code, 'ROBOT_FAULT');
  const snapshot = await c.getRobotState();
  assert.equal(snapshot.activeMap.id, 'map-demo');
  assert.equal(snapshot.mode, 'fault');
});

test('I7-12: schema chặn NaN/Infinity, kind count, path count/byte limit trước render', () => {
  for (const x of [NaN, Infinity, -Infinity]) {
    assert.equal(MissionRequestSchema.safeParse({ ...request(), poses: [pose(x)] }).success, false);
  }
  for (const poses of [[], Array.from({ length: 101 }, () => pose())]) {
    assert.equal(MissionRequestSchema.safeParse({ ...request(), poses }).success, false);
  }
  const path = { version: 1, type: 'navigation.path', streamEpoch: 'P', sequence: 1,
    sentAt: new Date().toISOString(), payload: { missionId: 'm', mapId: 'map-demo', mapRevision: 'rev-1',
      frameId: 'map', kind: 'planned', poses: [{ x: 1, y: 1, yaw: 0 }] } };
  assert.doesNotThrow(() => { preflightNavigationPath(path); NavigationPathEnvelopeSchema.parse(path); });
  assert.throws(() => preflightNavigationPath({ ...path, padding: 'x'.repeat(256 * 1024) }), { code: 'PATH_TOO_LARGE' });
  assert.throws(() => preflightNavigationPath({ ...path, payload: { ...path.payload,
    poses: Array.from({ length: 2001 }, () => ({ x: 1, y: 1, yaw: 0 })) } }), { code: 'PATH_TOO_LARGE' });
  assert.equal(NavigationPathEnvelopeSchema.safeParse({ ...path, wrong: true }).success, false);
});

test('I7-13: ma trận state machine; terminal không quay về executing/canceling', () => {
  const statuses = ['accepted', 'executing', 'canceling', 'succeeded', 'failed', 'canceled'];
  const allowed = { accepted: ['executing', 'canceling', 'failed', 'succeeded'],
    executing: ['canceling', 'succeeded', 'failed'], canceling: ['canceled', 'succeeded', 'failed'] };
  for (const from of statuses) for (const to of statuses) {
    const expected = from === to || Boolean(allowed[from]?.includes(to));
    assert.equal(canTransitionMission(from, to), expected, from + ' -> ' + to);
    if (expected) assert.equal(transitionMission(record(from), to).status, to);
    else assert.throws(() => transitionMission(record(from), to), { code: 'INVALID_MISSION_TRANSITION' });
  }
});

test('I7-14: thiếu cờ khóa chuyển động không được coi là đã cho phép chạy', async t => {
  const c = await client(t);
  const state = await c.getRobotState();
  const { motionInhibited: omitted, ...incomplete } = state;
  assert.equal(omitted, false);
  assert.equal(RobotStateSchema.safeParse(incomplete).success, false);
  assert.equal(checkMissionPreconditions({ robotSnapshot: incomplete,
    mapId: 'map-demo', mapRevision: 'rev-1' }).ok, false);
  assert.equal(RobotStateSchema.safeParse({ ...state, localization: { ...state.localization, typo: 1 } }).success, false);
});

test('I7-15: duplicate preview/save atomically một resource, clone độc lập; context/bounds bị kiểm tra', async t => {
  const c = await client(t);
  const { kind: ignored, ...args } = request();
  assert.ok(ignored);
  const previews = await Promise.all([c.previewRoute(args), c.previewRoute(args)]);
  assert.equal(previews[0].jobId, previews[1].jobId);
  const save = { ...args, requestId: crypto.randomUUID(), name: 'Independent route' };
  const [first, second] = await Promise.all([c.saveRoute(save), c.saveRoute(save)]);
  assert.equal(first.routeId, second.routeId);
  first.poses[0].x = 999;
  assert.equal(second.poses[0].x, 8);
  const query = { mapId: args.mapId, mapRevision: args.mapRevision };
  assert.equal((await c.listRoutes(query)).length, 1);
  await assert.rejects(c.saveRoute({ ...save, name: 'Different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(c.createMission({ ...request(), poses: [pose(10, 3)] }), { code: 'POSE_OUT_OF_BOUNDS' });
  await assert.rejects(c.createMission({ ...request(), mapId: 'map-rotated', poses: [pose(8, -2)] }), { code: 'MAP_NOT_ACTIVE' });
});

test('I7-16: logout khi executing dừng producer, không phát mission/path vào user mới', async t => {
  const c = await client(t);
  let events = 0;
  c.subscribeMissions(() => { events++; });
  const accepted = await c.createMission(request());
  c.subscribeNavigationPath({ missionId: accepted.missionId }, () => { events++; });
  await until(() => c.getRobotState(), s => s.velocity.linearX > 0);
  await c.logout();
  const count = events;
  await c.login({ username: 'admin', password: 'demo-only' });
  await pause(300);
  assert.equal(events, count);
  assert.equal((await c.getActiveMission()).mission, null);
  assert.equal((await c.getRobotState()).velocity.linearX, 0);
  assert.equal((await c.getRobotState()).pose.x, 4.12);
  await assert.rejects(c.getMission(accepted.missionId), { code: 'MISSION_NOT_FOUND' });
});

test('I7-17: reconnect/epoch mới cùng missionId lấy lại path và bỏ callback subscription cũ', async t => {
  missions.getState().clearMission(); nav.getState().reset(); mapping.getState().reset();
  const current = record();
  let epoch = 'A';
  let sequence = 0;
  let missionListener;
  const pathCallbacks = [];
  let closed = 0;
  const pathEvent = (x, customEpoch = epoch) => ({ version: 1, type: 'navigation.path', streamEpoch: customEpoch,
    sequence: ++sequence, sentAt: new Date().toISOString(), payload: { missionId: current.missionId,
      mapId: current.mapId, mapRevision: current.mapRevision, frameId: 'map', kind: 'planned',
      poses: [{ x, y: 1, yaw: 0 }] } });
  const c = {
    subscribeJobs: () => () => {},
    subscribeMissions: listener => { missionListener = listener; return () => {}; },
    subscribeRobotState: () => () => {},
    subscribeNavigationPath: (_, listener) => {
      pathCallbacks.push(listener);
      listener(pathEvent(epoch === 'A' ? 1 : 2));
      return () => { closed++; };
    },
    getMission: async () => current,
    getActiveMission: async () => ({ mission: current }),
    getActiveMappingSession: async () => ({ session: null }),
  };
  const coordinator = createNavigationCoordinator(c);
  t.after(() => { coordinator.dispose(); missions.getState().clearMission(); nav.getState().reset(); mapping.getState().reset(); });
  missionListener({ version: 1, type: 'mission.updated', streamEpoch: epoch, sequence: ++sequence,
    sentAt: new Date().toISOString(), payload: current });
  await until(() => missions.getState(), s => s.reconciliationState === 'ready' && s.plannedPath);
  const previous = pathCallbacks.at(-1);
  epoch = 'B'; sequence = 0;
  missionListener({ version: 1, type: 'mission.updated', streamEpoch: epoch, sequence: ++sequence,
    sentAt: new Date().toISOString(), payload: current });
  await until(() => missions.getState(), s => s.reconciliationState === 'ready' && s.plannedPath?.poses[0].x === 2);
  previous(pathEvent(999, 'A'));
  assert.equal(missions.getState().plannedPath.poses[0].x, 2);
  coordinator.dispose();
  assert.equal(closed, pathCallbacks.length, 'Tất cả path subscription được cleanup');
});

test('I7-18: gộp JobSchema không được nới lỏng contract mapping của Chặng 6', () => {
  const job = { jobId: 'mapping-job', type: 'finish_mapping', status: 'completed',
    result: { mapId: 'map-new', mapRevision: 'r1' }, error: null, createdAt: '2026-09-17T00:00:00.000Z' };
  assert.equal(MappingJobSchema.safeParse(job).success, true);
  assert.equal(MappingJobSchema.safeParse({ ...job, createdAt: 'not-a-date' }).success, false);
  assert.equal(MappingJobSchema.safeParse({ ...job, result: { ...job.result, garbage: true } }).success, false);
});

test('I7-19: login lại khi đã authenticated không âm thầm cắt mission subscriptions', async t => {
  const c = await client(t);
  let events = 0;
  c.subscribeMissions(() => { events++; });
  const accepted = await c.createMission(request());
  await until(() => c.getMission(accepted.missionId), m => m.status === 'executing');
  await assert.rejects(c.login({ username: 'admin', password: 'wrong-password' }));
  let before = events;
  await pause(250);
  assert.ok(events > before, 'Login thất bại không được thu hồi subscription của phiên hợp lệ');
  await c.login({ username: 'admin', password: 'demo-only' });
  before = events;
  await pause(250);
  assert.ok(events > before, 'Login lại cùng principal phải giữ luồng mission đang hoạt động');
});
