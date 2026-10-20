import { test, expect } from '@playwright/test';

async function startMockMapping(page, name) {
  await page.goto('/mapping');
  await expect(page).toHaveURL(/\/login$/);
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await expect(page).toHaveURL(/\/mapping$/);
  await page.getByLabel('Tên bản đồ').fill(name);
  await page.getByTestId('mapping-start-button').click();
  await expect(page.getByTestId('mapping-finish-button')).toBeEnabled();
}

test('accepted finish response is reconciled after Mapping route unmounts', async ({ page }) => {
  await startMockMapping(page, 'Route finish accepted');
  await page.evaluate(async () => {
    const { robotClient } = await import('/src/clients/index.js');
    const original = robotClient.finishMapping.bind(robotClient);
    window.finishCalls = [];
    robotClient.finishMapping = async request => {
      window.finishCalls.push({ ...request });
      const accepted = await original(request);
      window.finishAccepted = accepted;
      return new Promise(resolve => {
        window.releaseFinishReply = () => resolve(accepted);
      });
    };
  });

  await page.getByTestId('mapping-finish-button').click();
  await expect.poll(() => page.evaluate(() => Boolean(window.finishAccepted))).toBe(true);
  await page.getByRole('tab', { name: 'Đi đến đích & trạng thái', exact: true }).click();
  await expect(page).toHaveURL(/\/navigation$/);
  await page.evaluate(() => window.releaseFinishReply());

  await expect.poll(() => page.evaluate(async () => {
    const { useMappingWorkflowStore } = await import('/src/state/mappingWorkflowStore.js');
    const { session, viewerContext, finishAttempt } = useMappingWorkflowStore.getState();
    return { session, viewerKind: viewerContext?.kind, finishAttempt };
  })).toEqual({ session: null, viewerKind: 'saved', finishAttempt: null });
  expect(await page.evaluate(() => window.finishCalls)).toHaveLength(1);

  await page.getByRole('tab', { name: 'Tạo bản đồ', exact: true }).click();
  await expect(page.getByText('Bản đồ đã lưu', { exact: true })).toBeVisible();
});

test('uncertain finish after route change replays the original request ID', async ({ page }) => {
  await startMockMapping(page, 'Route finish uncertain');
  await page.evaluate(async () => {
    const { robotClient } = await import('/src/clients/index.js');
    const original = robotClient.finishMapping.bind(robotClient);
    window.finishCalls = [];
    robotClient.finishMapping = async request => {
      window.finishCalls.push({ ...request });
      const accepted = await original(request);
      if (window.finishCalls.length > 1) return accepted;
      window.finishAccepted = accepted;
      return new Promise((_, reject) => {
        window.rejectFinishReply = () => reject(new Error('reply lost after accept'));
      });
    };
  });

  await page.getByTestId('mapping-finish-button').click();
  await expect.poll(() => page.evaluate(() => Boolean(window.finishAccepted))).toBe(true);
  await page.getByRole('tab', { name: 'Đi đến đích & trạng thái', exact: true }).click();
  await expect(page).toHaveURL(/\/navigation$/);
  await page.evaluate(() => window.rejectFinishReply());
  await page.getByRole('tab', { name: 'Tạo bản đồ', exact: true }).click();
  await expect(page.getByText('Chưa xác định kết quả lưu.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Lấy lại kết quả cùng yêu cầu' }).click();

  await expect.poll(() => page.evaluate(async () => {
    const { useMappingWorkflowStore } = await import('/src/state/mappingWorkflowStore.js');
    return useMappingWorkflowStore.getState().viewerContext?.kind;
  })).toBe('saved');
  const calls = await page.evaluate(() => window.finishCalls);
  expect(calls).toHaveLength(2);
  expect(calls[1].requestId).toBe(calls[0].requestId);
  expect(calls[1].mappingSessionId).toBe(calls[0].mappingSessionId);
});
