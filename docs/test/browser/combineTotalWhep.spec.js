import { test, expect } from '@playwright/test';

async function installMovingWhep(page) {
  const requests = { post: 0, delete: 0 };
  await page.route('**/ui-test-camera/**', async route => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      requests.delete++;
      await route.fulfill({ status: 200 });
      return;
    }
    expect(request.method()).toBe('POST');
    requests.post++;
    const answer = await page.evaluate(async offer => {
      const peer = new RTCPeerConnection({ iceServers: [] });
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const ctx = canvas.getContext('2d');
      let frame = 0;
      const draw = () => {
        ctx.fillStyle = frame++ % 2 ? '#194f83' : '#42c765';
        ctx.fillRect(0, 0, 320, 180);
      };
      draw();
      const timer = setInterval(draw, 66);
      const stream = canvas.captureStream(15);
      for (const track of stream.getTracks()) peer.addTrack(track, stream);
      window.testMediaPeers.push({ peer, stream, timer });
      await peer.setRemoteDescription({ type: 'offer', sdp: offer });
      await peer.setLocalDescription(await peer.createAnswer());
      if (peer.iceGatheringState !== 'complete') {
        await new Promise(resolve => {
          const ready = () => {
            if (peer.iceGatheringState === 'complete') {
              peer.removeEventListener('icegatheringstatechange', ready);
              resolve();
            }
          };
          peer.addEventListener('icegatheringstatechange', ready);
          ready();
        });
      }
      return peer.localDescription.sdp;
    }, request.postData());
    await route.fulfill({
      status: 201,
      headers: { 'Content-Type': 'application/sdp', Location: `${new URL(request.url()).pathname}/session` },
      body: answer,
    });
  });
  return requests;
}

test('combine-total: Mapping session and Navigation map changes keep moving WHEP video', async ({ page }) => {
  const requests = await installMovingWhep(page);
  await page.goto('/mapping');
  await expect(page).toHaveURL(/\/login$/);
  await page.evaluate(async () => {
    const { robotClient } = await import('/src/clients/index.js');
    window.testMediaPeers = [];
    robotClient.getCameraStream = async ({ cameraId }) => ({
      kind: 'webrtc', cameraId,
      whepUrl: `${location.origin}/ui-test-camera/${cameraId}/whep`,
      grantToken: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  });
  await page.locator('#login-username').fill('admin');
  await page.locator('#login-password').fill('demo-only');
  await page.locator('#login-submit-btn').click();
  await expect(page).toHaveURL(/\/mapping$/);
  const front = page.getByTestId('camera-video-front');
  await expect(page.getByTestId('navigation-camera-health')).toHaveText('Live');
  await expect.poll(() => front.evaluate(v => v.videoWidth)).toBe(320);
  await page.evaluate(() => {
    window.mappingVideo = document.querySelector('[data-testid="camera-video-front"]');
    window.mappingStream = window.mappingVideo.srcObject;
  });
  expect(requests).toEqual({ post: 1, delete: 0 });

  await page.getByLabel('Tên bản đồ', { exact: true }).fill('WHEP mapping session');
  await page.getByTestId('mapping-start-button').click();
  await expect(page.getByText('Đang quét SLAM (Live)')).toBeVisible();
  // Chính trạng thái đang mapping từng làm nhánh cũ hiện joystick trở lại.
  await expect(page.getByTestId('mapping-joystick')).toHaveCount(0);
  await expect(page.getByTestId('navigation-joystick')).toHaveCount(0);
  await expect(page.getByTestId('acquire-control')).toHaveCount(0);
  await page.getByTestId('mapping-finish-button').click();
  await expect(page.getByText('Bản đồ đã lưu', { exact: true })).toBeVisible();
  await expect(page.getByTestId('mapping-joystick')).toHaveCount(0);
  expect(await front.evaluate(v => v === window.mappingVideo && v.srcObject === window.mappingStream)).toBe(true);
  expect(requests).toEqual({ post: 1, delete: 0 });
  expect(await front.evaluate(async v => {
    const frame = () => new Promise(resolve => v.requestVideoFrameCallback((_, m) => resolve(m.presentedFrames)));
    return (await frame()) < (await frame());
  })).toBe(true);

  await page.getByTestId('navigation-camera-select-rear').click();
  await expect(page.getByTestId('navigation-camera-health')).toHaveText('Live');
  await expect.poll(() => requests.delete).toBe(1);
  expect(requests.post).toBe(2);
  expect(await page.evaluate(() => window.mappingStream.getTracks().every(t => t.readyState === 'ended'))).toBe(true);

  await page.getByRole('tab', { name: 'Đi đến đích & trạng thái' }).click();
  await expect(page.getByTestId('navigation-camera-health')).toHaveText('Đang phát');
  await expect.poll(() => requests.delete).toBe(2);
  expect(requests.post).toBe(3);
  await page.evaluate(() => {
    window.navigationVideo = document.querySelector('[data-testid="camera-video-front"]');
    window.navigationStream = window.navigationVideo.srcObject;
  });
  await page.locator('#map-selector-select').click();
  await page.getByRole('option', { name: /Bản đồ xoay/ }).click();
  await expect(page.getByTestId('map2d-raster')).toBeVisible();
  expect(await page.evaluate(() => {
    const video = document.querySelector('[data-testid="camera-video-front"]');
    return video === window.navigationVideo && video.srcObject === window.navigationStream;
  })).toBe(true);
  expect(requests).toEqual({ post: 3, delete: 2 });
  await page.evaluate(async () => {
    const { useRobotStore } = await import('/src/stores/robotStore.js');
    const snapshot = useRobotStore.getState().snapshot;
    for (const batteryPercent of [77, 76, 75]) {
      useRobotStore.getState().accept({ ...snapshot, batteryPercent });
    }
  });
  expect(await page.evaluate(() => {
    const video = document.querySelector('[data-testid="camera-video-front"]');
    return video === window.navigationVideo && video.srcObject === window.navigationStream;
  })).toBe(true);
  expect(requests).toEqual({ post: 3, delete: 2 });
  expect(await page.getByTestId('camera-video-front').evaluate(async video => {
    const frame = () => new Promise(resolve => video.requestVideoFrameCallback((_, metadata) => resolve(metadata.presentedFrames)));
    return (await frame()) < (await frame());
  })).toBe(true);
  await page.getByRole('tab', { name: 'Tạo bản đồ', exact: true }).click();
  await expect(page.getByTestId('navigation-camera-health')).toHaveText('Live');
  await expect.poll(() => requests.delete).toBe(3);
  expect(requests.post).toBe(4);
  expect(await page.evaluate(() => window.navigationStream.getTracks().every(t => t.readyState === 'ended'))).toBe(true);
  await page.evaluate(() => {
    for (const { peer, stream, timer } of window.testMediaPeers) {
      clearInterval(timer);
      for (const track of stream.getTracks()) track.stop();
      peer.close();
    }
  });
});
