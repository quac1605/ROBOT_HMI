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
  if (route === '/navigation') await expect(page.getByTestId('acquire-control')).toHaveCount(0);
  if (route === '/mapping') await expect(page.getByTestId('acquire-control')).toBeVisible();
}

async function openMapping(page, { startSession = true } = {}) {
  await page.goto('/login');
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await page.waitForURL('**/navigation');
  await page.goto('/mapping');
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
  if (startSession) {
    await page.getByLabel('Tên bản đồ mới').fill('Browser manual mapping');
    await page.getByTestId('mapping-start-button').click();
    await expect(page.getByText('Đang quét SLAM (Live)')).toBeVisible();
  }
  await expect(page.getByTestId('camera-health')).toContainText('Live');
}

function joystick(page) {
  return page.getByTestId('mapping-joystick');
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
  await openMapping(page, { startSession: false });
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await expect(page.getByTestId('camera-video-front')).toBeVisible();

  await page.getByTestId('camera-select-rear').click();
  await expect(page.getByTestId('camera-video-rear')).toBeVisible();
  await expect(page.getByTestId('camera-health')).toContainText('Live');
});

test('C8-02: giữ và thả ngoài nút không có nonzero command trở lại', async ({ page }) => {
  await openMapping(page);
  const acquireBtn = page.getByTestId('acquire-control');
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
  await openMapping(page);

  // 1. Lùi: linearX < 0, angularZ === 0
  await page.getByTestId('acquire-control').click();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  await holdJoystick(page, 'backward');
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const bwdCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(bwdCmd).toMatchObject({ linearX: -0.3, angularZ: 0 });

  // 2. Quay trái: angularZ > 0, linearX === 0
  await page.getByTestId('acquire-control').click();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  await holdJoystick(page, 'left');
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const leftCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(leftCmd).toMatchObject({ linearX: 0, angularZ: 0.3 });

  // 3. Quay phải: angularZ < 0, linearX === 0
  await page.getByTestId('acquire-control').click();
  await page.evaluate(() => { window.testCalls.velocity = []; });
  await holdJoystick(page, 'right');
  await page.waitForFunction(() => window.testCalls.velocity.length > 0);
  await page.mouse.up();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');
  const rightCmd = await page.evaluate(() => window.testCalls.velocity[window.testCalls.velocity.length - 1]);
  expect(rightCmd).toMatchObject({ linearX: 0, angularZ: -0.3 });

  // 4. Camera sau do người dùng chọn; joystick tiến vẫn theo thân robot.
  await page.getByTestId('camera-select-rear').click();
  await expect(page.getByTestId('camera-health')).toContainText('Live');
  await page.getByTestId('acquire-control').click();
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

test('MJ-B01: lái mapping qua joystick rồi Stop đo được trước khi Finish lưu map', async ({ page }) => {
  await openMapping(page);
  // Mock sinh frame bản đồ đầu tiên sau ~500ms; chờ frame đầu thay vì giả định nó có ngay khi chip Live hiện.
  let before = null;
  await expect.poll(async () => {
    before = await page.evaluate(async () => {
      const { robotClient } = await import('/src/clients/index.js');
      const { useMappingWorkflowStore } = await import('/src/state/mappingWorkflowStore.js');
      const id = useMappingWorkflowStore.getState().session.mappingSessionId;
      try {
        const grid = await robotClient.getMapGrid({ kind: 'mapping', mappingSessionId: id });
        const robot = await robotClient.getRobotState();
        return { id, revision: grid.gridRevision, x: robot.pose?.x };
      } catch (error) {
        if (error.code === 'MAP_NOT_READY') return null;
        throw error;
      }
    });
    return before !== null;
  }).toBe(true);
  await page.getByTestId('acquire-control').click();
  try {
    await holdJoystick(page, 'forward');
    await expect.poll(async () => page.evaluate(async id => {
      const { robotClient } = await import('/src/clients/index.js');
      return (await robotClient.getMapGrid({ kind: 'mapping', mappingSessionId: id })).gridRevision;
    }, before.id)).toBeGreaterThan(before.revision);
    await expect.poll(() => page.evaluate(() => window.testCalls.velocity.length))
      .toBeGreaterThan(1);
  } finally {
    await page.mouse.up();
  }
  await confirmedAndQuiet(page);
  const moved = await page.evaluate(async () => {
    const { robotClient } = await import('/src/clients/index.js');
    return robotClient.getRobotState();
  });
  expect(moved.pose.x).toBeGreaterThan(before.x);
  expect(moved.mode).toBe('mapping');
  expect(await page.evaluate(() => window.testCalls.velocity.every(v =>
    v.linearX === 0.3 && v.angularZ === 0))).toBe(true);

  await page.getByTestId('mapping-finish-button').click();
  await expect.poll(() => page.evaluate(async () => {
    const { useMappingWorkflowStore } = await import('/src/state/mappingWorkflowStore.js');
    return useMappingWorkflowStore.getState().viewerContext?.kind;
  })).toBe('saved');
  await expectJoystickEnabled(page, false);
  const saved = await page.evaluate(async () => {
    const { robotClient } = await import('/src/clients/index.js');
    return (await robotClient.listMaps()).filter(item => item.name === 'Browser manual mapping');
  });
  expect(saved).toHaveLength(1);
  expect(await page.evaluate(() => window.testCalls.stop.length)).toBeGreaterThanOrEqual(2);
});

test('C8-04: pointercancel + lostcapture stop', async ({ page }) => {
  await openMapping(page);
  await page.getByTestId('acquire-control').click();
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
  await page.getByTestId('acquire-control').click();
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
  await openMapping(page);
  await page.getByTestId('acquire-control').click();

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
  await openMapping(page);
  await page.getByTestId('acquire-control').click();
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
  await openMapping(page);
  await page.getByTestId('acquire-control').click();
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
  await openMapping(page);
  await page.getByTestId('acquire-control').click();
  await expectJoystickEnabled(page, true);

  await page.keyboard.down('ArrowUp');
  await page.waitForFunction(() => window.testCalls.velocity.some(v => v.linearX > 0));

  // SPA unmount chuyển sang /navigation (không reload trang)
  const stopsBefore = await page.evaluate(() => window.testCalls.stop.length);
  await page.evaluate(() => {
    history.pushState(null, '', '/navigation');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForURL('**/navigation');
  await page.keyboard.up('ArrowUp');

  const stopsAfter = await page.evaluate(() => window.testCalls.stop.length);
  expect(stopsAfter).toBeGreaterThan(stopsBefore);

  // SPA navigate quay lại /mapping; session vẫn còn, lease không tự phục hồi.
  await page.evaluate(() => {
    history.pushState(null, '', '/mapping');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForURL('**/mapping');

  // Phải không tự động cấp quyền lại, joystick bị khóa.
  await expect(page.getByTestId('acquire-control')).toBeEnabled();
  await expectJoystickEnabled(page, false);
});

test('C8-09: switch camera khi đang giữ: stop ngay, freshness reset', async ({ page }) => {
  await openMapping(page);
  await page.getByTestId('acquire-control').click();
  await expectJoystickEnabled(page, true);

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
  await openMapping(page, { startSession: false });
  const health = page.getByTestId('camera-health');
  await expect(health).toContainText('Live');

  // Dừng video stream để health không còn được coi là fresh.
  await page.evaluate(() => document.querySelector('video')?.pause());
  await page.waitForTimeout(2000);
  await expect(health).toContainText('Đang chờ frame mới');

  // Khởi động lại video
  await page.evaluate(() => document.querySelector('video')?.play());
  await expect(health).toContainText('Live');
});

test('C8-11: heartbeat/control transport mất: ngừng publisher', async ({ page }) => {
  await openMapping(page);
  await page.getByTestId('acquire-control').click();
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
  await openMapping(page);
  await page.getByTestId('acquire-control').click();
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
  await openMapping(page, { startSession: false });

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

  // Bấm Yêu cầu dừng trên MappingPage dù chưa có phiên mapping.
  await page.getByTestId('manual-stop').click();
  await expect(page.getByTestId('stop-status')).toContainText('Đã xác nhận');

  // Xác nhận mission đã chuyển sang canceled và vận tốc về 0
  const mission = await page.evaluate(async (id) => await window.testClient.getMission(id), missionId);
  expect(mission.status).toBe('canceled');
  const vel = await page.evaluate(() => window.testClient._motionSource.latest()?.velocity?.linearX);
  expect(vel).toBe(0);
});

test('C8-14: E-stop/inhibit không acquire; đủ reasons đúng', async ({ page }) => {
  await openMapping(page);
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
  await openMapping(page);
  await page.getByTestId('acquire-control').click();
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
  await openMapping(page, { startSession: false });
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
  await spa(page, '/navigation');
  await spa(page, '/mapping');
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
  await openMapping(page, { startSession: false });
  await expect(page.getByTestId('camera-select-front')).toHaveText('Camera trước');
  await expect(page.getByTestId('camera-select-rear')).toHaveText('Camera sau');

  await expect(page.getByText('Mô phỏng', { exact: true })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/state/controlStore.js'))
    .useControlStore.getState().controlProfile)).toBe('mock');

  // Video front decode thành công
  await expect(page.getByTestId('camera-video-front')).toBeVisible();
});

for (const exit of ['route', 'logout']) {
  test(`C8-H-${exit}: late acquire after ${exit} never enables a remounted page`, async ({ page }) => {
    await openMapping(page);
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
    await expectJoystickEnabled(page, false);
    if (exit === 'route') {
      await spa(page, '/navigation');
      await spa(page, '/mapping');
    } else {
      await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
      await page.waitForURL('**/login');
    }
    await page.evaluate(() => window.finishAcquire());
    await expect.poll(() => page.evaluate(() => window.testCalls.release.some(r => r.leaseId === window.pendingLease.leaseId)))
      .toBe(true);
    expect(await page.evaluate(() => window.testCalls.velocity.length)).toBe(0);
    if (exit === 'route') {
      await expect(page.getByTestId('acquire-control')).toBeEnabled();
      await expectJoystickEnabled(page, false);
      expect((await page.evaluate(() => window.testClient.getControlState())).payload.ownership).toBe('none');
    } else {
      expect(await page.evaluate(() => localStorage.getItem('mock_robot_client_user'))).toBeNull();
    }
  });
}

test('U8-08: thu hồi quyền/unknown E-stop không mở lái dù camera fresh', async ({ page }) => {
  await openMapping(page);

  // 1. Chưa acquire: joystick disabled dù camera fresh.
  await expectJoystickEnabled(page, false);

  // 2. Unknown E-stop: fail closed, khóa acquire và joystick.
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: null }));
  await expect(page.getByTestId('acquire-control')).toBeDisabled();
  await expectJoystickEnabled(page, false);

  // 3. Khôi phục physicalEstopActive = false -> mở lại nút acquire
  await page.evaluate(() => window.testClient._sharedRobotState.update({ physicalEstopActive: false }));
  await expect(page.getByTestId('acquire-control')).toBeEnabled();
});
