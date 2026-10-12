import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { chromium } from '../../../frontend/node_modules/@playwright/test/index.mjs';
import { browserLaunchOptions } from './browser_launch_options.mjs';

const outputIndex = process.argv.indexOf('--output');
const outputPath = outputIndex >= 0 && process.argv[outputIndex + 1]
  ? process.argv[outputIndex + 1]
  : 'artifacts/stage6/benchmark-results.json';
const benchmarkUrl = 'http://127.0.0.1:4174';

const fullProfileDefinitions = [
  { key: 'profile_200x160_1hz', width: 200, height: 160, targetHz: 1, sampleCount: 30, seed: 1001 },
  { key: 'profile_200x160_2hz', width: 200, height: 160, targetHz: 2, sampleCount: 60, seed: 1002 },
  { key: 'profile_512x512_1hz', width: 512, height: 512, targetHz: 1, sampleCount: 30, seed: 1003 },
  { key: 'profile_512x512_2hz', width: 512, height: 512, targetHz: 2, sampleCount: 60, seed: 1004 },
];
const profileDefinitions = process.argv.includes('--smoke')
  ? fullProfileDefinitions.map((profile) => ({ ...profile, targetHz: 10, sampleCount: 2 }))
  : fullProfileDefinitions;

function stats(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return { count: 0, p50: 0, p95: 0, max: 0, avg: 0 };
  const percentile = (p) => finite[Math.min(finite.length - 1, Math.ceil(finite.length * p) - 1)];
  return {
    count: finite.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: finite[finite.length - 1],
    avg: finite.reduce((sum, value) => sum + value, 0) / finite.length,
  };
}

function waitForHttp(url, timeoutMs = 20_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode >= 200 && response.statusCode < 500) return resolve();
        setTimeout(probe, 100);
      });
      request.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) reject(new Error(`Vite không sẵn sàng tại ${url}`));
        else setTimeout(probe, 100);
      });
      request.setTimeout(1_000, () => request.destroy());
    };
    probe();
  });
}

