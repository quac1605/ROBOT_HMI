/**
 * backend/test/robotState.test.mjs
 * 
 * KIỂM THỬ M8 SLICE 1: ROBOT RUNTIME & STATE SERVICE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import argon2 from 'argon2';
import { WebSocket } from 'ws';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { createServerRuntime } from '../src/server.js';
import { acquireMapFixtureLock } from './helpers/testDatabaseLock.mjs';
import { assertAdapterCapability, ADAPTER_CAPABILITIES } from '../src/ros/adapterContract.js';
import { createMockRosAdapter } from '../src/ros/mockRosAdapter.js';
import { RobotStateSchema } from '@robot-hmi/contracts/robotState';

const { Pool } = pg;

test('M8 Slice 1: Adapter capability contract & assertCapability', () => {
    const mockAdapter = { capabilities: ADAPTER_CAPABILITIES };
    assert.doesNotThrow(() => assertAdapterCapability(mockAdapter, 'state'));
    assert.doesNotThrow(() => assertAdapterCapability(mockAdapter, 'motion'));
    assert.doesNotThrow(() => assertAdapterCapability(mockAdapter, 'mapping'));
    const actualAdapter = createMockRosAdapter();
    try {
        assert.equal(typeof actualAdapter.activateMap, 'function');
        assert.equal(typeof actualAdapter.previewRoute, 'function');
        assert.equal(typeof actualAdapter.beginMission, 'function');
        assert.equal(typeof actualAdapter.writeMissionVelocity, 'function');
        assert.equal(typeof actualAdapter.cancelMission, 'function');
        assert.equal(typeof actualAdapter.finishMission, 'function');
        assert.doesNotThrow(() => assertAdapterCapability(actualAdapter, 'activation'));
        assert.doesNotThrow(() => assertAdapterCapability(actualAdapter, 'routePreview'));
        assert.doesNotThrow(() => assertAdapterCapability(actualAdapter, 'mission'));
    } finally { actualAdapter.dispose(); }
    for (const missing of ['unsupported']) {
        assert.throws(() => assertAdapterCapability(mockAdapter, missing),
            err => err.code === 'ADAPTER_CAPABILITY_MISSING');
    }

    assert.throws(
        () => assertAdapterCapability({}, 'state'),
        err => err.code === 'ADAPTER_CAPABILITY_MISSING' && err.status === 501
    );
});

test('M8 mock adapter không tạo grid giả trước start; snapshot trả về độc lập', () => {
    const adapter = createMockRosAdapter();
    try {
        assert.throws(() => adapter.getMappingGrid('session-a'),
            err => err.code === 'MAPPING_GRID_UNAVAILABLE');
        adapter.startMapping('session-a');
        const first = adapter.getMappingGrid('session-a');
        first.grid.data[0] = 100;
        assert.equal(adapter.getMappingGrid('session-a').grid.data[0], -1);
        adapter.finishMapping('session-a');
        assert.throws(() => adapter.getMappingGrid('session-a'),
            err => err.code === 'MAPPING_GRID_UNAVAILABLE');
    } finally { adapter.dispose(); }
});

test('M8 mission handle cũ không phát lại velocity sau cancel hoặc mission mới', () => {
    const adapter = createMockRosAdapter();
    try {
        const first = adapter.beginMission('mission-a');
        adapter.writeMissionVelocity(first, { linearX: 0.3, angularZ: 0 });
        assert.equal(adapter.getCommand().velocity.linearX, 0.3);
        assert.equal(adapter.cancelMission(first), true);
        assert.deepEqual(adapter.getCommand().velocity, { linearX: 0, angularZ: 0 });
        assert.throws(() => adapter.writeMissionVelocity(first,
            { linearX: 0.3, angularZ: 0 }),
        error => error.code === 'MISSION_RUN_REVOKED');
        const second = adapter.beginMission('mission-b');
        assert.equal(adapter.cancelMission(first), false);
        adapter.writeMissionVelocity(second, { linearX: 0.2, angularZ: 0 });
        adapter.finishMission(second);
        assert.deepEqual(adapter.getCommand().velocity, { linearX: 0, angularZ: 0 });
    } finally { adapter.dispose(); }
});

test('M8 Slice 1: GET /api/robot/state (Auth required, RobotStateSchema valid) & WS robot.state stream', async () => {
    await assertTestTarget(process.env);
    const origin = 'http://127.0.0.1:4173';
    const runtime = createServerRuntime({
        ...process.env,
        HOST: '127.0.0.1',
        APP_ORIGIN: origin,
    });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });

    const username = `state_${randomUUID().replaceAll('-', '')}`;
    const password = 'test-robot-state-pass';
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await pool.query(
        'INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id',
        [username, hash]
    );
    const userId = inserted.rows[0].id;

    let started;
    const releaseMapFixtureLock = await acquireMapFixtureLock();

    try {
        started = await runtime.start({ port: 0 });
        const port = started.server.address().port;
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. Unauthenticated request -> 401 Unauthorized
        const unauthRes = await fetch(`${baseUrl}/api/robot/state`, {
            headers: { Origin: origin },
        });
        assert.equal(unauthRes.status, 401);

        // 2. Lấy CSRF token trước khi login
        const csrfRes = await fetch(`${baseUrl}/api/auth/csrf`, {
            headers: { Origin: origin },
        });
        assert.equal(csrfRes.status, 200);
        const initCookie = csrfRes.headers.get('set-cookie')?.split(';')[0];
        assert.ok(initCookie);
        const { csrfToken } = await csrfRes.json();
        assert.ok(csrfToken);

        // 3. Login tài khoản admin với CSRF token
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

        // 4. Authenticated GET /api/robot/state
        const stateRes = await fetch(`${baseUrl}/api/robot/state`, {
            headers: { Cookie: authCookie, Origin: origin },
        });
        assert.equal(stateRes.status, 200);
        const stateBody = await stateRes.json();
        const parsed = RobotStateSchema.parse(stateBody);
        assert.equal(parsed.robotId, 'robot-01');
        assert.equal(parsed.mode, 'idle');
        assert.equal(parsed.rosConnected, false);
        assert.equal(parsed.localization.status, 'unknown');
        assert.equal(parsed.physicalEstopActive, null);
        assert.equal(parsed.motionInhibited, true);
        assert.equal(parsed.pose, null);
        assert.equal(parsed.poseSourceUpdateAgeMs, null);

        // 5. Kiểm tra snapshot không cho phép mutate internal state
        stateBody.robotId = 'hacked';
        const freshState = started.robotRuntime.robotStateService.getRobotState();
        assert.equal(freshState.robotId, 'robot-01');

        // 6. Kết nối WebSocket /ws và nhận robot.state event
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
            headers: { Cookie: authCookie, Origin: origin },
        });

        const receivedEvents = [];
        ws.on('message', data => {
            try {
                receivedEvents.push(JSON.parse(data.toString('utf8')));
            } catch { /* ignore */ }
        });

        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
        });

        const initialDeadline = Date.now() + 2000;
        while (!receivedEvents.some(e => e.type === 'robot.state') &&
            Date.now() < initialDeadline) {
            await new Promise(r => setTimeout(r, 20));
        }
        const initialFrame = receivedEvents.find(e => e.type === 'robot.state');
        assert.ok(initialFrame, 'Socket mới phải nhận snapshot robot.state ban đầu');
        assert.equal(initialFrame.payload.rosConnected, false);
        assert.equal(initialFrame.payload.motionInhibited, true);

        assert.throws(() => started.sharedRobotState.update({ batteryPercent: Infinity }));
        assert.equal(started.sharedRobotState.getSnapshot().batteryPercent, null,
            'DTO nội bộ sai không được ghi vào state hoặc phát lên WS');

        // Trigger cập nhật trạng thái robot qua sharedRobotState
        started.robotRuntime.sharedRobotState.update({ batteryPercent: 95 });

        // Đợi nhận frame robot.state
        let foundEvent = null;
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            foundEvent = receivedEvents.find(e => e.type === 'robot.state' && e.payload?.batteryPercent === 95);
            if (foundEvent) break;
            await new Promise(r => setTimeout(r, 50));
        }

        assert.ok(foundEvent, 'Phải nhận được frame robot.state qua /ws với batteryPercent = 95');
        assert.equal(foundEvent.version, 1);
        assert.equal(foundEvent.payload.batteryPercent, 95);

        ws.close();
    } finally {
        try {
            await runtime.stop();
            await pool.query('DELETE FROM users WHERE id=$1', [userId]);
        } finally {
            try {
                await pool.end();
            } finally {
                await releaseMapFixtureLock();
            }
        }
    }
});
