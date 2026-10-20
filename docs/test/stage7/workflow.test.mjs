import test from 'node:test';
import assert from 'node:assert/strict';
import { useMissionStore as missions } from '../../../frontend/src/state/missionStore.js';
import { useNavigationWorkflowStore as nav } from '../../../frontend/src/state/navigationWorkflowStore.js';
import { useMappingWorkflowStore as mapping } from '../../../frontend/src/state/mappingWorkflowStore.js';
import { createNavigationCoordinator } from '../../../frontend/src/utils/navigationCoordinator.js';
import { sendMissionIntent } from '../../../frontend/src/utils/navigationCommands.js';
import { createMockRobotClient } from '../../../frontend/src/clients/mockRobotClient.js';
import { checkMissionPreconditions } from '../../../frontend/src/utils/navigationGuards.js';
import { resolvePoseQuality } from '../../../frontend/src/utils/poseQuality.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const map = { id: 'map-demo', revision: 'rev-1', frameId: 'map' };
const pose = { frameId: 'map', x: 4.12, y: 1.8, yaw: 0 };
function record(id = 'm', status = 'executing') {
    return {
        missionId: id, requestId: crypto.randomUUID(), kind: 'navigate_to_pose',
        mapId: map.id, mapRevision: map.revision, poses: [pose], status,
        currentPoseIndex: 0, distanceRemainingM: 1, error: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
}
const event = (payload, sequence = 1, streamEpoch = 'A') => ({
    version: 1, type: 'mission.updated', streamEpoch, sequence,
    sentAt: new Date().toISOString(), payload,
});
function reset() { missions.getState().clearMission(); nav.getState().reset(); mapping.getState().reset(); }
function completedPreview(jobId = 'j') {
    return {
        jobId, type: 'preview_route', status: 'completed', error: null, createdAt: '2026-09-17T00:00:00.000Z',
        result: {
            mapId: map.id, mapRevision: map.revision, frameId: 'map',
            label: 'Đường minh họa', path: [{ x: 1, y: 1, yaw: 0 }, { x: 2, y: 2, yaw: 0 }]
        }
    };
}
async function until(read, condition) {
    for (let count = 0; count < 100; count++) {
        const value = read();
        if (condition(value)) return value;
        await pause(20);
    }
    throw Error('Timed out');
}

test('C7 store: bỏ sequence cũ, đổi epoch đòi recovery và không nhận lại epoch đã retire', () => {
    reset();
    const m = record();
    missions.getState().ingestMission(event(m, 20));
    missions.getState().ingestMission(event({ ...m, status: 'accepted' }, 10));
    assert.equal(missions.getState().missionsById.m.status, 'executing');
    assert.equal(missions.getState().ingestMission(event(m, 1, 'B')), 'recover');
    assert.equal(missions.getState().reconciliationState, 'loading');
    missions.getState().applyRecovery(null, { ...m, status: 'succeeded' });
    assert.equal(missions.getState().ingestMission(event(m, 999, 'A')), 'ignore');
    assert.equal(missions.getState().missionsById.m.status, 'succeeded');
});

test('C7 store: path sai mission/map không ghi đè; path cũ bị bỏ theo sequence', () => {
    reset();
    const m = record();
    missions.getState().ingestMission(event(m));
    const path = {
        version: 1, type: 'navigation.path', streamEpoch: 'P', sequence: 10,
        sentAt: new Date().toISOString(), payload: {
            missionId: m.missionId,
            mapId: map.id, mapRevision: map.revision, frameId: 'map', kind: 'planned',
            poses: [{ x: 1, y: 1, yaw: 0 }]
        }
    };
    missions.getState().ingestPath(path);
    missions.getState().ingestPath({ ...path, sequence: 20, payload: { ...path.payload, mapId: 'other' } });
    missions.getState().ingestPath({ ...path, sequence: 5, payload: { ...path.payload, poses: [{ x: 9, y: 9, yaw: 0 }] } });
    assert.equal(missions.getState().plannedPath.poses[0].x, 1);
    missions.getState().ingestMission(event(record('new'), 30));
    assert.equal(missions.getState().plannedPath, null);
});

test('C7 store: sửa draft/đổi map vô hiệu preview đang chờ; cùng revision giữ draft', () => {
    reset();
    nav.getState().setSelectedMap(map);
    nav.getState().setRouteDraft([pose]);
    const request = { requestId: crypto.randomUUID(), mapId: map.id, mapRevision: map.revision, poses: [pose] };
    nav.getState().beginOperation('preview', request);
    nav.getState().bindJob('preview', request.requestId, 'j');
    const id = nav.getState().waypoints[0].id;
    nav.getState().updateWaypoint(id, { ...pose, x: 5 });
    nav.getState().recordJob(completedPreview());
    assert.equal(nav.getState().previewPath, null);
    const revision = nav.getState().draftRevision;
    nav.getState().setSelectedMap({ ...map });
    assert.equal(nav.getState().draftRevision, revision);
    assert.equal(nav.getState().waypoints[0].id, id);
    nav.getState().setSelectedMap({ ...map, revision: 'rev-2' });
    assert.equal(nav.getState().waypoints.length, 0);
    assert.equal(nav.getState().previewPath, null);
});

test('C7 store: event completed đến trước response được bind lại, snapshot accepted không hạ trạng thái', () => {
    reset();
    nav.getState().setSelectedMap(map);
    nav.getState().setRouteDraft([pose]);
    const req = { requestId: crypto.randomUUID(), mapId: map.id, mapRevision: map.revision, poses: [pose] };
    nav.getState().beginOperation('preview', req);
    const job = completedPreview();
    nav.getState().recordJob(job);
    nav.getState().bindJob('preview', req.requestId, job.jobId);
    assert.equal(nav.getState().preview.status, 'completed');
    assert.equal(nav.getState().previewPath.path.length, 2);
    nav.getState().recordJob({ ...job, status: 'accepted', result: null });
    assert.equal(nav.getState().preview.status, 'completed');
});

test('C7 waypoint: sửa/xóa/reorder giữ ID các điểm còn lại, không thay tuyến bằng một điểm', () => {
    reset();
    nav.getState().setRouteDraft([pose, { ...pose, x: 5 }, { ...pose, x: 6 }]);
    const [a, b, c] = nav.getState().waypoints;
    nav.getState().updateWaypoint(b.id, { ...b, yaw: 1 });
    assert.equal(nav.getState().waypoints.length, 3);
    nav.getState().moveWaypoint(c.id, -1);
    assert.deepEqual(nav.getState().waypoints.map(p => p.id), [a.id, c.id, b.id]);
    nav.getState().deleteWaypoint(c.id);
    assert.deepEqual(nav.getState().waypoints.map(p => p.id), [a.id, b.id]);
    assert.equal(nav.getState().routeDraft.poses[1].yaw, 1);
    assert.equal(Object.hasOwn(nav.getState().routeDraft.poses[1], 'id'), false);
});

test('C7 freshness: stale transport và source age null đều khóa submit', () => {
    const snapshot = {
        mode: 'idle', activeMap: map, activeMissionId: null, activeMappingSessionId: null,
        rosConnected: true, localization: { status: 'tracking' }, pose, poseSourceUpdateAgeMs: 0,
        physicalEstopActive: false, motionInhibited: false
    };
    assert.equal(resolvePoseQuality(snapshot, { transportStale: true }), 'stale');
    assert.equal(checkMissionPreconditions({
        robotSnapshot: snapshot, mapId: map.id,
        mapRevision: map.revision, transportStale: true
    }).ok, false);
    assert.equal(checkMissionPreconditions({
        robotSnapshot: { ...snapshot, poseSourceUpdateAgeMs: null },
        mapId: map.id, mapRevision: map.revision
    }).ok, false);
});

test('C7 coordinator: REST chậm không đè mission event mới, callback sau dispose bị bỏ', async t => {
    reset();
    const current = record();
    let missionListener;
    let release;
    let calls = 0;
    const deferred = new Promise(resolve => { release = resolve; });
    const client = {
        subscribeJobs: () => () => { },
        subscribeMissions: callback => { missionListener = callback; return () => { }; },
        subscribeNavigationPath: () => () => { },
        subscribeRobotState: () => () => { },
        getActiveMappingSession: async () => ({ session: null }),
        getMission: async () => current,
        getActiveMission: async () => ++calls === 1 ? deferred : { mission: current },
    };
    const coordinator = createNavigationCoordinator(client);
    t.after(() => { coordinator.dispose(); reset(); });
    missionListener(event(current, 20));
    release({ mission: { ...current, status: 'accepted' } });
    await until(() => missions.getState(), state => state.reconciliationState === 'ready');
    assert.equal(missions.getState().missionsById.m.status, 'executing');
    coordinator.dispose();
    reset();
    missionListener(event(current, 30));
    assert.equal(missions.getState().activeMissionId, null);
});

test('C7 recovery: job Finish terminal thắng snapshot phiên mapping cũ', async t => {
    reset();
    const session = {
        mappingSessionId: 'session-finished', name: 'Map đã lưu',
        status: 'mapping', startedAt: new Date().toISOString(),
    };
    mapping.getState().setSession(session);
    mapping.getState().selectTrackedJob({
        jobId: 'job-finished', type: 'finish_mapping', requestId: 'req-finished',
        acceptedSession: { ...session, status: 'finishing' },
    });
    const client = {
        subscribeJobs: () => () => {},
        subscribeMissions: () => () => {},
        subscribeRobotState: () => () => {},
        subscribeNavigationPath: () => () => {},
        getActiveMission: async () => ({ mission: null }),
        // REST này có thể được lấy trước khi worker lưu xong.
        getActiveMappingSession: async () => ({ session }),
        getJob: async () => ({
            jobId: 'job-finished', type: 'finish_mapping', status: 'completed',
            result: { mapId: 'saved-map', mapRevision: 'rev-2' },
            error: null, createdAt: new Date().toISOString(),
        }),
    };
    const coordinator = createNavigationCoordinator(client);
    t.after(() => { coordinator.dispose(); reset(); });
    const state = await until(() => mapping.getState(), value => value.ready);
    assert.equal(state.session, null);
    assert.deepEqual(state.viewerContext, {
        kind: 'saved', mapId: 'saved-map', mapRevision: 'rev-2',
    });
    assert.equal(state.trackedOperation.status, 'completed');
});

test('C7 retry: HTTP timeout sau accepted, mission đã terminal vẫn replay cùng requestId', async t => {
    reset();
    const c = createMockRobotClient();
    t.after(() => { c.dispose(); reset(); });
    await c.login({ username: 'admin', password: 'demo-only' });
    const original = c.createMission.bind(c);
    let createdId;
    let first = true;
    const ids = [];
    c.createMission = async request => {
        ids.push(request.requestId);
        const response = await original(request);
        createdId = response.missionId;
        if (first) { first = false; throw Object.assign(new Error('Timeout after accepted'), { code: 'TIMEOUT' }); }
        return response;
    };
    const request = {
        requestId: crypto.randomUUID(), kind: 'navigate_to_pose',
        mapId: map.id, mapRevision: map.revision, poses: [pose]
    };
    await sendMissionIntent(c, request);
    assert.equal(missions.getState().missionRequest.status, 'uncertain');
    await pause(350);
    assert.equal((await c.getMission(createdId)).status, 'succeeded');
    await sendMissionIntent(c, request, true);
    assert.deepEqual(ids, [request.requestId, request.requestId]);
    assert.equal(missions.getState().missionRequest.missionId, createdId);
});

test('C7 request: response của auth generation cũ không hồi sinh store', async () => {
    reset();
    let release;
    const c = { createMission: () => new Promise(resolve => { release = resolve; }) };
    const request = {
        requestId: crypto.randomUUID(), kind: 'navigate_to_pose', mapId: map.id,
        mapRevision: map.revision, poses: [pose]
    };
    const pending = sendMissionIntent(c, request);
    reset();
    release({ missionId: 'old', status: 'accepted' });
    await pending;
    assert.equal(missions.getState().missionRequest, null);
});