function startVite() {
  const viteCli = path.resolve(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', '4174', '--strictPort'], {
    cwd: process.cwd(),
    env: { ...process.env, VITE_ENABLE_STAGE6_TEST_CONTROLS: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let diagnostics = '';
  child.stdout.on('data', (chunk) => { diagnostics += chunk.toString(); });
  child.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
  child.diagnostics = () => diagnostics;
  return child;
}

function summarize(raw) {
  const samples = raw.rawSamples;
  const totalBytes = samples.reduce((sum, sample) => sum + sample.envelopeUtf8Bytes, 0);
  const committed = samples.filter((sample) => sample.outcome === 'committed');
  return {
    dimensions: { width: raw.width, height: raw.height, resolution: raw.resolution },
    targetHz: raw.targetHz,
    sampleCount: samples.length,
    durationMs: raw.durationMs,
    achievedHz: (samples.length * 1_000) / raw.durationMs,
    totalEnvelopeUtf8Bytes: totalBytes,
    averageEnvelopeUtf8Bytes: totalBytes / samples.length,
    envelopeBytesPerSecond: (totalBytes * 1_000) / raw.durationMs,
    generatedCount: samples.length,
    committedCount: committed.length,
    droppedCount: samples.length - committed.length,
    maxActiveTasks: raw.maxActiveTasks,
    maxPendingQueue: raw.maxPendingQueue,
    createdUrlsCount: raw.createdUrlsCount,
    revokedUrlsCount: raw.revokedUrlsCount,
    outstandingUrls: raw.outstandingUrls,
    heap: raw.heap,
    validation: stats(samples.map((sample) => sample.validationMs)),
    rgba: stats(committed.map((sample) => sample.rgbaMs)),
    raster: stats(committed.map((sample) => sample.rasterMs)),
    toBlob: stats(committed.map((sample) => sample.toBlobMs)),
    decode: stats(committed.map((sample) => sample.decodeMs)),
    endToEnd: stats(committed.map((sample) => sample.endToEndMs)),
    scheduleDelay: stats(samples.map((sample) => sample.scheduleDelayMs)),
    responsiveness: stats(raw.responsivenessDelaysMs),
    animationFrame: stats(raw.animationFrameDeltasMs),
    longTasks: stats(raw.longTaskDurationsMs),
    rawMeasurements: {
      responsivenessDelaysMs: raw.responsivenessDelaysMs,
      animationFrameDeltasMs: raw.animationFrameDeltasMs,
      longTaskDurationsMs: raw.longTaskDurationsMs,
    },
    errors: raw.errors,
    rawSamples: samples,
  };
}

async function runProfile(browser, definition) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(benchmarkUrl, { waitUntil: 'networkidle' });

  const raw = await page.evaluate(async (cfg) => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { default: Map2D } = await import('/src/components/map/Map2D.jsx');
    const { normalizeOccupancyGrid } = await import('/src/utils/normalizeOccupancyGrid.js');
    const { createOccupancyRasterController } = await import('/src/utils/occupancyRasterController.js');
    const { createRasterRuntime } = await import('/src/utils/rasterRuntime.js');

    const resolution = 0.05;
    const intervalMs = 1_000 / cfg.targetHz;
    const errors = [];
    let unhandledRejections = 0;
    addEventListener('unhandledrejection', () => { unhandledRejections += 1; });

    function lcg(seed) {
      let state = seed >>> 0;
      return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
    }

    const random = lcg(cfg.seed);
    const encoder = new TextEncoder();
    const payloads = [];
    for (let index = 0; index < cfg.sampleCount; index += 1) {
      const data = new Array(cfg.width * cfg.height);
      for (let cell = 0; cell < data.length; cell += 1) {
        const probability = random();
        data[cell] = probability < 0.2 ? -1 : probability < 0.85 ? 0 : 100;
      }
      const snapshot = {
        source: 'mock', mode: 'snapshot', encoding: 'occupancy-0-100-v1',
        context: { kind: 'mapping', mappingSessionId: `benchmark-${cfg.key}` },
        gridRevision: index + 1,
        grid: {
          header: { frame_id: 'map', stamp: { sec: index + 1, nanosec: 0 } },
          info: {
            map_load_time: { sec: 1, nanosec: 0 }, resolution,
            width: cfg.width, height: cfg.height,
            origin: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          },
          data,
        },
      };
      const envelopeHeader = {
        version: 1,
        type: 'map.grid',
        subscriptionId: 'benchmark-định-tuyến',
        streamId: `benchmark-stream-${cfg.key}`,
        streamEpoch: 1,
        sequence: index + 1,
        sentAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
      };
      const wireEnvelope = { ...envelopeHeader, payload: snapshot };
      const serialized = JSON.stringify(wireEnvelope);
      const encoded = encoder.encode(serialized);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)))
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      payloads.push({ serialized, digest, codeUnits: serialized.length, utf8Bytes: encoded.byteLength, envelopeHeader });
    }

    if (typeof gc === 'function') gc();
    const heapBefore = performance.memory?.usedJSHeapSize ?? null;
    let heapMax = heapBefore;
    const heapTimer = setInterval(() => {
      if (performance.memory) heapMax = Math.max(heapMax ?? 0, performance.memory.usedJSHeapSize);
    }, 50);

    const rawSamples = payloads.map((payload, index) => ({
      index: index + 1,
      gridRevision: index + 1,
      envelopeUtf8Bytes: payload.utf8Bytes,
      envelopeCodeUnits: payload.codeUnits,
      envelopeSha256: payload.digest,
      envelopeHeader: payload.envelopeHeader,
      scheduleDelayMs: null,
      validationMs: null,
      rgbaMs: null,
      toBlobMs: null,
      decodeMs: null,
      rasterMs: null,
      endToEndMs: null,
      outcome: 'pending',
    }));
    const byRevision = new Map(rawSamples.map((sample) => [sample.gridRevision, sample]));

    const baseRuntime = createRasterRuntime();
    const canvasPhase = new WeakMap();
    const blobPhase = new WeakMap();
    const urlPhase = new Map();
    let submitting = null;
    let pendingSample = null;
    let activePhase = null;
    let nativeBlobActive = 0;
    let maxNativeBlobActive = 0;
    let maxActiveTasks = 0;
    let maxPendingQueue = 0;
    const runtime = {
      ...baseRuntime,
      createCanvas() {
        const canvas = baseRuntime.createCanvas();
        const phase = submitting ?? pendingSample;
        pendingSample = phase === pendingSample ? null : pendingSample;
        if (phase) {
          activePhase = phase;
          phase.rasterStartedAt = performance.now();
          canvasPhase.set(canvas, phase);
        }
        return canvas;
      },
      createImageData(rgba, width, height) {
        if (activePhase?.rasterStartedAt != null) {
          activePhase.rgbaMs = performance.now() - activePhase.rasterStartedAt;
        }
        return baseRuntime.createImageData(rgba, width, height);
      },
      async toBlob(canvas, signal) {
        const phase = canvasPhase.get(canvas);
        const startedAt = performance.now();
        nativeBlobActive += 1;
        maxNativeBlobActive = Math.max(maxNativeBlobActive, nativeBlobActive);
        try {
          const blob = await baseRuntime.toBlob(canvas, signal);
          if (phase) {
            phase.toBlobMs = performance.now() - startedAt;
            blobPhase.set(blob, phase);
          }
          return blob;
        } finally {
          nativeBlobActive -= 1;
        }
      },
      createObjectURL(blob) {
        const url = baseRuntime.createObjectURL(blob);
        urlPhase.set(url, blobPhase.get(blob));
        return url;
      },
      async decodeUrl(url, signal) {
        const phase = urlPhase.get(url);
        const startedAt = performance.now();
        try {
          return await baseRuntime.decodeUrl(url, signal);
        } finally {
          if (phase) phase.decodeMs = performance.now() - startedAt;
        }
      },
      revokeObjectURL(url) {
        urlPhase.delete(url);
        return baseRuntime.revokeObjectURL(url);
      },
    };

    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const reactRoot = createRoot(host);
    let controller;
    const controllerDone = () => {
      const debug = controller.getDebugState();
      return debug.activeTasks === 0 && debug.pendingCount === 0;
    };
    controller = createOccupancyRasterController({
      runtime,
      onPublish(presentation) {
        if (!presentation?.raster) return;
        const raster = presentation.raster;
        const sample = byRevision.get(raster.gridRevision);
        if (!sample) {
          errors.push(`Publication không có sample: ${String(raster.gridRevision)}`);
          return;
        }
        sample.rasterMs = performance.now() - sample.rasterStartedAt;
        reactRoot.render(React.createElement(Map2D, {
          model: {
            ...raster,
            onLoad() {
              controller.acknowledgeLoaded(raster.token);
              if (sample.outcome === 'pending') {
                sample.outcome = 'committed';
                sample.endToEndMs = performance.now() - sample.arrivedAt;
              }
            },
            onError(event) {
              controller.acknowledgeImageError(raster.token, event);
              sample.outcome = 'image_error';
            },
          },
        }));
      },
      onError(error) { errors.push(`${error.code}:${error.message}`); },
    });
    const debugTimer = setInterval(() => {
      const debug = controller.getDebugState();
      maxActiveTasks = Math.max(maxActiveTasks, debug.activeTasks);
      maxPendingQueue = Math.max(maxPendingQueue, debug.pendingCount);
    }, 5);

    const responsivenessDelaysMs = [];
    let responseExpected = performance.now() + 50;
    const responseTimer = setInterval(() => {
      const now = performance.now();
      responsivenessDelaysMs.push(Math.max(0, now - responseExpected));
      responseExpected = now + 50;
    }, 50);
    const animationFrameDeltasMs = [];
    let lastAnimationFrame = null;
    let measuringFrames = true;
    const frame = (now) => {
      if (lastAnimationFrame != null) animationFrameDeltasMs.push(now - lastAnimationFrame);
      lastAnimationFrame = now;
      if (measuringFrames) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    const longTaskDurationsMs = [];
    let longTaskWindowStart = null;
    let longTaskWindowEnd = null;
    const recordLongTasks = (entries) => {
      for (const entry of entries) {
        if (
          longTaskWindowStart != null &&
          entry.startTime >= longTaskWindowStart &&
          (longTaskWindowEnd == null || entry.startTime < longTaskWindowEnd)
        ) {
          longTaskDurationsMs.push(entry.duration);
        }
      }
    };
    const longTaskObserver = typeof PerformanceObserver === 'function'
      ? new PerformanceObserver((list) => {
        recordLongTasks(list.getEntries());
      })
      : null;
    // Chỉ đo trong cửa sổ arrival/render bên dưới. `buffered: true` sẽ kéo cả
    // long-task của giai đoạn dựng fixture/serialize/hash vào kết quả pipeline
    // và tạo false failure, đặc biệt ở profile 512×512.
    try { longTaskObserver?.observe({ type: 'longtask', buffered: false }); } catch { /* unsupported */ }
    // Một số Chromium/channel vẫn giao entry đã xếp hàng trước observe dù
    // buffered=false. Xả queue và lọc bằng startTime để chỉ đo arrival/render.
    longTaskObserver?.takeRecords();
    longTaskWindowStart = performance.now();

    let arrived = 0;
    const profileStartedAt = performance.now() + 100;
    await new Promise((resolve) => {
      for (let index = 0; index < payloads.length; index += 1) {
        const scheduledAt = profileStartedAt + index * intervalMs;
        setTimeout(() => {
          const sample = rawSamples[index];
          sample.arrivedAt = performance.now();
          sample.scheduleDelayMs = Math.max(0, sample.arrivedAt - scheduledAt);
          const wire = JSON.parse(payloads[index].serialized);
          const validationStartedAt = performance.now();
          try {
            const normalized = normalizeOccupancyGrid(wire.payload);
            sample.validationMs = performance.now() - validationStartedAt;
            const debug = controller.getDebugState();
            if (debug.pendingCount === 1 && pendingSample?.outcome === 'pending') {
              pendingSample.outcome = 'dropped';
            }
            if (debug.activeTasks === 1) pendingSample = sample;
            submitting = sample;
            controller.updateGrid(normalized);
            submitting = null;
          } catch (error) {
            sample.outcome = 'validation_error';
            errors.push(`${error.code || error.name}:${error.message}`);
          }
          arrived += 1;
          if (arrived === payloads.length) resolve();
        }, Math.max(0, scheduledAt - performance.now()));
      }
    });

    const settleDeadline = performance.now() + 10_000;
    while (!controllerDone() && performance.now() < settleDeadline) {
      const debug = controller.getDebugState();
      maxActiveTasks = Math.max(maxActiveTasks, debug.activeTasks);
      maxPendingQueue = Math.max(maxPendingQueue, debug.pendingCount);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!controllerDone()) errors.push('PIPELINE_SETTLE_TIMEOUT');
    const firstArrivedAt = rawSamples[0]?.arrivedAt ?? profileStartedAt;
    const lastArrivedAt = rawSamples.at(-1)?.arrivedAt ?? firstArrivedAt;
    const durationMs = Math.max(intervalMs, lastArrivedAt - firstArrivedAt + intervalMs);
    for (const sample of rawSamples) {
      if (sample.outcome === 'pending') sample.outcome = 'dropped';
      delete sample.arrivedAt;
      delete sample.rasterStartedAt;
    }

    clearInterval(responseTimer);
    clearInterval(heapTimer);
    clearInterval(debugTimer);
    measuringFrames = false;
    longTaskWindowEnd = performance.now();
    recordLongTasks(longTaskObserver?.takeRecords() ?? []);
    longTaskObserver?.disconnect();
    controller.dispose();
    reactRoot.unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (typeof gc === 'function') gc();
    const heapAfter = performance.memory?.usedJSHeapSize ?? null;
    const counters = baseRuntime.getCounters();
    return {
      width: cfg.width,
      height: cfg.height,
      resolution,
      targetHz: cfg.targetHz,
      durationMs,
      rawSamples,
      maxActiveTasks: Math.max(maxActiveTasks, maxNativeBlobActive),
      maxPendingQueue,
      createdUrlsCount: counters.createdCount,
      revokedUrlsCount: counters.revokedCount,
      outstandingUrls: counters.activeCount,
      responsivenessDelaysMs,
      animationFrameDeltasMs,
      longTaskDurationsMs,
      heap: {
        supported: heapBefore != null && heapAfter != null,
        beforeBytes: heapBefore,
        afterBytes: heapAfter,
        maxBytes: heapMax,
        growthBytes: heapBefore == null || heapAfter == null ? null : heapAfter - heapBefore,
      },
      errors,
      unhandledRejections,
    };
  }, definition);

  raw.errors.push(...consoleErrors.map((error) => `CONSOLE:${error}`));
  raw.errors.push(...pageErrors.map((error) => `PAGE:${error}`));
  await context.close();
  return raw;
}

