/**
 * backend/test/control.test.mjs
 * 
 * KIỂM THỬ TÍCH HỢP M7: CONTROL AUTHORITY, MULTI-TAB LEASE ISOLATION & MEASURED STOP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import pg from 'pg';
import argon2 from 'argon2';
import { createServerRuntime } from '../src/server.js';
import { ControlEventEnvelopeSchema } from '@robot-hmi/contracts/control';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { acquireMapFixtureLock } from './helpers/testDatabaseLock.mjs';
import { APP_BUFFER_BUDGET } from '../src/realtime/outboundQueue.js';

const { Pool } = pg;

function sidFromCookie(pair) {
    return decodeURIComponent(pair.slice(pair.indexOf('=') + 1)).slice(2).split('.')[0];
}

function connectWs(port, cookie, origin, path = '/ws') {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
            headers: {
                Cookie: cookie,
                Origin: origin,
            },
        });
        const messages = [];
        ws.on('message', data => {
            try {
                messages.push(JSON.parse(data.toString('utf8')));
            } catch { /* ignore */ }
        });
        ws.once('open', () => resolve({ ws, messages }));
        ws.once('error', reject);
    });
}

function waitForMessage(messages, predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
            const found = messages.find(predicate);
            if (found) {
                clearInterval(interval);
                resolve(found);
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(interval);
                reject(new Error(`Timeout waiting for message matching predicate after ${timeoutMs}ms`));
            }
        }, 15);
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('M7 Integration: Multi-tab Lease Isolation, Teleop Watchdog & Measured Stop', async (t) => {
    await assertTestTarget(process.env);
    const origin = 'http://127.0.0.1:4173';
    const runtime = createServerRuntime({
        ...process.env,
        HOST: '127.0.0.1',
        APP_ORIGIN: origin,
    });
    const username = `m7_${randomUUID().replaceAll('-', '')}`;
    const password = 'test-only-m7-password';
    let userId;
    const cookies = new Set();
    const releaseMapFixtureLock = await acquireMapFixtureLock();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    t.after(async () => {
        try {
            await runtime.stop();
            for (const pair of cookies) {
                await pool.query('DELETE FROM session WHERE sid=$1', [sidFromCookie(pair)]);
            }
            if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
        } finally {
            try {
                await pool.end();
            } finally {
                await releaseMapFixtureLock();
            }
        }
    });

    const started = await runtime.start({ port: 0 });
    const port = started.server.address().port;

    // Tạo test user riêng biệt bằng argon2id
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await pool.query(
        'INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id',
        [username, hash]);
    userId = inserted.rows[0].id;

    // 1. Đăng nhập tạo Session Cookie & CSRF Token
    const csrfRes = await fetch(`http://127.0.0.1:${port}/api/auth/csrf`, {
        headers: { Origin: origin },
    });
    const cookieHeader = csrfRes.headers.get('set-cookie');
    const cookie = cookieHeader?.split(';')[0];
    if (cookie) cookies.add(cookie);
    const { csrfToken } = await csrfRes.json();

    const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: cookie,
            Origin: origin,
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ username, password }),
    });
    assert.equal(loginRes.status, 200);
    const authCookie = loginRes.headers.get('set-cookie')?.split(';')[0] || cookie;
    if (authCookie) cookies.add(authCookie);
    const authCsrf = loginRes.headers.get('x-csrf-token') || csrfToken;

    // 2. Mở 2 Tab WebSocket độc lập trên cùng 1 session
    const tab1 = await connectWs(port, authCookie, origin, '/ws');
    const tab2 = await connectWs(port, authCookie, origin, '/ws');

    const hello1Msg = await waitForMessage(tab1.messages, m => m.type === 'transport.hello');
    const hello2Msg = await waitForMessage(tab2.messages, m => m.type === 'transport.hello');

    assert.ok(hello1Msg.connectionId);
    assert.ok(hello1Msg.ownerToken);
    assert.ok(hello2Msg.connectionId);
    assert.ok(hello2Msg.ownerToken);
    assert.notEqual(hello1Msg.connectionId, hello2Msg.connectionId);
    assert.notEqual(hello1Msg.ownerToken, hello2Msg.ownerToken);

    // M6/F6.3: subscription emits an initial snapshot synchronously. The
    // WebSocket must forward it after hello, with no owner's lease in either tab.
    const initial1 = await waitForMessage(tab1.messages, m => m.type === 'control.snapshot');
    const initial2 = await waitForMessage(tab2.messages, m => m.type === 'control.snapshot');
    assert.equal(ControlEventEnvelopeSchema.safeParse(initial1).success, true);
    assert.equal(ControlEventEnvelopeSchema.safeParse(initial2).success, true);
    assert.equal(initial1.payload.ownership, 'none');
    assert.equal(initial2.payload.ownership, 'none');
    assert.equal(initial1.payload.lease, null);
    assert.equal(initial2.payload.lease, null);

    // A fresh process has no verified ROS/E-stop observation. The public
    // acquire route must fail closed before the test explicitly simulates a
    // healthy mock source. This prevents an optimistic boot state from passing.
    const coldAcquire = await fetch(`http://127.0.0.1:${port}/api/control/lease`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json', Cookie: authCookie,
            Origin: origin, 'X-CSRF-Token': authCsrf,
            'X-HMI-Connection-Id': hello1Msg.connectionId,
            'X-HMI-Owner-Token': hello1Msg.ownerToken,
        },
        body: JSON.stringify({ requestId: 'req-lease-before-source' }),
    });
    assert.equal(coldAcquire.status, 409);
    assert.equal((await coldAcquire.json()).error.code, 'ROBOT_NOT_STATIONARY');

    started.sharedRobotState.update({
        rosConnected: true, physicalEstopActive: false,
        motionInhibited: false, motionInhibitReason: null,
        localization: { status: 'tracking', reason: null },
    });
    await sleep(100); // wait for an actual mock source tick, not an HTTP heartbeat

    // 3. Tab 1 xin Lease thành công
    const leaseRes1 = await fetch(`http://127.0.0.1:${port}/api/control/lease`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: authCookie,
            Origin: origin,
            'X-CSRF-Token': authCsrf,
            'X-HMI-Connection-Id': hello1Msg.connectionId,
            'X-HMI-Owner-Token': hello1Msg.ownerToken,
        },
        body: JSON.stringify({ requestId: 'req-lease-tab1' }),
    });
    assert.equal(leaseRes1.status, 200);
    const lease1 = await leaseRes1.json();
    assert.equal(lease1.controlGeneration, 1);
    assert.ok(lease1.leaseId);

    // Tab 1 nhận được event control.granted qua WebSocket
    const granted1 = await waitForMessage(tab1.messages, m => m.type === 'control.granted');
    assert.equal(granted1.payload.leaseId, lease1.leaseId);
    const observerEvent = await waitForMessage(tab2.messages,
        m => m.type === 'control.snapshot' && m.payload.ownership === 'other');
    assert.equal(observerEvent.payload.lease, null);
    assert.equal(tab2.messages.some(m => m.type === 'control.granted'), false);

    // The independent map channel has no control subject. Closing it must
    // leave the app tab's lease and WebSocket binding intact.
    const mapSocket = await connectWs(port, authCookie, origin, '/map-stream');
    const mapHello = await waitForMessage(mapSocket.messages, m => m.type === 'transport.hello');
    assert.equal(mapHello.ownerToken, undefined);
    mapSocket.ws.terminate();
    await new Promise(resolve => mapSocket.ws.once('close', resolve));
    assert.equal(runtime.controlSubjectRegistry.appSubjectFor(hello1Msg.connectionId) !== null, true);

    // 4. Tab 2 xin Lease -> bị từ chối 409 CONTROL_BUSY
    const leaseRes2 = await fetch(`http://127.0.0.1:${port}/api/control/lease`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: authCookie,
            Origin: origin,
            'X-CSRF-Token': authCsrf,
            'X-HMI-Connection-Id': hello2Msg.connectionId,
            'X-HMI-Owner-Token': hello2Msg.ownerToken,
        },
        body: JSON.stringify({ requestId: 'req-lease-tab2' }),
    });
    assert.equal(leaseRes2.status, 409);
    const errLease2 = await leaseRes2.json();
    assert.equal(errLease2.error.code, 'CONTROL_BUSY');

    // Kẻ tấn công giả mạo token -> 403 OWNER_BINDING_REJECTED
    const fakeRes = await fetch(`http://127.0.0.1:${port}/api/control/lease`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: authCookie,
            Origin: origin,
            'X-CSRF-Token': authCsrf,
            'X-HMI-Connection-Id': hello1Msg.connectionId,
            'X-HMI-Owner-Token': '0000000000000000000000000000000000000000000000000000000000000000',
        },
        body: JSON.stringify({ requestId: 'req-fake' }),
    });
    assert.equal(fakeRes.status, 403);
    const fakeErr = await fakeRes.json();
    assert.equal(fakeErr.error.code, 'OWNER_BINDING_REJECTED');

    // 5. Kiểm tra tính cô lập Snapshot: Tab 1 (owner) thấy lease; Tab 2 (observer) nhận lease: null
    const stateRes1 = await fetch(`http://127.0.0.1:${port}/api/control/state`, {
        headers: {
            Cookie: authCookie,
            Origin: origin,
            'X-HMI-Connection-Id': hello1Msg.connectionId,
            'X-HMI-Owner-Token': hello1Msg.ownerToken,
        },
    });
    assert.equal(stateRes1.status, 200);
    const state1 = await stateRes1.json();
    assert.equal(state1.payload.ownership, 'self');
    assert.equal(state1.payload.lease?.leaseId, lease1.leaseId);

    const stateRes2 = await fetch(`http://127.0.0.1:${port}/api/control/state`, {
        headers: {
            Cookie: authCookie,
            Origin: origin,
            'X-HMI-Connection-Id': hello2Msg.connectionId,
            'X-HMI-Owner-Token': hello2Msg.ownerToken,
        },
    });
    assert.equal(stateRes2.status, 200);
    const state2 = await stateRes2.json();
    assert.equal(state2.payload.ownership, 'other');
    assert.equal(state2.payload.lease, null);

    // 6. Gửi vận tốc Teleop qua WebSocket & Watchdog Revocation
    const heartbeatMsg = await waitForMessage(tab1.messages, m => m.type === 'control.heartbeat');
    assert.ok(heartbeatMsg.payload.freshnessToken);

    tab1.ws.send(JSON.stringify({
        type: 'teleop.velocity',
        leaseId: lease1.leaseId,
        sequence: 1,
        freshnessToken: heartbeatMsg.payload.freshnessToken,
        linearX: 0.1,
        angularZ: 0,
    }));

    const cmdResult = await waitForMessage(tab1.messages, m => m.type === 'teleop.commandResult');
    assert.equal(cmdResult.payload.success, true);
    assert.equal(cmdResult.payload.commandSequence, 1);

    // Đợi > 300ms không gửi lệnh -> Watchdog hết hạn, tự động thu hồi lease
    const revokedMsg = await waitForMessage(tab1.messages, m => m.type === 'control.revoked', 3000);
    assert.equal(revokedMsg.payload.reason, 'WATCHDOG_TIMEOUT');
    assert.equal(revokedMsg.payload.leaseId, lease1.leaseId);

    // Đợi một nhịp 75ms để cảm biến robot phát mẫu đo đứng yên (stationary sample) sau khi dừng
    await sleep(75);

    // 7. Measured Stop Flow: Tab 1 nhận lease mới; Tab 2 phát lệnh Stop -> 202 Accepted & Measured Confirmation
    const leaseRes3 = await fetch(`http://127.0.0.1:${port}/api/control/lease`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: authCookie,
            Origin: origin,
            'X-CSRF-Token': authCsrf,
            'X-HMI-Connection-Id': hello1Msg.connectionId,
            'X-HMI-Owner-Token': hello1Msg.ownerToken,
        },
        body: JSON.stringify({ requestId: 'req-lease-round-2' }),
    });
    assert.equal(leaseRes3.status, 200);
    const lease3 = await leaseRes3.json();


    // A ticket admitted before stop must stay invalid even if the mock sensor
    // confirms zero before the HTTP response reaches this test process.
    const preStopTicket = runtime.motionGate.enter();
    // Tab 2 (không có lease) gọi HTTP Stop
    const stopRes = await fetch(`http://127.0.0.1:${port}/api/control/stop`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: authCookie,
            Origin: origin,
            'X-CSRF-Token': authCsrf,
        },
        body: JSON.stringify({ requestId: 'stop-req-1' }),
    });
    assert.equal(stopRes.status, 202); // HTTP 202 Accepted!
    const stopBody = await stopRes.json();
    assert.equal(stopBody.requestId, 'stop-req-1');
    assert.equal(stopBody.status, 'accepted');

    // Stop advances the admission epoch permanently for old intents. Checking
    // enter() here would race a valid early measured confirmation.
    assert.throws(() => runtime.motionGate.assert(preStopTicket),
        error => error.code === 'MOTION_ADMISSION_BLOCKED');

    // Kích thích nguồn phát mẫu đo dừng thực sự
    runtime.motionSource.tick();

    // Tab 1 và Tab 2 đều nhận được stopConfirmed
    const stopConfirmedMsg = await waitForMessage(tab1.messages, m => m.type === 'control.stopConfirmed');
    assert.equal(stopConfirmedMsg.payload.requestId, 'stop-req-1');
    assert.equal(stopConfirmedMsg.payload.evidenceKind, 'mock-source-observation');

    // Reconnect is a new tab identity. The old HTTP capability is fenced and
    // an old velocity command cannot acquire or move the robot implicitly.
    const oldClose = new Promise(resolve => tab1.ws.once('close', resolve));
    tab1.ws.terminate();
    await oldClose;
    const reconnected = await connectWs(port, authCookie, origin, '/ws');
    const reconnectHello = await waitForMessage(reconnected.messages,
        m => m.type === 'transport.hello');
    assert.notEqual(reconnectHello.connectionId, hello1Msg.connectionId);
    assert.notEqual(reconnectHello.ownerToken, hello1Msg.ownerToken);
    const oldBinding = await fetch(`http://127.0.0.1:${port}/api/control/lease`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: authCookie,
            Origin: origin, 'X-CSRF-Token': authCsrf,
            'X-HMI-Connection-Id': hello1Msg.connectionId,
            'X-HMI-Owner-Token': hello1Msg.ownerToken },
        body: JSON.stringify({ requestId: 'req-after-old-socket' }),
    });
    assert.equal(oldBinding.status, 403);
    const reconnectSnapshot = await waitForMessage(reconnected.messages,
        m => m.type === 'control.snapshot');
    assert.notEqual(reconnectSnapshot.payload.ownership, 'self');
    reconnected.ws.send(JSON.stringify({ type: 'teleop.velocity',
        leaseId: lease1.leaseId, sequence: 2,
        freshnessToken: heartbeatMsg.payload.freshnessToken,
        linearX: 0.1, angularZ: 0 }));
    const staleResult = await waitForMessage(reconnected.messages,
        m => m.type === 'teleop.commandResult' && m.payload.commandSequence === 2);
    assert.equal(staleResult.payload.success, false);
    assert.deepEqual(runtime.motionSource.getCommand().velocity,
        { linearX: 0, angularZ: 0 });

    // Reacquire through the new capability, then simulate a slow consumer.
    // Revoking the WebSocket record must synchronously revoke motion owner.
    runtime.motionSource.tick();
    const reacquire = await fetch(`http://127.0.0.1:${port}/api/control/lease`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: authCookie,
            Origin: origin, 'X-CSRF-Token': authCsrf,
            'X-HMI-Connection-Id': reconnectHello.connectionId,
            'X-HMI-Owner-Token': reconnectHello.ownerToken },
        body: JSON.stringify({ requestId: 'req-new-socket-owner' }),
    });
    assert.equal(reacquire.status, 200);
    const serverWs = runtime.registry.get(reconnectHello.connectionId).ws;
    reconnected.ws.on('error', () => {});
    serverWs._socket.cork();
    serverWs.send(JSON.stringify({ type: 'robot.state',
        payload: { testPadding: 'x'.repeat(APP_BUFFER_BUDGET + 1) } }));
    assert.ok(serverWs.bufferedAmount > APP_BUFFER_BUDGET);
    assert.equal(runtime.registry.send(reconnectHello.connectionId,
        reconnectSnapshot), false);
    assert.equal(runtime.controlSubjectRegistry.appSubjectFor(reconnectHello.connectionId), null);
    assert.deepEqual(runtime.motionSource.getCommand().velocity,
        { linearX: 0, angularZ: 0 });
    serverWs._socket.uncork();

    // The HTTP stop-only subject outlives sockets, but not the login SID.
    const stopOnlyId = `session:${sidFromCookie(authCookie)}`;
    assert.doesNotThrow(() => runtime.controlAuthority.getControlState(stopOnlyId));
    const logoutRes = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
        method: 'POST', headers: { Cookie: authCookie, Origin: origin,
            'X-CSRF-Token': authCsrf },
    });
    assert.equal(logoutRes.status, 204);
    assert.throws(() => runtime.controlAuthority.getControlState(stopOnlyId),
        error => error.code === 'UNAUTHENTICATED');

    // Đóng kết nối WebSockets
    reconnected.ws.terminate();
    tab2.ws.terminate();
    await sleep(100);
});
