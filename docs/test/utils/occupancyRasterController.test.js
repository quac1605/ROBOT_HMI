import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOccupancyRasterController,
  getActiveRasterDebugStates,
} from '../../../frontend/src/utils/occupancyRasterController.js';
import { createRasterRuntime } from '../../../frontend/src/utils/rasterRuntime.js';

// Polyfill ImageData cho Node runtime
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

function createFakeGrid(revision = 1) {
  return {
    context: { kind: 'saved', mapId: 'test-map', mapRevision: 'rev-1' },
    gridRevision: revision,
    geometry: {
      frameId: 'map',
      width: 2,
      height: 2,
      resolution: 0.05,
      origin: { x: 0, y: 0, yaw: 0 },
    },
    cells: new Int8Array([0, 0, 100, -1]),
  };
}

function createTestEnvironment(customOptions = {}) {
  let urlCounter = 0;
  const createdUrls = new Set();
  const revokedUrls = new Set();
  const pendingBlobResolvers = [];

  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      putImageData: () => {},
    }),
  };

  const runtime = createRasterRuntime({
    createCanvas: () => fakeCanvas,
    createImageData: (rgba, width, height) => ({ data: rgba, width, height }),
    createImage: () => ({}),
    createObjectURL: (blob) => {
      urlCounter += 1;
      const url = `blob:test/${urlCounter}`;
      createdUrls.add(url);
      return url;
    },
    revokeObjectURL: (url) => {
      revokedUrls.add(url);
    },
    toBlob: (canvas, signal) => {
      if (customOptions.immediateToBlob) {
        return Promise.resolve({ size: 100 });
      }
      return new Promise((resolve, reject) => {
        const resolver = (blob) => {
          if (!blob) {
            const err = new Error('Blob creation failed');
            err.code = 'RASTER_BLOB_ERROR';
            reject(err);
          } else {
            resolve(blob);
          }
        };
        signal?.addEventListener(
          'abort',
          () => {
            const err = new Error('Raster task aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true }
        );
        pendingBlobResolvers.push(resolver);
      });
    },
    decodeUrl: (url, signal) => {
      if (customOptions.rejectDecode) {
        const err = new Error('Decode failed');
        err.code = 'IMAGE_DECODE_FAILED';
        return Promise.reject(err);
      }
      if (signal?.aborted) {
        const err = new Error('Decode aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      return Promise.resolve();
    },
    ...customOptions,
  });

  return {
    runtime,
    createdUrls,
    revokedUrls,
    resolveNextBlob: (blob = { size: 100 }) => {
      const resolver = pendingBlobResolvers.shift();
      if (resolver) resolver(blob);
    },
  };
}

test('Controller chuyển đổi candidate và promote sang displayed khi acknowledgeLoaded', async () => {
  const env = createTestEnvironment();
  let latestPublished = null;

  const controller = createOccupancyRasterController({
    runtime: env.runtime,
    onPublish: (pres) => {
      latestPublished = pres.raster;
    },
  });

  // Gửi grid 1
  controller.updateGrid(createFakeGrid(1));
  env.resolveNextBlob();
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(latestPublished);
  assert.equal(latestPublished.gridRevision, 1);
  const token1 = latestPublished.token;
  const url1 = latestPublished.objectUrl;

  // Báo ảnh 1 đã load thành công
  controller.acknowledgeLoaded(token1);

  // Gửi grid 2
  controller.updateGrid(createFakeGrid(2));
  env.resolveNextBlob();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(latestPublished.gridRevision, 2);
  const token2 = latestPublished.token;
  const url2 = latestPublished.objectUrl;

  // Khi ảnh 2 load xong, URL 1 phải bị revoke
  controller.acknowledgeLoaded(token2);
  assert.ok(env.revokedUrls.has(url1));
  assert.ok(!env.revokedUrls.has(url2));

  controller.dispose();
  assert.ok(env.revokedUrls.has(url2));
});

test('Queue invariant: khi A đang chuyển đổi, nhận B rồi C thì B bị hủy, C được chuyển đổi', async () => {
  const env = createTestEnvironment();
  const publishedList = [];

  const controller = createOccupancyRasterController({
    runtime: env.runtime,
    onPublish: (pres) => {
      if (pres.raster) publishedList.push(pres.raster);
    },
  });

  // 1. Bắt đầu Grid A (chưa resolve toBlob)
  controller.updateGrid(createFakeGrid(1));

  // 2. Nhận Grid B rồi Grid C ngay sau đó
  controller.updateGrid(createFakeGrid(2));
  controller.updateGrid(createFakeGrid(3));

  // 3. Resolve Grid A (A bị hủy do thế hệ cũ, 0 commit cho A/B)
  env.resolveNextBlob();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(publishedList.length, 0);

  // 4. Resolve tiếp theo (phải là Grid C, Grid B bị bỏ qua)
  env.resolveNextBlob();
  await new Promise((r) => setTimeout(r, 10));

  // Chỉ có C được publish
  assert.equal(publishedList.length, 1);
  assert.equal(publishedList[0].gridRevision, 3);

  controller.dispose();
});

test('Xử lý lỗi toBlob null và decode error thu hồi candidate an toàn', async () => {
  const env = createTestEnvironment();
  let caughtError = null;

  const controller = createOccupancyRasterController({
    runtime: env.runtime,
    onError: (err) => {
      caughtError = err;
    },
  });

  // toBlob trả về null
  controller.updateGrid(createFakeGrid(1));
  env.resolveNextBlob(null);
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(caughtError);
  assert.equal(caughtError.code, 'RASTER_BLOB_ERROR');

  controller.dispose();
});

test('acknowledgeImageError rollback về displayed raster an toàn', async () => {
  const env = createTestEnvironment();
  let currentRaster = null;

  const controller = createOccupancyRasterController({
    runtime: env.runtime,
    onPublish: (pres) => {
      currentRaster = pres.raster;
    },
  });

  // 1. Grid 1 commit thành công
  controller.updateGrid(createFakeGrid(1));
  env.resolveNextBlob();
  await new Promise((r) => setTimeout(r, 10));
  controller.acknowledgeLoaded(currentRaster.token);
  const token1 = currentRaster.token;

  // 2. Grid 2 commit candidate
  controller.updateGrid(createFakeGrid(2));
  env.resolveNextBlob();
  await new Promise((r) => setTimeout(r, 10));
  const token2 = currentRaster.token;
  assert.equal(currentRaster.gridRevision, 2);

  // 3. Image error trên Grid 2 -> rollback về Grid 1
  controller.acknowledgeImageError(token2, new Error('SVG decode failed'));
  assert.equal(currentRaster.token, token1);
  assert.equal(currentRaster.gridRevision, 1);

  controller.dispose();
});

test('dispose() thu hồi toàn bộ Blob URL và chặn callback đến muộn', async () => {
  const env = createTestEnvironment();
  let publishedCount = 0;

  const controller = createOccupancyRasterController({
    runtime: env.runtime,
    onPublish: (pres) => {
      if (pres.raster) publishedCount += 1;
    },
  });

  controller.updateGrid(createFakeGrid(1));

  // Dispose ngay khi toBlob đang pending
  controller.dispose();

  // Resolve toBlob muộn
  env.resolveNextBlob();
  await new Promise((r) => setTimeout(r, 10));

  // Không có publish nào được phát sinh sau dispose
  assert.equal(publishedCount, 0);

  // Mọi URL được tạo đều đã bị revoke
  for (const url of env.createdUrls) {
    assert.ok(env.revokedUrls.has(url));
  }
});

test('Controller không khởi động toBlob thứ hai trước khi native encode hiện tại kết thúc', async () => {
  let activeNative = 0;
  let maxActiveNative = 0;
  let starts = 0;
  const resolvers = [];
  const published = [];
  const env = createTestEnvironment({
    toBlob: () => new Promise((resolve) => {
      starts += 1;
      activeNative += 1;
      maxActiveNative = Math.max(maxActiveNative, activeNative);
      resolvers.push(() => {
        activeNative -= 1;
        resolve({ size: 100 });
      });
    }),
  });
  const controller = createOccupancyRasterController({
    runtime: env.runtime,
    onPublish: ({ raster }) => {
      if (raster) published.push(raster.gridRevision);
    },
  });

  controller.updateGrid(createFakeGrid(1));
  controller.updateGrid(createFakeGrid(2));
  controller.updateGrid(createFakeGrid(3));

  assert.equal(starts, 1);
  assert.equal(controller.getDebugState().pendingCount, 1);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(starts, 2);
  assert.equal(maxActiveNative, 1);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(published, [3]);
  assert.equal(maxActiveNative, 1);
  controller.dispose();
});

test('Runtime chờ callback native toBlob sau abort và không báo slot rảnh sớm', async () => {
  let nativeCallback = null;
  const runtime = createRasterRuntime();
  const canvas = {
    toBlob(callback) {
      nativeCallback = callback;
    },
  };
  const abortController = new AbortController();
  const result = runtime.toBlob(canvas, abortController.signal).then(
    () => 'resolved',
    (error) => error.name
  );

  abortController.abort();
  await Promise.resolve();
  assert.equal(runtime.getCounters().activeBlobConversions, 1);

  nativeCallback({ size: 10 });
  assert.equal(await result, 'AbortError');
  assert.equal(runtime.getCounters().activeBlobConversions, 0);
  assert.equal(runtime.getCounters().maxActiveBlobConversions, 1);
});

test('Runtime dùng chung giữ một encode active và chỉ một request mới nhất chờ', async () => {
  const started = [];
  const nativeResolvers = [];
  const runtime = createRasterRuntime({
    toBlob: (canvas) => new Promise((resolve) => {
      started.push(canvas.id);
      nativeResolvers.push(resolve);
    }),
  });

  const first = runtime.toBlob({ id: 'A' }).then(() => 'A', (error) => error.name);
  const superseded = runtime.toBlob({ id: 'B' }).then(() => 'B', (error) => error.name);
  const latest = runtime.toBlob({ id: 'C' }).then(() => 'C', (error) => error.name);

  assert.deepEqual(started, ['A']);
  assert.equal(runtime.getCounters().activeBlobConversions, 1);
  assert.equal(runtime.getCounters().pendingBlobConversions, 1);
  assert.equal(await superseded, 'AbortError');

  nativeResolvers.shift()({ size: 1 });
  assert.equal(await first, 'A');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['A', 'C']);

  nativeResolvers.shift()({ size: 1 });
  assert.equal(await latest, 'C');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.getCounters().activeBlobConversions, 0);
  assert.equal(runtime.getCounters().pendingBlobConversions, 0);
  assert.equal(runtime.getCounters().maxActiveBlobConversions, 1);
});

test('resetCounters giữ ownership của URL đang sống để vẫn thu hồi được', () => {
  const revoked = [];
  let nextUrl = 0;
  const runtime = createRasterRuntime({
    createObjectURL: () => `blob:owned/${++nextUrl}`,
    revokeObjectURL: (url) => revoked.push(url),
  });
  const first = runtime.createObjectURL({});
  const second = runtime.createObjectURL({});
  runtime.revokeObjectURL(first);

  runtime.resetCounters();
  assert.deepEqual(runtime.getCounters(), {
    createdCount: 1,
    revokedCount: 0,
    activeCount: 1,
    activeBlobConversions: 0,
    pendingBlobConversions: 0,
    maxActiveBlobConversions: 0,
  });

  assert.equal(runtime.revokeObjectURL(second), true);
  assert.equal(runtime.getCounters().activeCount, 0);
  assert.equal(runtime.getCounters().createdCount, runtime.getCounters().revokedCount);
  assert.deepEqual(revoked, [first, second]);
});

test('Debug registry chỉ chứa controller còn sống và trả latest publish', async () => {
  const before = getActiveRasterDebugStates().length;
  const env = createTestEnvironment();
  let raster = null;
  const controller = createOccupancyRasterController({
    runtime: env.runtime,
    onPublish: (presentation) => {
      raster = presentation.raster;
    },
  });
  assert.equal(getActiveRasterDebugStates().length, before + 1);

  controller.updateGrid(createFakeGrid(7));
  env.resolveNextBlob();
  await new Promise((resolve) => setImmediate(resolve));
  const debug = controller.getDebugState();
  assert.equal(debug.latestPublished.gridRevision, 7);
  assert.equal(debug.latestPublished.token, raster.token);

  controller.dispose();
  assert.equal(getActiveRasterDebugStates().length, before);
});
