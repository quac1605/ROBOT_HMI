import test from 'node:test';
import assert from 'node:assert/strict';
import { rosGridToSnapshot } from '../src/ros/rosGridToSnapshot.js';

function createValidRosMessage({
  frame_id = 'map',
  width = 2,
  height = 2,
  resolution = 0.05,
  orientation = { x: 0, y: 0, z: 0, w: 1 },
  data = [0, 50, 100, -1],
} = {}) {
  return {
    header: {
      stamp: { sec: 1710000000, nanosec: 500000 },
      frame_id,
    },
    info: {
      map_load_time: { sec: 1710000000, nanosec: 500000 },
      resolution,
      width,
      height,
      origin: {
        position: { x: 1.0, y: 2.0, z: 0.0 },
        orientation,
      },
    },
    data,
  };
}

test('rosGridToSnapshot: chuyển đổi thành công message ROS OccupancyGrid sang MapGridSnapshot', () => {
  const message = createValidRosMessage();
  const context = { kind: 'mapping', mappingSessionId: 'sess-1' };
  const snapshot = rosGridToSnapshot(message, {
    context,
    gridRevision: 1,
    expectedFrameId: 'map',
  });

  assert.equal(snapshot.source, 'ros');
  assert.equal(snapshot.mode, 'snapshot');
  assert.equal(snapshot.encoding, 'occupancy-0-100-v1');
  assert.equal(snapshot.gridRevision, 1);
  assert.deepEqual(snapshot.context, context);
  assert.equal(snapshot.grid.info.width, 2);
  assert.equal(snapshot.grid.info.height, 2);
  assert.equal(snapshot.grid.data.length, 4);
});

test('rosGridToSnapshot: reject frame_id không khớp expectedFrameId', () => {
  const message = createValidRosMessage({ frame_id: 'odom' });
  assert.throws(
    () => rosGridToSnapshot(message, {
      context: { kind: 'mapping', mappingSessionId: 'sess-1' },
      gridRevision: 0,
      expectedFrameId: 'map',
    }),
    /MAP_FRAME_MISMATCH/
  );
});

test('rosGridToSnapshot: reject kích thước và dữ liệu không hợp lệ', () => {
  const context = { kind: 'mapping', mappingSessionId: 'sess-1' };
  
  // Width <= 0
  assert.throws(
    () => rosGridToSnapshot(createValidRosMessage({ width: 0 }), {
      context,
      gridRevision: 0,
      expectedFrameId: 'map',
    }),
    /INVALID_MAP_DIMENSIONS/
  );

  // Data length mismatch
  assert.throws(
    () => rosGridToSnapshot(createValidRosMessage({ data: [0, 50] }), {
      context,
      gridRevision: 0,
      expectedFrameId: 'map',
    }),
    /INVALID_MAP_DATA/
  );

  // Negative revision
  assert.throws(
    () => rosGridToSnapshot(createValidRosMessage(), {
      context,
      gridRevision: -1,
      expectedFrameId: 'map',
    }),
    /INVALID_GRID_REVISION/
  );
});

test('rosGridToSnapshot: reject quaternion nghiêng roll/pitch 3D', () => {
  const context = { kind: 'mapping', mappingSessionId: 'sess-1' };
  // roll = 45 độ (x = sin(pi/8), w = cos(pi/8))
  const sin = Math.sin(Math.PI / 8);
  const cos = Math.cos(Math.PI / 8);
  const message = createValidRosMessage({
    orientation: { x: sin, y: 0, z: 0, w: cos },
  });

  assert.throws(
    () => rosGridToSnapshot(message, {
      context,
      gridRevision: 0,
      expectedFrameId: 'map',
    }),
    { code: 'UNSUPPORTED_MAP_ORIENTATION' }
  );
});
