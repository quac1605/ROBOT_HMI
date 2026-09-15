import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StartMappingRequestSchema,
  FinishMappingRequestSchema,
  MappingSessionSchema,
  JobSchema,
} from '../../../frontend/src/schemas/mapping.js';

test('TC-MAP-SCHEMA-01: StartMappingRequestSchema kiểm tra tính hợp lệ và từ chối trường lạ', () => {
  const valid = { name: 'Khu vực kho A', requestId: 'req-123' };
  assert.equal(StartMappingRequestSchema.safeParse(valid).success, true);

  // Tên rỗng
  assert.equal(StartMappingRequestSchema.safeParse({ name: '   ', requestId: 'req-123' }).success, false);
  // Thiếu requestId
  assert.equal(StartMappingRequestSchema.safeParse({ name: 'Kho A' }).success, false);
  // Trường lạ ngoài contract
  assert.equal(StartMappingRequestSchema.safeParse({ ...valid, extraField: 'evil' }).success, false);
});

test('TC-MAP-SCHEMA-02: FinishMappingRequestSchema kiểm tra tính hợp lệ', () => {
  const valid = { mappingSessionId: 'sess-abc', name: 'Bản đồ hoàn chỉnh', requestId: 'req-finish-1' };
  assert.equal(FinishMappingRequestSchema.safeParse(valid).success, true);

  // Thiếu mappingSessionId
  assert.equal(FinishMappingRequestSchema.safeParse({ name: 'Bản đồ', requestId: 'req-1' }).success, false);
  // Trường lạ ngoài contract
  assert.equal(FinishMappingRequestSchema.safeParse({ ...valid, unknownParam: 123 }).success, false);
});

test('TC-MAP-SCHEMA-03: MappingSessionSchema chỉ chấp nhận 4 trạng thái hợp lệ', () => {
  const base = {
    mappingSessionId: 'sess-1',
    name: 'Bản đồ 1',
    startedAt: new Date().toISOString(),
  };

  for (const status of ['starting', 'mapping', 'finishing', 'save_failed']) {
    assert.equal(MappingSessionSchema.safeParse({ ...base, status }).success, true);
  }

  // Trạng thái không được phép (ví dụ: completed không thuộc session)
  assert.equal(MappingSessionSchema.safeParse({ ...base, status: 'completed' }).success, false);
  assert.equal(MappingSessionSchema.safeParse({ ...base, status: 'unknown' }).success, false);
});

test('TC-MAP-SCHEMA-04: JobSchema kiểm tra bất biến status cho start_mapping', () => {
  const createdAt = new Date().toISOString();

  // Pending (accepted/running)
  assert.equal(
    JobSchema.safeParse({
      jobId: 'job-1',
      type: 'start_mapping',
      status: 'accepted',
      result: null,
      error: null,
      createdAt,
    }).success,
    true
  );

  // Completed phải có result { mappingSessionId } và error null
  assert.equal(
    JobSchema.safeParse({
      jobId: 'job-1',
      type: 'start_mapping',
      status: 'completed',
      result: { mappingSessionId: 'sess-1' },
      error: null,
      createdAt,
    }).success,
    true
  );

  // Completed nhưng error không null -> Reject
  assert.equal(
    JobSchema.safeParse({
      jobId: 'job-1',
      type: 'start_mapping',
      status: 'completed',
      result: { mappingSessionId: 'sess-1' },
      error: { code: 'ERR', message: 'Fail' },
      createdAt,
    }).success,
    false
  );

  // Failed phải có error và result null
  assert.equal(
    JobSchema.safeParse({
      jobId: 'job-1',
      type: 'start_mapping',
      status: 'failed',
      result: null,
      error: { code: 'START_FAILED', message: 'Không thể khởi động' },
      createdAt,
    }).success,
    true
  );
});

test('TC-MAP-SCHEMA-05: JobSchema kiểm tra bất biến status cho finish_mapping', () => {
  const createdAt = new Date().toISOString();

  // Completed finish_mapping phải có result { mapId, mapRevision }
  assert.equal(
    JobSchema.safeParse({
      jobId: 'job-2',
      type: 'finish_mapping',
      status: 'completed',
      result: { mapId: 'map-new', mapRevision: 'rev-1' },
      error: null,
      createdAt,
    }).success,
    true
  );

  // Failed finish_mapping phải có error { code, message }
  assert.equal(
    JobSchema.safeParse({
      jobId: 'job-2',
      type: 'finish_mapping',
      status: 'failed',
      result: null,
      error: { code: 'SAVE_FAILED', message: 'Lỗi lưu bản đồ' },
      createdAt,
    }).success,
    true
  );
});
