import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { demoAssetsPlugin, demoDirectory, demoFileNames, demoMiddleware } from '../../../frontend/tooling/demoAssetsPlugin.mjs';

test('F8-N01: docs assets match manifest, are distinct H.264 MP4 with faststart', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(demoDirectory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.assets.map(asset => asset.name), demoFileNames);
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(path.join(demoDirectory, asset.name));
    assert.equal(bytes.length, asset.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
    const boxes = [];
    for (let offset = 0; offset < bytes.length;) {
      const size = bytes.readUInt32BE(offset);
      assert.ok(size >= 8 && offset + size <= bytes.length, 'Valid complete MP4 box');
      boxes.push(bytes.toString('ascii', offset + 4, offset + 8));
      offset += size;
    }
    assert.equal(boxes[0], 'ftyp');
    assert.ok(boxes.includes('moov') && boxes.includes('mdat'));
    assert.ok(boxes.indexOf('moov') < boxes.indexOf('mdat'), 'faststart: metadata before media');
    assert.ok(bytes.includes(Buffer.from('avc1')), 'H.264 sample entry');
  }
  assert.notEqual(manifest.assets[0].sha256, manifest.assets[1].sha256);
});

test('F8-N02: build emits only both MP4 files at unchanged URLs', () => {
  const outputs = [];
  demoAssetsPlugin().generateBundle.call({ addWatchFile() {}, emitFile(asset) { outputs.push(asset); } });
  assert.deepEqual(outputs.map(asset => asset.fileName), ['demo/front.mp4', 'demo/rear.mp4']);
  for (const [index, asset] of outputs.entries()) {
    assert.deepEqual(asset.source, fs.readFileSync(path.join(demoDirectory, demoFileNames[index])));
  }
});

test('F8-N03: dev video supports HEAD/ranges without exposing other docs', async t => {
  const middleware = demoMiddleware();
  const server = http.createServer((req, res) => middleware(req, res, error => {
    res.writeHead(error ? 500 : 404); res.end();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bytes = fs.readFileSync(path.join(demoDirectory, 'front.mp4'));
  const head = await fetch(`${base}/demo/front.mp4`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(`${base}/demo/front.mp4?camera=front`, { headers: { Range: 'bytes=0-63' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-63/${bytes.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 64));
  const tail = await fetch(`${base}/demo/front.mp4`, { headers: { Range: 'bytes=-16' } });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(-16));
  for (const value of ['bytes=999999999-', 'bytes=4-1', 'bytes=-0', 'bytes=0-1,4-5']) {
    const invalid = await fetch(`${base}/demo/front.mp4`, { headers: { Range: value } });
    assert.equal(invalid.status, 416);
  }
  for (const name of ['README.md', 'manifest.json', 'missing.mp4']) {
    assert.equal((await fetch(`${base}/demo/${name}`)).status, 404);
  }
  assert.equal((await fetch(`${base}/demo/front.mp4`, { method: 'POST' })).status, 405);
});
