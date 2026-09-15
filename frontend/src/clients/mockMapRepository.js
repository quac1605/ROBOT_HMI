import { demoMap, demoMapRotated } from './demoMap.js';
import { createDemoGrid200x160, createDemoGrid200x160Rotated } from './demoOccupancyGrid.js';
import { MapMetadataSchema } from '../schemas/mapping.js';
import { MapGridSnapshotSchema } from '../schemas/mapGrid.js';
import { normalizeOccupancyGrid } from '../utils/normalizeOccupancyGrid.js';

function deepFreeze(obj) {
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function createDefaultInitialRecords() {
  const meta1 = MapMetadataSchema.parse({
    ...demoMap,
    status: 'ready',
    assets: [
      { type: 'grid_json', source: 'mock', storage: 'memory', status: 'ready' },
      { type: 'yaml_meta', source: 'mock', storage: 'memory', status: 'ready' },
    ],
    capabilities: {
      hasOccupancyGrid: true,
      hasSlamState: false,
      canResumeMapping: false,
      canLocalize: true,
      canNavigate: true,
    },
    createdAt: new Date().toISOString(),
  });

  const snap1 = MapGridSnapshotSchema.parse(createDemoGrid200x160());

  const meta2 = MapMetadataSchema.parse({
    ...demoMapRotated,
    status: 'ready',
    assets: [
      { type: 'grid_json', source: 'mock', storage: 'memory', status: 'ready' },
      { type: 'yaml_meta', source: 'mock', storage: 'memory', status: 'ready' },
    ],
    capabilities: {
      hasOccupancyGrid: true,
      hasSlamState: false,
      canResumeMapping: false,
      canLocalize: true,
      canNavigate: true,
    },
    createdAt: new Date().toISOString(),
  });

  const snap2 = MapGridSnapshotSchema.parse(createDemoGrid200x160Rotated());

  return [
    { metadata: meta1, snapshot: snap1 },
    { metadata: meta2, snapshot: snap2 },
  ];
}

export function createMockMapRepository(initialRecords = null) {
  const keyOf = (id, revision) => JSON.stringify([id, revision]);
  const recordsToLoad = initialRecords ?? createDefaultInitialRecords();

  let records = new Map();
  for (const item of recordsToLoad) {
    const key = keyOf(item.metadata.id, item.metadata.revision);
    records.set(key, deepFreeze({
      key,
      metadata: MapMetadataSchema.parse(structuredClone(item.metadata)),
      snapshot: MapGridSnapshotSchema.parse(structuredClone(item.snapshot)),
    }));
  }

  function assertSavedContextMatches(metadata, context) {
    if (context.kind !== 'saved' || context.mapId !== metadata.id || context.mapRevision !== metadata.revision) {
      const err = new Error(`Context của snapshot (${context.kind}:${context.mapId}:${context.mapRevision}) không khớp metadata (${metadata.id}:${metadata.revision})`);
      err.code = 'MAP_CONTEXT_MISMATCH';
      throw err;
    }
  }

  function assertGeometryMatchesMetadata(metadata, geometry) {
    if (
      metadata.frameId !== geometry.frameId ||
      metadata.width !== geometry.width ||
      metadata.height !== geometry.height ||
      Math.abs(metadata.resolution - geometry.resolution) > 1e-6 ||
      Math.abs(metadata.origin.x - geometry.origin.x) > 1e-5 ||
      Math.abs(metadata.origin.y - geometry.origin.y) > 1e-5 ||
      Math.abs(metadata.origin.yaw - geometry.origin.yaw) > 1e-5
    ) {
      const err = new Error('Geometry của snapshot không khớp với metadata');
      err.code = 'MAP_GEOMETRY_MISMATCH';
      throw err;
    }
  }

  function assertRequiredAssetsReady(assets) {
    const types = new Set(assets.filter((a) => a.status === 'ready').map((a) => a.type));
    if (!types.has('grid_json') || !types.has('yaml_meta')) {
      const err = new Error('Thiếu assets bắt buộc ở trạng thái ready: grid_json và yaml_meta');
      err.code = 'MAP_ASSETS_INCOMPLETE';
      throw err;
    }
  }

  return {
    async listMaps() {
      return Array.from(records.values()).map((r) => structuredClone(r.metadata));
    },

    async getMap(mapId, revision) {
      const key = keyOf(mapId, revision);
      const record = records.get(key);
      if (!record) {
        const err = new Error(`Không tìm thấy map ${mapId}:${revision}`);
        err.code = 'MAP_NOT_FOUND';
        throw err;
      }
      return structuredClone(record.metadata);
    },

    async getMapGrid(mapId, revision) {
      const key = keyOf(mapId, revision);
      const record = records.get(key);
      if (!record) {
        const err = new Error(`Không tìm thấy map grid ${mapId}:${revision}`);
        err.code = 'MAP_NOT_FOUND';
        throw err;
      }
      return structuredClone(record.snapshot);
    },

    prepareSaved({ metadata, snapshot }) {
      const checkedMetadata = MapMetadataSchema.parse(structuredClone(metadata));
      const checkedSnapshot = MapGridSnapshotSchema.parse(structuredClone(snapshot));
      const normalized = normalizeOccupancyGrid(checkedSnapshot);

      assertSavedContextMatches(checkedMetadata, checkedSnapshot.context);
      assertGeometryMatchesMetadata(checkedMetadata, normalized.geometry);
      assertRequiredAssetsReady(checkedMetadata.assets);

      const key = keyOf(checkedMetadata.id, checkedMetadata.revision);
      if (records.has(key)) {
        const err = new Error(`Đã tồn tại bản đồ với ID và revision: ${key}`);
        err.code = 'MAP_REVISION_CONFLICT';
        throw err;
      }

      return deepFreeze({
        key,
        metadata: checkedMetadata,
        snapshot: checkedSnapshot,
      });
    },

    commitPrepared(record) {
      const next = new Map(records);
      next.set(record.key, record);
      records = next; // Điểm commit công khai duy nhất
    },

    remove(mapId, revision) {
      const key = keyOf(mapId, revision);
      const next = new Map(records);
      next.delete(key);
      records = next;
    },
  };
}
