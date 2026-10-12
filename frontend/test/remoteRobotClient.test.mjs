/**
 * frontend/test/remoteRobotClient.test.mjs
 * 
 * UNIT & INTEGRATION TEST CHO REMOTE ROBOT CLIENT VÀ VELOCITY SENDER (M9 / F9.1 - F9.5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVelocitySender } from '../src/clients/remoteVelocitySender.js';
import { createHttpWsRobotClient } from '../src/clients/httpWsRobotClient.js';
import { createRemoteTransport } from '../src/clients/remoteTransport.js';
import { TeleopVelocityMessageSchema } from '../src/schemas/control.js';
import { sendMissionIntent } from '../src/utils/navigationCommands.js';
import { useMissionStore } from '../src/state/missionStore.js';

class FakeSocket {
    static instances = [];
    constructor(url) {
        this.url = url;
        this.readyState = 1;
        this.bufferedAmount = 0;
        this.sent = [];
        FakeSocket.instances.push(this);
    }
    send(frame) { this.sent.push(JSON.parse(frame)); }
    receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
    close() {
        this.readyState = 3;
        this.onclose?.();
    }
}

const hello = (id, map = false) => ({
    version: 1, type: 'transport.hello', connectionId: id,
    serverBootEpoch: 'boot-1', controlProfile: 'mock',
    ...(!map ? { ownerToken: 'a'.repeat(64) } : {}),
});
const csrfOne = '1'.repeat(64);
const csrfTwo = '2'.repeat(64);

function response(body, status = 200, headers = {}) {
    return new Response(status === 204 ? null : JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json', ...headers },
    });
}

test('M9: createVelocitySender ném lỗi đồng bộ khi chưa sẵn sàng, sai lease, hoặc backpressure', () => {
    let leaseId = 'lease-1';
    let socketReadyState = 1;
    let bufferedAmount = 0;
    const sentFrames = [];

    const fakeSocket = {
        get readyState() { return socketReadyState; },
        get bufferedAmount() { return bufferedAmount; },
        send(data) { sentFrames.push(data); },
    };

    const sender = createVelocitySender({
        requestSchema: TeleopVelocityMessageSchema,
        requireContext: () => ({
            socket: fakeSocket,
            leaseId,
        }),
        maxBufferedBytes: 1024,
    });

    // 1. Gửi hợp lệ -> void return đồng bộ
    const res = sender({
        leaseId: 'lease-1',
        sequence: 1,
        freshnessToken: 'token-1',
        linearX: 0.5,
        angularZ: 0.1,
    });
    assert.equal(res, undefined, 'sendVelocity phải trả về undefined đồng bộ');
    assert.equal(sentFrames.length, 1);
    const parsed = JSON.parse(sentFrames[0]);
    assert.equal(parsed.type, 'teleop.velocity');
    assert.equal(parsed.payload.linearX, 0.5);

    // 2. Sai leaseId -> CONTROL_TRANSPORT_NOT_READY
    assert.throws(() => {
        sender({
            leaseId: 'lease-diff',
            sequence: 2,
            freshnessToken: 'token-1',
            linearX: 0.5,
            angularZ: 0.1,
        });
    }, /CONTROL_TRANSPORT_NOT_READY/);

    // 3. Socket closed -> CONTROL_TRANSPORT_NOT_READY
    socketReadyState = 3;
    assert.throws(() => {
        sender({
            leaseId: 'lease-1',
            sequence: 3,
            freshnessToken: 'token-1',
            linearX: 0.5,
            angularZ: 0.1,
        });
    }, /CONTROL_TRANSPORT_NOT_READY/);
    socketReadyState = 1;

    // 4. Backpressure vượt maxBufferedBytes -> CONTROL_TRANSPORT_BACKPRESSURE
    bufferedAmount = 2000;
    assert.throws(() => {
        sender({
            leaseId: 'lease-1',
            sequence: 4,
            freshnessToken: 'token-1',
            linearX: 0.5,
            angularZ: 0.1,
        });
    }, /CONTROL_TRANSPORT_BACKPRESSURE/);
    assert.equal(sentFrames.length, 1, 'Lệnh bị từ chối không được queue/replay');
});

test('M9: createHttpWsRobotClient public facade compliance & connection status', () => {
    const client = createHttpWsRobotClient({
        baseUrl: 'http://127.0.0.1:3001',
        wsUrl: 'ws://127.0.0.1:3001',
    });

    assert.equal(client.kind, 'remote');
    assert.equal(typeof client.login, 'function');
    assert.equal(typeof client.logout, 'function');
    assert.equal(typeof client.getSession, 'function');
    assert.equal(typeof client.getRobotState, 'function');
    assert.equal(typeof client.subscribeRobotState, 'function');
    assert.equal(typeof client.listMaps, 'function');
    assert.equal(typeof client.getMap, 'function');
    assert.equal(typeof client.getMapGrid, 'function');
    assert.equal(typeof client.subscribeMapGrid, 'function');
    assert.equal(typeof client.getActiveMappingSession, 'function');
    assert.equal(typeof client.startMapping, 'function');
    assert.equal(typeof client.finishMapping, 'function');
    assert.equal(typeof client.getJob, 'function');
    assert.equal(typeof client.subscribeJobs, 'function');
    assert.equal(typeof client.activateMap, 'function');
    assert.equal(typeof client.previewRoute, 'function');
    assert.equal(typeof client.saveRoute, 'function');
    assert.equal(typeof client.listRoutes, 'function');
    assert.equal(typeof client.createMission, 'function');
    assert.equal(typeof client.getMission, 'function');
    assert.equal(typeof client.getActiveMission, 'function');
    assert.equal(typeof client.cancelMission, 'function');
    assert.equal(typeof client.subscribeMissions, 'function');
    assert.equal(typeof client.subscribeNavigationPath, 'function');
    assert.equal(typeof client.listCameras, 'function');
    assert.equal(typeof client.getCameraStream, 'function');
    assert.equal(typeof client.acquireControl, 'function');
    assert.equal(typeof client.releaseControl, 'function');
    assert.equal(typeof client.requestStop, 'function');
    assert.equal(typeof client.sendVelocity, 'function');
    assert.equal(typeof client.subscribeControl, 'function');
    assert.equal(typeof client.getControlState, 'function');
    assert.equal(typeof client.subscribeConnectionStatus, 'function');
    assert.equal(typeof client.dispose, 'function');

    // Kiểm tra subscribeConnectionStatus phát trạng thái khởi đầu
    let currentStatus = null;
    const unsub = client.subscribeConnectionStatus(s => {
        currentStatus = s;
    });
    assert.ok(currentStatus);
    assert.equal(currentStatus.status, 'disconnected');
    assert.equal(typeof unsub, 'function');
    unsub();

    client.dispose();
});

test('M9 remote: hello thật mới ready, lease DTO phẳng, disconnect không replay velocity', async () => {
    FakeSocket.instances.length = 0;
    const calls = [];
    const client = createHttpWsRobotClient({ WebSocketClass: FakeSocket,
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (url.endsWith('/api/auth/csrf')) return response({ csrfToken: csrfOne });
            if (url.endsWith('/api/auth/login')) return response({ user: { id: 'u1', username: 'tester' } }, 200,
                { 'X-CSRF-Token': csrfTwo });
            if (url.endsWith('/api/control/lease')) return response({ leaseId: 'lease-1',
                expiresAt: new Date(Date.now() + 10_000).toISOString(),
                limits: { maxLinearX: 1, maxAngularZ: 1 }, controlGeneration: 1 });
            throw new Error('UNEXPECTED_HTTP_CALL');
        },
    });
    const statuses = [];
    const unsubscribe = client.subscribeConnectionStatus(value => statuses.push(value));
    try {
        await client.login({ username: 'tester', password: 'private-test-password' });
        assert.equal(statuses.at(-1).status, 'connecting');
        await assert.rejects(() => client.acquireControl({ requestId: 'acquire-1' }),
            /CONTROL_TRANSPORT_NOT_READY/);
        const app = FakeSocket.instances.find(socket => socket.url.endsWith('/ws'));
        app.receive(hello('tab-1'));
        assert.equal(statuses.at(-1).status, 'connected');
        const lease = await client.acquireControl({ requestId: 'acquire-1' });
        assert.equal(lease.leaseId, 'lease-1');
        const acquire = calls.find(call => call.url.endsWith('/api/control/lease'));
        assert.equal(acquire.options.headers.get('X-HMI-Connection-Id'), 'tab-1');
        assert.equal(acquire.options.headers.get('X-HMI-Owner-Token'), 'a'.repeat(64));
        assert.equal(acquire.options.headers.get('X-CSRF-Token'), csrfTwo);
        assert.equal(client.sendVelocity({ leaseId: 'lease-1', sequence: 1,
            freshnessToken: 'fresh-1', linearX: 0.2, angularZ: 0 }), undefined);
        assert.equal(app.sent.at(-1).type, 'teleop.velocity');
        const sentCount = app.sent.length;
        app.close();
        assert.equal(statuses.at(-1).status, 'disconnected');
        assert.throws(() => client.sendVelocity({ leaseId: 'lease-1', sequence: 2,
            freshnessToken: 'fresh-1', linearX: 0.2, angularZ: 0 }),
        /CONTROL_TRANSPORT_NOT_READY/);
        await new Promise(resolve => setTimeout(resolve, 300));
        const newApp = FakeSocket.instances.filter(socket => socket.url.endsWith('/ws')).at(-1);
        assert.notEqual(newApp, app);
        newApp.receive(hello('tab-2'));
        assert.equal(app.sent.length, sentCount);
        assert.equal(newApp.sent.length, 0, 'Reconnect không queue/replay velocity cũ');
        assert.throws(() => client.sendVelocity({ leaseId: 'lease-1', sequence: 3,
            freshnessToken: 'fresh-1', linearX: 0.2, angularZ: 0 }),
        /CONTROL_TRANSPORT_NOT_READY/);
    } finally { unsubscribe(); client.dispose(); }
});

test('M9 remote map: subscribe trước hello, exact subscriptionId, đủ envelope và cleanup', async () => {
    FakeSocket.instances.length = 0;
    const client = createHttpWsRobotClient({ WebSocketClass: FakeSocket,
        fetchImpl: async url => url.endsWith('/api/auth/csrf')
            ? response({ csrfToken: csrfOne })
            : response({ user: { id: 'u1', username: 'tester' } }),
    });
    try {
        await client.login({ username: 'tester', password: 'private-test-password' });
        const map = FakeSocket.instances.find(socket => socket.url.endsWith('/map-stream'));
        const context = { kind: 'mapping', mappingSessionId: 'session-1' };
        const received = [];
        const unsubscribe = client.subscribeMapGrid(context, value => received.push(value),
            { subscriptionId: 'sub-exact' });
        assert.equal(map.sent.length, 0, 'Chưa có map hello thì chưa gửi subscribe');
        map.receive(hello('map-1', true));
        assert.equal(map.sent[0].subscriptionId, 'sub-exact');
        const frame = { version: 1, type: 'map.status', subscriptionId: 'sub-exact',
            streamId: 'stream-1', streamEpoch: 1, sequence: 1,
            sentAt: new Date().toISOString(), payload: { context, state: 'ready',
                sourceState: 'stale', lastSourceUpdateAgeMs: null } };
        map.receive({ ...frame, subscriptionId: 'other-sub' });
        assert.equal(received.length, 0);
        map.receive(frame);
        assert.equal(received.length, 1);
        assert.equal(received[0].type, 'map.status');
        assert.equal(received[0].sequence, 1);
        unsubscribe();
        assert.equal(map.sent.at(-1).type, 'map.unsubscribe');
        map.receive({ ...frame, sequence: 2 });
        assert.equal(received.length, 1);
    } finally { client.dispose(); }
});

test('M9 remote: logout 503 không giả thành công; HTTP response có byte cap', async () => {
    FakeSocket.instances.length = 0;
    const client = createHttpWsRobotClient({ WebSocketClass: FakeSocket,
        fetchImpl: async url => {
            if (url.endsWith('/api/auth/csrf')) return response({ csrfToken: csrfOne });
            if (url.endsWith('/api/auth/logout')) return response({
                error: { code: 'AUTH_STORE_UNAVAILABLE', message: 'Tạm thời lỗi' },
            }, 503);
            return response({ user: { id: 'u1', username: 'tester' } });
        },
    });
    try {
        await client.login({ username: 'tester', password: 'private-test-password' });
        await assert.rejects(() => client.logout(), error => error.status === 503);
        assert.equal((await client.getSession()).user.username, 'tester');
    } finally { client.dispose(); }
    const transport = createRemoteTransport({ maxResponseBytes: 32,
        fetchImpl: async () => response({ data: 'x'.repeat(100) }), WebSocketClass: null });
    try {
        await assert.rejects(() => transport.request('/api/too-large'),
            error => error.code === 'RESPONSE_TOO_LARGE');
    } finally { transport.dispose(); }
});

test('M9 mutation timeout giữ trạng thái uncertain và retry cùng requestId', async () => {
    useMissionStore.getState().clearMission();
    const sent = [];
    const request = { requestId: crypto.randomUUID(), kind: 'navigate_to_pose',
        mapId: 'map-a', mapRevision: 'rev-a', poses: [] };
    const client = {
        createMission: async dto => {
            sent.push(dto.requestId);
            if (sent.length === 1) throw Object.assign(new Error('REQUEST_TIMEOUT'),
                { code: 'REQUEST_TIMEOUT', outcomeUnknown: true });
            return { missionId: 'mission-a' };
        },
        getActiveMission: async () => ({ mission: null }),
    };
    await sendMissionIntent(client, request);
    assert.equal(useMissionStore.getState().missionRequest.status, 'uncertain');
    await sendMissionIntent(client, request, true);
    assert.deepEqual(sent, [request.requestId, request.requestId]);
    assert.equal(useMissionStore.getState().missionRequest.missionId, 'mission-a');
    useMissionStore.getState().clearMission();
});

test('M9 auth: response thiếu user hoặc CSRF sai không được tạo authenticated client', async () => {
    for (const mode of ['bad-csrf', 'bad-login']) {
        const client = createHttpWsRobotClient({ WebSocketClass: FakeSocket,
            fetchImpl: async url => {
                if (url.endsWith('/api/auth/csrf')) return response({
                    csrfToken: mode === 'bad-csrf' ? 'invalid' : csrfOne,
                });
                return response({ user: null });
            },
        });
        try {
            await assert.rejects(() => client.login({ username: 'tester', password: 'secret' }));
            await assert.rejects(() => client.getRobotState(),
                error => error.code === 'UNAUTHENTICATED');
        } finally { client.dispose(); }
    }
});
