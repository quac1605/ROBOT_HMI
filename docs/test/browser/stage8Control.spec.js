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
  if (route === '/mapping') await expect(page.getByTestId('manual-mode-toggle')).toHaveCount(0);
  if (route === '/navigation') await expect(page.getByTestId('manual-mode-toggle')).toBeVisible();
}

async function openNavigation(page) {
  await page.goto('/login');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await page.waitForURL('**/navigation');
  await page.evaluate(async () => {
    window.testClient = (await import('/src/clients/index.js')).robotClient;
    window.testCalls = { acquire: [], stop: [], release: [], velocity: [], camera: [], finish: [] };
    for (const [method, key] of [
      ['acquireControl', 'acquire'],
      ['requestStop', 'stop'],
      ['releaseControl', 'release'],
      ['sendVelocity', 'velocity'],
      ['getCameraStream', 'camera'],
      ['finishMapping', 'finish'],
    ]) {
      const original = window.testClient[method].bind(window.testClient);
      window.testClient[method] = (...args) => {
        window.testCalls[key].push(structuredClone(args[0]));
        return original(...args);
      };
    }
  });
  await expect(page.getByTestId('navigation-camera-health')).toContainText('Đang phát');
}

function joystick(page) {
  return page.getByTestId('navigation-joystick');
}

async function expectJoystickEnabled(page, enabled) {
  await expect(joystick(page)).toHaveAttribute('aria-disabled', enabled ? 'false' : 'true');
}

// Pointer thật: down ở tâm, kéo theo một trong bốn trục. Caller thả bằng
// mouse.up() trong finally hoặc phát cancel/lostcapture để kiểm cleanup.
async function holdJoystick(page, direction) {
  await expectJoystickEnabled(page, true);
  await joystick(page).scrollIntoViewIfNeeded();
  const box = await joystick(page).boundingBox();
  if (!box) throw new Error('JOYSTICK_NOT_VISIBLE');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const radius = Math.min(box.width, box.height) * 0.32;
  const offsets = {
    forward: [0, -radius], backward: [0, radius],
    left: [-radius, 0], right: [radius, 0],
  };
  const offset = offsets[direction];
  if (!offset) throw new Error('INVALID_DIRECTION');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + offset[0], cy + offset[1], { steps: 4 });
}

test('C8-01: login -> front clip decode -> switch rear decode; cameraId/nhãn đúng', async ({ page }) => {
  await openNavigation(page);
  await expect(page.getByTestId('navigation-camera-health')).toContainText('Đang phát');
  await expect(page.getByTestId('camera-video-front')).toBeVisible();

  await page.getByTestId('navigation-camera-select-rear').click();
  await expect(page.getByTestId('camera-video-rear')).toBeVisible();
  await expect(page.getByTestId('navigation-camera-health')).toContainText('Đang phát');
});

