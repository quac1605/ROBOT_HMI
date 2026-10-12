/**
 * backend/src/repositories/missions.js
 * 
 * PERSISTENCE REPOSITORY CHO NHIỆM VỤ ĐIỀU HƯỚNG (MISSIONS - M8 / F8.5).
 */
import { MissionSchema } from '@robot-hmi/contracts/mission';

function mapMissionRow(row) {
    if (!row) return null;
    return MissionSchema.parse({
        missionId: row.id,
        requestId: row.request_id,
        kind: row.kind,
        mapId: row.map_id,
        mapRevision: row.revision,
        poses: typeof row.poses === 'string' ? JSON.parse(row.poses) : row.poses,
        status: row.status,
        currentPoseIndex: row.current_pose_index !== null ? Number(row.current_pose_index) : null,
        distanceRemainingM: row.distance_remaining_m !== null ? Number(row.distance_remaining_m) : null,
        error: row.error ? (typeof row.error === 'string' ? JSON.parse(row.error) : row.error) : null,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
    });
}

export function createMissionsRepository(pool) {
    return {
        async createMission({
            id,
            robotId = 'robot-01',
            principal,
            requestId,
            mapId,
            mapRevision,
            kind,
            poses,
            status = 'accepted',
            currentPoseIndex = null,
            distanceRemainingM = null,
            error = null,
        }, client = pool) {
            const result = await client.query(
                `INSERT INTO missions (
                    id, robot_id, principal, request_id, map_id, revision, kind, poses,
                    status, current_pose_index, distance_remaining_m, error,
                    created_at, updated_at
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
                 RETURNING *`,
                [
                    id, robotId, principal, requestId, mapId, mapRevision, kind,
                    JSON.stringify(poses), status, currentPoseIndex,
                    distanceRemainingM, error ? JSON.stringify(error) : null,
                ],
            );
            return mapMissionRow(result.rows[0]);
        },

        async getActiveMission({ robotId = 'robot-01' } = {}) {
            const result = await pool.query(
                `SELECT * FROM missions
                 WHERE robot_id = $1 AND status IN ('accepted', 'executing', 'canceling')
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [robotId],
            );
            return result.rows[0] ? mapMissionRow(result.rows[0]) : null;
        },

        async getMissionById(id) {
            const result = await pool.query(
                `SELECT * FROM missions WHERE id = $1`,
                [id],
            );
            return result.rows[0] ? mapMissionRow(result.rows[0]) : null;
        },

        async updateMission(id, patch) {
            const {
                status, currentPoseIndex, distanceRemainingM, error,
                allowedStatuses = ['accepted', 'executing', 'canceling'],
            } = patch;
            const hasDistance = Object.hasOwn(patch, 'distanceRemainingM');
            const result = await pool.query(
                `UPDATE missions
                 SET status = COALESCE($2, status),
                     current_pose_index = CASE WHEN $3::int IS NOT NULL THEN $3 ELSE current_pose_index END,
                     distance_remaining_m = CASE WHEN $7::boolean THEN $4::float8 ELSE distance_remaining_m END,
                     error = CASE WHEN $5::jsonb IS NOT NULL THEN $5 ELSE error END,
                     updated_at = NOW()
                 WHERE id = $1 AND status = ANY($6::text[])
                 RETURNING *`,
                [
                    id,
                    status || null,
                    currentPoseIndex ?? null,
                    distanceRemainingM ?? null,
                    error ? JSON.stringify(error) : null,
                    allowedStatuses, hasDistance,
                ],
            );
            return result.rows[0] ? mapMissionRow(result.rows[0]) : null;
        },
    };
}
