/**
 * backend/test/health.test.mjs
 * 
 * Kiểm thử tính năng phân biệt giữa Live và Ready, và các hành vi cốt lõi của App (M3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';

function setupTestApp({ isReady = false } = {}) {
    const config = {
        NODE_ENV: 'test',
        TRUST_LOOPBACK_PROXY: 'false',
    };
    const logger = createLogger({ nodeEnv: 'test' });
    let ready = isReady;
    const readinessState = {
        isReady: () => ready,
        setReady: (v) => { ready = v; },
        getDetails: () => (ready ? 'Ready' : 'Not Ready'),
    };
    const app = createApp({ config, logger, readinessState, healthOnly: true });
    return { app, readinessState };
}

// Helper giả lập request không cần mở network port
async function simulateRequest(app, { method = 'GET', url, headers = {}, body = null }) {
    const http = await import('node:http');
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    try {
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, headers: res.headers, json };
    } finally {
        await new Promise(r => server.close(r));
    }
}

test('/api/health/live luôn trả về 200 kể cả khi readiness = false', async () => {
    const { app } = setupTestApp({ isReady: false });
    const res = await simulateRequest(app, { url: '/api/health/live' });

    assert.equal(res.status, 200);
    assert.equal(res.json?.live, true);
    assert.ok(res.headers.get('x-request-id'), 'Phải có header X-Request-Id');
});

test('/api/health/ready trả về 503 khi chưa sẵn sàng và 200 khi đã sẵn sàng', async () => {
    const { app, readinessState } = setupTestApp({ isReady: false });

    // 1. Khi chưa sẵn sàng -> 503 Service Unavailable
    const unreadyRes = await simulateRequest(app, { url: '/api/health/ready' });
    assert.equal(unreadyRes.status, 503);
    assert.equal(unreadyRes.json?.ready, false);

    // 2. Chuyển sang sẵn sàng -> 200 OK
    readinessState.setReady(true);
    const readyRes = await simulateRequest(app, { url: '/api/health/ready' });
    assert.equal(readyRes.status, 200);
    assert.equal(readyRes.json?.ready, true);
});

test('Các endpoint /api trả về Cache-Control: no-store', async () => {
    const { app } = setupTestApp();
    const res = await simulateRequest(app, { url: '/api/health/live' });
    assert.match(res.headers.get('cache-control') || '', /no-store/);
});

test('Endpoint không tồn tại trong /api trả về JSON 404', async () => {
    const { app } = setupTestApp();
    const res = await simulateRequest(app, { url: '/api/non-existent-endpoint' });
    assert.equal(res.status, 404);
    assert.equal(res.json?.error?.code, 'NOT_FOUND');
    assert.ok(res.json?.requestId);
});
