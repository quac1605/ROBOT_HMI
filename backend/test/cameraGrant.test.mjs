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

test('live camera descriptor requires login; media grant is path bound and revoked on logout', async () => {
  await assertTestTarget(process.env);
  const origin = 'https://127.0.0.1:5173';
  const dataDir = await mkdtemp(path.join(process.env.DATA_DIR, 'camera-grant-'));
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const username = `camera_${randomUUID().replaceAll('-', '')}`;
  const password = `test-${randomUUID()}`;
  let userId;
  let client;
  let cookies = '';
  const runtime = createServerRuntime({ ...process.env,
    HOST: '127.0.0.1', APP_ORIGIN: origin, DATA_DIR: dataDir,
    CAMERA_MEDIA_MODE: 'ros', CAMERA_WHEP_BASE_URL: 'https://127.0.0.1:8889',
  });
  try {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    const inserted = await pool.query(
      'INSERT INTO users(username, password_hash) VALUES($1, $2) RETURNING id',
      [username, hash]);
    userId = inserted.rows[0].id;
    const started = await runtime.start({ port: 0 });
    const baseUrl = `http://127.0.0.1:${started.server.address().port}`;
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
      constructor(url) { super(url, { headers: { Origin: origin, Cookie: cookies } }); }
    }
    client = createHttpWsRobotClient({ baseUrl,
      wsUrl: `ws://127.0.0.1:${started.server.address().port}`,
      fetchImpl: browserFetch, WebSocketClass: BrowserSocket });
    await assert.rejects(() => client.getCameraStream({ cameraId: 'front' }),
      error => error.code === 'UNAUTHENTICATED');
    let connected = false;
    const unsubscribe = client.subscribeConnectionStatus(value => {
      connected = value.status === 'connected';
    });
    await client.login({ username, password });
    const deadline = Date.now() + 2500;
    while (!connected && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(connected, true);
    const front = await client.getCameraStream({ cameraId: 'front' });
    assert.equal(front.kind, 'webrtc');
    assert.equal(front.whepUrl, 'https://127.0.0.1:8889/front/whep');
    const authorize = body => fetch(`${baseUrl}/api/internal/camera-media-auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const body = { protocol: 'webrtc', action: 'read', path: 'front',
      token: front.grantToken };
    assert.equal((await authorize(body)).status, 204);
    assert.equal((await authorize({ ...body, path: 'rear' })).status, 401);
    await client.logout();
    assert.equal((await authorize(body)).status, 401);
    unsubscribe();
  } finally {
    client?.dispose();
    await runtime.stop();
    if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await pool.end();
    await rm(dataDir, { recursive: true, force: true });
  }
});
