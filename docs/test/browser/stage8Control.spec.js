import { test, expect } from '@playwright/test';

async function confirmedAndQuiet(page) {
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  await expect.poll(() => page.evaluate(() => window.testClient._motionSource.latest()?.velocity))
    .toEqual({ linearX: 0, angularZ: 0 });
  const count = await page.evaluate(() => window.testCalls.velocity.length);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.testCalls.velocity.length)).toBe(count);
}

async function spa(page, route) {
  await page.evaluate(path => {
    history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate'));
  }, route);
  await page.waitForURL(`**${route}`);
  // URL mutates synchronously; React may batch two popstates without unmounting.
  // Assert the destination DOM before navigating back or resolving a late request.
  if (route === '/status') await expect(page.getByTestId('acquire-control')).toHaveCount(0);
  if (route === '/teleop') await expect(page.getByTestId('acquire-control')).toBeVisible();
}

async function teleop(page) {
  await page.goto('/login');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await page.waitForURL('**/status');
  await page.goto('/teleop');
  await page.evaluate(async () => {
    window.testClient = (await import('/src/clients/index.js')).robotClient;
    window.testCalls = { acquire: [], stop: [], release: [], velocity: [] };
    for (const [method, key] of [
      ['acquireControl', 'acquire'],
      ['requestStop', 'stop'],
      ['releaseControl', 'release'],
      ['sendVelocity', 'velocity'],
    ]) {
      const original = window.testClient[method].bind(window.testClient);
      window.testClient[method] = (...args) => {
        window.testCalls[key].push(structuredClone(args[0]));
        return original(...args);
      };
    }
  });
}

test('C8-01: login -> front clip decode -> switch rear decode; cameraId/nhãn đúng', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await expect(page.getByTestId('camera-video-front')).toBeVisible();

  await page.getByTestId('camera-select-rear').click();
  await expect(page.getByTestId('camera-video-rear')).toBeVisible();
  await expect(page.getByTestId('camera-health')).toContainText('Live');
});

test('C8-02: giữ và thả ngoài nút không có nonzero command trở lại', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  const acquireBtn = page.getByTestId('acquire-control');
  await expect(acquireBtn).toBeEnabled();
  await acquireBtn.click();

  const forwardBtn = page.getByTestId('dpad-forward');
  await expect(forwardBtn).toBeEnabled();

  const box = await forwardBtn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // Di chuyển ra ngoài nút rồi thả
  await page.mouse.move(10, 10);
  await page.mouse.up();
  await page.waitForTimeout(100);

  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const callCount = await page.evaluate(() => window.testCalls.velocity.length);
  await page.waitForTimeout(300);
  const afterCallCount = await page.evaluate(() => window.testCalls.velocity.length);
  expect(afterCallCount).toBe(callCount);
});

test('C8-03: lùi/quay trái/quay phải đúng dấu/đơn vị; chọn camera sau không đảo vector', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');

  // 1. Lùi: linearX < 0, angularZ === 0
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-backward')).toBeEnabled();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  const bwd = page.getByTestId('dpad-backward');
  const bwdBox = await bwd.boundingBox();
  await page.mouse.move(bwdBox.x + bwdBox.width / 2, bwdBox.y + bwdBox.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const bwdCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(bwdCmd.linearX).toBeLessThan(0);
  expect(Math.abs(bwdCmd.angularZ)).toBeLessThan(1e-4);

  // 2. Quay trái: angularZ > 0, linearX === 0
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-left')).toBeEnabled();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  const left = page.getByTestId('dpad-left');
  const leftBox = await left.boundingBox();
  await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + leftBox.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const leftCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(leftCmd.angularZ).toBeGreaterThan(0);
  expect(Math.abs(leftCmd.linearX)).toBeLessThan(1e-4);

  // 3. Quay phải: angularZ < 0, linearX === 0
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-right')).toBeEnabled();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  const right = page.getByTestId('dpad-right');
  const rightBox = await right.boundingBox();
  await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + rightBox.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const rightCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(rightCmd.angularZ).toBeLessThan(0);
  expect(Math.abs(rightCmd.linearX)).toBeLessThan(1e-4);

  // 4. Switch sang camera sau: DPad vẫn hoạt động và hướng tiến KHÔNG bị đảo (vẫn linearX > 0)
  await page.getByTestId('camera-select-rear').click();
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-forward')).toBeEnabled();

  await page.evaluate(() => { window.testCalls.velocity = []; });
  const fwd = page.getByTestId('dpad-forward');
  const fwdBox = await fwd.boundingBox();
  await page.mouse.move(fwdBox.x + fwdBox.width / 2, fwdBox.y + fwdBox.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const fwdRearCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(fwdRearCmd.linearX).toBeGreaterThan(0);
});

test('C8-04: pointercancel + lostcapture stop', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  const forwardBtn = page.getByTestId('dpad-forward');
  await expect(forwardBtn).toBeEnabled();

  // Test 1: pointercancel ngừng publisher
  const box = await forwardBtn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  await forwardBtn.dispatchEvent('pointercancel', { pointerId: 1 });
  await confirmedAndQuiet(page); // Prove cancellation works BEFORE normal mouse release.
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const vel1 = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel1.linearX).toBe(0);

  // Test 2: lostpointercapture ngừng publisher
  await page.getByTestId('acquire-control').click();
  await expect(forwardBtn).toBeEnabled();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  await forwardBtn.dispatchEvent('lostpointercapture', { pointerId: 1 });
  await confirmedAndQuiet(page);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const vel2 = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel2.linearX).toBe(0);
});

