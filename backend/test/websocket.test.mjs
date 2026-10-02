/**
 * backend/test/websocket.test.mjs
 * 
 * INTEGRATION TEST WEBSOCKET, DANH TÍNH TAB VÀ OWNER TOKEN BINDING (M6).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { createServerRuntime } from '../src/server.js';
import { bindHttpOwner } from '../src/realtime/bindHttpOwner.js';
import { AUTH_LIFETIME_MS } from '../src/auth/sessionLifecycle.js';
import { APP_BUFFER_BUDGET } from '../src/realtime/outboundQueue.js';

import pg from 'pg';
import argon2 from 'argon2';
const { Pool } = pg;

function sidFromCookie(pair) {
    return decodeURIComponent(pair.slice(pair.indexOf('=') + 1)).slice(2).split('.')[0];
}


test('M6 Integration: WebSocket Tab Binding, Owner Token Isolation, Disconnect Revocation', async () => {
    // 1. Chốt chặn an toàn database test
    await assertTestTarget(process.env);

    const runtime = createServerRuntime({
        ...process.env,
        HOST: '127.0.0.1',
        APP_ORIGIN: 'http://127.0.0.1:4173',
    });
    const { server, lifecycle, registry } = await runtime.start({ port: 0 });
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const origin = 'http://127.0.0.1:4173';
    // A unique test user keeps this test independent of any provisioned admin.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const username = `m6_${randomUUID().replaceAll('-', '')}`;
    const password = 'test-only-m6-password';
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await pool.query(
        'INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id',
        [username, hash]);
    const testUser = { id: inserted.rows[0].id };
    const cookies = new Set();

    let tabA;
    let tabB;
    let mapWs;
    let tabA2;
    let otherSessionWs;
    let limitWs;
    let pendingSocket;
    try {
        // 2. Lấy CSRF và Đăng nhập để có Cookie Session
        const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`);
        assert.equal(csrfRes.status, 200);
        const sessionCookie = csrfRes.headers.get('set-cookie').split(';')[0];
        cookies.add(sessionCookie);
        const { csrfToken } = await csrfRes.json();

        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cookie': sessionCookie,
                'Origin': origin,
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify({ username, password }),
        });
        assert.equal(loginRes.status, 200);
        const authCookie = loginRes.headers.get('set-cookie').split(';')[0];
        cookies.add(authCookie);
        const authCsrfToken = loginRes.headers.get('x-csrf-token'); // Lấy CSRF token mới sau login

        // 3. Kiểm tra bảo vệ: Sai Origin bị 403, Không có auth bị 401, Sai path bị 404
        await new Promise((resolve) => {
            const badOriginWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
                headers: { Origin: 'http://attacker.com', Cookie: authCookie },
            });
            badOriginWs.on('unexpected-response', (_req, res) => {
                assert.equal(res.statusCode, 403);
                resolve();
            });
        });

        await new Promise((resolve) => {
            const noAuthWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
                headers: { Origin: origin },
            });
            noAuthWs.on('unexpected-response', (_req, res) => {
                assert.equal(res.statusCode, 401);
                resolve();
            });
        });

        await new Promise((resolve) => {
            const badPathWs = new WebSocket(`ws://127.0.0.1:${port}/api/invalid-ws`, {
                headers: { Origin: origin, Cookie: authCookie },
            });
            badPathWs.on('unexpected-response', (_req, res) => {
                assert.equal(res.statusCode, 404);
                resolve();
            });
        });

        // 4. HAI TAB CÙNG CHIA SẺ 1 COOKIE SESSION
        // Mở Tab A
        tabA = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Origin: origin, Cookie: authCookie },
        });
        const helloA = await new Promise((resolve) => {
            tabA.once('message', (msg) => resolve(JSON.parse(msg.toString('utf8'))));
        });

        assert.equal(helloA.type, 'transport.hello');
        assert.equal(helloA.controlProfile, 'mock');
        assert.match(helloA.ownerToken, /^[0-9a-f]{64}$/i);
        assert.ok(helloA.connectionId);

        // Mở Tab B
        tabB = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Origin: origin, Cookie: authCookie },
        });
        const helloB = await new Promise((resolve) => {
            tabB.once('message', (msg) => resolve(JSON.parse(msg.toString('utf8'))));
        });

        assert.equal(helloB.type, 'transport.hello');
        assert.notEqual(helloA.connectionId, helloB.connectionId, 'Hai tab phải có connectionId khác nhau');
        assert.notEqual(helloA.ownerToken, helloB.ownerToken, 'Hai tab phải có ownerToken khác nhau');

        // 5. Kiểm tra bindHttpOwner với Tab A và Tab B
        // Trích xuất session ID từ cookie
        const sid = registry.get(helloA.connectionId).sessionId;

        // Tạo mock request đại diện cho Tab A
        const now = Date.now();
        function createMockReq(connId, token) {
            return {
                sessionID: sid,
                user: { id: testUser.id },
                session: {
                    authBootEpoch: lifecycle.authBootEpoch,
                    issuedAt: now,
                    absoluteExpiresAt: now + AUTH_LIFETIME_MS,
                    cookie: { maxAge: AUTH_LIFETIME_MS },
                },
                get: (header) => {
                    if (header.toLowerCase() === 'x-hmi-connection-id') return connId;
                    if (header.toLowerCase() === 'x-hmi-owner-token') return token;
                    return undefined;
                },
            };
        }


        // Tab A gửi đúng id và token của Tab A -> Thành công
        const boundA = bindHttpOwner(createMockReq(helloA.connectionId, helloA.ownerToken), registry, lifecycle);
        assert.equal(boundA.connectionId, helloA.connectionId);

        // Tab B thử dùng connectionId của Tab A nhưng token của Tab B -> Bị từ chối 403
        assert.throws(
            () => bindHttpOwner(createMockReq(helloA.connectionId, helloB.ownerToken), registry, lifecycle),
            (err) => err.code === 'OWNER_BINDING_REJECTED' && err.status === 403,
            'Tab B không được phép gửi lệnh thay Tab A'
        );

        // Token ngẫu nhiên giả mạo -> Bị từ chối 403
        const fakeToken = '0'.repeat(64);
        assert.throws(
            () => bindHttpOwner(createMockReq(helloA.connectionId, fakeToken), registry, lifecycle),
            (err) => err.code === 'OWNER_BINDING_REJECTED' && err.status === 403,
            'Token giả mạo phải bị chặn 403'
        );

        // 6. Kiểm tra đóng Tab A (Disconnect Revocation)
        tabA.close();
        await new Promise((resolve) => tabA.once('close', resolve));

        // Tab A vừa đóng -> Thử bindHttpOwner lại cho Tab A phải bị từ chối
        assert.throws(
            () => bindHttpOwner(createMockReq(helloA.connectionId, helloA.ownerToken), registry, lifecycle),
            (err) => err.code === 'OWNER_BINDING_REJECTED',
            'Tab đã đóng kết nối socket phải bị thu hồi quyền ngay lập tức'
        );

        // Tab B vẫn đang mở -> bindHttpOwner cho Tab B vẫn hợp lệ bình thường
        const boundB = bindHttpOwner(createMockReq(helloB.connectionId, helloB.ownerToken), registry, lifecycle);
        assert.equal(boundB.connectionId, helloB.connectionId);

        // Reconnect creates a new capability; a previous tab identity stays fenced.
        tabA2 = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Origin: origin, Cookie: authCookie },
        });
        const helloA2 = await new Promise(resolve =>
            tabA2.once('message', msg => resolve(JSON.parse(msg.toString('utf8')))));
        assert.notEqual(helloA2.connectionId, helloA.connectionId);
        assert.notEqual(helloA2.ownerToken, helloA.ownerToken);
        assert.throws(() => bindHttpOwner(
            createMockReq(helloA.connectionId, helloA.ownerToken), registry, lifecycle));

        // Cork the real TCP socket to model a client that cannot drain data.
        // A new app event must fail closed once bufferedAmount exceeds budget.
        const slowServerSocket = registry.get(helloA2.connectionId).ws;
        const slowClosed = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('SLOW_SOCKET_NOT_CLOSED')), 3500);
            tabA2.once('close', () => { clearTimeout(timer); resolve(); });
        });
        tabA2.on('error', () => {}); // TCP reset may surface on the client.
        slowServerSocket._socket.cork();
        slowServerSocket.send(JSON.stringify({ type: 'robot.state',
            payload: { testPadding: 'x'.repeat(APP_BUFFER_BUDGET + 1) } }));
        assert.ok(slowServerSocket.bufferedAmount > APP_BUFFER_BUDGET);
        assert.equal(registry.send(helloA2.connectionId,
            { type: 'robot.state', payload: {} }), false);
        slowServerSocket._socket.uncork();
        await slowClosed;
        assert.equal(registry.get(helloA2.connectionId), undefined);

        // A second browser login has a different SID even for the same user.
        const otherBootstrap = await fetch(`${baseUrl}/api/auth/csrf`);
        const otherAnonymous = otherBootstrap.headers.get('set-cookie').split(';')[0];
        cookies.add(otherAnonymous);
        const otherCsrf = (await otherBootstrap.json()).csrfToken;
        const otherLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST', headers: { Origin: origin, Cookie: otherAnonymous,
                'X-CSRF-Token': otherCsrf, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        assert.equal(otherLogin.status, 200);
        const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0];
        cookies.add(otherCookie);
        otherSessionWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Origin: origin, Cookie: otherCookie },
        });
        const otherHello = await new Promise(resolve =>
            otherSessionWs.once('message', msg => resolve(JSON.parse(msg.toString('utf8')))));
        const otherSid = registry.get(otherHello.connectionId).sessionId;
        assert.notEqual(otherSid, sid);
        assert.throws(() => bindHttpOwner({
            ...createMockReq(helloB.connectionId, helloB.ownerToken), sessionID: otherSid,
        }, registry, lifecycle), error => error.code === 'OWNER_BINDING_REJECTED');

        // 7. Kiểm tra kênh /map-stream không có quyền owner
        mapWs = new WebSocket(`ws://127.0.0.1:${port}/map-stream`, {
            headers: { Origin: origin, Cookie: authCookie },
        });
        const helloMap = await new Promise((resolve) => {
            mapWs.once('message', (msg) => resolve(JSON.parse(msg.toString('utf8'))));
        });
        assert.equal(helloMap.ownerToken, undefined, 'Kênh /map-stream không được cấp ownerToken');

        // Cố tình dùng connectionId của mapWs để bindHttpOwner -> Bị từ chối (record.kind !== "app")
        assert.throws(
            () => bindHttpOwner(createMockReq(helloMap.connectionId, helloB.ownerToken), registry, lifecycle),
            (err) => err.code === 'OWNER_BINDING_REJECTED'
        );
        const rateClosed = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('RATE_LIMIT_SOCKET_NOT_CLOSED')), 3500);
            mapWs.once('close', () => { clearTimeout(timer); resolve(); });
        });
        for (let i = 0; i < 31; i += 1) mapWs.send(JSON.stringify({ type: 'ping' }));
        await rateClosed;
        assert.equal(registry.get(helloMap.connectionId), undefined);

        // The ws library must reject an incoming frame above the 64 KiB cap.
        limitWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Origin: origin, Cookie: authCookie },
        });
        const limitHello = await new Promise(resolve => limitWs.once('message', msg =>
            resolve(JSON.parse(msg.toString('utf8')))));
        const sizeClosed = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('OVERSIZE_SOCKET_NOT_CLOSED')), 3500);
            limitWs.once('close', () => { clearTimeout(timer); resolve(); });
        });
        limitWs.on('error', () => {});
        limitWs.send('x'.repeat(64 * 1024 + 1));
        await sizeClosed;
        assert.equal(registry.get(limitHello.connectionId), undefined);

        // 8. Kiểm tra chịu lỗi với Frame lạ / JSON hỏng
        const errorPromise = new Promise((resolve) => {
            tabB.once('message', (msg) => resolve(JSON.parse(msg.toString('utf8'))));
        });
        tabB.send('not a json string');
        const errReply = await errorPromise;
        assert.equal(errReply.type, 'error');
        assert.equal(errReply.error.code, 'INVALID_JSON');
        const unknownReply = new Promise(resolve => tabB.once('message', msg =>
            resolve(JSON.parse(msg.toString('utf8')))));
        tabB.send(JSON.stringify({ type: 'control.velocity', linearMps: 1 }));
        assert.equal((await unknownReply).error.code, 'UNKNOWN_MESSAGE_TYPE');

        // 9. Kiểm tra Logout thu hồi toàn bộ socket còn lại của session
        const closePromiseB = new Promise((resolve) => {
            tabB.once('close', (code) => resolve(code));
        });

        // Hold only the upgrade's first session read. HTTP logout must still
        // finish; releasing the old DB result afterward must not open a socket.
        const store = runtime.app.locals.sessionStore;
        const originalGet = store.get.bind(store);
        let releaseUpgradeRead;
        let signalUpgradeRead;
        const upgradeReadStarted = new Promise(resolve => { signalUpgradeRead = resolve; });
        store.get = (requestedSid, callback) => {
            if (requestedSid === sid && !releaseUpgradeRead) {
                releaseUpgradeRead = () => originalGet(requestedSid, callback);
                signalUpgradeRead();
                return;
            }
            originalGet(requestedSid, callback);
        };
        pendingSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Origin: origin, Cookie: authCookie },
        });
        const pendingOutcome = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('PENDING_UPGRADE_NOT_SETTLED')), 3500);
            const done = result => { clearTimeout(timer); resolve(result); };
            pendingSocket.once('open', () => done('OPENED'));
            pendingSocket.once('unexpected-response', (_request, response) => {
                response.resume(); done(`HTTP_${response.statusCode}`);
            });
            pendingSocket.once('error', () => done('ERROR'));
            pendingSocket.once('close', () => done('CLOSED'));
        });
        await upgradeReadStarted;

        const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
            method: 'POST',
            headers: {
                'Cookie': authCookie,
                'Origin': origin,
                'X-CSRF-Token': authCsrfToken, // Dùng token của authenticated session
            },
        });
        releaseUpgradeRead();
        store.get = originalGet;
        assert.equal(logoutRes.status, 204);
        assert.notEqual(await pendingOutcome, 'OPENED');

        // Tab B phải nhận được tín hiệu đóng từ server với code 1008
        const codeB = await closePromiseB;
        assert.equal(codeB, 1008);

        // Cố gắng bind lại cho Tab B sau logout phải thất bại
        assert.throws(
            () => bindHttpOwner(createMockReq(helloB.connectionId, helloB.ownerToken), registry, lifecycle),
            (err) => ['OWNER_BINDING_REJECTED', 'SESSION_REVOKED'].includes(err.code)
        );
        assert.equal(registry.get(otherHello.connectionId)?.closed, false,
            'Logout session A không được revoke session B');

        // Expiry in the durable store must close an already open socket.
        const otherClose = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('EXPIRED_SOCKET_NOT_CLOSED')), 3500);
            otherSessionWs.once('close', () => { clearTimeout(timer); resolve(); });
        });
        await pool.query("UPDATE session SET sess=jsonb_set(sess::jsonb, '{absoluteExpiresAt}', '0'::jsonb)::json WHERE sid=$1", [otherSid]);
        await otherClose;
        assert.equal(registry.get(otherHello.connectionId), undefined);

    } finally {
        try { tabA?.close(); } catch { }
        try { tabB?.close(); } catch { }
        try { mapWs?.close(); } catch { }
        try { tabA2?.close(); } catch { }
        try { otherSessionWs?.close(); } catch { }
        try { limitWs?.close(); } catch { }
        try { pendingSocket?.terminate(); } catch { }
        await runtime.stop();
        for (const pair of cookies) {
            await pool.query('DELETE FROM session WHERE sid=$1', [sidFromCookie(pair)]);
        }
        await pool.query('DELETE FROM users WHERE id=$1', [testUser.id]);
        await pool.end();
    }

});
