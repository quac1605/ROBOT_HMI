/**
 * backend/test/mappingWorkflow.test.mjs
 * 
 * KIỂM THỬ M8 SLICE 3: MAPPING WORKFLOW, JOBS & MAP ACTIVATION.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import argon2 from 'argon2';
import { WebSocket } from 'ws';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { acquireMapFixtureLock } from './helpers/testDatabaseLock.mjs';
import { createServerRuntime } from '../src/server.js';
import {
    StartMappingResponseSchema,
    FinishMappingResponseSchema,
    GetActiveMappingSessionResponseSchema,
} from '@robot-hmi/contracts/mapping';
import { ActivateMapResponseSchema } from '@robot-hmi/contracts/mission';
import { JobSchema } from '@robot-hmi/contracts/job';

const { Pool } = pg;

test('M8 Slice 3: Mapping Workflow (Start -> Active -> Finish -> Jobs -> Activate)', async () => {
    await assertTestTarget(process.env);
    const dataDir = await mkdtemp(path.join(process.env.DATA_DIR, 'm8-mapping-'));
    const origin = 'http://127.0.0.1:4173';
    const runtime = createServerRuntime({
        ...process.env,
        HOST: '127.0.0.1',
        APP_ORIGIN: origin,
        DATA_DIR: dataDir,
    });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    const username = `mapwf_${randomUUID().replaceAll('-', '')}`;
    const password = 'test-mapping-pass';
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await pool.query(
        'INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id',
        [username, hash]
    );
    const userId = inserted.rows[0].id;

    let started;
    let createdMapId;
    let mappingSessionId;
    let ws;
    let originalStoreAssetForCleanup;
    const cookies = new Set();
    const releaseMapFixtureLock = await acquireMapFixtureLock();

    try {
        started = await runtime.start({ port: 0 });
        const port = started.server.address().port;
        const baseUrl = `http://127.0.0.1:${port}`;

        // Dữ liệu cũ là lỗi setup phải thấy rõ, không tự tắt session của lượt khác.
        const activeBefore = await pool.query(
            "SELECT id FROM mapping_sessions WHERE robot_id='robot-01' AND active=true"
        );
        assert.equal(activeBefore.rowCount, 0, 'Test DB còn mapping session active');

        // 1. Login lấy auth cookie và CSRF
        const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`, { headers: { Origin: origin } });
        const initCookie = csrfRes.headers.get('set-cookie')?.split(';')[0];
        if (initCookie) cookies.add(initCookie);
        const { csrfToken } = await csrfRes.json();

        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
                Cookie: initCookie,
                Origin: origin,
            },
            body: JSON.stringify({ username, password }),
        });
        assert.equal(loginRes.status, 200);
        const authCookie = loginRes.headers.get('set-cookie')?.split(';')[0];
        assert.ok(authCookie);
        cookies.add(authCookie);

        // Lấy CSRF token cho session đã authenticate
        const authCsrfRes = await fetch(`${baseUrl}/api/auth/csrf`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        const { csrfToken: authCsrf } = await authCsrfRes.json();
        assert.ok(authCsrf);

        // Khởi tạo trạng thái robot sẵn sàng (ready, không bị inhibit)
        started.robotRuntime.sharedRobotState.update({
            rosConnected: true,
            physicalEstopActive: false,
            motionInhibited: false,
            motionInhibitReason: null,
            localization: { status: 'tracking', reason: null },
        });

        // Kết nối WS /ws để nghe job.updated
        ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        const wsEvents = [];
        ws.on('message', data => {
            try { wsEvents.push(JSON.parse(data.toString('utf8'))); } catch { /* ignore */ }
        });
        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });

        // 2. GET /api/mapping/sessions/active -> ban đầu chưa có session
        const initActiveRes = await fetch(`${baseUrl}/api/mapping/sessions/active`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(initActiveRes.status, 200);
        const initActiveBody = GetActiveMappingSessionResponseSchema.parse(await initActiveRes.json());
        assert.equal(initActiveBody.session, null);

        // 3. POST /api/mapping/start
        const startReqId = randomUUID();
        const startRes = await fetch(`${baseUrl}/api/mapping/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({ name: 'Office Mapping Flow', requestId: startReqId }),
        });
        assert.equal(startRes.status, 200);
        const startBody = StartMappingResponseSchema.parse(await startRes.json());
        assert.equal(startBody.status, 'accepted');
        mappingSessionId = startBody.mappingSessionId;
        const startJobId = startBody.jobId;

        // A lost HTTP response must not create a second mapping session/job.
        const replayStart = await fetch(`${baseUrl}/api/mapping/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ name: 'Office Mapping Flow', requestId: startReqId }),
        });
        assert.equal(replayStart.status, 200);
        assert.deepEqual(StartMappingResponseSchema.parse(await replayStart.json()), startBody);
        const changedStart = await fetch(`${baseUrl}/api/mapping/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ name: 'Different Map', requestId: startReqId }),
        });
        assert.equal(changedStart.status, 409);
        assert.equal((await changedStart.json()).error.code, 'IDEMPOTENCY_CONFLICT');

        // Kiểm tra robot state đã đổi sang mode mapping
        const stateRes = await fetch(`${baseUrl}/api/robot/state`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        const state = await stateRes.json();
        assert.equal(state.mode, 'mapping');
        assert.equal(state.activeMappingSessionId, mappingSessionId);

        // Kiểm tra GET /api/mapping/sessions/active đã thấy session
        const activeRes = await fetch(`${baseUrl}/api/mapping/sessions/active`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(activeRes.status, 200);
        const activeBody = GetActiveMappingSessionResponseSchema.parse(await activeRes.json());
        assert.equal(activeBody.session?.mappingSessionId, mappingSessionId);
        assert.equal(activeBody.session?.status, 'mapping');

        // Kiểm tra start_mapping job status
        const startJobRes = await fetch(`${baseUrl}/api/jobs/${startJobId}`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(startJobRes.status, 200);
        const startJob = JobSchema.parse(await startJobRes.json());
        assert.equal(startJob.status, 'completed');
        assert.equal(startJob.result?.mappingSessionId, mappingSessionId);

        // Kiểm tra không cho start mapping lần 2 khi đang có session active
        const conflictStartRes = await fetch(`${baseUrl}/api/mapping/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({ name: 'Another Map', requestId: randomUUID() }),
        });
        assert.equal(conflictStartRes.status, 409);

        // 4. POST /api/mapping/finish
        // Fail exactly one asset write. A failed save must preserve the live
        // snapshot/session so a NEW requestId can retry without remapping.
        const originalStoreAsset = started.assetStore.storeAsset;
        originalStoreAssetForCleanup = originalStoreAsset;
        let failOneWrite = true;
        started.assetStore.storeAsset = async input => {
            if (failOneWrite) {
                failOneWrite = false;
                throw new Error('TEST_ASSET_WRITE_FAILURE');
            }
            return originalStoreAsset(input);
        };
        const finishReqId = randomUUID();
        const finishRes = await fetch(`${baseUrl}/api/mapping/finish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({
                mappingSessionId,
                name: 'Final Office Map',
                requestId: finishReqId,
            }),
        });
        assert.equal(finishRes.status, 200);
        const finishBody = FinishMappingResponseSchema.parse(await finishRes.json());
        assert.equal(finishBody.status, 'accepted');
        const finishJobId = finishBody.jobId;

        const replayFinish = await fetch(`${baseUrl}/api/mapping/finish`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ mappingSessionId, name: 'Final Office Map',
                requestId: finishReqId }),
        });
        assert.equal(replayFinish.status, 200);
        assert.deepEqual(FinishMappingResponseSchema.parse(await replayFinish.json()), finishBody);

        let failedFinishJob;
        const failedDeadline = Date.now() + 3000;
        while (Date.now() < failedDeadline) {
            const response = await fetch(`${baseUrl}/api/jobs/${finishJobId}`, {
                headers: { Cookie: authCookie, Origin: origin },
            });
            failedFinishJob = JobSchema.parse(await response.json());
            if (failedFinishJob.status === 'failed') break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(failedFinishJob.status, 'failed');
        assert.equal((await pool.query('SELECT status,active FROM mapping_sessions WHERE id=$1',
            [mappingSessionId])).rows[0].status, 'save_failed');
        assert.equal(started.robotRuntime.sharedRobotState.getSnapshot().activeMappingSessionId,
            mappingSessionId);
        assert.ok(started.robotRuntime.adapter.getMappingGrid(mappingSessionId));
        started.assetStore.storeAsset = originalStoreAsset;

        const retryFinishRes = await fetch(`${baseUrl}/api/mapping/finish`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
            body: JSON.stringify({ mappingSessionId, name: 'Final Office Map',
                requestId: randomUUID() }),
        });
        assert.equal(retryFinishRes.status, 200);
        const retryFinish = FinishMappingResponseSchema.parse(await retryFinishRes.json());
        assert.notEqual(retryFinish.jobId, finishJobId);

        // Đợi background finish_mapping hoàn tất
        let finishJobCompleted = null;
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            const jobRes = await fetch(`${baseUrl}/api/jobs/${retryFinish.jobId}`, {
                headers: { Cookie: authCookie, Origin: origin },
            });
            if (jobRes.status === 200) {
                const job = JobSchema.parse(await jobRes.json());
                if (job.status === 'completed') {
                    finishJobCompleted = job;
                    break;
                }
            }
            await new Promise(r => setTimeout(r, 50));
        }

        assert.ok(finishJobCompleted, 'Job finish_mapping phải hoàn tất thành công');
        createdMapId = finishJobCompleted.result?.mapId;
        const createdRevision = finishJobCompleted.result?.mapRevision;
        assert.ok(createdMapId);
        assert.ok(createdRevision);

        // Kiểm tra sau khi finish: active mapping session là null
        const afterFinishActiveRes = await fetch(`${baseUrl}/api/mapping/sessions/active`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        const afterFinishActiveBody = GetActiveMappingSessionResponseSchema.parse(await afterFinishActiveRes.json());
        assert.equal(afterFinishActiveBody.session, null);

        // 5. POST /api/maps/activate
        const activateReqId = randomUUID();
        const activateRes = await fetch(`${baseUrl}/api/maps/activate`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': authCsrf,
                Cookie: authCookie,
                Origin: origin,
            },
            body: JSON.stringify({
                mapId: createdMapId,
                mapRevision: createdRevision,
                requestId: activateReqId,
            }),
        });
        assert.equal(activateRes.status, 200);
        const activateBody = ActivateMapResponseSchema.parse(await activateRes.json());
        assert.equal(activateBody.status, 'accepted');

        // Kiểm tra activate_map job status
        const activateJobRes = await fetch(`${baseUrl}/api/jobs/${activateBody.jobId}`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(activateJobRes.status, 200);
        const activateJob = JobSchema.parse(await activateJobRes.json());
        assert.equal(activateJob.status, 'completed');
        assert.equal(activateJob.result?.mapId, createdMapId);

        // Kiểm tra robot state đã chuyển activeMap sang map vừa tạo
        const finalStateRes = await fetch(`${baseUrl}/api/robot/state`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        const finalState = await finalStateRes.json();
        assert.equal(finalState.mode, 'idle');
        assert.equal(finalState.activeMap?.id, createdMapId);
        assert.equal(finalState.activeMap?.revision, createdRevision);
        assert.equal(finalState.localization.status, 'tracking');

        // Adapter ACK sai context không được biến thành completed/tracking.
        const originalActivate = started.robotRuntime.adapter.activateMap;
        started.robotRuntime.adapter.activateMap = () => ({
            mapId: 'wrong-map', mapRevision: createdRevision, status: 'ready',
        });
        try {
            const invalidActivationId = randomUUID();
            const invalidActivation = await fetch(`${baseUrl}/api/maps/activate`, {
                method: 'POST', headers: { 'Content-Type': 'application/json',
                    'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
                body: JSON.stringify({ mapId: createdMapId,
                    mapRevision: createdRevision, requestId: invalidActivationId }),
            });
            assert.equal(invalidActivation.status, 503);
            assert.equal((await invalidActivation.json()).error.code,
                'ACTIVATION_CONTEXT_MISMATCH');
            const row = await pool.query(
                "SELECT resource_ref->>'jobId' AS id FROM idempotency_requests " +
                'WHERE principal_scope=$1 AND request_id=$2',
                [username, invalidActivationId]);
            assert.equal(row.rowCount, 1);
            const failedJobRes = await fetch(`${baseUrl}/api/jobs/${row.rows[0].id}`, {
                headers: { Cookie: authCookie, Origin: origin },
            });
            assert.equal(failedJobRes.status, 200);
            assert.equal(JobSchema.parse(await failedJobRes.json()).status, 'failed');
            const failedStateRes = await fetch(`${baseUrl}/api/robot/state`, {
                headers: { Cookie: authCookie, Origin: origin },
            });
            const failedState = await failedStateRes.json();
            assert.equal(failedState.activeMap, null);
            assert.equal(failedState.localization.status, 'unknown');
            assert.equal(failedState.motionInhibited, true);

            // Replay returns the original job even though activation left the robot inhibited.
            const replayInvalid = await fetch(`${baseUrl}/api/maps/activate`, {
                method: 'POST', headers: { 'Content-Type': 'application/json',
                    'X-CSRF-Token': authCsrf, Cookie: authCookie, Origin: origin },
                body: JSON.stringify({ mapId: createdMapId,
                    mapRevision: createdRevision, requestId: invalidActivationId }),
            });
            assert.equal(replayInvalid.status, 200);
            assert.equal(ActivateMapResponseSchema.parse(await replayInvalid.json()).jobId,
                row.rows[0].id);
        } finally {
            started.robotRuntime.adapter.activateMap = originalActivate;
        }

        ws.close();
    } finally {
        // The fixture may fail before the explicit restore above.
        if (started?.assetStore && typeof originalStoreAssetForCleanup === 'function') {
            started.assetStore.storeAsset = originalStoreAssetForCleanup;
        }
        ws?.close();
        try {
            await runtime.stop();
            // Chỉ xóa fixture thuộc principal của test; không chạm session
            // hoặc map của test khác dù cùng robot_id.
            const mapRows = await pool.query(
                "SELECT DISTINCT operation_payload->>'mapId' AS id FROM jobs " +
                "WHERE principal=$1 AND operation_payload ? 'mapId'", [username]
            );
            const mapIds = [...new Set([
                createdMapId, ...mapRows.rows.map(row => row.id),
            ].filter(Boolean))];
            await pool.query('DELETE FROM events WHERE principal=$1', [username]);
            await pool.query('DELETE FROM idempotency_requests WHERE principal_scope=$1', [username]);
            await pool.query('DELETE FROM jobs WHERE principal=$1', [username]);
            if (mappingSessionId) {
                await pool.query('DELETE FROM mapping_sessions WHERE id=$1', [mappingSessionId]);
            }
            for (const mapId of mapIds) {
                await pool.query('DELETE FROM maps WHERE id=$1', [mapId]);
            }
            for (const pair of cookies) {
                const sid = decodeURIComponent(pair.slice(pair.indexOf('=') + 1)).slice(2).split('.')[0];
                await pool.query('DELETE FROM session WHERE sid=$1', [sid]);
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
