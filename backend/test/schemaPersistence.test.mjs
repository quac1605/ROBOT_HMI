import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MissionSchema, RouteSchema } from '@robot-hmi/contracts/mission';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { reconcileInterruptedMissions } from '../src/db/runtimeRecovery.js';

test('M4 schema lưu đủ route/mission DTO và khóa một mission active mỗi robot', async () => {
  await assertTestTarget(process.env);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const mapId = randomUUID();
  const revision = randomUUID();
  const robotId = `test-${randomUUID()}`;
  const routeId = randomUUID();
  const firstId = randomUUID();
  const secondId = randomUUID();
  const poses = [{ frameId: 'map', x: 1, y: 2, yaw: 0 }];
  try {
    await pool.query('INSERT INTO maps(id) VALUES($1)', [mapId]);
    await pool.query(
      "INSERT INTO map_revisions(map_id,revision,name,status,metadata) " +
      "VALUES($1,$2,$3,'creating','{}'::jsonb)", [mapId, revision, 'test map']);
    const route = await pool.query(
      'INSERT INTO routes(id,map_id,revision,name,poses) VALUES($1,$2,$3,$4,$5) ' +
      'RETURNING *', [routeId, mapId, revision, 'Test route', JSON.stringify(poses)]);
    RouteSchema.parse({ routeId: route.rows[0].id, name: route.rows[0].name,
      mapId, mapRevision: revision, poses: route.rows[0].poses,
      createdAt: route.rows[0].created_at.toISOString() });
    const requestId = randomUUID();
    const mission = await pool.query(
      'INSERT INTO missions(id,robot_id,principal,request_id,map_id,revision,kind,poses,' +
      'status,current_pose_index,distance_remaining_m) ' +
      "VALUES($1,$2,$3,$4,$5,$6,'navigate_to_pose',$7,'accepted',0,1.5) RETURNING *",
      [firstId, robotId, 'test-user', requestId, mapId, revision, JSON.stringify(poses)]);
    const row = mission.rows[0];
    assert.equal(row.principal, 'test-user');
    MissionSchema.parse({ missionId: row.id, requestId: row.request_id,
      kind: row.kind, mapId: row.map_id, mapRevision: row.revision,
      poses: row.poses, status: row.status, currentPoseIndex: row.current_pose_index,
      distanceRemainingM: row.distance_remaining_m, error: row.error,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
    await assert.rejects(() => pool.query(
      'INSERT INTO missions(id,robot_id,request_id,map_id,revision,kind,poses,status) ' +
      "VALUES($1,$2,$3,$4,$5,'navigate_to_pose',$6,'accepted')",
      [secondId, robotId, randomUUID(), mapId, revision, JSON.stringify(poses)]),
    /missions_single_active_idx|unique constraint/i);
    await pool.query(
      "UPDATE missions SET status='failed',error=$2,updated_at=now() WHERE id=$1",
      [firstId, { code: 'SERVER_RESTART_RECONCILIATION_REQUIRED',
        message: 'Mission was interrupted.' }]);
    await pool.query(
      'INSERT INTO missions(id,robot_id,request_id,map_id,revision,kind,poses,status) ' +
      "VALUES($1,$2,$3,$4,$5,'navigate_to_pose',$6,'accepted')",
      [secondId, robotId, randomUUID(), mapId, revision, JSON.stringify(poses)]);
    assert.equal(await reconcileInterruptedMissions(pool, { robotId }), 1);
    const after = await pool.query('SELECT status,error FROM missions WHERE id=$1', [secondId]);
    assert.equal(after.rows[0].status, 'failed');
    assert.equal(after.rows[0].error.code, 'SERVER_RESTART_RECONCILIATION_REQUIRED');
    assert.equal(await reconcileInterruptedMissions(pool, { robotId }), 0,
      'Reconcile lặp không sinh terminal event thứ hai');
  } finally {
    await pool.query('DELETE FROM missions WHERE robot_id=$1', [robotId]);
    await pool.query('DELETE FROM events WHERE robot_id=$1', [robotId]);
    await pool.query('DELETE FROM routes WHERE id=$1', [routeId]);
    await pool.query('DELETE FROM maps WHERE id=$1', [mapId]);
    await pool.end();
  }
});