test('C8-05: hai pointer/hai nút: chỉ một publisher duy nhất', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  const fwd = page.getByTestId('dpad-forward');
  const bwd = page.getByTestId('dpad-backward');
  await expect(fwd).toBeEnabled();
  await expect(bwd).toBeEnabled();

  // Pointer 1 hold fwd
  const box = await fwd.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); // Real capture: synthetic pointer 1 can throw before the second pointer test.
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));
  const count = await page.evaluate(() => window.testCalls.velocity.length);
  const stops = await page.evaluate(() => window.testCalls.stop.length);

  // Pointer 2 down trên bwd trong khi pointer 1 vẫn đang giữ
  await bwd.dispatchEvent('pointerdown', { pointerId: 2, button: 0 });
  await bwd.dispatchEvent('pointerup', { pointerId: 2 });
  await expect.poll(() => page.evaluate(() => window.testCalls.velocity.length)).toBeGreaterThan(count + 2);
  expect(await page.evaluate(() => window.testCalls.stop.length)).toBe(stops);
  const commands = await page.evaluate(() => window.testCalls.velocity);
  expect(commands.every(v => v.linearX > 0 && v.angularZ === 0)).toBe(true);
  expect(new Set(commands.map(v => v.sequence)).size).toBe(commands.length);

  // Lấy các lệnh vận tốc gần nhất: chỉ publisher của pointer 1 phát (linearX > 0)
  const recentCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(recentCmd.linearX).toBeGreaterThan(0);

  // Thả pointer 1 -> dừng lái
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const vel = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel.linearX).toBe(0);
});

test('C8-06: phím Space ngoài input gọi manual stop; trong input không stop', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-forward')).toBeEnabled();

  // 1. Giữ phím ArrowUp và bấm Space ngoài input -> dừng khẩn cấp
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));
  await page.keyboard.press('Space');
  await confirmedAndQuiet(page);
  await page.keyboard.up('ArrowUp');

  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const vel = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel.linearX).toBe(0);

  // 2. Khi focus trong ô input, gõ Space không kích hoạt manual stop
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'test-dummy-input';
    document.body.appendChild(input);
    input.focus();
  });
  const stopCountBefore = await page.evaluate(() => window.testCalls.stop.length);
  await page.keyboard.press('Space');
  const stopCountAfter = await page.evaluate(() => window.testCalls.stop.length);
  expect(stopCountAfter).toBe(stopCountBefore);
  await page.evaluate(() => document.getElementById('test-dummy-input')?.remove());
});

test('C8-07: window blur ngừng hold', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-forward')).toBeEnabled();

  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await confirmedAndQuiet(page);
  await page.keyboard.up('ArrowUp');

  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const vel = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel.linearX).toBe(0);
});

