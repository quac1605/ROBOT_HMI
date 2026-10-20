import { test, expect } from '@playwright/test';

test('combine-total: leaving Navigation stops manual lease; Mapping has camera but no drive controls', async ({ page }) => {
  await page.goto('/navigation');
  await expect(page).toHaveURL(/\/login$/);
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await expect(page).toHaveURL(/\/navigation$/);

  await page.evaluate(async () => {
    window.testClient = (await import('/src/clients/index.js')).robotClient;
    window.velocityCalls = [];
    window.stopCalls = [];
    const send = window.testClient.sendVelocity.bind(window.testClient);
    const requestStop = window.testClient.requestStop.bind(window.testClient);
    window.testClient.sendVelocity = message => {
      window.velocityCalls.push({ ...message });
      return send(message);
    };
    window.testClient.requestStop = message => {
      window.stopCalls.push({ ...message });
      return requestStop(message);
    };
  });

  await expect(page.getByTestId('navigation-camera-health')).toHaveText('Đang phát');
  const manualToggle = page.getByTestId('manual-mode-toggle');
  await expect(manualToggle).toBeEnabled();
  await expect(manualToggle).not.toBeChecked();
  await manualToggle.click();
  await expect(page.getByTestId('navigation-joystick')).toHaveAttribute('aria-disabled', 'false');
  // Focus trong MUI Select: Space mở danh sách map, không được phát manual stop.
  await page.locator('#map-selector-select').focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('listbox')).toBeVisible();
  expect(await page.evaluate(() => window.stopCalls.length)).toBe(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('navigation-joystick').focus();
  await page.keyboard.down('w');
  await expect.poll(() => page.evaluate(() => window.velocityCalls.filter(v => v.linearX > 0).length))
    .toBeGreaterThan(0);

  await page.getByRole('tab', { name: 'Tạo bản đồ', exact: true }).click();
  await page.keyboard.up('w');
  await expect(page).toHaveURL(/\/mapping$/);
  await expect(page.getByTestId('navigation-camera-panel')).toBeVisible();
  await expect(page.getByTestId('navigation-joystick')).toHaveCount(0);
  await expect(page.getByTestId('mapping-joystick')).toHaveCount(0);
  await expect(page.getByTestId('manual-mode-toggle')).toHaveCount(0);
  await expect(page.getByTestId('acquire-control')).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () =>
    (await window.testClient.getControlState()).payload.ownership)).toBe('none');
  await expect.poll(() => page.evaluate(() => window.testClient._motionSource.getCommand().velocity))
    .toEqual({ linearX: 0, angularZ: 0 });
  const afterRoute = await page.evaluate(() => window.velocityCalls.length);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.velocityCalls.length)).toBe(afterRoute);

  await page.getByRole('tab', { name: 'Đi đến đích & trạng thái', exact: true }).click();
  await expect(page).toHaveURL(/\/navigation$/);
  await expect(page.getByTestId('manual-mode-toggle')).not.toBeChecked();
  await expect(page.getByTestId('navigation-joystick')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('manual-mode-toggle')).toBeEnabled();
  await page.getByTestId('manual-mode-toggle').click();
  await expect(page.getByTestId('navigation-joystick')).toHaveAttribute('aria-disabled', 'false');
  await page.getByTestId('manual-mode-toggle').click();
  await expect(page.getByTestId('navigation-joystick')).toHaveAttribute('aria-disabled', 'true');
});
