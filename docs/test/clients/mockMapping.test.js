import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedRobotState } from '../../../frontend/src/clients/sharedRobotState.js';
import { createMockMapGrid } from '../../../frontend/src/clients/mockMapGrid.js';
import { createMockMappingService } from '../../../frontend/src/clients/mockMapping.js';
import { createMockMapRepository } from '../../../frontend/src/clients/mockMapRepository.js';
import { JobSchema } from '../../../frontend/src/schemas/mapping.js';

function setupServices() {
  const sharedRobotState = createSharedRobotState({
    robotId: 'robot-01',
    mode: 'idle',
    activeMap: { id: 'map-demo', revision: 'rev-1' },
    activeMappingSessionId: null,
    pose: { frameId: 'map', x: 4.12, y: 1.8, yaw: 0.4 },
    poseSourceUpdateAgeMs: 0,
  });
  const mapRepository = createMockMapRepository();
  const mapGridService = createMockMapGrid({ mapRepository });
  const mappingService = createMockMappingService({ sharedRobotState, mapGridService, mapRepository });
  return { sharedRobotState, mapGridService, mappingService, mapRepository };
}

test('TC-MAP-00: Start giữ idle/pose null đến khi xác nhận và bảo toàn đúng tên phiên', async () => {
  const { mappingService, mapGridService, sharedRobotState } = setupServices();

  const response = await mappingService.startMapping({
    name: 'Kho thành phẩm',
    requestId: 'req-two-phase-start',
  });

  const acceptedSession = await mappingService.getActiveMappingSession();
  assert.equal(acceptedSession.session.name, 'Kho thành phẩm');
  assert.equal(acceptedSession.session.status, 'starting');

  const acceptedRobotState = sharedRobotState.getSnapshot();
  assert.equal(acceptedRobotState.mode, 'idle');
  assert.equal(acceptedRobotState.activeMap, null);
  assert.equal(acceptedRobotState.activeMappingSessionId, response.mappingSessionId);
  assert.equal(acceptedRobotState.pose, null);
  assert.equal(acceptedRobotState.poseSourceUpdateAgeMs, null);

  await new Promise((resolve) => setTimeout(resolve, 450));
  const confirmedSession = await mappingService.getActiveMappingSession();
  const confirmedRobotState = sharedRobotState.getSnapshot();
  assert.equal(confirmedSession.session.status, 'mapping');
  assert.equal(confirmedRobotState.mode, 'mapping');
  assert.equal(confirmedRobotState.activeMappingSessionId, response.mappingSessionId);
  // This standalone service has no telemetry source; it must not invent a pose.
  assert.equal(confirmedRobotState.pose, null);

  const finish = await mappingService.finishMapping({
    mappingSessionId: response.mappingSessionId,
    name: 'Kho thành phẩm',
    requestId: 'req-two-phase-finish',
  });
  assert.ok(finish.jobId);
  assert.equal((await mappingService.getActiveMappingSession()).session.status, 'finishing');

  mappingService.dispose();
  mapGridService.dispose();
});

test('TC-MAP-01: Idempotency kiểm soát đúng conflict trên cùng requestId', async () => {
  const { mappingService, mapGridService } = setupServices();

  const reqId = 'req-fixed-123';
  const resp1 = await mappingService.startMapping({ name: 'Map A', requestId: reqId });

  // Gọi lại cùng requestId, cùng tên -> trả response cache
  const resp2 = await mappingService.startMapping({ name: 'Map A', requestId: reqId });
  assert.equal(resp1.mappingSessionId, resp2.mappingSessionId);

  // Gọi lại cùng requestId nhưng đổi tên -> IDEMPOTENCY_CONFLICT
  await assert.rejects(async () => {
    await mappingService.startMapping({ name: 'Map B khác tên', requestId: reqId });
  }, (err) => err.code === 'IDEMPOTENCY_CONFLICT');

  mapGridService.dispose();
  mappingService.dispose();
});

test('TC-MAP-02: 20 Finish đồng thời với request ID khác nhau: chỉ 1 accepted, 19 bị FINISH_ALREADY_IN_PROGRESS', async () => {
  const { mappingService, mapGridService } = setupServices();

  const startResp = await mappingService.startMapping({ name: 'Concurrent Test', requestId: 'req-start-conc' });
  const sessionId = startResp.mappingSessionId;

  // Chờ session khởi động xong (400ms)
  await new Promise((r) => setTimeout(r, 450));

  const promises = [];
  for (let i = 0; i < 20; i += 1) {
    promises.push(
      mappingService
        .finishMapping({
          mappingSessionId: sessionId,
          name: 'Map Concurrent',
          requestId: `req-finish-${i}`,
        })
        .then(
          (res) => ({ status: 'accepted', res }),
          (err) => ({ status: 'rejected', code: err.code })
        )
    );
  }

  const results = await Promise.all(promises);
  const accepted = results.filter((r) => r.status === 'accepted');
  const rejected = results.filter((r) => r.status === 'rejected' && r.code === 'FINISH_ALREADY_IN_PROGRESS');

  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 19);

  // Chờ job lưu hoàn tất
  await new Promise((r) => setTimeout(r, 550));
  mapGridService.dispose();
  mappingService.dispose();
});

