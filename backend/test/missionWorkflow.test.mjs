/**
 * backend/test/missionWorkflow.test.mjs
 * 
 * INTEGRATION TEST: M8 SLICE 4 & 5 (ROUTES, MISSIONS, MANUAL STOP & CAMERAS)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import argon2 from 'argon2';
import WebSocket from 'ws';
import { createServerRuntime } from '../src/server.js';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { acquireMapFixtureLock } from './helpers/testDatabaseLock.mjs';

const { Pool } = pg;
function sid(pair) {
    return decodeURIComponent(pair.slice(pair.indexOf('=') + 1)).slice(2).split('.')[0];
}

test('M8 Slice 4 & 5: Routes, Missions, Preemption via Stop & Camera Subsystem', async () => {
    await assertTestTarget(process.env); // Before any database or filesystem mutation.
    const dataDir = await mkdtemp(path.join(process.env.DATA_DIR, 'm8-nav-'));
    const origin = process.env.APP_ORIGIN;
    let baseUrl;
    const testPassword = 'Password123!';
    const passwordHash = await argon2.hash(testPassword, { type: argon2.argon2id });
    const userId = randomUUID();
    const username = `admin_m8_nav_${randomUUID().replaceAll('-', '')}`;
    let mapId;
    let revision;
    let mapFixtureSessionId;
    let ws;
    const cookies = new Set();
    const missionIds = new Set();

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 5,
    });

    const runtime = createServerRuntime({
        ...process.env,
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
    });
    const releaseMapFixtureLock = await acquireMapFixtureLock();

    try {
        const started = await runtime.start({ port: 0 });
        const port = started.server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        await pool.query(
            `INSERT INTO users (id, username, password_hash, enabled)
             VALUES ($1, $2, $3, true)`,
            [userId, username, passwordHash],
        );

        // A ready DB row without verified grid/yaml assets is not a valid map.
        // Build this fixture through the real persistence path instead.
        const session = await started.mapPersistence.createMappingSession({
            robotId: `robot-nav-${randomUUID()}`, name: 'Navigation test map',
        });
        mapFixtureSessionId = session.id;
        started.robotRuntime.sharedRobotState.update({ rosConnected: true });
        started.robotRuntime.adapter.startMapping(session.id);
        started.robotRuntime.adapter.sample(); // Fixture map cần mẫu nguồn mock, Start không tự tạo grid.
        const snapshot = started.robotRuntime.adapter.getMappingGrid(session.id);
        const accepted = await started.mapPersistence.acceptFinish({
            principalScope: username, requestId: randomUUID(),
            mappingSessionId: session.id, name: 'Navigation test map',
        });
        mapId = accepted.resourceRef.mapId;
        revision = accepted.resourceRef.revision;
        const readyJob = await started.mapPersistence.runFinish({
            jobId: accepted.body.jobId, snapshot,
            yaml: 'image: grid.json\nresolution: 0.05\norigin: [0, 0, 0]\n',
        });
        started.robotRuntime.adapter.finishMapping(session.id);
        mapId = readyJob.result.mapId;
        revision = readyJob.result.mapRevision;

        // 1. Lấy CSRF và Đăng nhập
        const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`, {
            headers: { Origin: origin },
        });
        assert.equal(csrfRes.status, 200);
        const anonymousCookie = csrfRes.headers.get('set-cookie')?.split(';')[0];
        assert.ok(anonymousCookie);
        cookies.add(anonymousCookie);
        const { csrfToken } = await csrfRes.json();

        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
                Cookie: anonymousCookie,
                Origin: origin,
            },
            body: JSON.stringify({ username, password: testPassword }),
        });
        assert.equal(loginRes.status, 200);
        const authCookie = loginRes.headers.get('set-cookie')?.split(';')[0];
        assert.ok(authCookie);
        cookies.add(authCookie);

        // Lấy CSRF sau khi authenticate
        const authCsrfRes = await fetch(`${baseUrl}/api/auth/csrf`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        const { csrfToken: authCsrf } = await authCsrfRes.json();

        // Chuẩn bị trạng thái robot sẵn sàng và map đã activate
        started.robotRuntime.sharedRobotState.update({
            rosConnected: true,
            physicalEstopActive: false,
            motionInhibited: false,
            motionInhibitReason: null,
            localization: { status: 'tracking', reason: null },
            activeMap: { id: mapId, revision },
            pose: { frameId: 'map', x: 0, y: 0, yaw: 0 },
        });

        // Kết nối WS /ws
        ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        const wsEvents = [];
        ws.on('message', data => {
            try { wsEvents.push(JSON.parse(data.toString())); } catch { /* ignore */ }
        });
        await new Promise(r => ws.on('open', r));

        // ==========================================
        // TEST A: Preview Route & Save Route & List Routes
        // ==========================================
        const waypoints = [
            { frameId: 'map', x: 1.0, y: 1.0, yaw: 0.0 },
            { frameId: 'map', x: 2.0, y: 3.0, yaw: 1.57 },
        ];

        // 1. Preview route
        const previewRequestId = randomUUID();
        const previewRes = await fetch(`${baseUrl}/api/routes/preview`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({
                requestId: previewRequestId,
                mapId,
                mapRevision: revision,
                poses: waypoints,
            }),
        });
        assert.equal(previewRes.status, 200);
        const { jobId: previewJobId } = await previewRes.json();
        assert.ok(previewJobId);

        // Đợi preview job completed
        let previewJob;
        for (let i = 0; i < 30; i++) {
            const jobRes = await fetch(`${baseUrl}/api/jobs/${previewJobId}`, {
                headers: { Cookie: authCookie, Origin: origin },
            });
            previewJob = await jobRes.json();
            if (previewJob.status === 'completed') break;
            await new Promise(r => setTimeout(r, 50));
        }
        assert.equal(previewJob.status, 'completed');
        assert.equal(previewJob.result.label, 'Đường minh họa');
        assert.ok(Array.isArray(previewJob.result.path));
        assert.ok(previewJob.result.path.length >= 2);
        const previewReplay = await fetch(`${baseUrl}/api/routes/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ requestId: previewRequestId, mapId,
                mapRevision: revision, poses: waypoints }),
        });
        assert.equal(previewReplay.status, 200);
        assert.equal((await previewReplay.json()).jobId, previewJobId,
            'Retry preview không tạo job thứ hai');
        const previewConflict = await fetch(`${baseUrl}/api/routes/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ requestId: previewRequestId, mapId,
                mapRevision: revision, poses: [waypoints[0]] }),
        });
        assert.equal(previewConflict.status, 409);
        assert.equal((await previewConflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');

        // 2. Save route
        const saveRequestId = randomUUID();
        const saveRouteRes = await fetch(`${baseUrl}/api/routes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({
                requestId: saveRequestId,
                name: 'Lộ trình tuần tra 1',
                mapId,
                mapRevision: revision,
                poses: waypoints,
            }),
        });
        assert.equal(saveRouteRes.status, 200);
        const savedRoute = await saveRouteRes.json();
        assert.equal(savedRoute.name, 'Lộ trình tuần tra 1');
        assert.equal(savedRoute.mapId, mapId);
        const saveReplay = await fetch(`${baseUrl}/api/routes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ requestId: saveRequestId,
                name: 'Lộ trình tuần tra 1', mapId,
                mapRevision: revision, poses: waypoints }),
        });
        assert.equal(saveReplay.status, 200);
        assert.deepEqual(await saveReplay.json(), savedRoute,
            'Retry save phải trả đúng route đã commit');
        const saveConflict = await fetch(`${baseUrl}/api/routes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ requestId: saveRequestId,
                name: 'Tên đã đổi', mapId, mapRevision: revision,
                poses: waypoints }),
        });
        assert.equal(saveConflict.status, 409);
        assert.equal((await saveConflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
        const outsideMap = await fetch(`${baseUrl}/api/routes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ requestId: randomUUID(),
                name: 'Ngoài bản đồ', mapId, mapRevision: revision,
                poses: [{ frameId: 'map', x: 100, y: 100, yaw: 0 }] }),
        });
        assert.equal(outsideMap.status, 400);
        assert.equal((await outsideMap.json()).error.code, 'POSE_OUTSIDE_MAP');

        // 3. List routes
        const listRoutesRes = await fetch(`${baseUrl}/api/routes?mapId=${mapId}&mapRevision=${revision}`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(listRoutesRes.status, 200);
        const routesList = await listRoutesRes.json();
        assert.equal(routesList.filter(r => r.routeId === savedRoute.routeId).length, 1);

        // ==========================================
        // TEST B: Create Mission, Execution & Succeeded
        // ==========================================
        const outsideMission = await fetch(`${baseUrl}/api/missions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ requestId: randomUUID(),
                kind: 'navigate_to_pose', mapId, mapRevision: revision,
                poses: [{ frameId: 'map', x: 100, y: 100, yaw: 0 }] }),
        });
        assert.equal(outsideMission.status, 400);
        assert.equal((await outsideMission.json()).error.code, 'POSE_OUTSIDE_MAP');
        const missionReqId = randomUUID();
        const createMissionRes = await fetch(`${baseUrl}/api/missions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({
                requestId: missionReqId,
                kind: 'navigate_through_poses',
                mapId,
                mapRevision: revision,
                poses: [
                    { frameId: 'map', x: 1.5, y: 1.5, yaw: 0 },
                    { frameId: 'map', x: 3.0, y: 3.0, yaw: 0.78 },
                ],
            }),
        });
        assert.equal(createMissionRes.status, 200);
        const { missionId } = await createMissionRes.json();
        assert.ok(missionId);
        missionIds.add(missionId);
        const missionReplay = await fetch(`${baseUrl}/api/missions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ requestId: missionReqId,
                kind: 'navigate_through_poses', mapId,
                mapRevision: revision, poses: [
                    { frameId: 'map', x: 1.5, y: 1.5, yaw: 0 },
                    { frameId: 'map', x: 3.0, y: 3.0, yaw: 0.78 },
                ] }),
        });
        assert.equal(missionReplay.status, 200);
        assert.equal((await missionReplay.json()).missionId, missionId,
            'Retry mission không tạo executor thứ hai');
        const missionConflict = await fetch(`${baseUrl}/api/missions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ requestId: missionReqId,
                kind: 'navigate_to_pose', mapId, mapRevision: revision,
                poses: [{ frameId: 'map', x: 1.5, y: 1.5, yaw: 0 }] }),
        });
        assert.equal(missionConflict.status, 409);
        assert.equal((await missionConflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');

        // Kiểm tra GET /api/missions/active
        const activeRes = await fetch(`${baseUrl}/api/missions/active`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(activeRes.status, 200);
        const { mission: activeMission } = await activeRes.json();
        assert.ok(activeMission);
        assert.equal(activeMission.missionId, missionId);

        // Đợi mission succeeded
        let finishedMission;
        for (let i = 0; i < 40; i++) {
            const mRes = await fetch(`${baseUrl}/api/missions/${missionId}`, {
                headers: { Cookie: authCookie, Origin: origin },
            });
            finishedMission = await mRes.json();
            if (finishedMission.status === 'succeeded') break;
            await new Promise(r => setTimeout(r, 60));
        }
        assert.equal(finishedMission.status, 'succeeded');
        assert.equal(finishedMission.distanceRemainingM, 0);

        // Kiểm tra nhận được WS mission.updated và navigation.path
        assert.ok(wsEvents.some(e => e.type === 'mission.updated' && e.payload?.missionId === missionId));
        assert.ok(wsEvents.some(e => e.type === 'navigation.path' && e.payload?.missionId === missionId));

        // ==========================================
        // TEST C: Mission Cancel & Preemption via POST /api/control/stop
        // ==========================================
        // 1. Test chủ động cancel qua POST /api/missions/:id/cancel
        const cancelMissionReqId = randomUUID();
        const cancelCreateRes = await fetch(`${baseUrl}/api/missions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({
                requestId: cancelMissionReqId,
                kind: 'navigate_to_pose',
                mapId,
                mapRevision: revision,
                poses: [{ frameId: 'map', x: 5.0, y: 5.0, yaw: 0 }],
            }),
        });
        assert.equal(cancelCreateRes.status, 200);
        const { missionId: cancelMissionId } = await cancelCreateRes.json();
        missionIds.add(cancelMissionId);

        const cancelPostRes = await fetch(`${baseUrl}/api/missions/${cancelMissionId}/cancel`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({
                requestId: randomUUID(),
                missionId: cancelMissionId,
            }),
        });
        assert.equal(cancelPostRes.status, 200);
        const cancelResult = await cancelPostRes.json();
        assert.equal(cancelResult.status, 'canceled');
        const lateProgress = await started.robotRuntime.missionsRepo.updateMission(cancelMissionId, {
            status: 'executing', currentPoseIndex: 0,
            allowedStatuses: ['accepted', 'executing'],
        });
        assert.equal(lateProgress, null, 'Late executor không được hồi sinh mission terminal');
        assert.deepEqual(started.robotRuntime.adapter.getCommand().velocity,
            { linearX: 0, angularZ: 0 });

        // 2. Test manual stop preempts active mission (F8.5)
        // Mở lại robot sau khi cancel để tạo mission mới
        started.robotRuntime.sharedRobotState.update({
            motionInhibited: false,
            motionInhibitReason: null,
            localization: { status: 'tracking', reason: null },
        });

        const preemptMissionReqId = randomUUID();
        const preemptCreateRes = await fetch(`${baseUrl}/api/missions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({
                requestId: preemptMissionReqId,
                kind: 'navigate_to_pose',
                mapId,
                mapRevision: revision,
                poses: [{ frameId: 'map', x: 7.0, y: 6.0, yaw: 0 }],
            }),
        });
        assert.equal(preemptCreateRes.status, 200);
        const { missionId: preemptMissionId } = await preemptCreateRes.json();
        missionIds.add(preemptMissionId);

        // Gửi POST /api/control/stop
        const stopRes = await fetch(`${baseUrl}/api/control/stop`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({ requestId: randomUUID() }),
        });
        assert.equal(stopRes.status, 202);

        // Mission phải bị hủy thành canceled
        await new Promise(r => setTimeout(r, 100));
        const preemptedMissionRes = await fetch(`${baseUrl}/api/missions/${preemptMissionId}`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        const preemptedMission = await preemptedMissionRes.json();
        assert.equal(preemptedMission.status, 'canceled');
        await new Promise(r => setTimeout(r, 180)); // Quá một tick mission cũ.
        assert.deepEqual(started.robotRuntime.adapter.getCommand().velocity,
            { linearX: 0, angularZ: 0 }, 'Callback cũ không được phát lại velocity');
        assert.equal((await (await fetch(`${baseUrl}/api/missions/${preemptMissionId}`, {
            headers: { Cookie: authCookie, Origin: origin },
        })).json()).status, 'canceled');

        // A mock source failure must end the mission and lock motion, rather
        // than leave an accepted/executing job with a hidden nonzero command.
        started.robotRuntime.sharedRobotState.update({
            motionInhibited: false, motionInhibitReason: null,
            localization: { status: 'tracking', reason: null },
        });
        const originalWriteMissionVelocity = started.robotRuntime.adapter.writeMissionVelocity;
        started.robotRuntime.adapter.writeMissionVelocity = () => {
            throw new Error('TEST_MISSION_SOURCE_FAILED');
        };
        try {
            const failedCreate = await fetch(`${baseUrl}/api/missions`, {
                method: 'POST', headers: {
                    'Content-Type': 'application/json', 'X-CSRF-Token': authCsrf,
                    Cookie: authCookie, Origin: origin,
                },
                body: JSON.stringify({ requestId: randomUUID(),
                    kind: 'navigate_to_pose', mapId, mapRevision: revision,
                    poses: [{ frameId: 'map', x: 1, y: 1, yaw: 0 }] }),
            });
            assert.equal(failedCreate.status, 200);
            const { missionId: failedMissionId } = await failedCreate.json();
            missionIds.add(failedMissionId);
            let failedMission;
            const failureDeadline = Date.now() + 2000;
            do {
                const response = await fetch(`${baseUrl}/api/missions/${failedMissionId}`, {
                    headers: { Cookie: authCookie, Origin: origin },
                });
                failedMission = await response.json();
                if (failedMission.status === 'failed') break;
                await new Promise(r => setTimeout(r, 20));
            } while (Date.now() < failureDeadline);
            assert.equal(failedMission.status, 'failed');
            assert.equal(started.robotRuntime.sharedRobotState.getSnapshot().mode, 'fault');
            assert.equal(started.robotRuntime.sharedRobotState.getSnapshot().motionInhibited, true);
            assert.deepEqual(started.robotRuntime.adapter.getCommand().velocity,
                { linearX: 0, angularZ: 0 });
        } finally {
            started.robotRuntime.adapter.writeMissionVelocity = originalWriteMissionVelocity;
        }

        // ==========================================
        // TEST D: Camera Subsystem (M8 Slice 5 / F8.6)
        // ==========================================
        // 1. GET /api/cameras
        const camerasRes = await fetch(`${baseUrl}/api/cameras`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(camerasRes.status, 200);
        const cameras = await camerasRes.json();
        assert.equal(cameras.length, 2);
        assert.equal(cameras[0].cameraId, 'front');
        assert.equal(cameras[1].cameraId, 'rear');

        // 2. GET /api/cameras/front/stream
        const frontStreamRes = await fetch(`${baseUrl}/api/cameras/front/stream`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(frontStreamRes.status, 200);
        const frontStream = await frontStreamRes.json();
        assert.equal(frontStream.kind, 'file');
        assert.equal(frontStream.url, '/demo/front.mp4');

        // 3. GET /api/cameras/rear/stream
        const rearStreamRes = await fetch(`${baseUrl}/api/cameras/rear/stream`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(rearStreamRes.status, 200);
        const rearStream = await rearStreamRes.json();
        assert.equal(rearStream.kind, 'file');
        assert.equal(rearStream.url, '/demo/rear.mp4');

        // 4. GET camera không tồn tại -> 404
        const invalidCameraRes = await fetch(`${baseUrl}/api/cameras/unknown/stream`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(invalidCameraRes.status, 404);

        ws.close();
    } finally {
        ws?.close();
        try {
            await runtime.stop();
            await pool.query('DELETE FROM missions WHERE id = ANY($1::text[])',
                [[...missionIds]]);
            if (mapId) {
                await pool.query('DELETE FROM routes WHERE map_id=$1', [mapId]);
                await pool.query("DELETE FROM events WHERE resource_ref->>'mapId'=$1", [mapId]);
            }
            await pool.query('DELETE FROM idempotency_requests WHERE principal_scope=$1', [username]);
            await pool.query('DELETE FROM jobs WHERE principal=$1', [username]);
            if (mapFixtureSessionId) {
                await pool.query('DELETE FROM mapping_sessions WHERE id=$1', [mapFixtureSessionId]);
            }
            if (mapId) await pool.query('DELETE FROM maps WHERE id=$1', [mapId]);
            for (const pair of cookies) {
                await pool.query('DELETE FROM session WHERE sid=$1', [sid(pair)]);
            }
            await pool.query('DELETE FROM users WHERE id=$1', [userId]);
        } finally {
            try {
                await pool.end();
            } finally {
                try {
                    await rm(dataDir, { recursive: true, force: true });
                } finally {
                    await releaseMapFixtureLock();
                }
            }
        }
    }
});
