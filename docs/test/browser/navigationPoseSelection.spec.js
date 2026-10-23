import { test, expect } from '@playwright/test';

test('Navigation: chọn pose hiện tại và đích bằng kéo chuột, chỉ khi manual tắt', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await expect(page.getByTestId('map2d-svg')).toBeVisible();
  await expect(page.getByTestId('navigation-camera-health')).toHaveText('Đang phát');

  const current = page.getByTestId('select-initial-pose');
  const goal = page.getByTestId('select-goal-pose');
  await expect(current).toBeEnabled();
  await expect(goal).toBeEnabled();
  await page.getByTestId('manual-mode-toggle').click();
  await expect(page.getByTestId('navigation-joystick')).toHaveAttribute('aria-disabled', 'false');
  await expect(current).toBeDisabled();
  await expect(goal).toBeDisabled();
  await page.getByTestId('manual-mode-toggle').click();
  await expect(current).toBeEnabled();

  const svg = page.getByTestId('map2d-svg');
  const box = await svg.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await current.click();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 38, y - 18, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('map2d-initial-pose')).toBeVisible();
  await expect(current).toBeEnabled();
  await expect(page.getByTestId('original-position')).toContainText('Vị trí ban đầu:');

  await goal.click();
  await page.mouse.move(x + 30, y + 22);
  await page.mouse.down();
  await page.mouse.move(x + 5, y + 52, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('map2d-goal')).toBeVisible();
  const draft = await page.evaluate(async () =>
    (await import('/src/state/navigationWorkflowStore.js')).useNavigationWorkflowStore.getState().routeDraft);
  expect(draft.poses).toHaveLength(1);
  expect(Math.abs(draft.poses[0].yaw)).toBeGreaterThan(0.1);

  await expect(page.getByTestId('mission-submit')).toBeEnabled();
  await page.getByTestId('mission-submit').click();
  await expect(page.getByTestId('mission-feedback')).toContainText('executing');
  await expect(current).toBeDisabled();
  await page.getByTestId('mission-cancel').click();
  await expect(page.getByTestId('mission-feedback')).toContainText('canceled');
  await expect(current).toBeEnabled();
  const before = await page.evaluate(async () =>
    (await (await import('/src/clients/index.js')).robotClient.getOriginalPosition()).originalPosition);
  await current.click();
  await page.mouse.move(x - 30, y - 25);
  await page.mouse.down();
  await page.mouse.move(x - 8, y - 32, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => page.evaluate(async () =>
    (await (await import('/src/clients/index.js')).robotClient.getOriginalPosition()).originalPosition.x))
    .not.toBe(before.x);
});
