import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRosMapService } from '../src/ros/rosMapService.js';

function workerMessage(revision) {
    return JSON.stringify({
        revision,
        geometry: {
            frameId: 'map', width: 1, height: 1, resolution: 0.05,
            origin: { x: 0, y: 0, yaw: 0 },
        },
        stamp: { sec: 1, nanosec: 0 },
        mapLoadTime: { sec: 1, nanosec: 0 },
        counts: { unknown: 0, free: 1, occupied: 0, other: 0 },
        pngBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
    }) + '\n';
}

test('keeps recent /map images across metadata/image races and clears them when publisher is lost', () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    const service = createRosMapService({
        enabled: true, spawnImpl: () => child, logger: { info() {}, warn() {} },
    });
    service.start();

    const first = 'a'.repeat(32);
    const second = 'b'.repeat(32);
    child.stdout.write(workerMessage(first));
    assert.equal(service.getMetadata().revision, first);
    child.stdout.write(workerMessage(second));
    assert.equal(service.getMetadata().revision, second);
    assert.ok(service.getImage(first));
    assert.ok(service.getImage(second));

    child.stdout.write('{"type":"source_lost"}\n');
    assert.deepEqual(service.getMetadata(), { status: 'waiting' });
    assert.equal(service.getImage(first), null);
    assert.equal(service.getImage(second), null);
    service.dispose();
});
