import { test, expect } from '@playwright/test';

const SVG = 'svg[aria-label="Bản đồ 2D Occupancy Grid"]';
const RASTER = `${SVG} image`;
const runtimeFailures = new WeakMap();

async function login(page) {
  await page.goto('/login');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));
  await expect.poll(() => page.evaluate(() => Boolean(window.__STAGE6_TEST_CONTROLS__))).toBe(true);
}

async function startSession(page, name) {
  await page.goto('/mapping');
  await page.getByLabel('Tên bản đồ mới').fill(name);
  await page.getByTestId('mapping-start-button').click();
  await expect.poll(
    () => page.evaluate(() => window.__STAGE6_TEST_CONTROLS__.getActiveMappingSession()),
    { timeout: 5_000 }
  ).toMatchObject({ session: { name, status: 'mapping' } });
  const active = await page.evaluate(() => window.__STAGE6_TEST_CONTROLS__.getActiveMappingSession());
  return active.session;
}

async function spaNavigate(page, label, pathname) {
  await page.getByRole('button', { name: 'Mở menu chức năng' }).click();
  await page.getByRole('link', { name: label }).click();
  await expect(page).toHaveURL(new RegExp(`${pathname}$`));
}

async function waitForRasterPipeline(page, trigger) {
  return page.evaluate(async (triggerSource) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const triggerFn = new AsyncFunction('controller', 'makeGrid', 'runtime', 'publications', 'errors', 'done', triggerSource);
    const { createOccupancyRasterController } = await import('/src/utils/occupancyRasterController.js');
    const { createRasterRuntime } = await import('/src/utils/rasterRuntime.js');
    const runtime = createRasterRuntime();
    const publications = [];
    const errors = [];
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const controller = createOccupancyRasterController({
      runtime,
      onPublish(presentation) {
        if (!presentation?.raster) return;
        publications.push(presentation.raster);
        controller.acknowledgeLoaded(presentation.raster.token);
        resolveDone();
      },
      onError(error) { errors.push(error); },
    });
    const makeGrid = (revision, value, context = { kind: 'mapping', mappingSessionId: 'pipeline-test' }) => ({
      context,
      gridRevision: revision,
      geometry: {
        frameId: 'map', width: 4, height: 3, resolution: 0.05,
        origin: { x: 0, y: 0, yaw: 0 },
      },
      cells: new Int8Array(12).fill(value),
    });
    try {
      await triggerFn(controller, makeGrid, runtime, publications, errors, done);
      await Promise.race([
        done,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Raster pipeline timeout')), 3_000)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const beforeDispose = runtime.getCounters();
      const debug = controller.getDebugState();
      controller.dispose();
      return {
        revisions: publications.map((item) => item.gridRevision),
        contexts: publications.map((item) => item.context),
        errors,
        debug,
        beforeDispose,
        afterDispose: runtime.getCounters(),
      };
    } finally {
      controller.dispose();
    }
  }, trigger.toString().replace(/^.*?\{/, '').replace(/\}\s*$/, ''));
}

test.describe('Chặng 6 — Chromium acceptance với production modules và oracle xác định', () => {
  test.beforeEach(async ({ page }) => {
    const failures = [];
    runtimeFailures.set(page, failures);
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
    await login(page);
  });

  test.afterEach(async ({ page }) => {
    await page.waitForTimeout(0);
    expect(runtimeFailures.get(page) ?? []).toEqual([]);
  });

  test('Case 1: Official 4x3 — blob production có exact RGBA và row flip', async ({ page }) => {
    const actual = await page.evaluate(async () => {
      const { createDemoGridSnapshot } = await import('/src/clients/demoOccupancyGrid.js');
      const { normalizeOccupancyGrid } = await import('/src/utils/normalizeOccupancyGrid.js');
      const { createOccupancyRasterController } = await import('/src/utils/occupancyRasterController.js');
      let controller;
      try {
        return await new Promise((resolve, reject) => {
          controller = createOccupancyRasterController({
            onPublish(presentation) {
              if (!presentation?.raster) return;
              const raster = presentation.raster;
              const image = new Image();
              image.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 4;
                canvas.height = 3;
                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0);
                const bytes = Array.from(context.getImageData(0, 0, 4, 3).data);
                controller.acknowledgeLoaded(raster.token);
                resolve(bytes);
              };
              image.onerror = reject;
              image.src = raster.objectUrl;
            },
            onError: reject,
          });
          controller.updateGrid(normalizeOccupancyGrid(createDemoGridSnapshot()));
        });
      } finally {
        controller?.dispose();
      }
    });

    const U = [176, 190, 197, 255];
    const G = [128, 128, 128, 255];
    const W = [255, 255, 255, 255];
    const B = [0, 0, 0, 255];
    expect(actual).toEqual([
      ...U, ...G, ...W, ...B,
      ...B, ...W, ...G, ...U,
      ...W, ...B, ...U, ...G,
    ]);
  });

  test('Case 2: 200x160 và origin pi/2 — robot/goal dùng cùng transform, không double rotate', async ({ page }) => {
    const math = await page.evaluate(async () => {
      const { worldToGrid, gridToWorld, worldToSvg } = await import('/src/utils/mapCoordinates.js');
      const standard = { width: 200, height: 160, resolution: 0.05, origin: { x: 0, y: 0, yaw: 0 } };
      const rotated = { ...standard, origin: { x: 10, y: -3, yaw: Math.PI / 2 } };
      return {
        grid: worldToGrid({ x: 1, y: 2 }, standard),
        svg: worldToSvg({ x: 1, y: 2 }, standard),
        worldRotated: gridToWorld({ u: 20, v: 40 }, rotated),
        svgRotated: worldToSvg({ x: 8, y: -2 }, rotated),
      };
    });
    expect(math.grid.u).toBeCloseTo(20, 10);
    expect(math.grid.v).toBeCloseTo(40, 10);
    expect(math.svg).toEqual({ x: 20, y: 120 });
    expect(math.worldRotated.x).toBeCloseTo(8, 10);
    expect(math.worldRotated.y).toBeCloseTo(-2, 10);
    expect(math.svgRotated.x).toBeCloseTo(20, 10);
    expect(math.svgRotated.y).toBeCloseTo(120, 10);

    await spaNavigate(page, 'Đi đến đích', '/navigation');
    await expect(page.locator(RASTER)).toBeVisible();
    await page.locator('#map-selector-select').click();
    await page.getByRole('option', { name: /Bản đồ xoay 90/ }).click();
    await expect(page.locator(RASTER)).toBeVisible();
    await page.getByLabel('X (m)').fill('8');
    await page.getByLabel('Y (m)').fill('-2');
    await page.getByLabel('Góc (°)').fill('90');
    await page.getByRole('button', { name: 'Áp dụng' }).click();
    const goalTransform = await page.locator(`${SVG} line[stroke="#d32f2f"]`).locator('..').getAttribute('transform');
    const [, x, y] = /translate\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(goalTransform);
    expect(Number(x)).toBeCloseTo(20, 6);
    expect(Number(y)).toBeCloseTo(120, 6);
    await expect(page.locator(RASTER)).not.toHaveAttribute('transform');
    await page.locator('#map-selector-select').click();
    await page.getByRole('option', { name: /Bản đồ mẫu VKIST/ }).click();
    await expect(page.getByText('Chưa chọn mục tiêu.')).toBeVisible();
  });

  test('Case 3: Pan/zoom/resize/numeric/bounds giữ world goal và đổi viewBox đúng', async ({ page }) => {
    await spaNavigate(page, 'Đi đến đích', '/navigation');
    await expect(page.locator(RASTER)).toBeVisible();
    await page.getByLabel('X (m)').fill('1');
    await page.getByLabel('Y (m)').fill('2');
    await page.getByLabel('Góc (°)').fill('30');
    await page.getByRole('button', { name: 'Áp dụng' }).click();
    const goalText = page.getByText(/Tọa độ: X =/);
    await expect(goalText).toContainText('1.00m');
    await expect(goalText).toContainText('2.00m');
    await expect(page.getByRole('button', { name: 'Bắt đầu di chuyển' })).toBeDisabled();
    await expect(page.getByText(/Chưa gửi mission/)).toBeVisible();
    const initial = await page.locator(SVG).getAttribute('viewBox');
    await page.getByRole('button', { name: 'Phóng to bản đồ' }).click();
    const zoomed = await page.locator(SVG).getAttribute('viewBox');
    expect(zoomed).not.toBe(initial);
    await page.getByRole('button', { name: 'Kéo xem bản đồ' }).click();
    const box = await page.locator(SVG).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 45, box.y + box.height / 2 + 25);
    await page.mouse.up();
    const panned = await page.locator(SVG).getAttribute('viewBox');
    expect(panned).not.toBe(zoomed);
    await page.setViewportSize({ width: 960, height: 720 });
    await expect(page.locator(SVG)).toHaveAttribute('viewBox', panned);
    await expect(goalText).toContainText('1.00m');

    await page.getByLabel('X (m)').fill('10');
    await page.getByLabel('Y (m)').fill('2');
    await page.getByRole('button', { name: 'Áp dụng' }).click();
    await expect(page.getByText(/nằm ngoài phạm vi hình học/)).toBeVisible();
    await expect(goalText).toContainText('1.00m');

    await page.getByLabel('X (m)').fill('1');
    await page.getByLabel('Y (m)').fill('2');
    await page.getByLabel('Góc (°)').fill('1e308');
    await page.getByRole('button', { name: 'Áp dụng' }).click();
    await expect(page.getByText(/Góc quay nằm ngoài phạm vi số/)).toBeVisible();
    await expect(goalText).toContainText('1.00m');

    const boundary = await page.evaluate(async () => {
      const { isInsideMap } = await import('/src/utils/mapCoordinates.js');
      const geometry = { width: 200, height: 160, resolution: 0.05, origin: { x: 0, y: 0, yaw: 0 } };
      return [
        isInsideMap({ x: -5e-11, y: 0 }, geometry),
        isInsideMap({ x: -1e-5, y: 0 }, geometry),
        isInsideMap({ x: 10, y: 0 }, geometry),
      ];
    });
    expect(boundary).toEqual([true, false, false]);
  });

  test('Case 4: Deferred A→B→C — chỉ latest C publish, active/pending không vượt 1', async ({ page }) => {
    const result = await waitForRasterPipeline(page, async (controller, makeGrid, runtime, publications, errors, done) => {
      runtime.setBlobDelayMs(80);
      const maxima = { active: 0, pending: 0 };
      const timer = setInterval(() => {
        const state = controller.getDebugState();
        maxima.active = Math.max(maxima.active, state.activeTasks);
        maxima.pending = Math.max(maxima.pending, state.pendingCount);
      }, 2);
      controller.updateGrid(makeGrid('A', 0));
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.updateGrid(makeGrid('B', 50));
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.updateGrid(makeGrid('C', 100));
      await done;
      clearInterval(timer);
      if (maxima.active > 1 || maxima.pending > 1) throw new Error(JSON.stringify(maxima));
    });
    expect(result.revisions).toEqual(['C']);
    expect(result.errors).toEqual([]);
    expect(result.debug).toMatchObject({ activeTasks: 0, pendingCount: 0 });
    expect(result.afterDispose.activeCount).toBe(0);
    expect(result.afterDispose.createdCount).toBe(result.afterDispose.revokedCount);
  });

  test('Case 5: Deferred decode + context switch — A không commit vào B', async ({ page }) => {
    const result = await waitForRasterPipeline(page, async (controller, makeGrid, runtime, publications, errors, done) => {
      const realDecode = runtime.decodeUrl.bind(runtime);
      runtime.decodeUrl = async (url, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return realDecode(url, signal);
      };
      controller.updateGrid(makeGrid(1, 0, { kind: 'saved', mapId: 'A', mapRevision: 'r1' }));
      await new Promise((resolve) => setTimeout(resolve, 15));
      controller.updateGrid(makeGrid(1, 100, { kind: 'saved', mapId: 'B', mapRevision: 'r1' }));
      await done;
    });
    expect(result.contexts).toEqual([{ kind: 'saved', mapId: 'B', mapRevision: 'r1' }]);
    expect(result.errors).toEqual([]);
    expect(result.afterDispose.activeCount).toBe(0);
  });

  test('Case 6: Same geometry giữ viewBox; geometry đổi giữa pointerDown/Up hủy goal', async ({ page }) => {
    await page.evaluate(async () => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { default: Map2D } = await import('/src/components/map/Map2D.jsx');
      const host = document.createElement('div');
      host.id = 'map2d-acceptance-harness';
      document.body.replaceChildren(host);
      const root = createRoot(host);
      const goals = [];
      const render = (geometry, revision) => root.render(React.createElement(Map2D, {
        model: {
          context: { kind: 'saved', mapId: 'harness', mapRevision: 'r1' },
          gridRevision: revision,
          geometry,
          objectUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/%3E',
          token: String(revision),
          onLoad() {}, onError() {},
        },
        tool: 'goal',
        onGoalChange: (goal) => goals.push(goal),
      }));
      const original = { frameId: 'map', width: 200, height: 160, resolution: 0.05, origin: { x: 0, y: 0, yaw: 0 } };
      render(original, 1);
      window.__MAP2D_HARNESS__ = { render, goals, original, root };
    });
    const harness = page.locator('#map2d-acceptance-harness');
    const svg = harness.locator(SVG);
    await expect(svg).toBeVisible();
    await harness.getByRole('button', { name: 'Phóng to bản đồ' }).click();
    const zoomed = await svg.getAttribute('viewBox');
    await page.evaluate(() => window.__MAP2D_HARNESS__.render({ ...window.__MAP2D_HARNESS__.original }, 2));
    await expect(svg).toHaveAttribute('viewBox', zoomed);

    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.evaluate(() => window.__MAP2D_HARNESS__.render({
      ...window.__MAP2D_HARNESS__.original,
      width: 220,
      height: 180,
    }, 3));
    await expect(svg).toHaveAttribute('viewBox', '-8 -8 236 196');
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2);
    await page.mouse.up();
    expect(await page.evaluate(() => window.__MAP2D_HARNESS__.goals)).toEqual([]);
    await page.evaluate(() => window.__MAP2D_HARNESS__.root.unmount());
  });

  test('Case 7: blob/decode/SVG error giữ last-good, error code đúng, URL cân bằng', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const { createOccupancyRasterController } = await import('/src/utils/occupancyRasterController.js');
      const { createRasterRuntime } = await import('/src/utils/rasterRuntime.js');
      const runtime = createRasterRuntime();
      const publications = [];
      const errors = [];
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const grid = (revision) => ({
        context: { kind: 'mapping', mappingSessionId: 'failure-test' }, gridRevision: revision,
        geometry: { frameId: 'map', width: 4, height: 3, resolution: 0.05, origin: { x: 0, y: 0, yaw: 0 } },
        cells: new Int8Array(12).fill(0),
      });
      let latest = null;
      const controller = createOccupancyRasterController({
        runtime,
        onPublish(presentation) {
          latest = presentation?.raster ?? null;
          publications.push(latest?.gridRevision ?? null);
          if (latest && latest.gridRevision !== 4) controller.acknowledgeLoaded(latest.token);
        },
        onError(error) { errors.push(error.code); },
      });
      controller.updateGrid(grid(1));
      while (latest?.gridRevision !== 1) await wait(5);
      const lastGoodUrl = latest.objectUrl;
      runtime.setBlobNullOnce(true);
      controller.updateGrid(grid(2));
      while (!errors.includes('RASTER_BLOB_ERROR')) await wait(5);
      const afterBlob = latest.objectUrl;
      runtime.setDecodeFailureOnce(true);
      controller.updateGrid(grid(3));
      while (errors.length < 2) await wait(5);
      const afterDecode = latest.objectUrl;
      controller.updateGrid(grid(4));
      while (latest?.gridRevision !== 4) await wait(5);
      controller.acknowledgeImageError(latest.token, new Error('SVG image load failed'));
      await wait(10);
      const afterSvgError = latest?.objectUrl;
      controller.dispose();
      return {
        publications, errors, lastGoodUrl, afterBlob, afterDecode, afterSvgError,
        counters: runtime.getCounters(),
      };
    });
    expect(result.afterBlob).toBe(result.lastGoodUrl);
    expect(result.afterDecode).toBe(result.lastGoodUrl);
    expect(result.afterSvgError).toBe(result.lastGoodUrl);
    expect(result.errors).toEqual(['RASTER_BLOB_ERROR', 'IMAGE_DECODE_FAILED', 'IMAGE_DECODE_FAILED']);
    expect(result.counters.activeCount).toBe(0);
    expect(result.counters.createdCount).toBe(result.counters.revokedCount);
  });

  test('Case 8: StrictMode unmount khi toBlob pending — không late publish/error/rò URL', async ({ page }) => {
    const browserErrors = [];
    page.on('pageerror', (error) => browserErrors.push(error.message));
    const result = await page.evaluate(async () => {
      const React = (await import('/node_modules/.vite/deps/react.js')).default;
      const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
      const { useOccupancyRaster } = await import('/src/hooks/useOccupancyRaster.js');
      const { createRasterRuntime } = await import('/src/utils/rasterRuntime.js');
      const runtime = createRasterRuntime();
      runtime.setBlobDelayMs(120);
      const grid = {
        context: { kind: 'mapping', mappingSessionId: 'strict-unmount' }, gridRevision: 1,
        geometry: { frameId: 'map', width: 64, height: 64, resolution: 0.05, origin: { x: 0, y: 0, yaw: 0 } },
        cells: new Int8Array(64 * 64).fill(0),
      };
      let renderedRaster = 0;
      function Harness() {
        const { raster } = useOccupancyRaster(grid, runtime);
        if (raster) renderedRaster += 1;
        return React.createElement('div', { id: 'hook-result' }, raster ? 'raster' : 'pending');
      }
      const host = document.createElement('div');
      document.body.replaceChildren(host);
      const root = createRoot(host);
      root.render(React.createElement(React.StrictMode, null, React.createElement(Harness)));
      await new Promise((resolve) => setTimeout(resolve, 20));
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 220));
      return { renderedRaster, counters: runtime.getCounters(), body: document.body.textContent };
    });
    expect(result.renderedRaster).toBe(0);
    expect(result.counters.activeCount).toBe(0);
    expect(result.counters.createdCount).toBe(result.counters.revokedCount);
    expect(result.body).toBe('');
    expect(browserErrors).toEqual([]);
  });

  test('Case 9: Double-start và getJob ngay sau accepted chỉ tạo một session', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const controls = window.__STAGE6_TEST_CONTROLS__;
      const make = (suffix) => controls.startMapping({ name: 'Double Start Browser', requestId: `double-${suffix}-${crypto.randomUUID()}` });
      const settled = await Promise.allSettled([make('a'), make('b')]);
      const fulfilled = settled.filter((item) => item.status === 'fulfilled');
      const rejected = settled.filter((item) => item.status === 'rejected');
      const response = fulfilled[0]?.value;
      const immediateJob = response ? await controls.getJob(response.jobId) : null;
      return {
        fulfilled: fulfilled.length,
        rejected: rejected.length,
        rejectedCode: rejected[0]?.reason?.code,
        response,
        immediateJob,
        session: await controls.getActiveMappingSession(),
      };
    });
    expect(result.fulfilled).toBe(1);
    expect(result.rejected).toBe(1);
    expect(['ROBOT_NOT_IDLE', 'MAPPING_ALREADY_ACTIVE']).toContain(result.rejectedCode);
    expect(result.immediateJob).toMatchObject({ jobId: result.response.jobId, status: 'accepted' });
    expect(result.session.session.mappingSessionId).toBe(result.response.mappingSessionId);
    expect(result.session.session.name).toBe('Double Start Browser');
  });

  test('Case 10: Mapping→Navigation→Mapping giữ session và live grid tiếp tục', async ({ page }) => {
    const started = await startSession(page, 'Route Continuity Browser');
    await expect(page.getByText(/Phiên:/)).toContainText('Route Continuity Browser');
    await expect(page.locator(RASTER)).toBeVisible();
    const before = await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.getMapGrid({
      kind: 'mapping', mappingSessionId: sessionId,
    }), started.mappingSessionId);
    await spaNavigate(page, 'Đi đến đích', '/navigation');
    await expect(page.locator(RASTER)).toBeVisible();
    await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.advanceSourceStep(sessionId), started.mappingSessionId);
    await spaNavigate(page, 'Xây dựng bản đồ', '/mapping');
    await expect(page.getByText(/Phiên:/)).toContainText(started.mappingSessionId);
    const after = await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.getMapGrid({
      kind: 'mapping', mappingSessionId: sessionId,
    }), started.mappingSessionId);
    expect(after.gridRevision).toBeGreaterThan(before.gridRevision);
  });

  test('Case 11: Finish background cập nhật catalog và load exact saved revision', async ({ page }) => {
    const name = `Saved Browser ${Date.now()}`;
    await startSession(page, name);
    await expect(page.getByRole('button', { name: 'Hoàn tất & Lưu bản đồ' })).toBeEnabled();
    await page.getByRole('button', { name: 'Hoàn tất & Lưu bản đồ' }).click();
    await spaNavigate(page, 'Đi đến đích', '/navigation');
    await expect.poll(async () => page.evaluate(async (mapName) => {
      const maps = await window.__STAGE6_TEST_CONTROLS__.listMaps();
      return maps.find((map) => map.name === mapName) ?? null;
    }, name), { timeout: 6_000 }).not.toBeNull();
    const saved = await page.evaluate(async (mapName) => {
      const controls = window.__STAGE6_TEST_CONTROLS__;
      const map = (await controls.listMaps()).find((item) => item.name === mapName);
      const grid = await controls.getMapGrid({ kind: 'saved', mapId: map.id, mapRevision: map.revision });
      return { map, grid };
    }, name);
    expect(saved.map.revision).toBe('rev-1');
    expect(saved.grid.context).toEqual({ kind: 'saved', mapId: saved.map.id, mapRevision: saved.map.revision });
    await page.locator('#map-selector-select').click();
    await expect(page.getByRole('option', { name: new RegExp(name) })).toBeVisible();
  });

  test('Case 12: Save failure không tạo ready; retry giữ raster và chỉ tạo một map', async ({ page }) => {
    const name = `Retry Browser ${Date.now()}`;
    const started = await startSession(page, name);
    await expect(page.locator(RASTER)).toBeVisible();
    await page.evaluate((sessionId) => {
      const controls = window.__STAGE6_TEST_CONTROLS__;
      controls.setMapScenario(sessionId, 'pause');
      controls.emitSessionNow(sessionId);
    }, started.mappingSessionId);
    await page.waitForTimeout(100);
    const beforeFailure = await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.getLiveSessionSnapshot(sessionId), started.mappingSessionId);
    await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.failNextSaveForSession(sessionId), started.mappingSessionId);
    await page.getByRole('button', { name: 'Hoàn tất & Lưu bản đồ' }).click();
    await expect(page.getByText('Lưu thất bại', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(RASTER)).toBeVisible();
    await expect(page.locator(RASTER)).toHaveAttribute('href', /^blob:/);
    const afterFailure = await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.getLiveSessionSnapshot(sessionId), started.mappingSessionId);
    expect(afterFailure.context).toEqual(beforeFailure.context);
    expect(afterFailure.gridRevision).toBe(beforeFailure.gridRevision);
    expect(await page.evaluate(async (mapName) => (await window.__STAGE6_TEST_CONTROLS__.listMaps())
      .filter((map) => map.name === mapName).length, name)).toBe(0);
    await page.getByRole('button', { name: 'Thử lại lưu bản đồ' }).click();
    await expect(page.getByText(/đã được lưu thành công/)).toBeVisible({ timeout: 6_000 });
    expect(await page.evaluate(async (mapName) => (await window.__STAGE6_TEST_CONTROLS__.listMaps())
      .filter((map) => map.name === mapName).length, name)).toBe(1);
  });

  test('Case 13: Saved silence hợp lệ; live stale/offline/recovery không làm mới grid giả', async ({ page }) => {
    const started = await startSession(page, 'Freshness Browser');
    await expect(page.locator(RASTER)).toBeVisible();
    const before = await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.getLiveSessionSnapshot(sessionId), started.mappingSessionId);
    await page.evaluate((sessionId) => {
      const controls = window.__STAGE6_TEST_CONTROLS__;
      controls.setMapScenario(sessionId, 'pause');
      controls.emitSessionNow(sessionId);
    }, started.mappingSessionId);
    await page.waitForTimeout(2_250);
    await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.emitSessionNow(sessionId), started.mappingSessionId);
    await expect(page.getByText(/Nguồn: stale/)).toBeVisible();
    const stale = await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.getLiveSessionSnapshot(sessionId), started.mappingSessionId);
    expect(stale.gridRevision).toBe(before.gridRevision);
    expect(stale.grid.header.stamp).toEqual(before.grid.header.stamp);
    await page.evaluate((sessionId) => {
      const controls = window.__STAGE6_TEST_CONTROLS__;
      controls.setMapScenario(sessionId, 'live');
      controls.emitSessionNow(sessionId);
    }, started.mappingSessionId);
    await expect(page.getByText(/Nguồn: stale/)).toBeVisible();
    expect((await page.evaluate(
      (sessionId) => window.__STAGE6_TEST_CONTROLS__.getLiveSessionSnapshot(sessionId),
      started.mappingSessionId
    )).gridRevision).toBe(stale.gridRevision);
    await page.evaluate((sessionId) => {
      const controls = window.__STAGE6_TEST_CONTROLS__;
      controls.setMapScenario(sessionId, 'offline');
      controls.emitSessionNow(sessionId);
    }, started.mappingSessionId);
    await expect(page.getByText(/Nguồn: offline/)).toBeVisible();
    await page.evaluate((sessionId) => {
      const controls = window.__STAGE6_TEST_CONTROLS__;
      controls.setMapScenario(sessionId, 'live');
      controls.advanceSourceStep(sessionId);
      controls.emitSessionNow(sessionId);
    }, started.mappingSessionId);
    await expect(page.getByText(/Nguồn: live/)).toBeVisible();
    const recovered = await page.evaluate((sessionId) => window.__STAGE6_TEST_CONTROLS__.getLiveSessionSnapshot(sessionId), started.mappingSessionId);
    expect(recovered.gridRevision).toBeGreaterThan(stale.gridRevision);

    const savedEvents = await page.evaluate(async () => {
      const { robotClient } = await import('/src/clients/index.js');
      let count = 0;
      const unsubscribe = robotClient.subscribeMapGrid(
        { kind: 'saved', mapId: 'map-demo', mapRevision: 'rev-1' },
        () => { count += 1; },
        { subscriptionId: `saved-silence-${crypto.randomUUID()}` }
      );
      await new Promise((resolve) => setTimeout(resolve, 700));
      unsubscribe();
      return count;
    });
    expect(savedEvents).toBe(2);
  });

  test('Case 14: Wrong frame/context pose bị ẩn; đúng frame/context hiện đúng ô', async ({ page }) => {
    await page.goto('/navigation');
    await expect(page.locator(RASTER)).toBeVisible();
    const robotNose = `${SVG} polygon[points="0.3,-0.12 0.45,0 0.3,0.12"]`;
    const robot = page.locator(robotNose).locator('..').locator('..');
    await expect(robot).toBeVisible();
    await page.evaluate(() => {
      window.__STAGE6_TEST_CONTROLS__.setTelemetryScenario('stale');
      window.__STAGE6_TEST_CONTROLS__.patchRobotState({
      activeMap: { id: 'map-rotated', revision: 'rev-1' },
      activeMappingSessionId: null,
      pose: { frameId: 'map', x: 1, y: 2, yaw: 0 },
      });
    });
    await expect(robot).toHaveCount(0);
    await page.evaluate(() => window.__STAGE6_TEST_CONTROLS__.patchRobotState({
      activeMap: { id: 'map-demo', revision: 'rev-1' },
      pose: { frameId: 'odom', x: 1, y: 2, yaw: 0 },
    }));
    await expect(robot).toHaveCount(0);
    await page.evaluate(() => {
      window.__STAGE6_TEST_CONTROLS__.setTelemetryPose({ x: 1, y: 2, yaw: 0 });
      window.__STAGE6_TEST_CONTROLS__.setTelemetryScenario('online');
    });
    await expect(robot).toBeVisible();
    expect(await robot.getAttribute('transform')).toBe('translate(20 120)');
  });

  test('Case 15: Full reload ghi rõ mock in-memory, không tuyên bố backend recovery', async ({ page }) => {
    await page.goto('/mapping');
    await expect(page.getByText(/Mock lưu trong bộ nhớ; tải lại toàn bộ trang sẽ mất phiên/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Mock lưu trong bộ nhớ; tải lại toàn bộ trang sẽ mất phiên/)).toBeVisible();
    await expect(page.getByText(/backend.*recovery/i)).toHaveCount(0);
  });
});
