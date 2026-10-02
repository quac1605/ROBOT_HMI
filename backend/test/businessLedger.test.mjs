import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { reserveBusinessOperation, operationFingerprint } from '../src/db/businessLedger.js';

const { Pool } = pg;

test('M4 ledger: concurrent reserve, replay sau restart, conflict, expiry và rollback', async () => {
  await assertTestTarget(process.env);
  const scope = `test-user:${randomUUID()}`;
  const robotId = `test-${randomUUID()}`;
  const requestId = randomUUID();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let secondPool;
  let creates = 0;
  let currentTime = Date.now();
  try {
    const input = {
      principalScope: scope, requestId, operation: 'save_route',
      payload: { mapId: 'map-A', poses: [{ x: 1, y: 2 }], name: 'Route' },
      now: () => currentTime,
      create: async client => {
        creates += 1;
        const resourceId = randomUUID();
        await client.query(
          'INSERT INTO events(event_type,robot_id,principal,request_id,payload) ' +
          'VALUES($1,$2,$3,$4,$5)',
          ['test.ledger.created', robotId, scope, requestId, { resourceId }]);
        return { status: 201, body: { routeId: resourceId }, resourceRef: { resourceId } };
      },
    };
    assert.equal(operationFingerprint('save_route', { a: 1, b: 2 }),
      operationFingerprint('save_route', { b: 2, a: 1 }));
    assert.throws(() => operationFingerprint('save_route', { speed: Infinity }),
      /INVALID_OPERATION_PAYLOAD/);
    assert.throws(() => operationFingerprint('teleop.velocity', {}),
      /UNKNOWN_BUSINESS_OPERATION/, 'Velocity không được ghi vào durable ledger');

    const concurrent = await Promise.all(Array.from({ length: 12 }, () =>
      reserveBusinessOperation({ ...input, pool })));
    assert.equal(creates, 1);
    assert.equal(concurrent.filter(result => !result.replayed).length, 1);
    assert.ok(concurrent.every(result =>
      result.body.routeId === concurrent[0].body.routeId && result.status === 201));
    const count = await pool.query(
      'SELECT count(*)::integer AS n FROM events WHERE robot_id=$1 AND request_id=$2',
      [robotId, requestId]);
    assert.equal(count.rows[0].n, 1, 'Resource và accepted response chỉ commit một lần');

    await pool.end();
    secondPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const replay = await reserveBusinessOperation({ ...input, pool: secondPool });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, concurrent[0].body);
    assert.equal(creates, 1);
    await assert.rejects(() => reserveBusinessOperation({ ...input, pool: secondPool,
      requestId: randomUUID(), maxRecordsPerScope: 1 }),
    error => error.code === 'IDEMPOTENCY_SCOPE_EXHAUSTED' && error.status === 429);
    assert.deepEqual((await reserveBusinessOperation({ ...input, pool: secondPool,
      maxRecordsPerScope: 1 })).body, concurrent[0].body,
    'Hết quota không được quên fingerprint của ID cũ');
    await assert.rejects(() => reserveBusinessOperation({ ...input, pool: secondPool,
      payload: { name: 'Different' } }), error => error.code === 'IDEMPOTENCY_CONFLICT');
    currentTime += 24 * 60 * 60 * 1000;
    await assert.rejects(() => reserveBusinessOperation({ ...input, pool: secondPool }),
      error => error.code === 'IDEMPOTENCY_EXPIRED' && error.status === 410);
    assert.equal(creates, 1, 'ID cũ hết hạn không được tạo resource mới');

    const failingId = randomUUID();
    await assert.rejects(() => reserveBusinessOperation({ ...input, pool: secondPool,
      requestId: failingId, create: async client => {
        await client.query(
          'INSERT INTO events(event_type,robot_id,payload) VALUES($1,$2,$3)',
          ['test.ledger.rollback', robotId, {}]);
        throw new Error('TEST_CREATE_FAILURE');
      } }), /TEST_CREATE_FAILURE/);
    const rows = await secondPool.query(
      'SELECT count(*)::integer AS n FROM idempotency_requests ' +
      'WHERE principal_scope=$1 AND request_id=$2', [scope, failingId]);
    assert.equal(rows.rows[0].n, 0, 'Ledger row cũng rollback khi tạo resource lỗi');
    const events = await secondPool.query(
      "SELECT count(*)::integer AS n FROM events WHERE robot_id=$1 AND event_type='test.ledger.rollback'",
      [robotId]);
    assert.equal(events.rows[0].n, 0);
  } finally {
    const cleanupPool = secondPool ?? pool;
    if (pool !== cleanupPool && !pool.ending) await pool.end();
    await cleanupPool.query('DELETE FROM idempotency_requests WHERE principal_scope=$1', [scope]);
    await cleanupPool.query('DELETE FROM events WHERE robot_id=$1', [robotId]);
    await cleanupPool.end();
  }
});
