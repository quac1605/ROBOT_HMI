import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { assertTestTarget } from '../../backend/scripts/assert-test-target.mjs';
import { createServerRuntime } from '../../backend/src/server.js';
import { browserLaunchOptions } from '../../docs/test/scripts/browser_launch_options.mjs';

const frontendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requireBackend = createRequire(new URL('../../backend/package.json', import.meta.url));
const pg = requireBackend('pg');
const argon2 = requireBackend('argon2');
const origin = 'http://127.0.0.1:4174';
const backendUrl = 'http://127.0.0.1:3002';

async function waitForVite(child) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error('VITE_EXITED_BEFORE_READY');
        try {
            const response = await fetch(`${origin}/login`);
            if (response.ok) return;
        } catch { /* Vite chưa mở cổng. */ }
        await delay(100);
    }
    throw new Error('VITE_READY_TIMEOUT');
}

async function waitForBothHellos(helloPaths) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (helloPaths.has('/ws') && helloPaths.has('/map-stream')) return;
        await delay(20);
    }
    throw new Error('REMOTE_WS_HELLO_MISSING');
}

// Standalone opt-in smoke: real Chromium -> Vite proxy -> real backend with
// MockRosAdapter. It never uses frontend mock internals or real motor/camera.
await assertTestTarget(process.env);
const dataDir = await mkdtemp(path.join(process.env.DATA_DIR, 'm9-ui-'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const runtime = createServerRuntime({ ...process.env,
    HOST: '127.0.0.1', APP_ORIGIN: origin, DATA_DIR: dataDir });
const username = `browser_${randomUUID().replaceAll('-', '')}`;
const password = `test-${randomUUID()}`;
let userId;
let vite;
let browser;
try {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await pool.query(
        'INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id',
        [username, hash]);
    userId = inserted.rows[0].id;
    await runtime.start({ port: 3002 });
    vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host',
        '127.0.0.1', '--port', '4174', '--strictPort'], {
        cwd: frontendDir,
        env: { ...process.env, VITE_ROBOT_CLIENT: 'remote',
            HMI_BACKEND_URL: backendUrl,
            VITE_ENABLE_STAGE6_TEST_CONTROLS: 'true' },
        stdio: 'ignore',
    });
    await waitForVite(vite);
    browser = await chromium.launch(browserLaunchOptions());
    const page = await browser.newPage();
    const helloPaths = new Set();
    const apiPaths = new Set();
    let robotStateFrames = 0;
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/api/')) apiPaths.add(url.pathname);
    });
    page.on('websocket', socket => {
        socket.on('framereceived', frame => {
            try {
                const parsed = JSON.parse(frame.payload);
                if (parsed.type === 'transport.hello') {
                    helloPaths.add(new URL(socket.url()).pathname);
                }
                if (parsed.type === 'robot.state' &&
                    new URL(socket.url()).pathname === '/ws') robotStateFrames++;
            } catch { /* Binary/error frame is not a hello. */ }
        });
    });

    await page.goto(`${origin}/login`);
    await expect(page.getByText('demo-only')).toHaveCount(0);
    await page.locator('#login-username').fill(username);
    await page.locator('#login-password').fill(password);
    await page.locator('#login-submit-btn').click();
    await page.waitForURL('**/navigation');
    await expect(page.getByRole('heading', { name: 'Trạng thái robot' })).toBeVisible();
    await waitForBothHellos(helloPaths);
    assert.ok(robotStateFrames > 0, 'Telemetry UI phải nhận robot.state qua /ws');
    assert.equal(await page.evaluate(() => window.__STAGE6_TEST_CONTROLS__), undefined);

    for (const [route, heading] of [
        ['/mapping', 'Xây dựng Bản đồ SLAM (Mapping)'],
        ['/navigation', 'Điều hướng'],
        ['/gesture', 'Phát hiện Người & Cử chỉ'],
    ]) {
        await page.goto(origin + route);
        await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    await expect(page.getByTestId('gesture-demo-notice')).toContainText('không gửi lệnh điều khiển robot');
    await expect(page.getByTestId('gesture-current')).toHaveText('Chưa nhận diện');
    await page.goto(origin + '/teleop');
    await page.waitForURL('**/mapping');
    await expect(page.getByTestId('mapping-joystick')).toHaveAttribute('aria-disabled', 'true');
    await expect.poll(() => apiPaths.has('/api/cameras/front/stream')).toBe(true);
    for (const required of ['/api/auth/login', '/api/auth/session',
        '/api/control/state', '/api/maps', '/api/cameras/front/stream']) {
        assert.ok(apiPaths.has(required), `Thiếu HTTP request thật: ${required}`);
    }
    assert.deepEqual(pageErrors, []);
    await page.getByRole('button', { name: 'Đăng xuất' }).click();
    await page.waitForURL('**/login');
    console.log('REMOTE_BROWSER_SMOKE_PASS: navigation/mapping/gesture, redirect /teleop, HTTP/WS thật, logout, joystick khóa');
} finally {
    await browser?.close();
    if (vite && vite.exitCode === null) {
        vite.kill();
        await Promise.race([new Promise(resolve => vite.once('exit', resolve)), delay(2000)]);
    }
    await runtime.stop();
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await pool.end();
    await rm(dataDir, { recursive: true, force: true });
}
