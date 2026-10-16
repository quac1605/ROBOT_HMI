import { test, expect } from '@playwright/test';

// Server WHEP giả cho test, dùng HAI RTCPeerConnection thật và Canvas video
// chuyển động. Không liên hệ MediaMTX/ROS/camera đang chạy hoặc cấp grant thật.
test('UI-WHEP: gesture rerenders giữ video/peer; chuyển camera đóng đúng phiên cũ', async ({ page }) => {
  const requests = { post: 0, delete: 0 };
  await page.route('**/ui-test-camera/**', async route => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      requests.delete++;
      await route.fulfill({ status: 200 });
      return;
    }
    expect(request.method()).toBe('POST');
    expect(request.headers().authorization).toBe(`Bearer ${'a'.repeat(64)}`);
    requests.post++;
    const answer = await page.evaluate(async offer => {
      const peer = new RTCPeerConnection({ iceServers: [] });
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d');
      let counter = 0;
      const draw = () => {
        ctx.fillStyle = counter++ % 2 ? '#194f83' : '#42c765';
        ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = '#fff'; ctx.fillText(String(counter), 30, 30);
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
              peer.removeEventListener('icegatheringstatechange', ready); resolve();
            }
          };
          peer.addEventListener('icegatheringstatechange', ready);
          ready();
        });
      }
      return peer.localDescription.sdp;
    }, request.postData());
    await route.fulfill({ status: 201, headers: {
      'Content-Type': 'application/sdp', Location: `${new URL(request.url()).pathname}/session`,
    }, body: answer });
  });
  await page.goto('/login');
  await page.evaluate(async () => {
    const { mountCameraLifecycleHarness } = await import('/tooling/cameraLifecycleHarness.mjs');
    const { robotClient } = await import('/src/clients/index.js');
    window.testMediaPeers = [];
    window.descriptorCalls = 0;
    robotClient.getCameraStream = async ({ cameraId }) => {
      window.descriptorCalls++;
      return { kind: 'webrtc', cameraId, whepUrl: `${location.origin}/ui-test-camera/${cameraId}/whep`,
        grantToken: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() };
    };
    const host = document.createElement('div');
    host.style.width = '520px'; document.body.prepend(host);
    window.cameraTestRoot = mountCameraLifecycleHarness(host);
  });
  const video = page.getByTestId('camera-video-front');
  await expect(page.getByTestId('navigation-camera-health')).toHaveText('Đang phát');
  await expect.poll(() => video.evaluate(v => v.videoWidth)).toBe(320);
  await page.evaluate(() => {
    window.originalCameraVideo = document.querySelector('[data-testid="camera-video-front"]');
    window.originalCameraStream = window.originalCameraVideo.srcObject;
  });
  for (let i = 0; i < 4; i++) await page.getByTestId('test-gesture-update').click();
  const retained = await video.evaluate(async v => {
    const frame = () => new Promise(resolve => v.requestVideoFrameCallback((_, m) => resolve(m.presentedFrames)));
    const first = await frame(), second = await frame();
    return { sameNode: v === window.originalCameraVideo, sameStream: v.srcObject === window.originalCameraStream,
      liveTracks: v.srcObject.getTracks().every(t => t.readyState === 'live'),
      framesAdvance: second > first, descriptors: window.descriptorCalls };
  });
  expect(retained).toEqual({ sameNode: true, sameStream: true, liveTracks: true, framesAdvance: true, descriptors: 1 });
  expect(requests).toEqual({ post: 1, delete: 0 });
  await page.getByTestId('navigation-camera-select-rear').click();
  await expect(page.getByTestId('camera-video-rear')).toBeVisible();
  await expect(page.getByTestId('navigation-camera-health')).toHaveText('Đang phát');
  await expect.poll(() => requests.delete).toBe(1);
  expect(requests.post).toBe(2);
  expect(await page.evaluate(() => window.originalCameraStream.getTracks().every(t => t.readyState === 'ended'))).toBe(true);
  await page.evaluate(() => window.cameraTestRoot.unmount());
  await expect.poll(() => requests.delete).toBe(2);
  await page.evaluate(() => {
    for (const {peer, stream, timer} of window.testMediaPeers) {
      clearInterval(timer); for (const track of stream.getTracks()) track.stop(); peer.close();
    }
  });
});
