/**
 * packages/contracts/test/manifest.test.js
 * 
 * Kiểm thử tính toàn vẹn của API_MANIFEST và transport schemas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { API_MANIFEST } from '../src/apiManifest.js';
import { ConnectionStatusSchema, TransportHelloSchema, MapTransportHelloSchema, HttpErrorPayloadSchema } from '../src/transport.js';
import { MapAssetSchema } from '../src/mapping.js';

test('M2 manifest phủ mọi method public và không có route nhầm tên', () => {
    const http = {
        login: ['POST', '/api/auth/login'], getSession: ['GET', '/api/auth/session'],
        logout: ['POST', '/api/auth/logout'], getCsrf: ['GET', '/api/auth/csrf'],
        getRobotState: ['GET', '/api/robot/state'], listMaps: ['GET', '/api/maps'],
        getMap: ['GET', '/api/maps/:id'], getMapGrid: ['GET', '/api/map-grid'],
        getActiveMappingSession: ['GET', '/api/mapping/sessions/active'],
        startMapping: ['POST', '/api/mapping/start'], finishMapping: ['POST', '/api/mapping/finish'],
        getJob: ['GET', '/api/jobs/:id'], activateMap: ['POST', '/api/maps/activate'],
        previewRoute: ['POST', '/api/routes/preview'], saveRoute: ['POST', '/api/routes'],
        listRoutes: ['GET', '/api/routes'], createMission: ['POST', '/api/missions'],
        getActiveMission: ['GET', '/api/missions/active'], getMission: ['GET', '/api/missions/:id'],
        cancelMission: ['POST', '/api/missions/:id/cancel'], listCameras: ['GET', '/api/cameras'],
        getCameraStream: ['GET', '/api/cameras/:cameraId/stream'],
        acquireControl: ['POST', '/api/control/lease'],
        releaseControl: ['POST', '/api/control/release'],
        requestStop: ['POST', '/api/control/stop'], getControlState: ['GET', '/api/control/state'],
    };
    const ws = {
        subscribeRobotState: ['/ws', 'robot.state'], subscribeMapGrid: ['/map-stream', 'map.grid'],
        subscribeJobs: ['/ws', 'job.updated'], subscribeMissions: ['/ws', 'mission.updated'],
        subscribeNavigationPath: ['/ws', 'navigation.path'],
        subscribeControl: ['/ws', 'control.*'], sendVelocity: ['/ws', 'teleop.velocity'],
    };
    assert.deepEqual(Object.keys(API_MANIFEST).sort(),
        [...Object.keys(http), ...Object.keys(ws), 'subscribeConnectionStatus', 'dispose'].sort());
    for (const [name, expected] of Object.entries(http)) {
        assert.deepEqual([API_MANIFEST[name].method, API_MANIFEST[name].path], expected, name);
    }
    for (const [name, expected] of Object.entries(ws)) {
        assert.deepEqual([API_MANIFEST[name].channel, API_MANIFEST[name].eventType], expected, name);
    }
});

test('API_MANIFEST được đóng băng toàn bộ và không thể ghi đè', () => {
    assert.ok(Object.isFrozen(API_MANIFEST), 'API_MANIFEST phải được freeze');
    assert.throws(() => {
        // Cố tình gán đè field để kiểm tra tính bất biến
        API_MANIFEST.getRobotState = null;
    }, /Cannot assign to read only property/);

    for (const [key, entry] of Object.entries(API_MANIFEST)) {
        assert.ok(Object.isFrozen(entry), `Entry ${key} phải được freeze`);
    }
});

test('API_MANIFEST chứa đúng các ràng buộc đường dẫn HTTP và mã trạng thái chuẩn', () => {
    // requestStop phải trả về HTTP 202 Accepted
    assert.equal(API_MANIFEST.requestStop.method, 'POST');
    assert.equal(API_MANIFEST.requestStop.path, '/api/control/stop');
    assert.equal(API_MANIFEST.requestStop.successStatus, 202);

    // logout phải trả về HTTP 204 No Content
    assert.equal(API_MANIFEST.logout.method, 'POST');
    assert.equal(API_MANIFEST.logout.path, '/api/auth/logout');
    assert.equal(API_MANIFEST.logout.successStatus, 204);

    // getActiveMission phải đứng trước /:id để tránh nhầm route
    assert.equal(API_MANIFEST.getActiveMission.path, '/api/missions/active');
    assert.equal(API_MANIFEST.getMission.path, '/api/missions/:id');
});

test('API_MANIFEST ánh xạ đúng các kênh WebSocket và sự kiện', () => {
    assert.equal(API_MANIFEST.subscribeMapGrid.channel, '/map-stream');
    assert.equal(API_MANIFEST.subscribeRobotState.channel, '/ws');
    assert.equal(API_MANIFEST.subscribeRobotState.eventType, 'robot.state');
    assert.equal(API_MANIFEST.sendVelocity.type, 'ws');
    assert.equal(API_MANIFEST.sendVelocity.eventType, 'teleop.velocity');
});

test('Transport schemas parse dữ liệu hợp lệ và reject trường lạ', () => {
    const validStatus = {
        status: 'connected',
        connectionEpoch: 1,
        controlProfile: 'mock',
    };
    assert.deepEqual(ConnectionStatusSchema.parse(validStatus), validStatus);

    // Từ chối trạng thái không nằm trong enum
    assert.throws(() => {
        ConnectionStatusSchema.parse({ ...validStatus, status: 'idle' });
    });

    // TransportHelloSchema: ownerToken phải đúng regex 64 hex
    const validHello = {
        version: 1,
        type: 'transport.hello',
        connectionId: 'conn-1234',
        ownerToken: 'a'.repeat(64),
        serverBootEpoch: 'boot-epoch-1',
        controlProfile: 'mock',
    };
    assert.deepEqual(TransportHelloSchema.parse(validHello), validHello);

    assert.throws(() => {
        TransportHelloSchema.parse({ ...validHello, ownerToken: 'token-ngan' });
    });
    assert.equal(TransportHelloSchema.safeParse({ ...validHello, ownerToken: undefined }).success, false);
    const { ownerToken: _capability, ...mapHello } = validHello;
    assert.deepEqual(MapTransportHelloSchema.parse(mapHello), mapHello);
    assert.equal(MapTransportHelloSchema.safeParse(validHello).success, false);
    assert.equal(TransportHelloSchema.safeParse({ ...validHello, controlProfile: 'hardware' }).success, false);
    assert.equal(ConnectionStatusSchema.safeParse({ ...validStatus,
        connectionEpoch: Number.MAX_SAFE_INTEGER + 1 }).success, false);
    assert.equal(HttpErrorPayloadSchema.safeParse({ error: { code: 'INVALID',
        message: 'x'.repeat(513) } }).success, false);
});

test('M4 map asset giữ mock memory và chấp nhận mock filesystem đúng contract', () => {
    const original = { type: 'grid_json', source: 'mock', storage: 'memory', status: 'ready' };
    assert.deepEqual(MapAssetSchema.parse(original), original);
    const saved = { ...original, storage: 'filesystem' };
    assert.deepEqual(MapAssetSchema.parse(saved), saved);
    assert.equal(MapAssetSchema.safeParse({ ...saved, source: 'ros' }).success, false);
    assert.equal(MapAssetSchema.safeParse({ ...saved, absolutePath: '/private/map.json' }).success, false);
});
