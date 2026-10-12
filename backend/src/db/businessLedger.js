import { createHash } from 'node:crypto';
import { stableStringify } from '@robot-hmi/control-domain/stableStringify';
import { withTransaction } from './transaction.js';

const OPERATIONS = new Set([
  'start_mapping', 'finish_mapping', 'activate_map', 'preview_route',
  'save_route', 'create_mission', 'cancel_mission',
]);
const MAX_RECORDS_PER_SCOPE = 4096;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function ledgerError(code, status = 409) {
  return Object.assign(new Error(code), { code, status });
}

function assertJson(value, depth = 0) {
  if (depth > 16) throw ledgerError('INVALID_OPERATION_PAYLOAD', 400);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value) && value.length <= 4096) {
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    if (keys.length > 128) throw ledgerError('INVALID_OPERATION_PAYLOAD', 400);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw ledgerError('INVALID_OPERATION_PAYLOAD', 400);
      }
      assertJson(descriptor.value, depth + 1);
    }
    return;
  }
  throw ledgerError('INVALID_OPERATION_PAYLOAD', 400);
}

export function operationFingerprint(operation, payload) {
  if (!OPERATIONS.has(operation)) throw ledgerError('UNKNOWN_BUSINESS_OPERATION', 400);
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    throw ledgerError('INVALID_OPERATION_PAYLOAD', 400);
  }
  assertJson(payload);
  const canonical = stableStringify({ operation, payload });
  if (Buffer.byteLength(canonical) > 64 * 1024) {
    throw ledgerError('INVALID_OPERATION_PAYLOAD', 413);
  }
  return createHash('sha256').update(canonical).digest('hex');
}

// `principalScope` must be derived by the server from the authenticated user/robot.
// `create` performs only PostgreSQL writes, never ROS/filesystem I/O while holding the lock.
export async function reserveBusinessOperation({
  pool, principalScope, requestId, operation, payload, create, now = Date.now,
  maxRecordsPerScope = MAX_RECORDS_PER_SCOPE,
}) {
  if (typeof principalScope !== 'string' || principalScope.length < 1 ||
      principalScope.length > 256 || typeof requestId !== 'string' ||
      requestId.length < 1 || requestId.length > 128 || typeof create !== 'function' ||
      !Number.isInteger(maxRecordsPerScope) || maxRecordsPerScope < 1 ||
      maxRecordsPerScope > MAX_RECORDS_PER_SCOPE) {
    throw ledgerError('INVALID_OPERATION_IDENTITY', 400);
  }
  const fingerprint = operationFingerprint(operation, payload);
  return withTransaction(pool, async client => {
    // Serialize capacity checks within a scope. A hash collision only adds waiting.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [principalScope]);
    const existing = await client.query(
      'SELECT operation,fingerprint,state,response_status,response_payload,resource_ref,expires_at ' +
      'FROM idempotency_requests WHERE principal_scope=$1 AND request_id=$2 FOR UPDATE',
      [principalScope, requestId]);
    if (existing.rowCount) {
      const prior = existing.rows[0];
      if (prior.operation !== operation || prior.fingerprint !== fingerprint) {
        throw ledgerError('IDEMPOTENCY_CONFLICT');
      }
      if (now() >= new Date(prior.expires_at).getTime() || prior.state === 'expired') {
        throw ledgerError('IDEMPOTENCY_EXPIRED', 410);
      }
      if (prior.state !== 'completed' && prior.state !== 'failed') {
        throw ledgerError('IDEMPOTENCY_RECONCILIATION_REQUIRED');
      }
      return { replayed: true, status: prior.response_status,
        body: prior.response_payload, resourceRef: prior.resource_ref };
    }
    const count = await client.query(
      'SELECT count(*)::integer AS total FROM idempotency_requests WHERE principal_scope=$1',
      [principalScope]);
    if (count.rows[0].total >= maxRecordsPerScope) {
      throw ledgerError('IDEMPOTENCY_SCOPE_EXHAUSTED', 429);
    }
    await client.query(
      'INSERT INTO idempotency_requests' +
      '(principal_scope,request_id,operation,fingerprint,state,expires_at) ' +
      "VALUES($1,$2,$3,$4,'pending',$5)",
      [principalScope, requestId, operation, fingerprint, new Date(now() + RETENTION_MS)]);
    const created = await create(client);
    if (!created || !Number.isInteger(created.status) || created.status < 200 ||
        created.status > 599 || !created.body || typeof created.body !== 'object') {
      throw ledgerError('INVALID_OPERATION_RESULT', 500);
    }
    assertJson(created.body);
    if (created.resourceRef !== undefined) assertJson(created.resourceRef);
    await client.query(
      "UPDATE idempotency_requests SET state='completed',response_status=$3," +
      'response_payload=$4,resource_ref=$5 WHERE principal_scope=$1 AND request_id=$2',
      [principalScope, requestId, created.status, created.body, created.resourceRef ?? null]);
    return { replayed: false, status: created.status,
      body: created.body, resourceRef: created.resourceRef ?? null };
  });
}