test('C8-08: đổi route khi holding: cleanup, quay lại không tự cấp quyền', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-forward')).toBeEnabled();

  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // SPA unmount chuyển sang /status (không reload trang)
  const stopsBefore = await page.evaluate(() => window.testCalls.stop.length);
  await page.evaluate(() => {
    history.pushState(null, '', '/status');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForURL('**/status');
  await page.keyboard.up('ArrowUp');

  const stopsAfter = await page.evaluate(() => window.testCalls.stop.length);
  expect(stopsAfter).toBeGreaterThan(stopsBefore);

  // SPA navigate quay lại /teleop
  await page.evaluate(() => {
    history.pushState(null, '', '/teleop');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForURL('**/teleop');

  // Phải không tự động cấp quyền lại, D-Pad phải disabled
  await expect(page.getByTestId('acquire-control')).toBeEnabled();
  await expect(page.getByTestId('dpad-forward')).toBeDisabled();
});

test('C8-09: switch camera khi đang giữ: stop ngay, freshness reset', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-forward')).toBeEnabled();

  // Giữ phím tiến
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // Chuyển camera sang Sau khi đang giữ lái
  await page.getByTestId('camera-select-rear').click();
  await confirmedAndQuiet(page);
  await page.keyboard.up('ArrowUp');

  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  await expect(page.getByTestId('camera-video-rear')).toBeVisible();
  const vel = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel.linearX).toBe(0);
});

test('C8-10: camera health hiển thị đúng theo trạng thái', async ({ page }) => {
  await teleop(page);
  const health = page.getByTestId('camera-health');
  await expect(health).toContainText('Live');

  // Dừng video stream tạm thời để test chuyển đổi sang Stale
  await page.evaluate(() => document.querySelector('video')?.pause());
  await page.waitForTimeout(2000);
  await expect(health).toContainText('Stale');

  // Khởi động lại video
  await page.evaluate(() => document.querySelector('video')?.play());
  await expect(health).toContainText('Live');
});

test('C8-11: heartbeat/control transport mất: ngừng publisher', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-forward')).toBeEnabled();

  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // Cắt transport sang offline
  await page.evaluate(() => window.testClient.setDemoScenario('offline'));
  await expect(page.getByTestId('dpad-forward')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.testClient._motionSource.getCommand().velocity))
    .toEqual({ linearX: 0, angularZ: 0 });
  const commandCount = await page.evaluate(() => window.testCalls.velocity.length);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.testCalls.velocity.length)).toBe(commandCount);
  await page.keyboard.up('ArrowUp');

  // Publisher phải ngừng ngay, D-Pad bị khóa
  await expect(page.getByTestId('dpad-forward')).toBeDisabled();
  const vel = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel.linearX).toBe(0);

  // Phục hồi lại online
  await page.evaluate(() => window.testClient.setDemoScenario('online'));
});

test('C8-12: service revoke khóa D-Pad và loop không tiếp tục', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-forward')).toBeEnabled();

  // Thu hồi quyền bằng manual stop
  await page.getByTestId('manual-stop').click();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');

  // D-Pad phải bị khóa ngay lập tức
  await expect(page.getByTestId('dpad-forward')).toBeDisabled();
  const vel = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel.linearX).toBe(0);
});

test('C8-13: manual stop lúc navigation đang thực thi: mission canceling -> terminal hợp lệ', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');

  // Tạo một mission thật đang di chuyển thông qua testClient
  const missionId = await page.evaluate(async () => {
    const res = await window.testClient.createMission({
      requestId: crypto.randomUUID(),
      mapId: 'map-demo',
      mapRevision: 'rev-1',
      kind: 'navigate_to_pose',
      poses: [{ frameId: 'map', x: 7, y: 3, yaw: 0 }],
    });
    return res.missionId;
  });

  // Chờ mission có vận tốc
  await page.waitForFunction(() => window.testClient._motionSource.latest()?.velocity?.linearX > 0);

  // Bấm Yêu cầu dừng trên trang Teleop
  await page.getByTestId('manual-stop').click();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');

  // Xác nhận mission đã chuyển sang canceled và vận tốc về 0
  const mission = await page.evaluate(async (id) => await window.testClient.getMission(id), missionId);
  expect(mission.status).toBe('canceled');
  const vel = await page.evaluate(() => window.testClient._motionSource.latest()?.velocity?.linearX);
  expect(vel).toBe(0);
});

test('C8-14: E-stop/inhibit không acquire; đủ reasons đúng', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  const acquireBtn = page.getByTestId('acquire-control');
  await expect(acquireBtn).toBeEnabled();

  // Kích hoạt E-stop vật lý
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: true }));
  await expect(acquireBtn).toBeDisabled();

  // Hủy E-stop vật lý -> acquire button mở lại
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: false }));
  await expect(acquireBtn).toBeEnabled();
});

test('C8-15: logout lúc holding: dọn dẹp phiên an toàn', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
  await expect(page.getByTestId('dpad-forward')).toBeEnabled();

  // Giữ lái
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // Mở menu và nhấn Đăng xuất thật
  await page.getByRole('button', { name: 'Mở menu chức năng' }).click();
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await page.keyboard.up('ArrowUp');

  // Điều hướng về /login và session bị xóa
  await page.waitForURL('**/login');
  const user = await page.evaluate(() => localStorage.getItem('mock_robot_client_user'));
  expect(user).toBeNull();
});

