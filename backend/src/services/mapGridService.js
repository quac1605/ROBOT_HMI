/**
 * backend/src/services/mapGridService.js
 * 
 * QUẢN LÝ VÀ STREAM BẢN ĐỒ LƯỚI 2D OCCUPANCY GRID (M8 / F8.2).
 * Giới hạn tối đa 262,144 ô, 2 MiB UTF-8, metadata 16 KiB.
 */
import { randomUUID } from 'node:crypto';
import {
    MapMetadataSchema,
    ListMapsResponseSchema,
    GetMapResponseSchema,
} from '@robot-hmi/contracts/mapping';
import {
    MapContextSchema,
    parseMapGridSnapshot,
} from '@robot-hmi/contracts/mapGrid';

function mapError(code, status = 400) {
    return Object.assign(new Error(code), { code, status });
}

export function createMapGridService({ pool, mapPersistence, adapter, registry, lifecycle }) {
    let sequence = 0;
    const streamId = randomUUID();
    const activeByConnection = new Map();

    async function listMaps() {
        const result = await pool.query(
            "SELECT metadata FROM map_revisions WHERE status = 'ready' ORDER BY created_at DESC"
        );
        const list = [];
        for (const row of result.rows) {
            const metadata = MapMetadataSchema.parse(row.metadata);
            // A DB row marked ready is insufficient if an asset disappeared.
            try { await mapPersistence.getReadyMap(metadata.id, metadata.revision); }
            catch { throw mapError('MAP_ASSET_UNAVAILABLE', 503); }
            list.push(metadata);
        }
        return ListMapsResponseSchema.parse(list);
    }

    async function getMap(mapId, revision) {
        if (typeof mapId !== 'string' || !mapId.trim()) {
            throw mapError('INVALID_MAP_ID', 400);
        }
        let query;
        let params;
        if (revision && typeof revision === 'string' && revision.trim()) {
            query = "SELECT metadata FROM map_revisions WHERE map_id = $1 AND revision = $2 AND status = 'ready'";
            params = [mapId, revision];
        } else {
            query = "SELECT metadata FROM map_revisions WHERE map_id = $1 AND status = 'ready' ORDER BY created_at DESC LIMIT 1";
            params = [mapId];
        }
        const result = await pool.query(query, params);
        if (!result.rowCount) {
            throw mapError('MAP_NOT_FOUND', 404);
        }
        const metadata = MapMetadataSchema.parse(result.rows[0].metadata);
        await mapPersistence.getReadyMap(metadata.id, metadata.revision);
        return GetMapResponseSchema.parse(metadata);
    }

    async function getMapGrid(rawContext) {
        const context = MapContextSchema.parse(rawContext);
        if (context.kind === 'saved') {
            const snapshot = await mapPersistence.getSavedGrid(context.mapId, context.mapRevision);
            return parseMapGridSnapshot(snapshot);
        }

        if (context.kind === 'mapping') {
            const sessionRes = await pool.query(
                "SELECT id, status, active FROM mapping_sessions WHERE id = $1",
                [context.mappingSessionId]
            );
            if (!sessionRes.rowCount) {
                throw mapError('SESSION_NOT_FOUND', 404);
            }
            const session = sessionRes.rows[0];
            if (!session.active) {
                throw mapError('MAPPING_NOT_ACTIVE', 409);
            }
            const liveSnapshot = adapter.getMappingGrid(context.mappingSessionId);
            const parsed = parseMapGridSnapshot(liveSnapshot);
            if (parsed.context.kind !== 'mapping' ||
                parsed.context.mappingSessionId !== context.mappingSessionId) {
                throw mapError('MAP_CONTEXT_MISMATCH', 400);
            }
            return parsed;
        }

        throw mapError('INVALID_MAP_CONTEXT', 400);
    }

    function unsubscribeClient(record, subscriptionId) {
        const active = record && activeByConnection.get(record.connectionId);
        if (active && active.id === subscriptionId) active.cancel();
    }

    function subscribeClient(record, { context: rawContext, subscriptionId }) {
        if (!record || record.closed || record.kind !== 'map' ||
            registry.get(record.connectionId) !== record) return;
        const context = MapContextSchema.parse(rawContext);
        unsubscribeClient(record, activeByConnection.get(record.connectionId)?.id);

        const active = {
            id: subscriptionId,
            context,
            cancelled: false,
            cancel() {
                if (active.cancelled) return;
                active.cancelled = true;
                if (activeByConnection.get(record.connectionId) === active) {
                    activeByConnection.delete(record.connectionId);
                }
                record.subscriptions.delete(active.cancel);
            },
        };
        activeByConnection.set(record.connectionId, active);
        record.subscriptions.add(active.cancel);

        const isCurrent = () => !active.cancelled && !record.closed &&
            activeByConnection.get(record.connectionId) === active &&
            registry.get(record.connectionId) === record;
        const send = frame => isCurrent() && registry.send(record.connectionId, frame);
        const envelope = (type, payload) => ({
            version: 1, type, subscriptionId, streamId, streamEpoch: 1,
            sequence: ++sequence, sentAt: new Date().toISOString(), payload,
        });

        void (async () => {
            try {
                const snapshot = await getMapGrid(context);
                if (!isCurrent()) return;
                // No source timestamp is known for this mock live grid. A
                // resend must not pretend that cached cells are fresh.
                if (!send(envelope('map.status', {
                    context, state: 'ready',
                    sourceState: context.kind === 'saved' ? 'saved' : 'stale',
                    lastSourceUpdateAgeMs: null,
                }))) return;
                send(envelope('map.grid', snapshot));
            } catch (error) {
                if (!isCurrent()) return;
                const code = typeof error?.code === 'string' &&
                    /^[A-Z][A-Z0-9_]{2,80}$/.test(error.code)
                    ? error.code : 'MAP_UNAVAILABLE';
                // Do not echo database/asset paths or driver error messages.
                send(envelope('map.error', {
                    context, error: { code, message: code },
                }));
            }
        })();
    }

    return {
        listMaps,
        getMap,
        getMapGrid,
        subscribeClient,
        unsubscribeClient,
    };
}
