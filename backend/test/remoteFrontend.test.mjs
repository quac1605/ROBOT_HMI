import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import argon2 from 'argon2';
import { WebSocket } from 'ws';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { createServerRuntime } from '../src/server.js';
import { createHttpWsRobotClient } from '../../frontend/src/clients/httpWsRobotClient.js';

// Exercise the actual frontend facade against the actual HTTP and WS server.
// Node has no browser cookie jar, so this adapter supplies only cookie handling
// and Origin; all DTO parsing, CSRF, hello binding and socket lifecycle stay real.
test('M9 real HTTP/WS facade: session, hello, robot/control/map DTO, logout', async () => {
    await assertTestTarget(process.env);
    const origin = 'http://127.0.0.1:4173';
    const dataDir = await mkdtemp(path.join(process.env.DATA_DIR, 'm9-remote-'));
    const runtime = createServerRuntime({ ...process.env,
        HOST: '127.0.0.1', APP_ORIGIN: origin, DATA_DIR: dataDir });
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const username = `remote_${randomUUID().replaceAll('-', '')}`;
    const password = `test-${randomUUID()}`;
    let userId;
    let client;
    let cookies = '';
    try {
        const hash = await argon2.hash(password, { type: argon2.argon2id });
        const inserted = await pool.query(
            'INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id',
            [username, hash]);
        userId = inserted.rows[0].id;
        const started = await runtime.start({ port: 0 });
        const port = started.server.address().port;
        const baseUrl = `http://127.0.0.1:${port}`;
        const wsUrl = `ws://127.0.0.1:${port}`;
        const browserFetch = async (url, options) => {
            const headers = new Headers(options?.headers);
            headers.set('Origin', origin);
            if (cookies) headers.set('Cookie', cookies);
            const response = await fetch(url, { ...options, headers });
            const updated = response.headers.get('set-cookie')?.split(';')[0];
            if (updated) cookies = updated;
            return response;
        };
        class BrowserSocket extends WebSocket {
            constructor(url) {
                super(url, { headers: { Origin: origin, Cookie: cookies } });
            }
        }
        client = createHttpWsRobotClient({ baseUrl, wsUrl,
            fetchImpl: browserFetch, WebSocketClass: BrowserSocket });
        const states = [];
        const unsubscribe = client.subscribeConnectionStatus(value => states.push(value));
        try {
            const login = await client.login({ username, password });
            assert.equal(login.user.username, username);
            const deadline = Date.now() + 2500;
            while (states.at(-1)?.status !== 'connected' && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(states.at(-1)?.status, 'connected', 'Phải nhận hello thực');
            assert.equal(states.at(-1)?.controlProfile, 'mock');
            assert.equal((await client.getSession()).user.username, username);
            const robot = await client.getRobotState();
            assert.equal(robot.rosConnected, false);
            const control = await client.getControlState();
            assert.equal(typeof control.payload.controlGeneration, 'number');
            assert.ok(Array.isArray(await client.listMaps()));
            assert.equal((await client.getActiveMappingSession()).session, null);
            assert.equal((await client.getActiveMission()).mission, null);
            assert.ok(Array.isArray(await client.listCameras()));
            await assert.rejects(() => client.acquireControl({ requestId: randomUUID() }),
                error => error.code === 'ROBOT_NOT_STATIONARY');
            started.sharedRobotState.update({ rosConnected: true,
                physicalEstopActive: false, motionInhibited: false,
                motionInhibitReason: null,
                localization: { status: 'tracking', reason: null } });
            await new Promise(resolve => setTimeout(resolve, 100));
            const controlEvents = [];
            const unsubscribeControl = client.subscribeControl(event => controlEvents.push(event));
            try {
                const lease = await client.acquireControl({ requestId: randomUUID() });
                assert.ok(lease.leaseId);
                const heartbeatDeadline = Date.now() + 1500;
                while (!controlEvents.some(event => event.type === 'control.heartbeat') &&
                    Date.now() < heartbeatDeadline) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                const heartbeat = controlEvents.find(event => event.type === 'control.heartbeat');
                assert.ok(heartbeat, 'Phải có freshness token từ server');
                assert.equal(client.sendVelocity({ leaseId: lease.leaseId, sequence: 1,
                    freshnessToken: heartbeat.payload.freshnessToken,
                    linearX: 0.1, angularZ: 0 }), undefined);
                const ackDeadline = Date.now() + 1000;
                while (!controlEvents.some(event => event.type === 'teleop.commandResult' &&
                    event.payload.commandSequence === 1) && Date.now() < ackDeadline) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                assert.equal(controlEvents.find(event =>
                    event.type === 'teleop.commandResult' &&
                    event.payload.commandSequence === 1)?.payload.success, true);
                assert.equal(started.motionSource.getCommand().velocity.linearX, 0.1);
                const stop = await client.requestStop({ requestId: randomUUID() });
                assert.equal(stop.status, 'accepted');
                assert.throws(() => client.sendVelocity({ leaseId: lease.leaseId,
                    sequence: 2, freshnessToken: heartbeat.payload.freshnessToken,
                    linearX: 0.1, angularZ: 0 }), /CONTROL_TRANSPORT_NOT_READY/);
                started.motionSource.tick();
                const confirmDeadline = Date.now() + 1500;
                while (!controlEvents.some(event => event.type === 'control.stopConfirmed' &&
                    event.payload.requestId === stop.requestId) && Date.now() < confirmDeadline) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                assert.ok(controlEvents.some(event => event.type === 'control.stopConfirmed' &&
                    event.payload.requestId === stop.requestId),
                'Stop chỉ confirmed từ mock source observation mới');
            } finally { unsubscribeControl(); }
            const previousEpoch = states.at(-1).connectionEpoch;
            await client.login({ username, password }); // Server rotates SID and closes old WS.
            const rotationDeadline = Date.now() + 2500;
            while ((states.at(-1)?.status !== 'connected' ||
                states.at(-1)?.connectionEpoch === previousEpoch) &&
                Date.now() < rotationDeadline) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(states.at(-1)?.status, 'connected');
            assert.notEqual(states.at(-1)?.connectionEpoch, previousEpoch,
                'Session rotation phải tạo hello/binding mới');
            assert.equal(typeof (await client.getControlState()).payload.controlGeneration,
                'number');
            await client.logout();
            assert.equal(states.at(-1)?.status, 'disconnected');
            await assert.rejects(() => client.getRobotState(),
                error => error.code === 'UNAUTHENTICATED');
        } finally { unsubscribe(); }
    } finally {
        client?.dispose();
        await runtime.stop();
        if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
        await pool.end();
        await rm(dataDir, { recursive: true, force: true });
    }
});
