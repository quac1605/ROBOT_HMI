/**
 * backend/test/mapGrid.test.mjs
 * 
 * KIỂM THỬ M8 SLICE 2: MAP MANAGEMENT & GRID STREAMING.
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
import { createMapGridService } from '../src/services/mapGridService.js';
import { ListMapsResponseSchema, GetMapResponseSchema } from '@robot-hmi/contracts/mapping';
import { parseMapGridSnapshot } from '@robot-hmi/contracts/mapGrid';

const { Pool } = pg;

test('M8 map subscription: unsubscribe/replacement fence kết quả DB đến muộn', async () => {
    const context = { kind: 'saved', mapId: 'saved-a', mapRevision: 'rev-a' };
    let resolveOld;
    let reads = 0;
    const record = { connectionId: 'map-conn-1', kind: 'map', closed: false,
        subscriptions: new Set() };
    const frames = [];
    const registry = {
        get: id => id === record.connectionId && !record.closed ? record : undefined,
        send: (_id, frame) => { frames.push(frame); return true; },
    };
    const service = createMapGridService({ registry,
        mapPersistence: { getSavedGrid: () => {
            reads += 1;
            return reads === 1 ? new Promise(resolve => { resolveOld = resolve; })
                : Promise.resolve(createFixtureGridSnapshot('saved-a', 'rev-a'));
        } },
    });

    service.subscribeClient(record, { context, subscriptionId: 'old' });
    service.unsubscribeClient(record, 'wrong');
    assert.equal(record.subscriptions.size, 1, 'Sai ID không hủy subscription');
    service.subscribeClient(record, { context, subscriptionId: 'new' });
    resolveOld(createFixtureGridSnapshot('saved-a', 'rev-a'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(record.subscriptions.size, 1, 'Thay thế chỉ giữ một subscription');
    assert.deepEqual(frames.map(frame => frame.subscriptionId), ['new', 'new']);
    service.unsubscribeClient(record, 'new');
    assert.equal(record.subscriptions.size, 0);
});

function createFixtureGridSnapshot(mapId, mapRevision) {
    const width = 4;
    const height = 3;
    return {
        source: 'mock',
        mode: 'snapshot',
        encoding: 'occupancy-0-100-v1',
        context: { kind: 'saved', mapId, mapRevision },
        gridRevision: 1,
        grid: {
            header: { frame_id: 'map', stamp: { sec: 100, nanosec: 0 } },
            info: {
                map_load_time: { sec: 100, nanosec: 0 },
                resolution: 0.05,
                width,
                height,
                origin: {
                    position: { x: 0, y: 0, z: 0 },
                    orientation: { x: 0, y: 0, z: 0, w: 1 },
                },
            },
            data: [
                0, 100, -1, 50,
                100, 0, 50, -1,
                -1, 50, 0, 100,
            ],
        },
    };
}

const FIXTURE_YAML = `image: grid.json\nresolution: 0.05\norigin: [0.0, 0.0, 0.0]\nnegate: 0\noccupied_thresh: 0.65\nfree_thresh: 0.196\n`;

test('M8 Slice 2: Map Management & Grid Streaming (HTTP /api/maps, /api/map-grid, WS /map-stream)', async () => {
    await assertTestTarget(process.env);
    const dataDir = await mkdtemp(path.join(process.env.DATA_DIR, 'm8-grid-'));
    const origin = 'http://127.0.0.1:4173';
    const runtime = createServerRuntime({
        ...process.env,
        HOST: '127.0.0.1',
        APP_ORIGIN: origin,
        DATA_DIR: dataDir,
    });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    const username = `map_${randomUUID().replaceAll('-', '')}`;
    const robotId = `robot-map-${randomUUID().replaceAll('-', '')}`;
    const password = 'test-map-grid-pass';
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await pool.query(
        'INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id',
        [username, hash]
    );
    const userId = inserted.rows[0].id;

    let started;
    let mapId;
    let sessionId;
    let liveSessionId;
    const cookies = new Set();
    const releaseMapFixtureLock = await acquireMapFixtureLock();

    try {
        started = await runtime.start({ port: 0 });
        const port = started.server.address().port;
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. Login lấy auth cookie
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

        // 2. Tạo một bản đồ ready thông qua mapPersistence
        const session = await started.mapPersistence.createMappingSession({
            robotId,
            name: 'Slice 2 Test Session',
        });
        sessionId = session.id;

        const finishRes = await started.mapPersistence.acceptFinish({
            principalScope: username,
            requestId: randomUUID(),
            mappingSessionId: session.id,
            name: 'Slice 2 Map',
        });
        assert.equal(finishRes.status, 202);
        mapId = finishRes.resourceRef.mapId;
        const revision = finishRes.resourceRef.revision;
        const snapshot = createFixtureGridSnapshot(mapId, revision);
        await started.mapPersistence.runFinish({
            jobId: finishRes.body.jobId,
            snapshot,
            yaml: FIXTURE_YAML,
        });

        // 3. GET /api/maps (List maps)
        const listRes = await fetch(`${baseUrl}/api/maps`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(listRes.status, 200);
        const listBody = await listRes.json();
        const parsedList = ListMapsResponseSchema.parse(listBody);
        assert.ok(parsedList.some(m => m.id === mapId && m.revision === revision));

        // 4. GET /api/maps/:id (Get single map)
        const getRes = await fetch(`${baseUrl}/api/maps/${mapId}?revision=${revision}`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(getRes.status, 200);
        const getBody = await getRes.json();
        const parsedMap = GetMapResponseSchema.parse(getBody);
        assert.equal(parsedMap.id, mapId);
        assert.equal(parsedMap.revision, revision);

        // 5. GET /api/map-grid?kind=saved
        const gridRes = await fetch(`${baseUrl}/api/map-grid?kind=saved&mapId=${mapId}&mapRevision=${revision}`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(gridRes.status, 200);
        const gridBody = await gridRes.json();
        const parsedGrid = parseMapGridSnapshot(gridBody);
        assert.equal(parsedGrid.context.kind, 'saved');
        assert.equal(parsedGrid.context.mapId, mapId);
        assert.equal(parsedGrid.grid.data.length, 12);

        // Route query must be strict. Unknown fields or a mixed context must
        // not be silently discarded before MapContextSchema sees them.
        const extraQuery = await fetch(`${baseUrl}/api/map-grid?kind=saved&mapId=${mapId}&mapRevision=${revision}&ignored=1`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(extraQuery.status, 400);
        const mixedContext = await fetch(`${baseUrl}/api/map-grid?kind=saved&mapId=${mapId}&mapRevision=${revision}&mappingSessionId=fake`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(mixedContext.status, 400);

        // A DB-active mapping session alone cannot prove that a source grid
        // exists. Only an explicit adapter start may expose mock live cells.
        const live = await started.mapPersistence.createMappingSession({
            robotId, name: 'Live source guard',
        });
        liveSessionId = live.id;
        const liveUrl = `${baseUrl}/api/map-grid?kind=mapping&mappingSessionId=${live.id}`;
        const missingSource = await fetch(liveUrl, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(missingSource.status, 503);
        assert.equal((await missingSource.json()).error.code, 'MAPPING_GRID_UNAVAILABLE');
        started.robotRuntime.adapter.startMapping(live.id);
        const liveGridResponse = await fetch(liveUrl, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(liveGridResponse.status, 200);
        assert.equal(parseMapGridSnapshot(await liveGridResponse.json()).context.mappingSessionId, live.id);

        // 6. Test WebSocket /map-stream
        const ws = new WebSocket(`ws://127.0.0.1:${port}/map-stream`, {
            headers: { Cookie: authCookie, Origin: origin },
        });

        const mapEvents = [];
        ws.on('message', data => {
            try {
                mapEvents.push(JSON.parse(data.toString('utf8')));
            } catch { /* ignore */ }
        });

        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });

        // Gửi yêu cầu đăng ký nhận grid qua WebSocket
        ws.send(JSON.stringify({
            version: 1,
            type: 'map.subscribe',
            subscriptionId: 'test-sub-1',
            context: { kind: 'saved', mapId, mapRevision: revision },
        }));

        // Đợi nhận frame map.grid và map.status
        let foundGrid = null;
        let foundStatus = null;
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
            foundStatus = mapEvents.find(e => e.type === 'map.status' && e.subscriptionId === 'test-sub-1');
            foundGrid = mapEvents.find(e => e.type === 'map.grid' && e.subscriptionId === 'test-sub-1');
            if (foundStatus && foundGrid) break;
            await new Promise(r => setTimeout(r, 50));
        }

        assert.ok(foundStatus, 'Phải nhận được map.status trên /map-stream');
        assert.ok(foundGrid, 'Phải nhận được map.grid trên /map-stream');
        assert.equal(foundGrid.payload.context.mapId, mapId);

        // Strict wire contract: unknown fields must not silently replace the
        // active subscription. Wrong unsubscribe ID must not cancel it.
        ws.send(JSON.stringify({ version: 1, type: 'map.subscribe',
            subscriptionId: 'bad-sub', context: { kind: 'saved', mapId,
                mapRevision: revision }, extra: true }));
        const invalidDeadline = Date.now() + 2000;
        while (!mapEvents.some(e => e.type === 'error' &&
            e.error?.code === 'INVALID_MAP_SUBSCRIPTION') && Date.now() < invalidDeadline) {
            await new Promise(r => setTimeout(r, 20));
        }
        assert.ok(mapEvents.some(e => e.type === 'error' &&
            e.error?.code === 'INVALID_MAP_SUBSCRIPTION'));

        ws.send(JSON.stringify({ version: 1, type: 'map.unsubscribe',
            subscriptionId: 'wrong-sub' }));
        assert.equal(started.registry.get(mapEvents.find(e =>
            e.type === 'transport.hello').connectionId).subscriptions.size, 1);
        ws.send(JSON.stringify({ version: 1, type: 'map.unsubscribe',
            subscriptionId: 'test-sub-1' }));
        const unsubscribeDeadline = Date.now() + 2000;
        while (started.registry.get(mapEvents.find(e =>
            e.type === 'transport.hello').connectionId)?.subscriptions.size !== 0 &&
            Date.now() < unsubscribeDeadline) {
            await new Promise(r => setTimeout(r, 20));
        }
        assert.equal(started.registry.get(mapEvents.find(e =>
            e.type === 'transport.hello').connectionId)?.subscriptions.size, 0);

        ws.close();
    } finally {
        try {
            await runtime.stop();
            if (mapId) {
                await pool.query('DELETE FROM events WHERE resource_ref->>\'mapId\'=$1', [mapId]);
                await pool.query('DELETE FROM idempotency_requests WHERE principal_scope=$1', [username]);
                await pool.query('DELETE FROM jobs WHERE operation_payload->>\'mapId\'=$1', [mapId]);
                await pool.query('DELETE FROM maps WHERE id=$1', [mapId]);
            }
            if (sessionId) {
                await pool.query('DELETE FROM mapping_sessions WHERE id=$1', [sessionId]);
            }
            if (liveSessionId) {
                await pool.query('DELETE FROM mapping_sessions WHERE id=$1', [liveSessionId]);
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