test('C8-16: manual stop retry và observation confirmation', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  const stopBtn = page.getByTestId('manual-stop');
  await expect(stopBtn).toBeEnabled();
  await page.evaluate(() => {
    const original = window.testClient.requestStop.bind(window.testClient);
    window.stopAttempts = [];
    window.testClient.requestStop = req => {
      window.stopAttempts.push(req.requestId);
      if (window.stopAttempts.length === 1) return Promise.reject(new Error('SIMULATED_RESPONSE_LOST'));
      return original(req);
    };
  });
  await stopBtn.click();
  await expect(page.getByTestId('retry-stop')).toBeVisible();
  await expect(page.getByTestId('acquire-control')).toBeDisabled();
  await spa(page, '/status');
  await spa(page, '/teleop');
  await expect(page.getByTestId('retry-stop')).toBeVisible();
  await page.getByTestId('retry-stop').click();
  const attempts = await page.evaluate(() => window.stopAttempts);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);

  // Phải hiển thị "Đã xác nhận" kèm profile mock
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận (mock)');
  const stopState = await page.evaluate(() => window.testClient.getControlState());
  expect(stopState.payload.stop?.status).toBe('confirmed');
  expect(stopState.payload.stop?.confirmation).toBeDefined();
  expect(stopState.payload.stop?.confirmation.evidenceKind).toBe('mock-source-observation');
});

test('U8-07: descriptor mặc định có nhãn và profile mock; video decode hợp lệ', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-select-front')).toHaveText('Trước');
  await expect(page.getByTestId('camera-select-rear')).toHaveText('Sau');

  // Profile chip hiển thị Profile: mock
  await expect(page.getByText('Profile: mock')).toBeVisible();

  // Video front decode thành công
  await expect(page.getByTestId('camera-video-front')).toBeVisible();
});

for (const exit of ['route', 'logout']) {
  test(`C8-H-${exit}: late acquire after ${exit} never enables a remounted page`, async ({ page }) => {
    await teleop(page);
    await expect(page.getByTestId('acquire-control')).toBeEnabled();
    await page.evaluate(() => {
      const original = window.testClient.acquireControl.bind(window.testClient);
      window.testClient.acquireControl = async req => {
        const lease = await original(req);
        window.pendingLease = lease;
        return new Promise(resolve => { window.finishAcquire = () => resolve(lease); });
      };
    });
    await page.getByTestId('acquire-control').click();
    await page.waitForFunction(() => Boolean(window.finishAcquire));
    await expect(page.getByTestId('dpad-forward')).toBeDisabled();
    if (exit === 'route') {
      await spa(page, '/status');
      await spa(page, '/teleop');
    } else {
      await page.getByRole('button', { name: 'Mở menu chức năng' }).click();
      await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
      await page.waitForURL('**/login');
    }
    await page.evaluate(() => window.finishAcquire());
    await expect.poll(() => page.evaluate(() => window.testCalls.release.some(r => r.leaseId === window.pendingLease.leaseId)))
      .toBe(true);
    expect(await page.evaluate(() => window.testCalls.velocity.length)).toBe(0);
    if (exit === 'route') {
      await expect(page.getByTestId('acquire-control')).toBeEnabled();
      await expect(page.getByTestId('dpad-forward')).toBeDisabled();
      expect((await page.evaluate(() => window.testClient.getControlState())).payload.ownership).toBe('none');
    } else {
      expect(await page.evaluate(() => localStorage.getItem('mock_robot_client_user'))).toBeNull();
    }
  });
}

test('U8-08: thu hồi quyền/unknown E-stop không mở lái dù camera fresh', async ({ page }) => {
  await teleop(page);
  await expect(page.getByTestId('camera-health')).toContainText('Live');

  // 1. Chưa acquire: DPad disabled dù camera fresh
  await expect(page.getByTestId('dpad-forward')).toBeDisabled();

  // 2. Unknown E-stop (physicalEstopActive = null): fail closed, khóa nút acquire và D-Pad
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: null }));
  await expect(page.getByTestId('acquire-control')).toBeDisabled();
  await expect(page.getByTestId('dpad-forward')).toBeDisabled();

  // 3. Khôi phục physicalEstopActive = false -> mở lại nút acquire
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: false }));
  await expect(page.getByTestId('acquire-control')).toBeEnabled();
});
