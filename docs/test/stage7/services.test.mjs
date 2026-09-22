import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockRobotClient } from '../../../frontend/src/clients/mockRobotClient.js';
import { JobSchema } from '../../../frontend/src/schemas/job.js';
import { createIdempotencyRegistry } from '../../../frontend/src/utils/idempotencyRegistry.js';
import { RobotStateSchema } from '../../../frontend/src/schemas/robotState.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pose = (x = 7, y = 3) => ({ frameId: 'map', x, y, yaw: 0 });
const request = (poses = [pose()]) => ({
  requestId: crypto.randomUUID(), mapId: 'map-demo', mapRevision: 'rev-1',
  kind: poses.length === 1 ? 'navigate_to_pose' : 'navigate_through_poses', poses,
});
const route = () => {
  const { kind: ignored, ...value } = request([pose(1, 1), pose(2, 2)]);
  assert.ok(ignored);
  return value;
};
async function client(t) {
  const c = createMockRobotClient();
  t.after(() => c.dispose());
  await c.login({ username: 'admin', password: 'demo-only' });
  return c;
}
async function until(read, accept, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await pause(20);
  }
  throw Error('Timed out waiting for expected state');
}

test('C7 registry: hai caller trước await dùng đúng một promise/resource', async () => {
  const registry = createIdempotencyRegistry();
  const args = { principalId: 'p', operation: 'create', requestId: 'r', payload: { b: 2, a: 1 } };
  let calls = 0;
  const work = async () => { calls++; await pause(10); return { id: 'only-one' }; };
  const [a, b] = await Promise.all([registry.run(args, work), registry.run(args, work)]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.throws(() => registry.run({ ...args, payload: { a: 2 } }, work), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('C7 job: preview completed giữ path, reject field rác', () => {
  const job = { jobId: 'j', type: 'preview_route', status: 'completed',
    createdAt: new Date().toISOString(), error: null,
    result: { mapId: 'm', mapRevision: 'r', frameId: 'map', label: 'Đường minh họa',
      path: [{ x: 1, y: 1, yaw: 0 }] } };
  assert.equal(JobSchema.parse(job).result.path.length, 1);
  assert.equal(JobSchema.safeParse({ ...job, garbage: true }).success, false);
});

test('C7 preview/save/list đi qua facade/schema và giữ exact map revision', async t => {
  const c = await client(t);
  const args = route();
  const accepted = await c.previewRoute(args);
  const job = await until(() => c.getJob(accepted.jobId), job => job.status === 'completed');
  assert.equal(job.result.path.length, 2);
  const saved = await c.saveRoute({ ...args, requestId: crypto.randomUUID(), name: 'Route A' });
  assert.equal((await c.listRoutes({ mapId: args.mapId, mapRevision: args.mapRevision }))[0].routeId, saved.routeId);
  assert.deepEqual(await c.listRoutes({ mapId: 'map-demo', mapRevision: 'rev-other' }), []);
});

test('C7 activation: duplicate đồng thời cùng id trả một job; pending khóa navigate', async t => {
  const c = await client(t);
  const args = { mapId: 'map-rotated', mapRevision: 'rev-1', requestId: crypto.randomUUID() };
  const [a, b] = await Promise.all([c.activateMap(args), c.activateMap(args)]);
  assert.equal(a.jobId, b.jobId);
  assert.equal((await c.getRobotState()).mode, 'localizing');
  await assert.rejects(c.createMission(request()), { code: 'ROBOT_NOT_IDLE' });
  await until(() => c.getJob(a.jobId), job => job.status === 'completed');
  const result = await c.getRobotState();
  assert.equal(result.activeMap.id, 'map-rotated');
  c.subscribeRobotState(() => {});
  await pause(250);
  assert.deepEqual((await c.getRobotState()).pose, result.pose);
});

test('C7 activation: request strict và map nonexistent bị từ chối', async t => {
  const c = await client(t);
  await assert.rejects(c.activateMap({ mapId: 'map-demo', mapRevision: 'rev-1', requestId: 'bad' }));
  await assert.rejects(c.activateMap({ mapId: 'missing', mapRevision: 'r', requestId: crypto.randomUUID() }),
    { code: 'MAP_NOT_FOUND' });
});

test('C7 mission: duplicate/conflict, accepted cancel không resurrect', async t => {
  const c = await client(t);
  const args = request();
  const [a, b] = await Promise.all([c.createMission(args), c.createMission(args)]);
  assert.equal(a.missionId, b.missionId);
  await assert.rejects(c.createMission({ ...args, poses: [pose(6, 2)] }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(c.createMission(request()), { code: 'MISSION_ACTIVE' });
  const before = (await c.getRobotState()).pose;
  await c.cancelMission({ missionId: a.missionId, requestId: crypto.randomUUID() });
  await pause(250);
  assert.equal((await c.getMission(a.missionId)).status, 'canceled');
  assert.deepEqual((await c.getRobotState()).pose, before);
});

test('C7 mission: đi qua waypoint, schema robot đúng, không snap-back sau terminal', async t => {
  const c = await client(t);
  const snapshots = [];
  c.subscribeRobotState(state => { RobotStateSchema.parse(state); snapshots.push(state); });
  const args = request([pose(4.24, 1.8), { ...pose(4.24, 2.04), yaw: 1.57 }]);
  const accepted = await c.createMission(args);
  let path;
  c.subscribeNavigationPath({ missionId: accepted.missionId }, event => { path = event.payload; });
  await until(() => c.getMission(accepted.missionId), mission => mission.status === 'succeeded');
  const finalPose = (await c.getRobotState()).pose;
  await pause(300);
  assert.deepEqual(finalPose, args.poses[1]);
  assert.deepEqual((await c.getRobotState()).pose, finalPose);
  assert.ok(snapshots.some(state => state.pose && Math.hypot(state.pose.x - 4.24, state.pose.y - 1.8) < 0.05));
  assert.equal(path.poses.length, 3);
});

for (const scenario of ['lost', 'offline', 'stale']) {
  test('C7 runtime: dừng/fail khi ' + scenario, async t => {
    const c = await client(t);
    c.subscribeRobotState(() => {});
    const accepted = await c.createMission(request());
    await until(() => c.getMission(accepted.missionId), m => m.status === 'executing');
    c.setDemoScenario(scenario);
    const end = await until(() => c.getMission(accepted.missionId), m => m.status === 'failed');
    assert.ok(end.error.code);
    assert.equal((await c.getRobotState()).velocity.linearX, 0);
    const stopped = c._telemetry.getControlState().snapshot.pose;
    await pause(200);
    assert.deepEqual(c._telemetry.getControlState().snapshot.pose, stopped);
  });
}

for (const scenario of ['goal-rejected', 'blocked-failed']) {
  test('C7 failure scenario: ' + scenario, async t => {
    const c = await client(t);
    c.setDemoMissionScenario(scenario);
    const accepted = await c.createMission(request());
    const result = await until(() => c.getMission(accepted.missionId), m => m.status === 'failed');
    assert.ok(result.error);
    assert.equal((await c.getRobotState()).velocity.linearX, 0);
    assert.equal((await c.getActiveMission()).mission, null);
  });
}

test('C7 logout/dispose: hủy preview/activation timer trước khi xóa job', async t => {
  const c = await client(t);
  await c.previewRoute(route());
  await c.activateMap({ mapId: 'map-rotated', mapRevision: 'rev-1', requestId: crypto.randomUUID() });
  await c.logout();
  await pause(400);
  assert.equal(c._sharedRobotState.getSnapshot().activeMap.id, 'map-demo');
  await c.login({ username: 'admin', password: 'demo-only' });
  await c.activateMap({ mapId: 'map-rotated', mapRevision: 'rev-1', requestId: crypto.randomUUID() });
  await pause(130);
  c.dispose();
  await pause(300);
  assert.equal(c._sharedRobotState.getSnapshot().activeMap.id, 'map-demo');
});

test('C7 lifecycle: response getMap đến sau dispose không tạo operation', async t => {
  const c = await client(t);
  const original = c._mapRepository.getMap.bind(c._mapRepository);
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  c._mapRepository.getMap = async (...args) => { await barrier; return original(...args); };
  const pending = c.activateMap({ mapId: 'map-rotated', mapRevision: 'rev-1', requestId: crypto.randomUUID() });
  await pause(0);
  c.dispose();
  release();
  await assert.rejects(pending);
  await pause(350);
  assert.equal(c._sharedRobotState.getSnapshot().activeMap.id, 'map-demo');
});
