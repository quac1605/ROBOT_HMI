import { useMissionStore } from '../state/missionStore.js';
import { useNavigationWorkflowStore } from '../state/navigationWorkflowStore.js';
import { useMappingWorkflowStore, handleIncomingJob } from '../state/mappingWorkflowStore.js';
import { isPending, TRANSPORT_STALE_MS } from './navigationPolicy.js';

export function createNavigationCoordinator(client, {
  missionStore = useMissionStore, navigationStore = useNavigationWorkflowStore,
  mappingStore = useMappingWorkflowStore,
} = {}) {
  let active = true;
  let eventVersion = 0;
  let recovering = false;
  let recoverAgain = false;
  let polling = false;
  let pathGeneration = 0;
  let pathKey = null;
  let closePath = null;
  let lastReceipt = performance.now();
  let disconnected = false;
  let suspended = false;
  const cleanup = [];

  function bindPath() {
    const state = missionStore.getState();
    const mission = state.missionsById[state.selectedMissionId];
    const key = mission ? JSON.stringify([mission.missionId, mission.mapId, mission.mapRevision]) : null;
    if (key === pathKey) return;
    pathKey = key;
    const generation = ++pathGeneration;
    closePath?.();
    closePath = null;
    if (!mission || !active) return;
    closePath = client.subscribeNavigationPath({ missionId: mission.missionId }, event => {
      if (active && generation === pathGeneration) missionStore.getState().ingestPath(event);
    });
  }

  function trackedJobs() {
    const nav = navigationStore.getState();
    return [nav.activation, nav.preview, mappingStore.getState().trackedOperation]
      .filter(item => item?.jobId && isPending(item.status));
  }

  function receiveJob(job) {
    if (['start_mapping', 'finish_mapping'].includes(job.type)) {
      handleIncomingJob(job, mappingStore);
    } else navigationStore.getState().recordJob(job);
  }

  async function reconcileJobs() {
    const tracked = trackedJobs();
    const results = await Promise.allSettled(tracked.map(item => client.getJob(item.jobId)));
    if (!active) return;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') { receiveJob(result.value); return; }
      const item = tracked[index];
      if (result.reason?.code !== 'JOB_NOT_FOUND') throw result.reason;
      if (mappingStore.getState().trackedOperation?.jobId === item.jobId) {
        mappingStore.getState().clearMissingTrackedOperation(result.reason);
      } else {
        for (const kind of ['activation', 'preview']) {
          const current = navigationStore.getState()[kind];
          if (current?.jobId === item.jobId) {
            navigationStore.getState().updateOperation(kind, current.request.requestId, {
              status: 'failed', error: { code: 'JOB_NOT_FOUND', message: 'Job không còn tồn tại sau đối soát.' },
            });
          }
        }
      }
    });
  }

  async function recover() {
    if (!active) return;
    if (recovering) { recoverAgain = true; return; }
    recovering = true;
    missionStore.getState().setRecovering();
    mappingStore.getState().setReady(false);
    try {
      let recovered = false;
      for (let attempt = 0; attempt < 3 && active; attempt += 1) {
        const version = eventVersion;
        const selectedId = missionStore.getState().selectedMissionId;
        const [activeResult, mappingResult, selectedResult] = await Promise.all([
          client.getActiveMission(), client.getActiveMappingSession(),
          selectedId ? client.getMission(selectedId).catch(error => {
            if (error.code === 'MISSION_NOT_FOUND') return null;
            throw error;
          }) : Promise.resolve(null),
        ]);
        if (!active) return;
        // REST hiện không có cursor: không cho snapshot đang await đè WS mới.
        // Nếu stream quá bận cả 3 lần, giữ khóa và yêu cầu đối soát lại.
        if (version !== eventVersion || selectedId !== missionStore.getState().selectedMissionId) continue;
        // Active-session snapshot được lấy trước lần GET job. Áp dụng nó trước,
        // để job terminal mới hơn có quyền kết thúc phiên và chọn saved viewer.
        // Nếu làm ngược lại, snapshot mapping cũ sẽ hồi sinh phiên đã lưu.
        mappingStore.getState().replaceRecoveredSession(mappingResult.session);
        await reconcileJobs();
        if (!active) return;
        if (version !== eventVersion) continue;
        missionStore.getState().applyRecovery(activeResult.mission, selectedResult);
        mappingStore.getState().setReady(true);
        // Resubscribe lấy path hiện tại, kể cả sau đổi epoch nhưng missionId giữ nguyên.
        pathGeneration += 1;
        closePath?.();
        closePath = null;
        pathKey = null;
        bindPath();
        recovered = true;
        break;
      }
      if (active && !recovered) throw new Error('State đổi trong lúc đối soát; hãy thử lại.');
    } catch (error) {
      if (active) {
        missionStore.getState().recoveryFailed(error);
        mappingStore.getState().setLastError(error);
      }
    } finally {
      recovering = false;
      if (active && recoverAgain) { recoverAgain = false; void recover(); }
    }
  }

  try {
    cleanup.push(client.subscribeJobs(event => {
      if (!active) return;
      eventVersion += 1;
      const job = event.payload || event;
      if (['start_mapping', 'finish_mapping'].includes(job.type)) receiveJob(job);
      else if (navigationStore.getState().ingestJob(event) === 'recover') missionStore.getState().requestRecovery();
    }));
    cleanup.push(client.subscribeMissions(event => {
      if (!active) return;
      eventVersion += 1;
      missionStore.getState().ingestMission(event);
    }));
    cleanup.push(missionStore.subscribe((state, previous) => {
      if (!active) return;
      bindPath();
      if (state.recoveryRevision !== previous.recoveryRevision) void recover();
    }));
    cleanup.push(client.subscribeRobotState(snapshot => {
      if (!active) return;
      const now = performance.now();
      const wasUnavailable = suspended || disconnected || now - lastReceipt > TRANSPORT_STALE_MS;
      lastReceipt = now;
      disconnected = !snapshot.rosConnected;
      if (!disconnected && wasUnavailable) {
        suspended = false;
        missionStore.getState().requestRecovery();
      }
      missionStore.getState().appendTelemetry(snapshot);
    }));
  } catch (error) {
    for (const close of cleanup) close();
    closePath?.();
    active = false;
    missionStore.getState().recoveryFailed(error);
    return { recover: () => {}, dispose: () => {} };
  }
  const interval = setInterval(() => {
    if (!active) return;
    if (!suspended && (disconnected || performance.now() - lastReceipt > TRANSPORT_STALE_MS)) {
      suspended = true;
      missionStore.getState().setRecovering();
    }
    if (!polling && !recovering && trackedJobs().length) {
      polling = true;
      reconcileJobs().catch(error => {
        if (active) navigationStore.getState().setError(error);
      }).finally(() => { polling = false; });
    }
  }, 500);
  void recover();

  return {
    recover,
    dispose() {
      if (!active) return;
      active = false;
      pathGeneration += 1;
      clearInterval(interval);
      closePath?.();
      for (const close of cleanup) close();
    },
  };
}
