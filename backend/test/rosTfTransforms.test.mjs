import test from 'node:test';
import assert from 'node:assert/strict';
import { createRosTfResolver } from '../src/ros/rosTfTransforms.js';

function transform(parent, child, x, y, yaw) {
    return {
        header: { frame_id: parent }, child_frame_id: child,
        transform: {
            translation: { x, y, z: 0 },
            rotation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
        },
    };
}

test('TF map <- odom composes translation and yaw with the odometry pose', () => {
    const resolver = createRosTfResolver();
    resolver.ingest({ transforms: [transform('map', 'odom', 1, 2, Math.PI / 2)] });
    const pose = resolver.resolvePose({ frameId: 'odom', x: 2, y: 0, yaw: Math.PI / 2 }, 'map');
    assert.equal(pose.frameId, 'map');
    assert.ok(Math.abs(pose.x - 1) < 1e-9);
    assert.ok(Math.abs(pose.y - 4) < 1e-9);
    assert.ok(Math.abs(Math.abs(pose.yaw) - Math.PI) < 1e-9);
});

test('TF inverse and multi-hop path resolve only connected frames', () => {
    const resolver = createRosTfResolver();
    resolver.ingest({ transforms: [
        transform('odom', 'map', -2, 0, 0),
        transform('earth', 'odom', 5, 0, 0),
    ] });
    assert.deepEqual(resolver.resolvePose({ frameId: 'odom', x: 0, y: 0, yaw: 0 }, 'map'),
        { frameId: 'map', x: 2, y: 0, yaw: 0 });
    assert.deepEqual(resolver.resolvePose({ frameId: 'map', x: 1, y: 0, yaw: 0 }, 'earth'),
        { frameId: 'earth', x: 4, y: 0, yaw: 0 });
    assert.equal(resolver.resolvePose({ frameId: 'base_link', x: 0, y: 0, yaw: 0 }, 'map'), null);
});

test('Dynamic TF expires; static TF survives until bridge state is cleared', () => {
    let now = 0;
    const resolver = createRosTfResolver({ now: () => now, maxDynamicAgeMs: 100 });
    const odom = { frameId: 'odom', x: 0, y: 0, yaw: 0 };
    resolver.ingest({ transforms: [transform('map', 'odom', 1, 0, 0)] });
    now = 101;
    assert.equal(resolver.resolvePose(odom, 'map'), null);
    resolver.ingest({ transforms: [transform('map', 'odom', 2, 0, 0)] }, { isStatic: true });
    now = 1000;
    assert.equal(resolver.resolvePose(odom, 'map').x, 2);
    resolver.clear();
    assert.equal(resolver.resolvePose(odom, 'map'), null);
});

test('Malformed and tilted TF are ignored', () => {
    const resolver = createRosTfResolver();
    const bad = transform('map', 'odom', 1, 0, 0);
    bad.transform.rotation = { x: Math.sin(0.1), y: 0, z: 0, w: Math.cos(0.1) };
    assert.equal(resolver.ingest({ transforms: [bad] }), 0);
    assert.equal(resolver.resolvePose({ frameId: 'odom', x: 0, y: 0, yaw: 0 }, 'map'), null);
});
