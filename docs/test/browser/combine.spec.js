import { test, expect } from '@playwright/test';

async function signIn(page) {
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
}

test('combine: all three tabs retain their integrated features in mock mode', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/login');
  await signIn(page);
  await expect(page).toHaveURL(/\/navigation$/);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByTestId('robot-status-card')).toBeVisible();
  await expect(page.getByTestId('robot-status-connection')).toHaveText('Online');
  await expect(page.getByTestId('map2d-raster')).toBeVisible();

  await page.getByRole('tab', { name: 'Tạo bản đồ & điều khiển', exact: true }).click();
  await expect(page).toHaveURL(/\/mapping$/);
  await expect(page.getByLabel('Tên bản đồ mới')).toBeVisible();
  await expect(page.getByTestId('mapping-joystick')).toBeVisible();
  await expect(page.getByTestId('mapping-joystick')).toHaveAttribute('aria-disabled', 'true');
  for (const camera of ['front', 'rear']) {
    await page.getByTestId(`camera-select-${camera}`).click();
    await expect(page.getByTestId(`camera-video-${camera}`)).toBeVisible();
    await expect(page.getByTestId('camera-health')).toContainText('Live');
  }

  await page.getByRole('tab', { name: 'Phát hiện Người & Cử chỉ', exact: true }).click();
  await expect(page).toHaveURL(/\/gesture$/);
  await expect(page.getByTestId('camera-video-front')).toBeVisible();
  await expect(page.getByTestId('gesture-camera-health')).toHaveText('Live');
  await expect(page.getByTestId('gesture-current')).toHaveText('Chưa nhận diện');

  await page.getByRole('tab', { name: 'Đi đến đích & trạng thái', exact: true }).click();
  await expect(page).toHaveURL(/\/navigation$/);
  await expect(page.getByTestId('robot-status-card')).toBeVisible();
  await expect(page.getByTestId('map2d-raster')).toBeVisible();
  expect(errors).toEqual([]);
});

for (const [requested, destination, testId] of [
  ['/gesture', '/gesture', 'gesture-status'],
  ['/status', '/navigation', 'robot-status-card'],
  ['/teleop', '/mapping', 'mapping-joystick'],
]) {
  test(`combine: login from ${requested} returns to ${destination}`, async ({ page }) => {
    await page.goto(requested);
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page);
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
    await expect(page.getByTestId(testId)).toBeVisible();
  });
}
