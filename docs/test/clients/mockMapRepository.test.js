import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockMapRepository } from '../../../frontend/src/clients/mockMapRepository.js';

function savedRecordFrom(repository, id, revision, name = 'Saved test') {
  return Promise.all([
    repository.getMap('map-demo', 'rev-1'),
    repository.getMapGrid('map-demo', 'rev-1'),
  ]).then(([baseMetadata, baseSnapshot]) => ({
    metadata: {
      ...baseMetadata,
      id,
      revision,
      name,
      createdAt: new Date().toISOString(),
    },
    snapshot: {
      ...baseSnapshot,
      context: { kind: 'saved', mapId: id, mapRevision: revision },
    },
  }));
}

test('prepareSaved không công khai record trước commit và commit xuất hiện nguyên tử', async () => {
  const repository = createMockMapRepository();
  const before = await repository.listMaps();
  const candidate = await savedRecordFrom(repository, 'map-atomic', 'rev-7');
  const prepared = repository.prepareSaved(candidate);

  assert.equal((await repository.listMaps()).length, before.length);
  await assert.rejects(
    repository.getMap('map-atomic', 'rev-7'),
    (error) => error.code === 'MAP_NOT_FOUND'
  );

  repository.commitPrepared(prepared);
  const saved = await repository.getMap('map-atomic', 'rev-7');
  const grid = await repository.getMapGrid('map-atomic', 'rev-7');
  assert.equal(saved.name, 'Saved test');
  assert.deepEqual(grid.context, {
    kind: 'saved',
    mapId: 'map-atomic',
    mapRevision: 'rev-7',
  });
});

test('prepareSaved lỗi geometry/assets không làm lộ map ready và read trả clone', async () => {
  const repository = createMockMapRepository();
  const baseline = await repository.listMaps();
  baseline[0].name = 'mutated outside';
  assert.notEqual((await repository.listMaps())[0].name, 'mutated outside');

  const bad = await savedRecordFrom(repository, 'map-invalid', 'rev-1');
  bad.metadata.width += 1;
  assert.throws(
    () => repository.prepareSaved(bad),
    (error) => error.code === 'MAP_GEOMETRY_MISMATCH'
  );
  assert.equal((await repository.listMaps()).some((map) => map.id === 'map-invalid'), false);

  const wrongFrame = await savedRecordFrom(repository, 'map-wrong-frame', 'rev-1');
  wrongFrame.metadata.frameId = 'odom';
  assert.throws(
    () => repository.prepareSaved(wrongFrame),
    (error) => error.code === 'MAP_GEOMETRY_MISMATCH'
  );
  assert.equal((await repository.listMaps()).some((map) => map.id === 'map-wrong-frame'), false);
});
