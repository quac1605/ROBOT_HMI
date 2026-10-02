/**
 * backend/src/routes/mapsRouter.js
 * 
 * ROUTER QUẢN LÝ BẢN ĐỒ VÀ OCCUPANCY GRID (M8 / F8.2).
 */
import { Router } from 'express';

function mapMapsError(err) {
    if (err.name === 'ZodError') {
        err.status = 400;
        err.code = 'VALIDATION_ERROR';
        return err;
    }
    const status404Codes = new Set(['MAP_NOT_FOUND', 'SESSION_NOT_FOUND']);
    const status409Codes = new Set(['MAPPING_NOT_ACTIVE', 'MAPPING_SESSION_NOT_FINISHABLE']);
    const status503Codes = new Set(['MAP_ASSET_UNAVAILABLE', 'MAPPING_GRID_UNAVAILABLE']);
    const status400Codes = new Set(['INVALID_MAP_ID', 'INVALID_MAP_CONTEXT', 'MAP_TOO_LARGE', 'INVALID_MAP_DATA', 'MAP_CONTEXT_MISMATCH', 'MAP_ASSETS_INCOMPLETE']);

    if (status404Codes.has(err.code)) err.status = 404;
    else if (status409Codes.has(err.code)) err.status = 409;
    else if (status503Codes.has(err.code)) err.status = 503;
    else if (status400Codes.has(err.code)) err.status = 400;

    return err;
}

export function createMapsRouter({ lifecycle, mapGridService }) {
    const router = Router();

    // GET /api/maps - Danh sách metadata các bản đồ đã lưu
    router.get('/maps', lifecycle.requireAuth, async (_req, res, next) => {
        try {
            const list = await mapGridService.listMaps();
            res.status(200).json(list);
        } catch (err) {
            next(mapMapsError(err));
        }
    });

    // GET /api/maps/:id - Chi tiết metadata bản đồ kèm mapRevision
    router.get('/maps/:id', lifecycle.requireAuth, async (req, res, next) => {
        try {
            const map = await mapGridService.getMap(req.params.id, req.query.revision);
            res.status(200).json(map);
        } catch (err) {
            next(mapMapsError(err));
        }
    });

    // GET /api/map-grid - Snapshot lưới ô vuông (OccupancyGrid)
    router.get('/map-grid', lifecycle.requireAuth, async (req, res, next) => {
        try {
            const { kind, mapId, mapRevision, mappingSessionId, ...rest } = req.query;
            if (Object.keys(rest).length > 0) {
                return res.status(400).json({
                    error: { code: 'INVALID_MAP_CONTEXT', message: 'Tham số query không hợp lệ' },
                });
            }
            let context;
            if (kind === 'saved') {
                if (mappingSessionId !== undefined) {
                    return res.status(400).json({
                        error: { code: 'INVALID_MAP_CONTEXT', message: 'Saved map không được kèm mappingSessionId' },
                    });
                }
                context = { kind: 'saved', mapId, mapRevision };
            } else if (kind === 'mapping') {
                if (mapId !== undefined || mapRevision !== undefined) {
                    return res.status(400).json({
                        error: { code: 'INVALID_MAP_CONTEXT', message: 'Mapping context không được kèm mapId' },
                    });
                }
                context = { kind: 'mapping', mappingSessionId };
            } else {
                return res.status(400).json({
                    error: { code: 'INVALID_MAP_CONTEXT', message: 'Context kind phải là saved hoặc mapping' },
                });
            }
            const grid = await mapGridService.getMapGrid(context);
            res.status(200).json(grid);
        } catch (err) {
            next(mapMapsError(err));
        }
    });

    return router;
}
