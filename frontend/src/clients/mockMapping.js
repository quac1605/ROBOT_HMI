import {
  StartMappingRequestSchema,
  FinishMappingRequestSchema,
  JobSchema,
} from '../schemas/mapping.js';
import { normalizeOccupancyGrid } from '../utils/normalizeOccupancyGrid.js';

function appError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createMockMappingService({
  sharedRobotState,
  mapGridService,
  mapRepository,
  onMappingStarted = null,
  mappingDriveGate,
  assertMappingFinishSafe,
  motionGate,
}) {
  if (!mappingDriveGate || typeof assertMappingFinishSafe !== 'function' || !motionGate) {
    throw appError('MAPPING_DRIVE_DEPENDENCIES_REQUIRED', 'Thiếu dependencies điều khiển mapping.');
  }
  let activeSession = null;
  const jobs = new Map();
  const jobListeners = new Set();
  const requestIndex = new Map();

  let simulateSaveFailureOnce = false;
  const failureInjectedSessions = new Set();

  let disposed = false;
  let operationEpoch = 0;
  const timers = new Set();

  function scheduleGuarded(ms, callback, handleUnexpectedFailure) {
    if (disposed) return null;
    const capturedEpoch = operationEpoch;
    const handle = setTimeout(async () => {
      timers.delete(handle);
      if (disposed || capturedEpoch !== operationEpoch) return;
      try {
        await callback(capturedEpoch);
      } catch (cause) {
        if (!disposed && capturedEpoch === operationEpoch) {
          handleUnexpectedFailure?.(cause, capturedEpoch);
        }
      }
    }, ms);
    timers.add(handle);
    if (handle?.unref) handle.unref();
    return handle;
  }

  function cancelTimers() {
    operationEpoch += 1;
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
  }

  function resetRuntime({ markDisposed = false } = {}) {
    if (disposed) return;
    cancelTimers();
    if (activeSession) {
      mappingDriveGate.clearSession(activeSession.mappingSessionId);
      mapGridService.removeLiveSession(activeSession.mappingSessionId);
    }
    activeSession = null;
    jobs.clear();
    requestIndex.clear();
    failureInjectedSessions.clear();
    simulateSaveFailureOnce = false;
    jobListeners.clear();
    sharedRobotState.update({
      mode: 'idle',
      activeMap: null,
      activeMappingSessionId: null,
      pose: null,
      poseSourceUpdateAgeMs: null,
    });
    disposed = markDisposed;
  }

  function emitJob(job) {
    const checked = JobSchema.parse(structuredClone(job));
    jobListeners.forEach((l) => {
      try {
        l(structuredClone(checked));
      } catch (err) {
        console.error('Lỗi job listener:', err);
      }
    });
  }

  function createJobRecord(type) {
    const jobId = `job-${Math.random().toString(36).substring(2, 9)}`;
    const job = {
      jobId,
      type,
      status: 'accepted',
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    jobs.set(jobId, job);
    return job;
  }

  function canonicalPayload(value) {
    return JSON.stringify(value, Object.keys(value).sort());
  }

  function lookupReplay(principalId, requestId, operation, payload) {
    if (!requestId) return { canonical: canonicalPayload(payload), response: null };
    const canonical = canonicalPayload(payload);
    const key = JSON.stringify([principalId, requestId]);
    const old = requestIndex.get(key);
    if (!old) return { canonical, response: null };
    if (old.operation !== operation || old.canonical !== canonical) {
      throw appError('IDEMPOTENCY_CONFLICT', 'requestId đã được dùng với operation hoặc payload khác');
    }
    return { canonical, response: structuredClone(old.response) };
  }

  function recordIdempotency(principalId, requestId, operation, canonical, response) {
    if (!requestId) return;
    const key = JSON.stringify([principalId, requestId]);
    requestIndex.set(key, {
      operation,
      canonical,
      response: structuredClone(response),
    });
  }

  return {
    async listMaps() {
      return mapRepository.listMaps();
    },

    async getMap(mapId, revision) {
      return mapRepository.getMap(mapId, revision);
    },

    async getActiveMappingSession() {
      return { session: activeSession ? structuredClone(activeSession) : null };
    },

    async getJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) {
        throw appError('JOB_NOT_FOUND', `Không tìm thấy job: ${jobId}`);
      }
      return JobSchema.parse(structuredClone(job));
    },

    subscribeJobs(listener) {
      jobListeners.add(listener);
      return () => {
        jobListeners.delete(listener);
      };
    },

    async startMapping(request, principalId = 'default-user') {
      if (disposed) throw appError('SERVICE_DISPOSED', 'Mapping service đã bị hủy');

      // 1. Validate request schema
      const { name, requestId } = StartMappingRequestSchema.parse(request);

      // 2. Lookup idempotency replay
      const payloadObj = { name, requestId };
      const { canonical, response: cachedResponse } = lookupReplay(
        principalId,
        requestId,
        'start_mapping',
        payloadObj
      );
      if (cachedResponse) return cachedResponse;

      // 3. Preconditions
      const robotState = sharedRobotState.getSnapshot();
      if (robotState.mode !== 'idle') {
        throw appError(
          'ROBOT_NOT_IDLE',
          `Robot đang ở chế độ ${robotState.mode}, chỉ được bắt đầu tạo bản đồ khi robot ở trạng thái idle`
        );
      }

      if (activeSession) {
        throw appError(
          'MAPPING_ALREADY_ACTIVE',
          activeSession.status === 'save_failed'
            ? 'Đang có phiên lưu thất bại, vui lòng thử lại lưu bản đồ trước khi tạo phiên mới'
            : 'Đang có một phiên tạo bản đồ khác đang hoạt động'
        );
      }

      if (robotState.activeMissionId !== null || robotState.activeMappingSessionId !== null ||
          robotState.motionInhibited !== false || robotState.physicalEstopActive !== false ||
          robotState.rosConnected !== true) {
        throw appError('MAPPING_START_BLOCKED', 'Robot chưa đủ điều kiện bắt đầu mapping.');
      }
      const startTicket = motionGate.enter();

      // 4. Staging memory creation
      const mappingSessionId = `sess-${Math.random().toString(36).substring(2, 9)}`;
      mappingDriveGate.beginSession(mappingSessionId);
      const job = createJobRecord('start_mapping');
      const resp = { mappingSessionId, jobId: job.jobId, status: 'accepted' };

      // 5. Save response into requestIndex
      recordIdempotency(principalId, requestId, 'start_mapping', canonical, resp);

      // 6. Commit synchronous context reservation.  The robot has not confirmed
      // SLAM yet, therefore it must remain idle and must not expose a pose from
      // the previously active saved map under the new mapping context.
      activeSession = {
        mappingSessionId,
        name,
        status: 'starting',
        startedAt: new Date().toISOString(),
      };
      mapGridService.createLiveSession(mappingSessionId);
      sharedRobotState.update({
        mode: 'idle',
        activeMap: null,
        activeMappingSessionId: mappingSessionId,
        pose: null,
        poseSourceUpdateAgeMs: null,
      });

      // 7. Emit accepted
      emitJob(job);

      // 8. Schedule guarded start worker
      scheduleGuarded(
        400,
        async (capturedEpoch) => {
          if (disposed || capturedEpoch !== operationEpoch) return;
          if (activeSession && activeSession.mappingSessionId === mappingSessionId) {
            motionGate.assert(startTicket);
            const beforeStart = sharedRobotState.getSnapshot();
            if (beforeStart.mode !== 'idle' || beforeStart.activeMappingSessionId !== mappingSessionId ||
                beforeStart.activeMissionId !== null || beforeStart.motionInhibited !== false ||
                beforeStart.rosConnected !== true || beforeStart.physicalEstopActive !== false) {
              throw appError('MAPPING_START_SUPERSEDED', 'Trạng thái robot đã đổi trong lúc khởi động.');
            }
            activeSession.status = 'mapping';
            // Reset the mock pose source before opening the mapping context.  A
            // telemetry tick after this commit is the first source-confirmed
            // pose that may be published for the new session.
            onMappingStarted?.({ mappingSessionId });
            sharedRobotState.update({
              mode: 'mapping',
              activeMap: null,
              activeMappingSessionId: mappingSessionId,
              pose: null,
              poseSourceUpdateAgeMs: null,
            });
            mappingDriveGate.activateSession(mappingSessionId);
            job.status = 'completed';
            job.result = { mappingSessionId };
            emitJob(job);
          }
        },
        (cause, capturedEpoch) => {
          if (disposed || capturedEpoch !== operationEpoch) return;
          if (activeSession && activeSession.mappingSessionId === mappingSessionId) {
            mappingDriveGate.clearSession(mappingSessionId);
            mapGridService.removeLiveSession(mappingSessionId);
            activeSession = null;
            sharedRobotState.update({
              mode: sharedRobotState.getSnapshot().mode === 'mapping'
                ? 'idle' : sharedRobotState.getSnapshot().mode,
              activeMappingSessionId: null,
              activeMap: null,
              pose: null,
              poseSourceUpdateAgeMs: null,
            });
            job.status = 'failed';
            job.error = { code: 'START_FAILED', message: cause?.message || 'Khởi động SLAM thất bại' };
            emitJob(job);
          }
        }
      );

      return structuredClone(resp);
    },

    async finishMapping(request, principalId = 'default-user') {
      if (disposed) throw appError('SERVICE_DISPOSED', 'Mapping service đã bị hủy');

      // 1. Validate request schema
      const { mappingSessionId, name, requestId } = FinishMappingRequestSchema.parse(request);

      // 2. Lookup idempotency replay
      const payloadObj = { mappingSessionId, name, requestId };
      const { canonical, response: cachedResponse } = lookupReplay(
        principalId,
        requestId,
        'finish_mapping',
        payloadObj
      );
      if (cachedResponse) return cachedResponse;

      // 3. Preconditions
      if (!activeSession || activeSession.mappingSessionId !== mappingSessionId) {
        throw appError('SESSION_NOT_FOUND', 'Phiên mapping không tồn tại hoặc đã kết thúc');
      }

      if (activeSession.status === 'starting') {
        throw appError('MAPPING_SESSION_STARTING', 'Phiên mapping đang khởi động, chưa thể kết thúc');
      }

      if (activeSession.status === 'finishing') {
        throw appError('FINISH_ALREADY_IN_PROGRESS', 'Phiên mapping đang trong quá trình lưu bản đồ');
      }

      if (activeSession.status !== 'mapping' && activeSession.status !== 'save_failed') {
        throw appError('INVALID_SESSION_STATUS', `Không thể lưu bản đồ từ trạng thái ${activeSession.status}`);
      }

      const currentRobotState = sharedRobotState.getSnapshot();
      if (currentRobotState.mode !== 'mapping') {
        throw appError('ROBOT_MODE_MISMATCH', 'Robot không ở chế độ mapping');
      }

      // lookupReplay ở đầu hàm đã xử lý replay trước mọi thay đổi gate.
      const finishTicket = assertMappingFinishSafe(mappingSessionId);
      mappingDriveGate.beginFinish(mappingSessionId);

      // 4. Staging memory creation
      const job = createJobRecord('finish_mapping');
      const resp = { jobId: job.jobId, status: 'accepted' };

      // 5. Save response into requestIndex
      recordIdempotency(principalId, requestId, 'finish_mapping', canonical, resp);

      // 6. Commit synchronous state
      activeSession.status = 'finishing';

      // 7. Emit accepted
      emitJob(job);

      // 8. Schedule guarded finish worker
      scheduleGuarded(
        400,
        async (capturedEpoch) => {
          if (disposed || capturedEpoch !== operationEpoch) return;
          if (!activeSession || activeSession.mappingSessionId !== mappingSessionId) return;

          const shouldFail = simulateSaveFailureOnce || failureInjectedSessions.has(mappingSessionId);
          if (shouldFail) {
            simulateSaveFailureOnce = false;
            failureInjectedSessions.delete(mappingSessionId);
            throw appError('SAVE_FAILED', 'Mô phỏng lỗi lưu bản đồ (Injected Failure)');
          }

          // Lấy live grid
          const liveSnapshot = await mapGridService.getMapGrid({ kind: 'mapping', mappingSessionId });
          motionGate.assert(finishTicket);
          if (disposed || capturedEpoch !== operationEpoch) return;
          if (!activeSession || activeSession.mappingSessionId !== mappingSessionId) return;

          // Normalize geometry chuẩn xác
          const normalized = normalizeOccupancyGrid(liveSnapshot);

          const mapId = `map-${Math.random().toString(36).substring(2, 7)}`;
          const mapRevision = 'rev-1';

          const metadata = {
            id: mapId,
            revision: mapRevision,
            name,
            status: 'ready',
            frameId: normalized.geometry.frameId,
            width: normalized.geometry.width,
            height: normalized.geometry.height,
            resolution: normalized.geometry.resolution,
            origin: {
              x: normalized.geometry.origin.x,
              y: normalized.geometry.origin.y,
              yaw: normalized.geometry.origin.yaw,
            },
            assets: [
              { type: 'grid_json', source: 'mock', storage: 'memory', status: 'ready' },
              { type: 'yaml_meta', source: 'mock', storage: 'memory', status: 'ready' },
            ],
            capabilities: {
              hasOccupancyGrid: true,
              hasSlamState: false,
              canResumeMapping: false,
              canLocalize: true,
              canNavigate: true,
            },
            createdAt: new Date().toISOString(),
          };

          const savedSnapshot = {
            ...structuredClone(liveSnapshot),
            context: {
              kind: 'saved',
              mapId,
              mapRevision,
            },
          };

          // Chuẩn bị record trước visibility boundary
          const preparedRecord = mapRepository.prepareSaved({
            metadata,
            snapshot: savedSnapshot,
          });

          // Visibility boundary: Commit đồng bộ duy nhất
          motionGate.assert(finishTicket);
          mapRepository.commitPrepared(preparedRecord);
          mapGridService.removeLiveSession(mappingSessionId);
          mappingDriveGate.finishSucceeded(mappingSessionId);
          activeSession = null;
          sharedRobotState.update({
            mode: 'idle',
            activeMappingSessionId: null,
            activeMap: null,
            pose: null,
            poseSourceUpdateAgeMs: null,
          });

          // Hoàn tất job thành công
          job.status = 'completed';
          job.result = { mapId, mapRevision };
          emitJob(job);
        },
        (cause, capturedEpoch) => {
          if (disposed || capturedEpoch !== operationEpoch) return;
          if (activeSession && activeSession.mappingSessionId === mappingSessionId) {
            activeSession.status = 'save_failed';
            mappingDriveGate.finishFailed(mappingSessionId);
          }
          job.status = 'failed';
          job.error = {
            code: cause?.code || 'SAVE_FAILED',
            message: cause?.message || 'Không thể lưu bản đồ',
          };
          emitJob(job);
        }
      );

      return structuredClone(resp);
    },

    // Test / Dev controls
    setSimulateSaveFailureOnce(val) {
      simulateSaveFailureOnce = Boolean(val);
    },

    failNextSaveForSession(sessionId) {
      failureInjectedSessions.add(sessionId);
    },

    reset() {
      resetRuntime();
    },

    dispose() {
      resetRuntime({ markDisposed: true });
    },
  };
}
