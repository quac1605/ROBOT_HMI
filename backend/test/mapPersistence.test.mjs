import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { migrate } from '../src/db/migrations.js';
import { loadMigrations } from '../src/db/migrationFiles.js';
import { createAssetStore } from '../src/storage/assetStore.js';
import { createMapPersistence } from '../src/db/mapPersistence.js';
import { startTemporaryPostgres } from './helpers/temporaryPostgres.mjs';
import { acquireMapFixtureLock } from './helpers/testDatabaseLock.mjs';

const { Pool } = pg;

function grid(mappingSessionId) {
  return {
    source: 'mock', mode: 'snapshot', encoding: 'occupancy-0-100-v1',
    context: { kind: 'mapping', mappingSessionId }, gridRevision: 1,
    grid: {
      header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
      info: { map_load_time: { sec: 1, nanosec: 0 }, resolution: 0.05,
        width: 2, height: 2,
        origin: { position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 } } },
      data: [-1, 0, 100, 50],
    },
  };
}

test('M4 map save: accepted bền vững, retry, crash reconcile, restore độc lập', async () => {
  await assertTestTarget(process.env);
  const runId = randomUUID();
  const robotId = `test-${runId}`;
  const scope = `test-user:${runId}`;
  const runDir = path.join(process.env.DATA_DIR, 'runs', runId);
  const restoreDir = path.join(process.env.DATA_DIR, 'runs', `${runId}-restore`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let restoreCluster;
  const mapIds = new Set();
  const jobIds = new Set();
  const releaseMapFixtureLock = await acquireMapFixtureLock();
  try {
    const assetStore = createAssetStore({ dataDir: runDir });
    const persistence = createMapPersistence({ pool, assetStore });
    const session = await persistence.createMappingSession({ robotId, name: 'Demo mapping' });
    const requestId = randomUUID();
    const accepted = await persistence.acceptFinish({ principalScope: scope, requestId,
      mappingSessionId: session.id, name: 'Saved map' });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.status, 'accepted');
    mapIds.add(accepted.resourceRef.mapId);
    jobIds.add(accepted.body.jobId);
    assert.equal((await persistence.getJob(accepted.body.jobId)).status, 'accepted',
      'getJob phải hoạt động ngay sau accepted');
    const before = await pool.query('SELECT status FROM map_revisions WHERE map_id=$1',
      [accepted.resourceRef.mapId]);
    assert.equal(before.rows[0].status, 'creating');
    await assert.rejects(() => persistence.getReadyMap(accepted.resourceRef.mapId,
      accepted.resourceRef.revision), error => error.code === 'MAP_NOT_FOUND');
    const completed = await persistence.runFinish({ jobId: accepted.body.jobId,
      snapshot: grid(session.id), yaml: 'image: grid.json\nresolution: 0.05\n' });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.result, { mapId: accepted.resourceRef.mapId,
      mapRevision: accepted.resourceRef.revision });
    const ready = await persistence.getReadyMap(accepted.resourceRef.mapId,
      accepted.resourceRef.revision);
    assert.equal(ready.metadata.status, 'ready');
    assert.equal(ready.metadata.assets.every(asset => asset.storage === 'filesystem'), true);
    assert.equal((await persistence.getSavedGrid(ready.metadata.id,
      ready.metadata.revision)).grid.data.length, 4);
    const replay = await persistence.acceptFinish({ principalScope: scope, requestId,
      mappingSessionId: session.id, name: 'Saved map' });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.body, accepted.body,
      'Response accepted phải replay nguyên vẹn dù job đã completed');
    await assert.rejects(() => persistence.acceptFinish({ principalScope: scope,
      requestId, mappingSessionId: session.id, name: 'Changed name' }),
    error => error.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(() => pool.query(
      "UPDATE map_revisions SET name='overwrite' WHERE map_id=$1 AND revision=$2",
      [ready.metadata.id, ready.metadata.revision]), /READY_MAP_IMMUTABLE/);
    await assert.rejects(() => pool.query(
      "UPDATE map_assets SET sha256=$3 WHERE map_id=$1 AND revision=$2 AND asset_kind='grid_json'",
      [ready.metadata.id, ready.metadata.revision, '0'.repeat(64)]),
    /READY_ASSET_IMMUTABLE/);
    await assert.rejects(() => persistence.runFinish({ jobId: accepted.body.jobId,
      snapshot: grid(session.id), yaml: 'another' }), error => error.code === 'JOB_NOT_RUNNABLE');

    const bundle = await persistence.exportReadyMapBundle(ready.metadata.id,
      ready.metadata.revision);
    const corrupted = structuredClone(bundle);
    corrupted.files[0].dataBase64 = Buffer.from('tampered').toString('base64');
    await assert.rejects(() => persistence.restoreReadyMapBundle(corrupted),
      error => error.code === 'BACKUP_HASH_MISMATCH');

    // Separate PostgreSQL cluster/database and DATA_DIR: no source DB/file fallback.
    restoreCluster = await startTemporaryPostgres(path.join(restoreDir, 'cluster'));
    assert.equal((await restoreCluster.pool.query('SELECT current_database() AS name')).rows[0].name,
      'robot_hmi_restore_test');
    await migrate(restoreCluster.pool, await loadMigrations());
    const restored = createMapPersistence({ pool: restoreCluster.pool,
      assetStore: createAssetStore({ dataDir: restoreDir }) });
    await restored.restoreReadyMapBundle(bundle);
    assert.deepEqual((await restored.getReadyMap(ready.metadata.id,
      ready.metadata.revision)).metadata, ready.metadata);
    assert.deepEqual((await restored.getSavedGrid(ready.metadata.id,
      ready.metadata.revision)).grid.data, [-1, 0, 100, 50]);
    const restoredBundle = await restored.exportReadyMapBundle(ready.metadata.id,
      ready.metadata.revision);
    assert.deepEqual(restoredBundle.files.map(file => file.sha256).sort(),
      bundle.files.map(file => file.sha256).sort());

    // Disk failure after first asset: job failed, session save_failed, no ready map.
    const retrySession = await persistence.createMappingSession({ robotId,
      name: 'Retry mapping' });
    const failing = await persistence.acceptFinish({ principalScope: scope,
      requestId: randomUUID(), mappingSessionId: retrySession.id, name: 'Failed map' });
    mapIds.add(failing.resourceRef.mapId);
    jobIds.add(failing.body.jobId);
    let writes = 0;
    const faulty = createMapPersistence({ pool, assetStore: {
      ...assetStore, async storeAsset(input) {
        writes += 1;
        if (writes === 2) throw new Error('TEST_DISK_FAILURE');
        return assetStore.storeAsset(input);
      },
    } });
    await assert.rejects(() => faulty.runFinish({ jobId: failing.body.jobId,
      snapshot: grid(retrySession.id), yaml: 'image: grid.json\n' }), /TEST_DISK_FAILURE/);
    assert.equal((await persistence.getJob(failing.body.jobId)).status, 'failed');
    assert.equal((await pool.query('SELECT status FROM mapping_sessions WHERE id=$1',
      [retrySession.id])).rows[0].status, 'save_failed');
    await assert.rejects(() => persistence.getReadyMap(failing.resourceRef.mapId,
      failing.resourceRef.revision), error => error.code === 'MAP_NOT_FOUND');
    await assert.rejects(fs.access(path.join(runDir, 'assets', 'maps',
      failing.resourceRef.mapId, failing.resourceRef.revision, 'grid.json')));
    const retried = await persistence.acceptFinish({ principalScope: scope,
      requestId: randomUUID(), mappingSessionId: retrySession.id, name: 'Retry saved' });
    mapIds.add(retried.resourceRef.mapId);
    jobIds.add(retried.body.jobId);
    assert.equal((await persistence.runFinish({ jobId: retried.body.jobId,
      snapshot: grid(retrySession.id), yaml: 'image: grid.json\n' })).status, 'completed');

    // Simulate a process crash after DB staging and first atomic file publish.
    const crashSession = await persistence.createMappingSession({ robotId,
      name: 'Crash mapping' });
    const crashed = await persistence.acceptFinish({ principalScope: scope,
      requestId: randomUUID(), mappingSessionId: crashSession.id, name: 'Crash map' });
    mapIds.add(crashed.resourceRef.mapId);
    jobIds.add(crashed.body.jobId);
    const crashKey = `maps/${crashed.resourceRef.mapId}/${crashed.resourceRef.revision}/grid.json`;
    const crashBytes = Buffer.from('incomplete staging data');
    await pool.query(
      "UPDATE jobs SET status='running',dispatch_state='running' WHERE id=$1",
      [crashed.body.jobId]);
    await pool.query(
      "INSERT INTO map_assets(id,map_id,revision,asset_kind,storage_key,sha256,byte_count,status) " +
      "VALUES($1,$2,$3,'grid_json',$4,$5,$6,'staging')",
      [randomUUID(), crashed.resourceRef.mapId, crashed.resourceRef.revision,
        crashKey, '0'.repeat(64), crashBytes.byteLength]);
    await assetStore.storeAsset({ relativeKey: crashKey, data: crashBytes });
    const afterRestart = createMapPersistence({ pool, assetStore });
    const report = await afterRestart.reconcile({ robotId });
    assert.ok(report.interruptedJobs >= 1);
    assert.equal((await afterRestart.getJob(crashed.body.jobId)).status, 'failed');
    assert.equal((await pool.query('SELECT status FROM mapping_sessions WHERE id=$1',
      [crashSession.id])).rows[0].status, 'save_failed');
    await assert.rejects(fs.access(path.join(runDir, 'assets', crashKey)),
      'Reconciliation chỉ xóa file có manifest staging/failed của job này');

    // Ready metadata must stop being advertised if a required asset disappears.
    const readyGridKey = ready.assets.find(asset => asset.asset_kind === 'grid_json').storage_key;
    await fs.unlink(path.join(runDir, 'assets', readyGridKey));
    await assert.rejects(() => afterRestart.getReadyMap(ready.metadata.id,
      ready.metadata.revision), error => error.code === 'MAP_ASSET_UNAVAILABLE');
    const degraded = await afterRestart.reconcile({ robotId });
    assert.ok(degraded.degradedMaps >= 1);
    assert.equal((await pool.query('SELECT status FROM map_revisions WHERE map_id=$1',
      [ready.metadata.id])).rows[0].status, 'failed');
  } finally {
    try {
      if (restoreCluster) await restoreCluster.stop();
      await pool.query('DELETE FROM idempotency_requests WHERE principal_scope=$1', [scope]);
      await pool.query('DELETE FROM jobs WHERE id=ANY($1::text[])', [[...jobIds]]);
      await pool.query('DELETE FROM mapping_sessions WHERE robot_id=$1', [robotId]);
      await pool.query('DELETE FROM maps WHERE id=ANY($1::text[])', [[...mapIds]]);
      await pool.query('DELETE FROM events WHERE robot_id=$1', [robotId]);
    } finally {
      try {
        await pool.end();
      } finally {
        try {
          await fs.rm(runDir, { recursive: true, force: true });
          await fs.rm(restoreDir, { recursive: true, force: true });
        } finally {
          await releaseMapFixtureLock();
        }
      }
    }
  }
});
