/**
 * backend/src/repositories/routes.js
 * 
 * PERSISTENCE REPOSITORY CHO LỘ TRÌNH (ROUTES - M8 / F8.5).
 */
import { RouteSchema } from '@robot-hmi/contracts/mission';

function mapRouteRow(row) {
    if (!row) return null;
    return RouteSchema.parse({
        routeId: row.id,
        name: row.name,
        mapId: row.map_id,
        mapRevision: row.revision,
        poses: typeof row.poses === 'string' ? JSON.parse(row.poses) : row.poses,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    });
}

export function createRoutesRepository(pool) {
    return {
        async saveRoute({ id, mapId, mapRevision, name, poses }, client = pool) {
            const result = await client.query(
                `INSERT INTO routes (id, map_id, revision, name, poses, created_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 RETURNING id, map_id, revision, name, poses, created_at`,
                [id, mapId, mapRevision, name, JSON.stringify(poses)],
            );
            return mapRouteRow(result.rows[0]);
        },

        async listRoutes({ mapId, mapRevision }) {
            const result = await pool.query(
                `SELECT id, map_id, revision, name, poses, created_at
                 FROM routes
                 WHERE map_id = $1 AND revision = $2
                 ORDER BY created_at DESC`,
                [mapId, mapRevision],
            );
            return result.rows.map(mapRouteRow);
        },

        async getRouteById(id) {
            const result = await pool.query(
                `SELECT id, map_id, revision, name, poses, created_at
                 FROM routes
                 WHERE id = $1`,
                [id],
            );
            return result.rows[0] ? mapRouteRow(result.rows[0]) : null;
        },
    };
}
