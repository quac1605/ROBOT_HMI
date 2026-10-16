import { test, expect } from '@playwright/test';

test('NavigationPage xem camera trước/sau bên cạnh map cùng rail cử chỉ; manual mặc định tắt', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await expect(page).toHaveURL(/\/navigation$/);

  const map = page.getByTestId('map2d-raster');
  const cameraPanel = page.getByTestId('navigation-camera-panel');
  await expect(map).toBeVisible();
  await expect(cameraPanel).toBeVisible();
  await expect(page.getByTestId('robot-status-card')).toBeVisible();
  await expect(page.getByTestId('mapping-joystick')).toHaveCount(0);

  const mapBox = await map.boundingBox();
  const cameraBox = await cameraPanel.boundingBox();
  expect(mapBox).not.toBeNull();
  expect(cameraBox).not.toBeNull();
  expect(cameraBox.x).toBeGreaterThanOrEqual(mapBox.x + mapBox.width - 1);
  const videoBox = await page.getByTestId('camera-video-front').boundingBox();
  const gestureBox = await page.getByTestId('camera-gesture-status').boundingBox();
  expect(gestureBox.width).toBeGreaterThanOrEqual(100);
  expect(gestureBox.width).toBeLessThanOrEqual(120);
  expect(Math.abs(gestureBox.height - videoBox.height)).toBeLessThanOrEqual(1);
  expect(gestureBox.x).toBeGreaterThanOrEqual(videoBox.x + videoBox.width);
  await expect(page.getByTestId('manual-mode-toggle')).not.toBeChecked();

  for (const id of ['front', 'rear']) {
    await page.getByTestId(`navigation-camera-select-${id}`).click();
    const video = page.getByTestId(`camera-video-${id}`);
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate(element =>
      element.currentSrc ? new URL(element.currentSrc).pathname : null))
      .toBe(`/demo/${id}.mp4`);
    await expect(page.getByTestId('navigation-camera-health')).toHaveText('Đang phát');
    await expect(map).toBeVisible();
  }
  await expect(page.getByTestId('camera-video-front')).toHaveCount(0);
  await page.evaluate(async () => {
    window.retainedVideo = document.querySelector('video');
    const { robotClient } = await import('/src/clients/index.js');
    const get = robotClient.getCameraStream.bind(robotClient);
    window.extraDescriptors = 0;
    robotClient.getCameraStream = (...args) => { window.extraDescriptors++; return get(...args); };
  });
  await page.locator('#map-selector-select').click();
  await page.getByRole('option', { name: /Bản đồ xoay/ }).click();
  await expect(map).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('video') === window.retainedVideo)).toBe(true);
  expect(await page.evaluate(() => window.extraDescriptors)).toBe(0);
  expect(await page.getByTestId('camera-video-rear').evaluate(async video => {
    const frame = () => new Promise(resolve => video.requestVideoFrameCallback((_, m) => resolve(m.presentedFrames)));
    return (await frame()) < (await frame());
  })).toBe(true);
});
