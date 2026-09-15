import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleIncomingJob,
  observedJobs,
  trackAcceptedJob,
  useMappingWorkflowStore,
} from '../../../frontend/src/state/mappingWorkflowStore.js';

function resetStore() {
  observedJobs.clear();
  useMappingWorkflowStore.getState().reset();
}

function neverSettles() {
  return new Promise(() => {});
}

test.afterEach(resetStore);

test('accepted Start tạo session starting đồng bộ và giữ chính xác tên người dùng', () => {
  resetStore();
  const client = {
    getActiveMappingSession: neverSettles,
    getJob: neverSettles,
  };

  void trackAcceptedJob(
    { mappingSessionId: 'sess-start', jobId: 'job-start', status: 'accepted' },
    'start_mapping',
    'req-start',
    client,
    useMappingWorkflowStore,
    { name: 'Kho tầng 1' }
  );

  const state = useMappingWorkflowStore.getState();
  assert.equal(state.processing, true);
  assert.equal(state.session?.status, 'starting');
  assert.equal(state.session?.name, 'Kho tầng 1');
  assert.equal(state.viewerContext?.mappingSessionId, 'sess-start');
});

test('start completed không thay tên phiên bằng giá trị mặc định', () => {
  resetStore();
  useMappingWorkflowStore.getState().selectTrackedJob({
    jobId: 'job-complete',
    type: 'start_mapping',
    requestId: 'req-complete',
    mappingName: 'Bản đồ chính xác',
    acceptedSession: {
      mappingSessionId: 'sess-complete',
      name: 'Bản đồ chính xác',
      status: 'starting',
      startedAt: new Date().toISOString(),
    },
  });

  handleIncomingJob({
    jobId: 'job-complete',
    type: 'start_mapping',
    status: 'completed',
    result: { mappingSessionId: 'sess-complete' },
    error: null,
    createdAt: new Date().toISOString(),
  }, useMappingWorkflowStore);

  const state = useMappingWorkflowStore.getState();
  assert.equal(state.session?.status, 'mapping');
  assert.equal(state.session?.name, 'Bản đồ chính xác');
  assert.equal(state.processing, false);
});

test('accepted Finish chuyển session sang finishing trước lần await đầu tiên', () => {
  resetStore();
  useMappingWorkflowStore.getState().setSession({
    mappingSessionId: 'sess-finish',
    name: 'Map cần lưu',
    status: 'mapping',
    startedAt: new Date().toISOString(),
  });
  const client = {
    getActiveMappingSession: neverSettles,
    getJob: neverSettles,
  };

  void trackAcceptedJob(
    { jobId: 'job-finish', status: 'accepted' },
    'finish_mapping',
    'req-finish',
    client,
    useMappingWorkflowStore
  );

  const state = useMappingWorkflowStore.getState();
  assert.equal(state.session?.status, 'finishing');
  assert.equal(state.session?.name, 'Map cần lưu');
  assert.equal(state.processing, true);
});

test('null recovery xóa session/viewer mapping cũ nhưng giữ saved viewer hợp lệ', () => {
  resetStore();
  useMappingWorkflowStore.getState().setSession({
    mappingSessionId: 'stale-session',
    name: 'Stale',
    status: 'mapping',
    startedAt: new Date().toISOString(),
  });
  useMappingWorkflowStore.getState().replaceRecoveredSession(null);
  assert.equal(useMappingWorkflowStore.getState().session, null);
  assert.equal(useMappingWorkflowStore.getState().viewerContext, null);

  useMappingWorkflowStore.getState().setViewerContext({
    kind: 'saved',
    mapId: 'map-saved',
    mapRevision: 'rev-2',
  });
  useMappingWorkflowStore.getState().replaceRecoveredSession(null);
  assert.deepEqual(useMappingWorkflowStore.getState().viewerContext, {
    kind: 'saved',
    mapId: 'map-saved',
    mapRevision: 'rev-2',
  });
});
