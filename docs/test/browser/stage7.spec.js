import { test, expect } from '@playwright/test';

async function activate(locator) {
    await expect(locator).toBeVisible();
    await expect(locator).toBeEnabled();
    await locator.evaluate(element => element.click());
}
async function login(page) {
    await page.goto('/login');
    await page.locator('#login-username').fill('admin');
    await page.locator('#login-password').fill('demo-only');
    await page.locator('#login-submit-btn').click();
    await page.waitForURL('**/navigation');
    await page.goto('/navigation');
    await expect(page.getByTestId('map2d-raster')).toBeVisible();
}
async function enterPose(page, x, y, degrees = 0, append = false) {
    await page.getByLabel('X (m)', { exact: true }).fill(String(x));
    await page.getByLabel('Y (m)', { exact: true }).fill(String(y));
    await page.getByLabel('Góc (°)', { exact: true }).fill(String(degrees));
    await activate(page.getByRole('button', { name: append ? 'Thêm điểm' : 'Áp dụng', exact: true }));
}
async function selectMap(page, rotated) {
    await page.locator('#map-selector-select').click();
    await page.getByRole('option', { name: rotated ? /Bản đồ xoay/ : /Bản đồ mẫu/ }).click();
    await expect(page.getByTestId('map2d-raster')).toBeVisible();
}
async function navigate(page, label, path) {
    // Menu là thanh tab ngang luôn hiển thị (không còn Drawer cần mở/đóng).
    await page.getByRole('tab', { name: label }).click();
    await expect(page).toHaveURL(new RegExp(path + '$'));
}
test.describe('Chặng 7 — remediation acceptance', () => {
    const errors = new WeakMap();
    test.beforeEach(async ({ page }) => {
        const failures = [];
        errors.set(page, failures);
        page.on('pageerror', error => failures.push(error.message));
        page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
        await login(page);
        // AUTO hiện cần ước lượng pose ban đầu trước khi gửi nhiệm vụ.
        await page.getByTestId('select-initial-pose').click();
        const map = await page.getByTestId('map2d-svg').boundingBox();
        await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2);
        await expect(page.getByTestId('original-position')).toContainText('Vị trí ban đầu:');
    });
    test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

    test('C7-01: preview và activate chạy qua facade/schema thật', async ({ page }) => {
        await enterPose(page, 1, 1);
        await enterPose(page, 2, 2, 0, true);
        await activate(page.getByTestId('preview-route'));
        await expect(page.locator('#preview-path')).toBeVisible();
        await selectMap(page, true);
        await expect(page.locator('#preview-path')).toHaveCount(0);
        await activate(page.getByTestId('activate-map'));
        await expect(page.getByText('Map đang xem đã active trên robot.')).toBeVisible();
        const snapshot = await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            return robotClient.getRobotState();
        });
        expect(snapshot.activeMap.id).toBe('map-rotated');
    });
    test('C7-02: tuyến hai waypoint succeeded không nhảy về pose cũ', async ({ page }) => {
        await enterPose(page, 4.24, 1.8);
        await enterPose(page, 4.24, 2.04, 90, true);
        await activate(page.getByTestId('mission-submit'));
        await expect(page.getByTestId('mission-feedback')).toContainText('succeeded');
        await page.waitForTimeout(450);
        const state = await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            return robotClient.getRobotState();
        });
        expect(state.pose.x).toBeCloseTo(4.24);
        expect(state.pose.y).toBeCloseTo(2.04);
        expect(state.velocity.linearX).toBe(0);
    });
    test('C7-03: đổi map ẩn overlay cũ; quay lại vẫn theo dõi mission', async ({ page }) => {
        await enterPose(page, 8, 3);
        await activate(page.getByTestId('mission-submit'));
        await expect(page.locator('#planned-path')).toBeVisible();
        await expect.poll(() => page.locator('#trajectory-layer circle').count()).toBeGreaterThan(0);
        await selectMap(page, true);
        await expect(page.locator('#planned-path')).toHaveCount(0);
        await expect(page.locator('#trajectory-layer')).toHaveCount(0);
        await expect(page.getByTestId('map2d-robot')).toHaveCount(0);
        await expect(page.getByTestId('mission-feedback')).toContainText('executing');
        await selectMap(page, false);
        await expect(page.locator('#planned-path')).toBeVisible();
        await activate(page.getByTestId('mission-cancel'));
        await expect(page.getByTestId('mission-feedback')).toContainText('canceled');
    });
    test('C7-04: telemetry stale hiện đúng chất lượng và khóa submit', async ({ page }) => {
        await enterPose(page, 5, 3);
        await expect(page.getByTestId('mission-submit')).toBeEnabled();
        await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            robotClient.setDemoScenario('stale');
        });
        await expect(page.getByTestId('map2d-robot')).toHaveAttribute('data-pose-quality', 'stale');
        await expect(page.getByTestId('mission-submit')).toBeDisabled();
        await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            robotClient.setDemoScenario('online');
        });
        await expect(page.getByTestId('mission-submit')).toBeEnabled();
    });
    test('C7-05: sửa một waypoint, lưu/nạp tuyến không tự gửi mission', async ({ page }) => {
        await enterPose(page, 1, 1);
        await enterPose(page, 2, 2, 0, true);
        await enterPose(page, 3, 2, 45);
        await expect(page.getByText('Danh sách Waypoints (2/100)')).toBeVisible();
        await page.getByLabel('Tên tuyến', { exact: true }).fill('Tuyến A');
        await activate(page.getByTestId('save-route'));
        await expect(page.getByRole('button', { name: /Nạp tuyến: Tuyến A/ })).toBeVisible();
        await page.getByRole('button', { name: 'Xóa hết', exact: true }).click();
        await page.getByRole('button', { name: /Nạp tuyến: Tuyến A/ }).click();
        await expect(page.getByText('Danh sách Waypoints (2/100)')).toBeVisible();
        const result = await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            const { useNavigationWorkflowStore: nav } = await import('/src/state/navigationWorkflowStore.js');
            return { active: await robotClient.getActiveMission(), points: nav.getState().routeDraft.poses };
        });
        expect(result.active.mission).toBeNull();
        expect(result.points[1].x).toBe(3);
    });
    test('C7-06: page navigation không làm mất mission', async ({ page }) => {
        await enterPose(page, 8, 3);
        await activate(page.getByTestId('mission-submit'));
        await expect(page.getByTestId('mission-feedback')).toContainText('executing');
        await navigate(page, 'Tạo bản đồ', '/mapping');

        await navigate(page, 'Đi đến đích', '/navigation');
        await expect(page.getByTestId('mission-feedback')).toContainText('executing');
        await activate(page.getByTestId('mission-cancel'));
        await expect(page.getByTestId('mission-feedback')).toContainText('canceled');
    });
    test('C7-07: scenario goal-rejected hiển thị failed có mã lỗi', async ({ page }) => {
        await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            robotClient.setDemoMissionScenario('goal-rejected');
        });
        await enterPose(page, 7, 3);
        await activate(page.getByTestId('mission-submit'));
        await expect(page.getByTestId('mission-feedback')).toContainText('failed');
        await expect(page.getByTestId('mission-feedback')).toContainText('GOAL_REJECTED');
    });
    test('C7-08: timeout giữ requestId, người dùng retry cùng ý định', async ({ page }) => {
        await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            const original = robotClient.createMission.bind(robotClient);
            window.__STAGE7_REQUEST_IDS__ = [];
            robotClient.createMission = async request => {
                window.__STAGE7_REQUEST_IDS__.push(request.requestId);
                if (window.__STAGE7_REQUEST_IDS__.length === 1) {
                    throw Object.assign(new Error('Test timeout before receipt'), { code: 'TIMEOUT' });
                }
                return original(request);
            };
        });
        await enterPose(page, 7, 3);
        await activate(page.getByTestId('mission-submit'));
        await page.getByRole('button', { name: 'Đối soát / thử lại cùng requestId', exact: true }).click();
        await expect(page.getByTestId('mission-feedback')).toContainText('executing');
        const ids = await page.evaluate(() => window.__STAGE7_REQUEST_IDS__);
        expect(ids.length).toBe(2);
        expect(ids[0]).toBe(ids[1]);
    });

    test('C7-09: hủy vẫn khả dụng khi POST create chưa trả nhưng WS đã accepted', async ({ page }) => {
        await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            const original = robotClient.createMission.bind(robotClient);
            robotClient.createMission = async request => {
                const response = await original(request);
                await new Promise(resolve => { window.__RELEASE_C7_CREATE__ = resolve; });
                return response;
            };
        });
        await enterPose(page, 8, 3);
        await activate(page.getByTestId('mission-submit'));
        await expect(page.getByTestId('mission-feedback')).toContainText('executing');
        await expect(page.getByTestId('mission-cancel')).toBeEnabled();
        await activate(page.getByTestId('mission-cancel'));
        await expect(page.getByTestId('mission-feedback')).toContainText('canceled');
        await page.evaluate(() => window.__RELEASE_C7_CREATE__());
        await expect(page.getByTestId('mission-feedback')).toContainText('canceled');
    });

    test('C7-10: mất nguồn pose giữa mission dừng/fail; heartbeat không giả tracking mới', async ({ page }) => {
        await enterPose(page, 8, 3);
        await activate(page.getByTestId('mission-submit'));
        await expect(page.getByTestId('mission-feedback')).toContainText('executing');
        const frozen = await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            robotClient.setDemoScenario('pose-heartbeat');
            return (await robotClient.getRobotState()).pose;
        });
        await expect(page.getByTestId('mission-feedback')).toContainText('POSE_STALE');
        await expect(page.getByTestId('mission-submit')).toBeDisabled();
        await expect(page.getByTestId('map2d-robot')).toHaveAttribute('data-pose-quality', 'stale');
        const state = await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            return robotClient.getRobotState();
        });
        expect(state.pose).toEqual(frozen);
        expect(state.velocity.linearX).toBe(0);
    });

    test('C7-11: sửa draft đang preview không nhận path cũ; edit không đổi mission đã gửi', async ({ page }) => {
        await enterPose(page, 8, 3);
        await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            const original = robotClient.previewRoute.bind(robotClient);
            robotClient.previewRoute = async request => {
                const response = await original(request);
                await new Promise(resolve => { window.__RELEASE_C7_PREVIEW__ = resolve; });
                return response;
            };
        });
        await activate(page.getByTestId('preview-route'));
        await enterPose(page, 7, 2);
        await page.evaluate(() => window.__RELEASE_C7_PREVIEW__());
        await expect(page.getByTestId('mission-submit')).toBeEnabled();
        await expect(page.locator('#preview-path')).toHaveCount(0);
        await activate(page.getByTestId('mission-submit'));
        await expect(page.getByTestId('mission-feedback')).toContainText('executing');
        await enterPose(page, 1, 1);
        const active = await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            return (await robotClient.getActiveMission()).mission;
        });
        expect(active.poses[0].x).toBe(7);
        expect(active.poses[0].y).toBe(2);
        const cancelButton = page.getByTestId('mission-cancel');
        await expect(cancelButton).toBeEnabled();
        // Mission telemetry rerenders at 10 Hz; activate the current enabled
        // node atomically so Playwright cannot lose it between actionability
        // checks and pointer dispatch.
        await cancelButton.evaluate(button => button.click());
        await expect(page.getByTestId('mission-feedback')).toContainText('canceled');
    });

    test('C7-12: double-click submit chỉ tạo một POST và một mission', async ({ page }) => {
        await page.evaluate(async () => {
            const { robotClient } = await import('/src/clients/index.js');
            const original = robotClient.createMission.bind(robotClient);
            window.__C7_CREATE_COUNT__ = 0;
            robotClient.createMission = async request => {
                window.__C7_CREATE_COUNT__++;
                return original(request);
            };
        });
        await enterPose(page, 8, 3);
        // Two synchronous DOM activations exercise the ref lock before rerender.
        await page.getByTestId('mission-submit').evaluate(button => { button.click(); button.click(); });
        await expect(page.getByTestId('mission-feedback')).toContainText('executing');
        expect(await page.evaluate(() => window.__C7_CREATE_COUNT__)).toBe(1);
        await activate(page.getByTestId('mission-cancel'));
        await expect(page.getByTestId('mission-feedback')).toContainText('canceled');
    });
});