test('TC-MAP-03: SAVE_FAILED giữ nguyên session; Retry với requestId mới thành công và parse được mapId/mapRevision', async () => {
  const { mappingService, mapGridService } = setupServices();

  const startResp = await mappingService.startMapping({ name: 'Retry Map', requestId: 'req-start-retry' });
  const sessionId = startResp.mappingSessionId;
  await new Promise((r) => setTimeout(r, 450));

  // 1. Kích hoạt lỗi one-shot bằng API dev/test tường minh
  mappingService.setSimulateSaveFailureOnce(true);

  const failResp = await mappingService.finishMapping({
    mappingSessionId: sessionId,
    name: 'Retry Map',
    requestId: 'req-attempt-1',
  });

  await new Promise((r) => setTimeout(r, 550));

  // Kiểm tra job 1 thất bại
  const job1 = await mappingService.getJob(failResp.jobId);
  assert.equal(job1.status, 'failed');
  assert.equal(job1.error.code, 'SAVE_FAILED');

  // Session phải ở trạng thái save_failed
  const { session } = await mappingService.getActiveMappingSession();
  assert.equal(session.status, 'save_failed');

  // 2. Thử lại (Retry) với requestId mới trên cùng session name
  const retryResp = await mappingService.finishMapping({
    mappingSessionId: sessionId,
    name: 'Retry Map',
    requestId: 'req-attempt-2',
  });

  await new Promise((r) => setTimeout(r, 550));

  // Job 2 phải thành công
  const job2 = await mappingService.getJob(retryResp.jobId);
  assert.equal(job2.status, 'completed');

  // Validate JobSchema & result schema { mapId, mapRevision }
  const parsedJob = JobSchema.parse(job2);
  assert.ok(parsedJob.result.mapId);
  assert.ok(parsedJob.result.mapRevision);

  // Danh mục map có map mới
  const maps = await mappingService.listMaps();
  assert.ok(maps.some((m) => m.id === parsedJob.result.mapId));

  mapGridService.dispose();
  mappingService.dispose();
});

test('TC-MAP-04: failNextSaveForSession mô phỏng lỗi lưu bản đồ đúng 1 lần và không tạo map rác trong catalog', async () => {
  const { mappingService, mapGridService } = setupServices();

  const startResp = await mappingService.startMapping({ name: 'Session Test', requestId: 'req-start-failtest' });
  const sessionId = startResp.mappingSessionId;

  // Đợi phiên mapping khởi động xong (400ms)
  await new Promise((r) => setTimeout(r, 450));

  // Tiêm lỗi lưu cho session này
  mappingService.failNextSaveForSession(sessionId);

  await mappingService.finishMapping({
    mappingSessionId: sessionId,
    name: 'Bản đồ thử nghiệm lỗi',
    requestId: 'req-finish-fail-1',
  });

  // Đợi job xử lý (500ms)
  await new Promise((r) => setTimeout(r, 550));

  const { session } = await mappingService.getActiveMappingSession();
  assert.equal(session.status, 'save_failed');

  // Danh mục map không bị thêm map rác
  const maps = await mappingService.listMaps();
  const failedMap = maps.find((m) => m.name === 'Bản đồ thử nghiệm lỗi');
  assert.equal(failedMap, undefined);

  mapGridService.dispose();
  mappingService.dispose();
});

test('TC-MAP-05: Chặn finishMapping khi phiên còn ở trạng thái starting', async () => {
  const { mappingService, mapGridService } = setupServices();

  const startResp = await mappingService.startMapping({ name: 'Immediate Finish', requestId: 'req-imm-start' });
  const sessionId = startResp.mappingSessionId;

  // Thử finish ngay khi session đang ở 'starting'
  await assert.rejects(
    async () => {
      await mappingService.finishMapping({
        mappingSessionId: sessionId,
        name: 'Immediate Finish',
        requestId: 'req-imm-finish',
      });
    },
    (err) => err.code === 'MAPPING_SESSION_STARTING'
  );

  mapGridService.dispose();
  mappingService.dispose();
});
