import { createHash, randomUUID } from 'node:crypto';
import { MapMetadataSchema, FinishMappingRequestSchema } from '@robot-hmi/contracts/mapping';
import { parseMapGridSnapshot } from '@robot-hmi/contracts/mapGrid';
import { JobSchema } from '@robot-hmi/contracts/job';
import { reserveBusinessOperation } from './businessLedger.js';
import { withTransaction } from './transaction.js';

const REQUIRED_ASSETS = Object.freeze([
  { kind: 'grid_json', filename: 'grid.json' },
  { kind: 'yaml_meta', filename: 'metadata.yaml' },
]);

function sha256(data) { return createHash('sha256').update(data).digest('hex'); }

function mapError(code, status = 409) {
  return Object.assign(new Error(code), { code, status });
}

function jobDto(row) {
  return JobSchema.parse({
    jobId: row.id, type: row.kind, status: row.status,
    result: row.result, error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function geometryOf(snapshot) {
  const { header, info } = snapshot.grid;
  const { position, orientation: q } = info.origin;
  const norm = Math.hypot(q.x, q.y, q.z, q.w);
  if (Math.abs(norm - 1) > 1e-3) throw mapError('INVALID_MAP_ORIENTATION', 400);
  const x = q.x / norm; const y = q.y / norm;
  const z = q.z / norm; const w = q.w / norm;
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  if (Math.abs(roll) > 1e-4 || Math.abs(pitch) > 1e-4) {
    throw mapError('UNSUPPORTED_MAP_ORIENTATION', 400);
  }
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { frameId: header.frame_id, width: info.width, height: info.height,
    resolution: info.resolution, origin: { x: position.x, y: position.y, yaw } };
}

function assertMetadataMatchesGrid(metadata, snapshot) {
  const geometry = geometryOf(snapshot);
  if (metadata.frameId !== geometry.frameId || metadata.width !== geometry.width ||
      metadata.height !== geometry.height ||
      Math.abs(metadata.resolution - geometry.resolution) > 1e-6 ||
      Math.abs(metadata.origin.x - geometry.origin.x) > 1e-5 ||
      Math.abs(metadata.origin.y - geometry.origin.y) > 1e-5 ||
      Math.abs(metadata.origin.yaw - geometry.origin.yaw) > 1e-5) {
    throw mapError('MAP_GEOMETRY_MISMATCH', 400);
  }
}

function assertRequiredMetadata(metadata) {
  const kinds = metadata.assets.filter(asset => asset.status === 'ready' &&
    asset.source === 'mock' && asset.storage === 'filesystem').map(asset => asset.type);
  if (kinds.length !== REQUIRED_ASSETS.length ||
      REQUIRED_ASSETS.some(asset => kinds.filter(kind => kind === asset.kind).length !== 1)) {
    throw mapError('MAP_ASSETS_INCOMPLETE', 400);
  }
}

function safeCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(code)
    ? code : 'SAVE_FAILED';
}

export function createMapPersistence({ pool, assetStore }) {
  if (!pool || !assetStore) throw new Error('MAP_PERSISTENCE_DEPENDENCIES_REQUIRED');

  async function createMappingSession({ robotId, name }) {
    if (typeof robotId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(robotId) ||
        typeof name !== 'string' || name.trim().length < 1 || name.length > 120) {
      throw mapError('INVALID_MAPPING_SESSION', 400);
    }
    const id = randomUUID();
    const result = await pool.query(
      "INSERT INTO mapping_sessions(id,robot_id,name,status,active) VALUES($1,$2,$3,'mapping',true) " +
      'RETURNING id,robot_id,name,status,started_at', [id, robotId, name.trim()]);
    return result.rows[0];
  }

  // Accepted job, map identity, session transition and HTTP replay are one DB commit.
  async function acceptFinish({ principalScope, requestId, mappingSessionId, name }) {
    const input = FinishMappingRequestSchema.parse({ requestId, mappingSessionId, name });
    return reserveBusinessOperation({
      pool, principalScope, requestId: input.requestId, operation: 'finish_mapping',
      payload: { mappingSessionId: input.mappingSessionId, name: input.name },
      create: async client => {
        const session = await client.query(
          'SELECT id,robot_id,status FROM mapping_sessions WHERE id=$1 AND active=true FOR UPDATE',
          [input.mappingSessionId]);
        if (!session.rowCount || !['mapping', 'save_failed'].includes(session.rows[0].status)) {
          throw mapError('MAPPING_SESSION_NOT_FINISHABLE');
        }
        const mapId = randomUUID(); const revision = randomUUID(); const jobId = randomUUID();
        const context = { mappingSessionId: input.mappingSessionId, mapId, revision,
          robotId: session.rows[0].robot_id, name: input.name };
        await client.query('INSERT INTO maps(id) VALUES($1)', [mapId]);
        await client.query(
          "INSERT INTO map_revisions(map_id,revision,name,status,metadata) " +
          "VALUES($1,$2,$3,'creating','{}'::jsonb)", [mapId, revision, input.name]);
        await client.query(
          "INSERT INTO jobs(id,kind,status,result,error,principal,operation_payload,dispatch_state) " +
          "VALUES($1,'finish_mapping','accepted',NULL,NULL,$2,$3,'pending')",
          [jobId, principalScope, context]);
        await client.query(
          "UPDATE mapping_sessions SET status='finishing',recovery_context=$2 WHERE id=$1",
          [input.mappingSessionId, { jobId, mapId, revision }]);
        await client.query(
          'INSERT INTO events(event_type,robot_id,principal,request_id,resource_ref,payload) ' +
          'VALUES($1,$2,$3,$4,$5,$6)',
          ['mapping.finish.accepted', context.robotId, principalScope, input.requestId,
            { jobId, mapId, revision }, { mappingSessionId: input.mappingSessionId }]);
        return { status: 202, body: { jobId, status: 'accepted' },
          resourceRef: { jobId, mapId, revision } };
      },
    });
  }

  async function getJob(jobId) {
    const result = await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (!result.rowCount) throw mapError('JOB_NOT_FOUND', 404);
    return jobDto(result.rows[0]);
  }

  async function markSaveFailed(jobId, code) {
    const context = await withTransaction(pool, async client => {
      const found = await client.query(
        "SELECT operation_payload FROM jobs WHERE id=$1 AND kind='finish_mapping' FOR UPDATE", [jobId]);
      if (!found.rowCount) return null;
      const ctx = found.rows[0].operation_payload;
      const updated = await client.query(
        "UPDATE jobs SET status='failed',result=NULL,error=$2,dispatch_state='done',updated_at=now() " +
        "WHERE id=$1 AND status IN ('accepted','running') RETURNING id",
        [jobId, { code, message: 'Không lưu được bản đồ; có thể thử lại với requestId mới.' }]);
      if (!updated.rowCount) return null;
      await client.query(
        "UPDATE mapping_sessions SET status='save_failed',active=true WHERE id=$1",
        [ctx.mappingSessionId]);
      await client.query(
        "UPDATE map_revisions SET status='failed' WHERE map_id=$1 AND revision=$2 AND status='creating'",
        [ctx.mapId, ctx.revision]);
      await client.query(
        "UPDATE map_assets SET status='failed' WHERE map_id=$1 AND revision=$2 AND status='staging'",
        [ctx.mapId, ctx.revision]);
      return ctx;
    });
    if (context) {
      // Cleanup failure leaves a failed manifest for the next startup pass.
      await cleanupFailedAssets(context.mapId, context.revision).catch(() => {});
    }
  }

  async function cleanupFailedAssets(mapId, revision) {
    const rows = await pool.query(
      "SELECT storage_key FROM map_assets WHERE map_id=$1 AND revision=$2 AND status='failed'",
      [mapId, revision]);
    for (const row of rows.rows) {
      await assetStore.removeUncommittedAsset(row.storage_key);
    }
  }

  // The caller dispatches this only after acceptFinish has committed.
  // No DB transaction remains open while files are written or verified.
  async function runFinish({ jobId, snapshot, yaml }) {
    const claim = await pool.query(
      "UPDATE jobs SET status='running',dispatch_state='running',updated_at=now() " +
      "WHERE id=$1 AND kind='finish_mapping' AND status='accepted' AND dispatch_state='pending' " +
      'RETURNING operation_payload,created_at', [jobId]);
    if (!claim.rowCount) throw mapError('JOB_NOT_RUNNABLE');
    const context = claim.rows[0].operation_payload;
    try {
      const saved = structuredClone(snapshot);
      saved.context = { kind: 'saved', mapId: context.mapId,
        mapRevision: context.revision };
      const grid = parseMapGridSnapshot(saved);
      const geometry = geometryOf(grid);
      if (typeof yaml !== 'string' || Buffer.byteLength(yaml) < 1 ||
          Buffer.byteLength(yaml) > 16 * 1024) throw mapError('YAML_ASSET_INVALID', 400);
      const assets = REQUIRED_ASSETS.map(({ kind, filename }) => ({
        kind, storageKey: `maps/${context.mapId}/${context.revision}/${filename}`,
        data: kind === 'grid_json' ? Buffer.from(JSON.stringify(grid)) : Buffer.from(yaml),
      }));
      const metadata = MapMetadataSchema.parse({
        id: context.mapId, revision: context.revision, name: context.name,
        status: 'ready', ...geometry,
        assets: REQUIRED_ASSETS.map(({ kind }) => ({
          type: kind, source: 'mock', storage: 'filesystem', status: 'ready',
        })),
        capabilities: { hasOccupancyGrid: true, hasSlamState: false,
          canResumeMapping: false, canLocalize: true, canNavigate: true },
        createdAt: new Date(claim.rows[0].created_at).toISOString(),
      });
      await withTransaction(pool, async client => {
        for (const asset of assets) {
          await client.query(
            "INSERT INTO map_assets(id,map_id,revision,asset_kind,storage_key,sha256,byte_count,status) " +
            "VALUES($1,$2,$3,$4,$5,$6,$7,'staging')",
            [randomUUID(), context.mapId, context.revision, asset.kind,
              asset.storageKey, sha256(asset.data), asset.data.byteLength]);
        }
      });
      for (const asset of assets) {
        await assetStore.storeAsset({ relativeKey: asset.storageKey, data: asset.data });
        await assetStore.readAsset(asset.storageKey,
          { sha256: sha256(asset.data), byteCount: asset.data.byteLength });
      }
      await withTransaction(pool, async client => {
        const job = await client.query('SELECT status FROM jobs WHERE id=$1 FOR UPDATE', [jobId]);
        if (job.rows[0]?.status !== 'running') throw mapError('JOB_NOT_RUNNABLE');
        const updated = await client.query(
          "UPDATE map_assets SET status='ready' WHERE map_id=$1 AND revision=$2 " +
          "AND status='staging' RETURNING id", [context.mapId, context.revision]);
        if (updated.rowCount !== REQUIRED_ASSETS.length) throw mapError('MAP_ASSETS_INCOMPLETE');
        await client.query(
          "UPDATE map_revisions SET status='ready',metadata=$3 WHERE map_id=$1 AND revision=$2 " +
          "AND status='creating'", [context.mapId, context.revision, metadata]);
        await client.query(
          "UPDATE jobs SET status='completed',result=$2,error=NULL,dispatch_state='done'," +
          'updated_at=now() WHERE id=$1',
          [jobId, { mapId: context.mapId, mapRevision: context.revision }]);
        await client.query(
          'UPDATE mapping_sessions SET active=false,ended_at=now(),recovery_context=NULL ' +
          'WHERE id=$1', [context.mappingSessionId]);
        await client.query(
          'INSERT INTO events(event_type,robot_id,principal,resource_ref,payload) ' +
          'VALUES($1,$2,$3,$4,$5)',
          ['mapping.finish.completed', context.robotId, null,
            { jobId, mapId: context.mapId, revision: context.revision }, {}]);
      });
      return getJob(jobId);
    } catch (error) {
      await markSaveFailed(jobId, safeCode(error));
      throw error;
    }
  }

  async function getReadyMap(mapId, revision) {
    const found = await pool.query(
      "SELECT metadata FROM map_revisions WHERE map_id=$1 AND revision=$2 AND status='ready'",
      [mapId, revision]);
    if (!found.rowCount) throw mapError('MAP_NOT_FOUND', 404);
    const metadata = MapMetadataSchema.parse(found.rows[0].metadata);
    assertRequiredMetadata(metadata);
    const assets = await pool.query(
      "SELECT asset_kind,storage_key,sha256,byte_count FROM map_assets " +
      "WHERE map_id=$1 AND revision=$2 AND status='ready'", [mapId, revision]);
    if (assets.rowCount !== REQUIRED_ASSETS.length ||
        REQUIRED_ASSETS.some(required =>
          assets.rows.filter(asset => asset.asset_kind === required.kind).length !== 1)) {
      throw mapError('MAP_ASSETS_INCOMPLETE');
    }
    for (const asset of assets.rows) {
      try {
        await assetStore.readAsset(asset.storage_key,
          { sha256: asset.sha256, byteCount: Number(asset.byte_count) });
      } catch {
        throw mapError('MAP_ASSET_UNAVAILABLE', 503);
      }
    }
    return { metadata, assets: assets.rows };
  }

  async function getSavedGrid(mapId, revision) {
    const { assets } = await getReadyMap(mapId, revision);
    const record = assets.find(asset => asset.asset_kind === 'grid_json');
    let bytes;
    try {
      bytes = await assetStore.readAsset(record.storage_key,
        { sha256: record.sha256, byteCount: Number(record.byte_count) });
    } catch { throw mapError('MAP_ASSET_UNAVAILABLE', 503); }
    const snapshot = parseMapGridSnapshot(JSON.parse(bytes.toString('utf8')));
    if (snapshot.context.kind !== 'saved' || snapshot.context.mapId !== mapId ||
        snapshot.context.mapRevision !== revision) throw mapError('MAP_CONTEXT_MISMATCH');
    return snapshot;
  }

  // Startup reconciliation never replays a robot command or resumes a map save.
  async function reconcile({ robotId } = {}) {
    await assetStore.cleanupStagingTemps();
    const pending = await pool.query(
      "SELECT j.id FROM jobs j LEFT JOIN mapping_sessions s " +
      "ON s.id=j.operation_payload->>'mappingSessionId' " +
      "WHERE j.kind='finish_mapping' AND j.status IN ('accepted','running') " +
      'AND ($1::text IS NULL OR s.robot_id=$1 OR s.id IS NULL)', [robotId ?? null]);
    for (const row of pending.rows) {
      await markSaveFailed(row.id, 'SERVER_RESTART_RECONCILIATION_REQUIRED');
    }
    const failed = await pool.query(
      "SELECT map_id,revision FROM map_assets WHERE status='failed' " +
      'GROUP BY map_id,revision');
    for (const row of failed.rows) await cleanupFailedAssets(row.map_id, row.revision);
    const ready = await pool.query(
      "SELECT map_id,revision FROM map_revisions WHERE status='ready'");
    let degraded = 0;
    for (const row of ready.rows) {
      try { await getReadyMap(row.map_id, row.revision); }
      catch {
        await pool.query(
          "UPDATE map_revisions SET status='failed'," +
          "metadata=jsonb_set(metadata,'{status}','\"failed\"'::jsonb) " +
          "WHERE map_id=$1 AND revision=$2 AND status='ready'",
          [row.map_id, row.revision]);
        degraded += 1;
      }
    }
    return { interruptedJobs: pending.rowCount, degradedMaps: degraded };
  }

  async function exportReadyMapBundle(mapId, revision) {
    const { metadata, assets } = await getReadyMap(mapId, revision);
    const files = [];
    for (const asset of assets) {
      const data = await assetStore.readAsset(asset.storage_key,
        { sha256: asset.sha256, byteCount: Number(asset.byte_count) });
      files.push({ kind: asset.asset_kind, storageKey: asset.storage_key,
        sha256: asset.sha256, byteCount: Number(asset.byte_count),
        dataBase64: data.toString('base64') });
    }
    return { version: 1, metadata, files };
  }

  async function restoreReadyMapBundle(bundle) {
    if (!bundle || bundle.version !== 1 || !Array.isArray(bundle.files)) {
      throw mapError('BACKUP_INVALID', 400);
    }
    const metadata = MapMetadataSchema.parse(bundle.metadata);
    if (metadata.status !== 'ready') throw mapError('BACKUP_INVALID', 400);
    assertRequiredMetadata(metadata);
    if (bundle.files.length !== REQUIRED_ASSETS.length) throw mapError('BACKUP_INVALID', 400);
    const files = bundle.files.map(file => {
      if (!REQUIRED_ASSETS.some(asset => asset.kind === file.kind) ||
          typeof file.dataBase64 !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64)) {
        throw mapError('BACKUP_INVALID', 400);
      }
      const data = Buffer.from(file.dataBase64, 'base64');
      if (data.toString('base64') !== file.dataBase64 ||
          data.byteLength !== file.byteCount || sha256(data) !== file.sha256) {
        throw mapError('BACKUP_HASH_MISMATCH', 400);
      }
      const expectedKey = `maps/${metadata.id}/${metadata.revision}/` +
        REQUIRED_ASSETS.find(asset => asset.kind === file.kind).filename;
      if (file.storageKey !== expectedKey) throw mapError('BACKUP_INVALID', 400);
      return { ...file, data };
    });
    if (new Set(files.map(file => file.kind)).size !== REQUIRED_ASSETS.length) {
      throw mapError('BACKUP_INVALID', 400);
    }
    const gridBytes = files.find(file => file.kind === 'grid_json').data;
    const snapshot = parseMapGridSnapshot(JSON.parse(gridBytes.toString('utf8')));
    if (snapshot.context.kind !== 'saved' || snapshot.context.mapId !== metadata.id ||
        snapshot.context.mapRevision !== metadata.revision) throw mapError('MAP_CONTEXT_MISMATCH', 400);
    assertMetadataMatchesGrid(metadata, snapshot);
    const written = [];
    try {
      for (const file of files) {
        await assetStore.storeAsset({ relativeKey: file.storageKey, data: file.data });
        written.push(file.storageKey);
      }
      await withTransaction(pool, async client => {
        await client.query('INSERT INTO maps(id) VALUES($1)', [metadata.id]);
        await client.query(
          "INSERT INTO map_revisions(map_id,revision,name,status,metadata) " +
          "VALUES($1,$2,$3,'ready',$4)",
          [metadata.id, metadata.revision, metadata.name, metadata]);
        for (const file of files) {
          await client.query(
            "INSERT INTO map_assets(id,map_id,revision,asset_kind,storage_key,sha256,byte_count,status) " +
            "VALUES($1,$2,$3,$4,$5,$6,$7,'ready')",
            [randomUUID(), metadata.id, metadata.revision, file.kind,
              file.storageKey, file.sha256, file.byteCount]);
        }
      });
    } catch (error) {
      for (const key of written) await assetStore.removeUncommittedAsset(key).catch(() => {});
      throw error;
    }
    return metadata;
  }

  return { createMappingSession, acceptFinish, runFinish,
    failAcceptedFinish: markSaveFailed, getJob,
    getReadyMap, getSavedGrid, reconcile, exportReadyMapBundle,
    restoreReadyMapBundle };
}
