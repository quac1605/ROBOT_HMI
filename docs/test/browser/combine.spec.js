import { test, expect } from '@playwright/test';

async function signIn(page) {
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
}

test('combine: two tabs retain camera, manual and mapping features in mock mode', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/login');
  await signIn(page);
  await expect(page).toHaveURL(/\/navigation$/);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByTestId('robot-status-card')).toBeVisible();
  await expect(page.getByTestId('robot-status-connection')).toHaveText('Online');
  await expect(page.getByTestId('map2d-raster')).toBeVisible();

  await page.getByRole('tab', { name: 'Tạo bản đồ', exact: true }).click();
  await expect(page).toHaveURL(/\/mapping$/);
  await expect(page.getByLabel('Tên bản đồ')).toBeVisible();
  await expect(page.getByTestId('navigation-joystick')).toHaveCount(0);
  await expect(page.getByTestId('mapping-joystick')).toHaveCount(0);
  for (const camera of ['front', 'rear']) {
    await page.getByTestId(`navigation-camera-select-${camera}`).click();
    await expect(page.getByTestId(`camera-video-${camera}`)).toBeVisible();
    await expect(page.getByTestId('navigation-camera-health')).toContainText('Live');
  }

  await page.getByRole('tab', { name: 'Đi đến đích & trạng thái', exact: true }).click();
  await expect(page).toHaveURL(/\/navigation$/);
  await expect(page.getByTestId('robot-status-card')).toBeVisible();
  await expect(page.getByTestId('map2d-raster')).toBeVisible();
  await expect(page.getByTestId('camera-gesture-status')).toContainText('Chưa nhận diện');
  await expect(page.getByTestId('manual-mode-toggle')).not.toBeChecked();
  await expect(page.getByTestId('navigation-joystick')).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

for (const [requested, destination, testId] of [
  ['/gesture', '/navigation', 'camera-gesture-status'],
  ['/status', '/navigation', 'robot-status-card'],
  ['/teleop', '/navigation', 'navigation-joystick'],
]) {
  test(`combine: login from ${requested} returns to ${destination}`, async ({ page }) => {
    await page.goto(requested);
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page);
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
    await expect(page.getByTestId(testId)).toBeVisible();
  });
}