test('C8-02: giữ và thả ngoài nút không có nonzero command trở lại', async ({ page }) => {
  await openNavigation(page);
  const acquireBtn = page.getByTestId('manual-mode-toggle');
  await expect(acquireBtn).toBeEnabled();
  await acquireBtn.click();

  await holdJoystick(page, 'forward');
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
  await openNavigation(page);

  // 1. Lùi: linearX < 0, angularZ === 0
  await page.getByTestId('manual-mode-toggle').click();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  await holdJoystick(page, 'backward');
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const bwdCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(bwdCmd).toMatchObject({ linearX: -0.3, angularZ: 0 });

  // 2. Quay trái: angularZ > 0, linearX === 0
  await page.getByTestId('manual-mode-toggle').click();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  await holdJoystick(page, 'left');
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const leftCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(leftCmd).toMatchObject({ linearX: 0, angularZ: 0.3 });

  // 3. Quay phải: angularZ < 0, linearX === 0
  await page.getByTestId('manual-mode-toggle').click();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  await holdJoystick(page, 'right');
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const rightCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(rightCmd).toMatchObject({ linearX: 0, angularZ: -0.3 });

  // 4. Camera sau do người dùng chọn; joystick tiến vẫn theo thân robot.
  await page.getByTestId('navigation-camera-select-rear').click();
  await expect(page.getByTestId('navigation-camera-health')).toContainText('Đang phát');
  await page.getByTestId('manual-mode-toggle').click();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  await holdJoystick(page, 'forward');
  try {
    await page.waitForFunction(() => window.testCalls.velocity.length > 0, null, { timeout: 5_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(async () => {
      const { useControlStore } = await import('/src/state/controlStore.js');
      const { useRobotStore } = await import('/src/stores/robotStore.js');
      const control = useControlStore.getState();
      const robot = useRobotStore.getState();
      return {
        control: { phase: control.phase, ready: control.ready,
          hasLease: Boolean(control.lease), stopUnconfirmed: control.stopUnconfirmed,
          controlError: control.controlError, generation: control.controlGeneration,
          cameraId: control.cameraId, selectedCameraId: control.selectedCameraId,
          lastFrameAt: control.lastFrameAt, heartbeatReceivedAt: control.heartbeatReceivedAt },
        robot: { mode: robot.snapshot?.mode, activeMappingSessionId: robot.snapshot?.activeMappingSessionId,
          rosConnected: robot.snapshot?.rosConnected, motionInhibited: robot.snapshot?.motionInhibited },
        calls: {
          acquireCount: window.testCalls.acquire.length,
          stopCount: window.testCalls.stop.length,
          releaseCount: window.testCalls.release.length,
          velocityCount: window.testCalls.velocity.length,
          lastVector: window.testCalls.velocity.at(-1)
            ? { linearX: window.testCalls.velocity.at(-1).linearX,
              angularZ: window.testCalls.velocity.at(-1).angularZ }
            : null,
        },
      };
    });
    throw new Error(`NO_FORWARD_AFTER_CAMERA_SWITCH ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const fwdRearCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(fwdRearCmd).toMatchObject({ linearX: 0.3, angularZ: 0 });
});

test('MJ-B01: Mapping dừng có bằng chứng trước khi lưu; camera không mở lại trong vòng đời phiên', async ({ page }) => {
  await openNavigation(page);
  await spa(page, '/mapping');
  await expect(page.getByTestId('navigation-camera-health')).toContainText('Live');
  await expect(page.getByTestId('navigation-joystick')).toHaveCount(0);
  await expect(page.getByTestId('mapping-joystick')).toHaveCount(0);
  await expect(page.getByTestId('camera-gesture-status')).toHaveCount(0);
  await page.evaluate(() => {
    window.mappingVideo = document.querySelector('[data-testid="camera-video-front"]');
    window.mappingDescriptorCount = window.testCalls.camera.length;
  });
  await page.getByLabel('Tên bản đồ', { exact: true }).fill('Browser mapping save gate');
  await page.getByTestId('mapping-start-button').click();
  await expect(page.getByText('Đang quét SLAM (Live)')).toBeVisible();
  await expect(page.getByTestId('map2d-raster')).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('video') === window.mappingVideo)).toBe(true);

  // Freeze nguồn đo, không mock response thành confirmed. UI phải giữ Finish
  // chưa được gọi dù requestStop đã accepted và command mục tiêu đã là zero.
  await page.evaluate(() => window.testClient._motionSource.setFrozen(true));
  await page.getByTestId('mapping-finish-button').click();
  await expect.poll(() => page.evaluate(() => window.testCalls.stop.length)).toBeGreaterThan(0);
  await expect(page.getByTestId('mapping-finish-button')).toBeDisabled();
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.testCalls.finish.length)).toBe(0);
  expect(await page.evaluate(async () => (await window.testClient.getControlState()).payload.stop.status))
    .toBe('unconfirmed');

  await page.evaluate(() => {
    window.testClient._motionSource.setFrozen(false);
    window.testClient._motionSource.sample();
  });
  await expect.poll(() => page.evaluate(async () => {
    const { useMappingWorkflowStore } = await import('/src/state/mappingWorkflowStore.js');
    return useMappingWorkflowStore.getState().viewerContext?.kind;
  })).toBe('saved');
  await expect(page.getByTestId('map2d-raster')).toBeVisible();
  const result = await page.evaluate(async () => ({
    saved: (await window.testClient.listMaps()).filter(item => item.name === 'Browser mapping save gate'),
    finishCalls: window.testCalls.finish.length,
    cameraCalls: window.testCalls.camera.length,
    initialCameraCalls: window.mappingDescriptorCount,
    sameVideo: document.querySelector('video') === window.mappingVideo,
    stop: (await window.testClient.getControlState()).payload.stop,
  }));
  expect(result.saved).toHaveLength(1);
  expect(result.finishCalls).toBe(1);
  expect(result.cameraCalls).toBe(result.initialCameraCalls);
  expect(result.sameVideo).toBe(true);
  expect(result.stop.status).toBe('confirmed');
  expect(result.stop.confirmation.evidenceKind).toBe('mock-source-observation');
  await expect(page.getByTestId('navigation-camera-health')).toContainText('Live');
});

test('C8-04: pointercancel + lostcapture stop', async ({ page }) => {
  await openNavigation(page);
  await page.getByTestId('manual-mode-toggle').click();
  const stick = joystick(page);

  // Test 1: pointercancel ngừng publisher
  await holdJoystick(page, 'forward');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  await stick.dispatchEvent('pointercancel', { pointerId: 1 });
  await confirmedAndQuiet(page); // Prove cancellation works BEFORE normal mouse release.
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const vel1 = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel1.linearX).toBe(0);

  // Test 2: lostpointercapture ngừng publisher
  await page.getByTestId('manual-mode-toggle').click();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  await holdJoystick(page, 'forward');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  await stick.dispatchEvent('lostpointercapture', { pointerId: 1 });
  await confirmedAndQuiet(page);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const vel2 = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel2.linearX).toBe(0);
});

test('C8-05: hai pointer trên joystick: chỉ một publisher duy nhất', async ({ page }) => {
  await openNavigation(page);
  await page.getByTestId('manual-mode-toggle').click();

  // Pointer 1 hold fwd
  await holdJoystick(page, 'forward');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));
  const count = await page.evaluate(() => window.testCalls.velocity.length);
  const stops = await page.evaluate(() => window.testCalls.stop.length);

  // Pointer thứ hai ở phía dưới joystick không được giành publisher.
  await joystick(page).evaluate(element => {
    const rect = element.getBoundingClientRect();
    const fields = { bubbles: true, pointerId: 2, button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height * 0.82 };
    element.dispatchEvent(new PointerEvent('pointerdown', { ...fields, isPrimary: false }));
    element.dispatchEvent(new PointerEvent('pointerup', { ...fields, isPrimary: false }));
  });
  await expect.poll(() => page.evaluate(() => window.testCalls.velocity.length)).toBeGreaterThan(count + 2);
  expect(await page.evaluate(() => window.testCalls.stop.length)).toBe(stops);
  const commands = await page.evaluate(() => window.testCalls.velocity);
  expect(commands.every(v => v.linearX === 0.3 && v.angularZ === 0)).toBe(true);
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
  await openNavigation(page);
  await page.getByTestId('manual-mode-toggle').click();
  await expectJoystickEnabled(page, true);

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
  await openNavigation(page);
  await page.getByTestId('manual-mode-toggle').click();
  await expectJoystickEnabled(page, true);

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
  await openNavigation(page);
  await page.getByTestId('manual-mode-toggle').click();
  await expectJoystickEnabled(page, true);

  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // SPA unmount Navigation sang Mapping (không reload trang)
  const stopsBefore = await page.evaluate(() => window.testCalls.stop.length);
  await page.evaluate(() => {
    history.pushState(null, '', '/mapping');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForURL('**/mapping');
  await page.keyboard.up('ArrowUp');

  const stopsAfter = await page.evaluate(() => window.testCalls.stop.length);
  expect(stopsAfter).toBeGreaterThan(stopsBefore);

  // Quay lại Navigation: lease không tự phục hồi.
  await page.evaluate(() => {
    history.pushState(null, '', '/navigation');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForURL('**/navigation');

  // Phải không tự động cấp quyền lại, joystick bị khóa.
  await expect(page.getByTestId('manual-mode-toggle')).toBeEnabled();
  await expectJoystickEnabled(page, false);
});

test('C8-09: switch camera khi đang giữ: stop ngay, freshness reset', async ({ page }) => {
  await openNavigation(page);
  await page.getByTestId('manual-mode-toggle').click();
  await expectJoystickEnabled(page, true);

  // Giữ phím tiến
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // Chuyển camera sang Sau khi đang giữ lái
  await page.getByTestId('navigation-camera-select-rear').click();
  await confirmedAndQuiet(page);
  await page.keyboard.up('ArrowUp');

  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  await expect(page.getByTestId('camera-video-rear')).toBeVisible();
  const vel = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel.linearX).toBe(0);
});

test('C8-10: camera health hiển thị đúng theo trạng thái', async ({ page }) => {
  await openNavigation(page);
  const health = page.getByTestId('navigation-camera-health');
  await expect(health).toContainText('Đang phát');

  // Dừng video stream để health không còn được coi là fresh.
  await page.evaluate(() => document.querySelector('video')?.pause());
  await page.waitForTimeout(2000);
  await expect(health).toHaveText('Chờ hình');

  // Khởi động lại video
  await page.evaluate(() => document.querySelector('video')?.play());
  await expect(health).toContainText('Đang phát');
});

test('C8-11: heartbeat/control transport mất: ngừng publisher', async ({ page }) => {
  await openNavigation(page);
  await page.getByTestId('manual-mode-toggle').click();
  await expectJoystickEnabled(page, true);

  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // Cắt transport sang offline
  await page.evaluate(() => window.testClient.setDemoScenario('offline'));
  await expectJoystickEnabled(page, false);
  await expect.poll(() => page.evaluate(() => window.testClient._motionSource.getCommand().velocity))
    .toEqual({ linearX: 0, angularZ: 0 });
  const commandCount = await page.evaluate(() => window.testCalls.velocity.length);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.testCalls.velocity.length)).toBe(commandCount);
  await page.keyboard.up('ArrowUp');

  // Publisher phải ngừng ngay, joystick bị khóa.
  await expectJoystickEnabled(page, false);
  const vel = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel.linearX).toBe(0);

  // Phục hồi lại online
  await page.evaluate(() => window.testClient.setDemoScenario('online'));
});

test('C8-12: service revoke khóa joystick và loop không tiếp tục', async ({ page }) => {
  await openNavigation(page);
  await page.getByTestId('manual-mode-toggle').click();
  await expectJoystickEnabled(page, true);

  // Thu hồi quyền bằng manual stop
  await page.getByTestId('manual-stop').click();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');

  // Joystick phải bị khóa ngay lập tức.
  await expectJoystickEnabled(page, false);
  const vel = await page.evaluate(() => window.testClient._sharedRobotState.getSnapshot().velocity);
  expect(vel.linearX).toBe(0);
});

test('C8-13: manual stop lúc navigation đang thực thi: mission canceling -> terminal hợp lệ', async ({ page }) => {
  // Không start mapping: mission và mapping phải loại trừ nhau.
  await openNavigation(page);

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

  // Bấm Yêu cầu dừng trên Navigation khi mission đang giữ robot.
  await page.getByTestId('manual-stop').click();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');

  // Xác nhận mission đã chuyển sang canceled và vận tốc về 0
  const mission = await page.evaluate(async (id) => await window.testClient.getMission(id), missionId);
  expect(mission.status).toBe('canceled');
  const vel = await page.evaluate(() => window.testClient._motionSource.latest()?.velocity?.linearX);
  expect(vel).toBe(0);
});

test('C8-14: E-stop/inhibit không acquire; đủ reasons đúng', async ({ page }) => {
  await openNavigation(page);
  const acquireBtn = page.getByTestId('manual-mode-toggle');
  await expect(acquireBtn).toBeEnabled();

  // Kích hoạt E-stop vật lý
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: true }));
  await expect(acquireBtn).toBeDisabled();

  // Hủy E-stop vật lý -> acquire button mở lại
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: false }));
  await expect(acquireBtn).toBeEnabled();
});

test('C8-15: logout lúc holding: dọn dẹp phiên an toàn', async ({ page }) => {
  await openNavigation(page);
  await page.getByTestId('manual-mode-toggle').click();
  await expectJoystickEnabled(page, true);

  // Giữ lái
  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // Nhấn Đăng xuất thật (nút nằm trên header)
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await page.keyboard.up('ArrowUp');

  // Điều hướng về /login và session bị xóa
  await page.waitForURL('**/login');
  const user = await page.evaluate(() => localStorage.getItem('mock_robot_client_user'));
  expect(user).toBeNull();
});

test('C8-16: manual stop retry và observation confirmation', async ({ page }) => {
  await openNavigation(page);
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
  await expect(page.getByTestId('manual-mode-toggle')).toBeDisabled();
  await spa(page, '/mapping');
  await spa(page, '/navigation');
  await expect(page.getByTestId('retry-stop')).toBeVisible();
  await page.getByTestId('retry-stop').click();
  const attempts = await page.evaluate(() => window.stopAttempts);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]);

  // UI hiển thị confirmation và profile mock vẫn được giữ trong store.
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận robot dừng');
  expect(await page.evaluate(async () => (await import('/src/state/controlStore.js'))
    .useControlStore.getState().controlProfile)).toBe('mock');
  const stopState = await page.evaluate(() => window.testClient.getControlState());
  expect(stopState.payload.stop?.status).toBe('confirmed');
  expect(stopState.payload.stop?.confirmation).toBeDefined();
  expect(stopState.payload.stop?.confirmation.evidenceKind).toBe('mock-source-observation');
});

test('U8-07: descriptor mặc định có nhãn và profile mock; video decode hợp lệ', async ({ page }) => {
  await openNavigation(page);
  await expect(page.getByTestId('navigation-camera-select-front')).toHaveText('Cam trước');
  await expect(page.getByTestId('navigation-camera-select-rear')).toHaveText('Cam sau');

  expect(await page.evaluate(async () => (await import('/src/state/controlStore.js'))
    .useControlStore.getState().controlProfile)).toBe('mock');

  // Video front decode thành công
  await expect(page.getByTestId('camera-video-front')).toBeVisible();
});

for (const exit of ['route', 'logout']) {
  test(`C8-H-${exit}: late acquire after ${exit} never enables a remounted page`, async ({ page }) => {
    await openNavigation(page);
    await expect(page.getByTestId('manual-mode-toggle')).toBeEnabled();
    await page.evaluate(() => {
      const original = window.testClient.acquireControl.bind(window.testClient);
      window.testClient.acquireControl = async req => {
        const lease = await original(req);
        window.pendingLease = lease;
        return new Promise(resolve => { window.finishAcquire = () => resolve(lease); });
      };
    });
    await page.getByTestId('manual-mode-toggle').click();
    await page.waitForFunction(() => Boolean(window.finishAcquire));
    await expectJoystickEnabled(page, false);
    if (exit === 'route') {
      await spa(page, '/mapping');
      await spa(page, '/navigation');
    } else {
      await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
      await page.waitForURL('**/login');
    }
    await page.evaluate(() => window.finishAcquire());
    await expect.poll(() => page.evaluate(() => window.testCalls.release.some(r => r.leaseId === window.pendingLease.leaseId)))
      .toBe(true);
    expect(await page.evaluate(() => window.testCalls.velocity.length)).toBe(0);
    if (exit === 'route') {
      await expect(page.getByTestId('manual-mode-toggle')).toBeEnabled();
      await expectJoystickEnabled(page, false);
      expect((await page.evaluate(() => window.testClient.getControlState())).payload.ownership).toBe('none');
    } else {
      expect(await page.evaluate(() => localStorage.getItem('mock_robot_client_user'))).toBeNull();
    }
  });
}

test('U8-08: thu hồi quyền/unknown E-stop không mở lái dù camera fresh', async ({ page }) => {
  await openNavigation(page);

  // 1. Chưa acquire: joystick disabled dù camera fresh.
  await expectJoystickEnabled(page, false);

  // 2. Unknown E-stop: fail closed, khóa acquire và joystick.
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: null }));
  await expect(page.getByTestId('manual-mode-toggle')).toBeDisabled();
  await expectJoystickEnabled(page, false);

  // 3. Khôi phục physicalEstopActive = false -> mở lại nút acquire
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: false }));
  await expect(page.getByTestId('manual-mode-toggle')).toBeEnabled();
});

test('NAV-MANUAL-TOGGLE: bật không tự chạy; tắt khi đang lái dừng và nhả lease', async ({ page }) => {
  await openNavigation(page);
  const toggle = page.getByTestId('manual-mode-toggle');
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expectJoystickEnabled(page, true);
  expect(await page.evaluate(() => window.testCalls.acquire[0].context)).toEqual({ kind: 'manual' });
  expect(await page.evaluate(() => window.testCalls.velocity.length)).toBe(0);
  await page.keyboard.down('KeyW');
  await expect.poll(() => page.evaluate(() => window.testCalls.velocity.some(v => v.linearX === 0.3 && v.angularZ === 0))).toBe(true);
  await toggle.click();
  await page.keyboard.up('KeyW');
  await confirmedAndQuiet(page);
  await expect(toggle).not.toBeChecked();
  await expectJoystickEnabled(page, false);
  expect((await page.evaluate(() => window.testClient.getControlState())).payload.ownership).toBe('none');
});

test('NAV-MANUAL-PENDING: tắt khi acquire pending không cho response muộn bật lại', async ({ page }) => {
  await openNavigation(page);
  await page.evaluate(() => {
    const original = window.testClient.acquireControl.bind(window.testClient);
    window.testClient.acquireControl = async req => {
      const lease = await original(req);
      window.pendingLease = lease;
      return new Promise(resolve => { window.finishAcquire = () => resolve(lease); });
    };
  });
  const toggle = page.getByTestId('manual-mode-toggle');
  await toggle.click();
  await page.waitForFunction(() => Boolean(window.finishAcquire));
  await expect(toggle).toBeChecked();
  await toggle.click();
  await page.evaluate(() => window.finishAcquire());
  await expect.poll(() => page.evaluate(() => window.testCalls.release.some(r => r.leaseId === window.pendingLease.leaseId))).toBe(true);
  await expect(toggle).not.toBeChecked();
  await expectJoystickEnabled(page, false);
  expect(await page.evaluate(() => window.testCalls.velocity.length)).toBe(0);
});

test('NAV-MANUAL-MAPPING: Navigation không xin manual khi phiên mapping còn active', async ({ page }) => {
  await openNavigation(page);
  await spa(page, '/mapping');
  await page.getByLabel('Tên bản đồ', { exact: true }).fill('Mapping blocks manual');
  await page.getByTestId('mapping-start-button').click();
  await expect(page.getByText('Đang quét SLAM (Live)')).toBeVisible();
  await spa(page, '/navigation');
  await expect(page.getByTestId('navigation-camera-health')).toHaveText('Đang phát');
  await expect(page.getByTestId('manual-mode-toggle')).toBeDisabled();
  await expectJoystickEnabled(page, false);
  expect(await page.evaluate(() => window.testCalls.acquire.length)).toBe(0);
  await page.keyboard.press('KeyW');
  expect(await page.evaluate(() => window.testCalls.velocity.length)).toBe(0);
});
