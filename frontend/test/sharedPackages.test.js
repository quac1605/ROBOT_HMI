import test from 'node:test';
import assert from 'node:assert/strict';

const contractModules = [
  'robotState',
  'camera',
  'job',
  'mapping',
  'mission',
  'control',
  'mapGrid',
];

const controlModules = [
  'controlPolicy',
  'controlLeaseCore',
  'stopObservation',
  'motionAdmissionGate',
  'controlRequestRegistry',
  'stableStringify',
  'controlEvidence',
  'controlStreamFence',
];

async function assertSameExports(oldSpecifier, sharedSpecifier, label) {
  const oldModule = await import(oldSpecifier);
  const sharedModule = await import(sharedSpecifier);

  assert.deepEqual(
    Object.keys(oldModule).sort(),
    Object.keys(sharedModule).sort(),
    `${label}: export names`,
  );

  for (const name of Object.keys(sharedModule)) {
    assert.strictEqual(
      oldModule[name],
      sharedModule[name],
      `${label}.${name}: must use one implementation`,
    );
  }
}

test('M1: frontend schema paths re-export shared contracts', async () => {
  for (const name of contractModules) {
    await assertSameExports(
      `../src/schemas/${name}.js`,
      `@robot-hmi/contracts/${name}`,
      name,
    );
  }
});

test('M1: frontend helper paths re-export shared control core', async () => {
  for (const name of controlModules) {
    await assertSameExports(
      `../src/utils/${name}.js`,
      `@robot-hmi/control-domain/${name}`,
      name,
    );
  }
});