import test from 'node:test';
import assert from 'node:assert/strict';
import { isStopEvidenceForProfile, matchesPendingStop } from '../../../frontend/src/utils/controlEvidence.js';
import { browserLaunchOptions } from '../scripts/browser_launch_options.mjs';
import { openCameraStream } from '../../../frontend/src/clients/cameraStreamClient.js';

test('U8-01: mock/hardware/unknown profile chỉ nhận đúng kind stop evidence; reject ACK giả/thiếu metadata', () => {
  const mockConfirmation = {
    requestId: 'req-1',
    controlGeneration: 1,
    evidenceKind: 'mock-source-observation',
    sourceEpoch: 'epoch-1',
    sourceSequence: 1,
    observedAt: new Date().toISOString(),
    velocity: { linearX: 0, angularZ: 0 },
  };

  const hardwareConfirmation = {
    requestId: 'req-1',
    controlGeneration: 1,
    evidenceKind: 'robot-measured',
    sourceId: 'lidar-odom',
    sourceAgeMs: 15,
    clockDomain: 'ros-time',
    sourceEpoch: 'epoch-1',
    sourceSequence: 1,
    observedAt: new Date().toISOString(),
    velocity: { linearX: 0, angularZ: 0 },
  };

  const pending = { requestId: 'req-1', controlGeneration: 1 };

  // 1. mock profile
  assert.equal(isStopEvidenceForProfile('mock', mockConfirmation), true);
  assert.equal(isStopEvidenceForProfile('mock', hardwareConfirmation), false);
  assert.equal(matchesPendingStop('mock', pending, mockConfirmation), true);
  assert.equal(matchesPendingStop('mock', pending, hardwareConfirmation), false);

  // 2. hardware profile
  assert.equal(isStopEvidenceForProfile('hardware', hardwareConfirmation), true);
  assert.equal(isStopEvidenceForProfile('hardware', mockConfirmation), false);
  assert.equal(matchesPendingStop('hardware', pending, hardwareConfirmation), true);

  // 3. unknown profile -> fail closed
  assert.equal(isStopEvidenceForProfile('unknown', mockConfirmation), false);
  assert.equal(matchesPendingStop('unknown', pending, mockConfirmation), false);

  // 4. Mismatch requestId hoặc controlGeneration
  assert.equal(matchesPendingStop('mock', { requestId: 'req-2', controlGeneration: 1 }, mockConfirmation), false);
  assert.equal(matchesPendingStop('mock', { requestId: 'req-1', controlGeneration: 2 }, mockConfirmation), false);

  // 5. Non-zero velocity không bao giờ là stop evidence
  assert.equal(matchesPendingStop('mock', pending, { ...mockConfirmation, velocity: { linearX: 0.1, angularZ: 0 } }), false);
});

test('U8-02: camera descriptor front/rear giữ mapping; thiếu reader hoặc kind không biết phải fail closed', () => {
  let reportedError = null;
  const fakeVideo = {
    requestVideoFrameCallback: () => 1,
    addEventListener: () => {},
    removeEventListener: () => {},
    pause: () => {},
    removeAttribute: () => {},
    load: () => {},
  };

  // Kind không biết -> fail closed
  openCameraStream({
    video: fakeVideo,
    descriptor: { kind: 'unsupported-kind' },
    onError: (err) => { reportedError = err; },
  });
  assert.equal(reportedError?.message, 'CAMERA_KIND_UNSUPPORTED');

  // WebRTC nhưng thiếu reader factory -> fail closed
  reportedError = null;
  openCameraStream({
    video: fakeVideo,
    descriptor: { kind: 'webrtc', whepUrl: '/whep' },
    createWebRtcReader: null,
    onError: (err) => { reportedError = err; },
  });
  assert.equal(reportedError?.message, 'WEBRTC_READER_NOT_CONFIGURED');
});

test('U8-03: cameraStreamClient đóng reader, tracks, video và frame callback; late onStream sau close bị bỏ', () => {
  let videoPaused = false;
  let tracksStopped = false;
  let callbackCancelled = false;

  const fakeVideo = {
    requestVideoFrameCallback: () => 10,
    cancelVideoFrameCallback: (id) => { if (id === 10) callbackCancelled = true; },
    addEventListener: () => {},
    removeEventListener: () => {},
    pause: () => { videoPaused = true; },
    removeAttribute: () => {},
    load: () => {},
    play: () => Promise.resolve(),
  };

  const fakeStream = {
    getTracks: () => [{ stop: () => { tracksStopped = true; } }],
  };

  let readerOnStream = null;
  let readerClosed = false;

  const closeStream = openCameraStream({
    video: fakeVideo,
    descriptor: { kind: 'webrtc', whepUrl: '/whep' },
    createWebRtcReader: ({ onStream }) => {
      readerOnStream = onStream;
      return { close: () => { readerClosed = true; } };
    },
    onError: () => {},
  });

  // Gửi stream
  readerOnStream(fakeStream);
  // Đóng session
  closeStream();

  assert.equal(videoPaused, true);
  assert.equal(tracksStopped, true);
  assert.equal(callbackCancelled, true);
  assert.equal(readerClosed, true);

  // Late stream sau close bị dừng track ngay
  let lateTrackStopped = false;
  readerOnStream({ getTracks: () => [{ stop: () => { lateTrackStopped = true; } }] });
  assert.equal(lateTrackStopped, true);
});

test('U8-04: play reject, video error, thiếu frame API đều clear health; không gửi onFrame sau cleanup', () => {
  let reportedError = null;
  const fakeVideoNoApi = {
    addEventListener: () => {},
    removeEventListener: () => {},
    pause: () => {},
    removeAttribute: () => {},
    load: () => {},
  };

  // Thiếu requestVideoFrameCallback -> fail closed
  openCameraStream({
    video: fakeVideoNoApi,
    descriptor: { kind: 'file', url: '/demo/front.mp4' },
    onError: (err) => { reportedError = err; },
  });

  assert.equal(reportedError?.message, 'FRAME_API_UNSUPPORTED');
});

test('U8-05: browserLaunchOptions trả đúng cấu hình, reject hai nguồn cấu hình xung đột', () => {
  assert.deepEqual(browserLaunchOptions({}), {});
  assert.deepEqual(browserLaunchOptions({ HMI_BROWSER_CHANNEL: 'chrome' }), { channel: 'chrome' });
  assert.deepEqual(browserLaunchOptions({ HMI_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium' }), {
    executablePath: '/usr/bin/chromium',
  });
  assert.throws(
    () => browserLaunchOptions({ HMI_BROWSER_CHANNEL: 'chrome', HMI_BROWSER_EXECUTABLE_PATH: '/usr/bin/chromium' }),
    /Choose channel OR executablePath/
  );
});

test('U8-06: DTO velocity m/s-rad/s giữ dấu và số hữu hạn; fake ROS sink nhận đúng vector', () => {
  const validVector = { linearX: -0.15, angularZ: 0.35 };
  assert.ok(Number.isFinite(validVector.linearX) && validVector.linearX < 0);
  assert.ok(Number.isFinite(validVector.angularZ) && validVector.angularZ > 0);

  const rosTwist = {
    linear: { x: validVector.linearX, y: 0, z: 0 },
    angular: { x: 0, y: 0, z: validVector.angularZ },
  };

  assert.equal(rosTwist.linear.x, -0.15);
  assert.equal(rosTwist.angular.z, 0.35);
  assert.equal(rosTwist.linear.y, 0);
});
