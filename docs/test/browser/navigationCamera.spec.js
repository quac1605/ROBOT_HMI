import { test, expect } from '@playwright/test';

test('NavigationPage xem camera trước/sau bên cạnh map mà không mở điều khiển', async ({ page }) => {
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
  // Khung camera rộng bằng ô Trạng thái robot bên dưới (cùng cột phải).
  const statusBox = await page.getByTestId('robot-status-card').boundingBox();
  expect(Math.abs(cameraBox.width - statusBox.width)).toBeLessThanOrEqual(1);

  for (const id of ['front', 'rear']) {
    await page.getByTestId(`navigation-camera-select-${id}`).click();
    const video = page.getByTestId(`camera-video-${id}`);
    await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate(element =>
      element.currentSrc ? new URL(element.currentSrc).pathname : null))
      .toBe(`/demo/${id}.mp4`);
    await expect(page.getByTestId('navigation-camera-health')).toHaveText('Đang phát');
    await expect(map).toBeVisible();
    // Phát hiện người & cử chỉ chỉ chạy trên cam trước.
    await expect(page.getByTestId('gesture-current'))
      .toHaveText(id === 'front' ? 'Chưa nhận diện' : 'Chỉ nhận diện ở cam trước');
  }
  await expect(page.getByTestId('camera-video-front')).toHaveCount(0);
});