async function main() {
  console.log('=== STAGE 6 PRODUCTION OCCUPANCY PIPELINE BENCHMARK ===');
  const vite = startVite();
  let browser;
  try {
    await waitForHttp(benchmarkUrl);
    browser = await chromium.launch({
      ...browserLaunchOptions(),
      headless: true,
      args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
    });
    const version = browser.version();
    const profiles = {};
    let globalMaxActive = 0;
    let globalMaxPending = 0;
    let outstandingUrls = 0;
    let unhandledRejections = 0;
    let errorCount = 0;
    for (const definition of profileDefinitions) {
      console.log(`[benchmark:grid] ${definition.key}: ${definition.sampleCount} @ ${definition.targetHz}Hz`);
      const raw = await runProfile(browser, definition);
      const profile = summarize(raw);
      profiles[definition.key] = profile;
      globalMaxActive = Math.max(globalMaxActive, profile.maxActiveTasks);
      globalMaxPending = Math.max(globalMaxPending, profile.maxPendingQueue);
      outstandingUrls += profile.outstandingUrls;
      unhandledRejections += raw.unhandledRejections;
      errorCount += profile.errors.length;
      console.log(`  committed=${profile.committedCount}, dropped=${profile.droppedCount}, p95=${profile.endToEnd.p95.toFixed(2)}ms`);
    }
    const artifact = {
      schemaVersion: '2.1.0',
      timestamp: new Date().toISOString(),
      methodology: {
        implementation: [
          '/src/schemas/mapGrid.js',
          '/src/utils/normalizeOccupancyGrid.js',
          '/src/utils/occupancyToRgba.js',
          '/src/utils/occupancyRasterController.js',
          '/src/utils/rasterRuntime.js',
          '/src/utils/mapCoordinates.js',
          '/src/utils/mapRenderModel.js',
          '/src/components/map/Map2D.jsx',
        ],
        transportBytes: 'TextEncoder(JSON.stringify(full map.grid envelope)).byteLength',
        arrivalScheduling: 'independent wall-clock setTimeout arrivals; latest-only production controller',
      },
      environment: {
        os: `${os.type()} ${os.release()} ${os.arch()}`,
        nodeVersion: process.version,
        chromiumVersion: version,
      },
      globalInvariants: {
        maxActiveTasks: globalMaxActive,
        maxPendingQueue: globalMaxPending,
        outstandingUrlsAfterDispose: outstandingUrls,
        errors: errorCount,
        unhandledRejections,
      },
      profiles,
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`[benchmark:grid] Artifact: ${outputPath}`);
  } catch (error) {
    console.error('[benchmark:grid] FAILED:', error);
    const diagnostics = vite.diagnostics();
    if (diagnostics) console.error(diagnostics);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    vite.kill();
  }
}

await main();
