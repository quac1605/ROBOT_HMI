import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeOccupancyGrid } from '../src/utils/normalizeOccupancyGrid.js';
import { occupancyToRgba } from '../src/utils/occupancyToRgba.js';
import { createOccupancyRasterController } from '../src/utils/occupancyRasterController.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

function generateSnapshot(width, height, revision = 1) {
  const total = width * height;
  const data = new Array(total);
  for (let i = 0; i < total; i += 1) {
    // Phân bổ: 70% free (0), 20% unknown (-1), 10% occupied (100)
    const r = Math.random();
    data[i] = r < 0.7 ? 0 : r < 0.9 ? -1 : 100;
  }
  return {
    source: 'mock',
    mode: 'snapshot',
    encoding: 'occupancy-0-100-v1',
    context: { kind: 'mapping', mappingSessionId: 'bench-session' },
    gridRevision: revision,
    grid: {
      header: { frame_id: 'map', stamp: { sec: 100, nanosec: 0 } },
      info: {
        map_load_time: { sec: 100, nanosec: 0 },
        resolution: 0.05,
        width,
        height,
        origin: {
          position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      data,
    },
  };
}

function computePercentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function runProfile({ width, height, hz, durationSec = 5 }) {
  const totalSnapshots = Math.round(hz * durationSec);
  const intervalMs = 1000 / hz;

  let urlId = 0;
  let createdUrls = 0;
  let revokedUrls = 0;
  let activeConversions = 0;
  let maxActiveConversions = 0;
  let maxPendingQueue = 0;

  const validateTimes = [];
  const rgbaTimes = [];
  const rasterLatencies = [];

  let snapshotsGenerated = 0;
  let snapshotsCommitted = 0;
  let snapshotsDropped = 0;

  // Đo dung lượng JSON UTF-8
  const sampleSnapshot = generateSnapshot(width, height, 1);
  const sampleJsonStr = JSON.stringify(sampleSnapshot);
  const messageBytes = new TextEncoder().encode(sampleJsonStr).length;
  const bytesPerSec = messageBytes * hz;

  if (globalThis.gc) globalThis.gc();
  const initialHeap = process.memoryUsage().heapUsed;

  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      putImageData: () => {},
    }),
    toBlob: (cb) => {
      // Giả lập toBlob bất đồng bộ chạy mất ~2-5ms
      setTimeout(() => {
        cb({ size: width * height });
      }, 4);
    },
  };

  return new Promise((resolve) => {
    let controller = null;

    controller = createOccupancyRasterController({
      createCanvas: () => {
        activeConversions += 1;
        if (activeConversions > maxActiveConversions) maxActiveConversions = activeConversions;
        return fakeCanvas;
      },
      createObjectURL: () => {
        urlId += 1;
        createdUrls += 1;
        return `blob:bench/${urlId}`;
      },
      revokeObjectURL: () => {
        revokedUrls += 1;
      },
      onCommit: (candidate) => {
        activeConversions = Math.max(0, activeConversions - 1);
        if (candidate) {
          snapshotsCommitted += 1;
          // Mô phỏng Image load ngay lập tức
          controller.handleImageLoaded(candidate.token);
        }
      },
      onError: () => {
        activeConversions = Math.max(0, activeConversions - 1);
      },
    });

    let currentIter = 0;

    const intervalTimer = setInterval(() => {
      currentIter += 1;
      snapshotsGenerated += 1;

      const snap = generateSnapshot(width, height, currentIter);

      // 1. Đo Validate Time
      const tVal0 = performance.now();
      const normalized = normalizeOccupancyGrid(snap);
      const tVal1 = performance.now();
      validateTimes.push(tVal1 - tVal0);

      // 2. Đo RGBA Time riêng
      const tRgba0 = performance.now();
      occupancyToRgba({ width, height, cells: normalized.cells });
      const tRgba1 = performance.now();
      rgbaTimes.push(tRgba1 - tRgba0);

      // 3. Đo Full Controller Latency
      const tCtrl0 = performance.now();
      controller.updateGrid(normalized);
      const tCtrl1 = performance.now();
      rasterLatencies.push(tCtrl1 - tCtrl0);

      if (currentIter >= totalSnapshots) {
        clearInterval(intervalTimer);

        // Đợi drain hoàn tất
        setTimeout(() => {
          controller.dispose();
          const finalHeap = process.memoryUsage().heapUsed;

          snapshotsDropped = snapshotsGenerated - snapshotsCommitted;

          resolve({
            profile: `${width}x${height} @ ${hz} Hz`,
            width,
            height,
            hz,
            durationSec,
            messageBytes,
            bytesPerSec,
            snapshotsGenerated,
            snapshotsCommitted,
            snapshotsDropped,
            validateTime: {
              median: Number(computePercentile(validateTimes, 50).toFixed(2)),
              p95: Number(computePercentile(validateTimes, 95).toFixed(2)),
              max: Number(Math.max(...validateTimes).toFixed(2)),
            },
            rgbaTime: {
              median: Number(computePercentile(rgbaTimes, 50).toFixed(2)),
              p95: Number(computePercentile(rgbaTimes, 95).toFixed(2)),
              max: Number(Math.max(...rgbaTimes).toFixed(2)),
            },
            rasterLatency: {
              median: Number(computePercentile(rasterLatencies, 50).toFixed(2)),
              p95: Number(computePercentile(rasterLatencies, 95).toFixed(2)),
              max: Number(Math.max(...rasterLatencies).toFixed(2)),
            },
            maxActiveConversions,
            maxPendingQueue,
            createdUrls,
            revokedUrls,
            outstandingUrls: createdUrls - revokedUrls,
            initialHeapMB: Number((initialHeap / (1024 * 1024)).toFixed(2)),
            finalHeapMB: Number((finalHeap / (1024 * 1024)).toFixed(2)),
            heapDeltaMB: Number(((finalHeap - initialHeap) / (1024 * 1024)).toFixed(2)),
          });
        }, 100);
      }
    }, intervalMs);
  });
}

async function runAllBenchmarks() {
  console.log('=== BẮT ĐẦU CHẠY 4 BENCHMARK PROFILES THEO MỤC 9.9 ===');

  const profiles = [
    { width: 200, height: 160, hz: 1, durationSec: 5 },
    { width: 200, height: 160, hz: 2, durationSec: 5 },
    { width: 512, height: 512, hz: 1, durationSec: 5 },
    { width: 512, height: 512, hz: 2, durationSec: 5 },
  ];

  const results = [];
  for (const p of profiles) {
    console.log(`Đang chạy profile: ${p.width}x${p.height} @ ${p.hz} Hz...`);
    const res = await runProfile(p);
    results.push(res);
    console.log(`  -> Hoàn thành: ${res.profile} (Bytes: ${res.messageBytes}, RGBA p95: ${res.rgbaTime.p95}ms, Outstanding URLs: ${res.outstandingUrls})`);
  }

  const outputData = {
    timestamp: new Date().toISOString(),
    os: process.platform,
    nodeVersion: process.version,
    results,
  };

  const outputPath = path.resolve('benchmark_results.json');
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf-8');
  console.log(`\nĐã lưu kết quả benchmark vào: ${outputPath}`);
  console.log(JSON.stringify(results, null, 2));
}

runAllBenchmarks();
