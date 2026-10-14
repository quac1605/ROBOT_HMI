import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionLifecycle } from '../src/auth/sessionLifecycle.js';
import { createCameraService } from '../src/services/cameraService.js';

test('ROS camera grant is camera-bound, expires and is revoked with the session', () => {
  let current = 100_000;
  const lifecycle = createSessionLifecycle({ now: () => current });
  const service = createCameraService({
    mode: 'ros', whepBaseUrl: 'https://127.0.0.1:8889', lifecycle,
    now: () => current,
  });
  const front = service.getCameraStream('front', 'session-a');
  assert.equal(front.kind, 'webrtc');
  assert.equal(front.whepUrl, 'https://127.0.0.1:8889/front/whep');
  const auth = { action: 'read', protocol: 'webrtc', path: 'front', token: front.grantToken };
  assert.equal(service.authorizeMediaRequest(auth), true);
  assert.equal(service.authorizeMediaRequest({ ...auth, path: 'rear' }), false);
  assert.equal(service.authorizeMediaRequest({ ...auth, action: 'publish' }), false);
  assert.equal(service.authorizeMediaRequest({ ...auth, token: '0'.repeat(64) }), false);
  lifecycle.invalidate('session-a');
  assert.equal(service.authorizeMediaRequest(auth), false);
  const rear = service.getCameraStream('rear', 'session-b');
  current += 60_000;
  assert.equal(service.authorizeMediaRequest({ ...auth, path: 'rear', token: rear.grantToken }), false);
  const expiring = service.getCameraStream('front', 'session-c', current + 500);
  assert.equal(new Date(expiring.expiresAt).getTime(), current + 500);
  current += 500;
  assert.equal(service.authorizeMediaRequest({ ...auth, token: expiring.grantToken }), false);
  service.dispose();
});

test('camera mock descriptor stays available without media server', () => {
  const service = createCameraService();
  assert.deepEqual(service.getCameraStream('front'), {
    kind: 'file', cameraId: 'front', url: '/demo/front.mp4',
  });
  assert.equal(service.authorizeMediaRequest({ action: 'read' }), false);
  service.dispose();
});
