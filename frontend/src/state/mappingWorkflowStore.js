import { create } from 'zustand';
import { JobSchema } from '../schemas/mapping.js';

const JOB_RANK = { accepted: 0, running: 1, completed: 2, failed: 2 };
export const observedJobs = new Map();

function recoveredSessionPatch(state, session) {
  if (session) {
    return {
      session,
      viewerContext: { kind: 'mapping', mappingSessionId: session.mappingSessionId },
    };
  }
  return {
    session: null,
    viewerContext: state.viewerContext?.kind === 'mapping' ? null : state.viewerContext,
  };
}

export function mergeObservedJob(incoming) {
  const checked = JobSchema.parse(incoming);
  const old = observedJobs.get(checked.jobId);
  if (old && JOB_RANK[checked.status] < JOB_RANK[old.status]) return old;
  if (
    old &&
    JOB_RANK[old.status] === 2 &&
    JSON.stringify(old) !== JSON.stringify(checked)
  ) {
    const err = new Error(`Xung đột trạng thái terminal của job: ${checked.jobId}`);
    err.code = 'JOB_TERMINAL_CONFLICT';
    throw err;
  }
  observedJobs.set(checked.jobId, structuredClone(checked));
  return checked;
}

export function handleIncomingJob(job, store = useMappingWorkflowStore) {
  const merged = mergeObservedJob(job);
  const tracked = store.getState().trackedOperation;
  if (!tracked || tracked.jobId !== merged.jobId) return;

  store.getState().recordJob(merged);

  if (merged.status === 'failed' && merged.type === 'start_mapping') {
    store.getState().rollbackFailedStart(merged.error);
  } else if (merged.status === 'failed' && merged.type === 'finish_mapping') {
    store.getState().retainLiveAfterSaveFailure(merged.error);
  } else if (merged.status === 'completed' && merged.type === 'finish_mapping') {
    store.getState().finishWithSavedContext({
      kind: 'saved',
      mapId: merged.result.mapId,
      mapRevision: merged.result.mapRevision,
    });
  } else if (merged.status === 'completed' && merged.type === 'start_mapping') {
    store.getState().finishStart(merged.result.mappingSessionId);
  }
}

export async function trackAcceptedJob(
  response,
  type,
  requestId,
  client,
  store = useMappingWorkflowStore,
  operationContext = {}
) {
  const currentSession = store.getState().session;
  const acceptedSession = type === 'start_mapping' && operationContext.name
    ? {
        mappingSessionId: response.mappingSessionId,
        name: operationContext.name,
        status: 'starting',
        startedAt: operationContext.startedAt ?? new Date().toISOString(),
      }
    : type === 'finish_mapping' && currentSession
      ? { ...currentSession, status: 'finishing' }
      : null;

  // Select the job before any await. subscribeJobs may already have delivered
  // accepted/completed, and mergeObservedJob below must never regress it.
  store.getState().selectTrackedJob({
    jobId: response.jobId,
    type,
    requestId,
    acceptedSession,
    mappingName: operationContext.name ?? currentSession?.name ?? null,
  });

  const cached = observedJobs.get(response.jobId);
  const [sessionResult, jobResult] = await Promise.allSettled([
    client.getActiveMappingSession(),
    client.getJob(response.jobId),
  ]);

  // Service recovery is authoritative and supplies the exact requested name
  // even for callers that use the backward-compatible five-argument API.
  if (sessionResult.status === 'fulfilled') {
    store.getState().replaceRecoveredSession(sessionResult.value.session);
  }

  // Apply the cached subscription event after recovery, then the polled job.
  // mergeObservedJob guarantees accepted/running can never overwrite terminal.
  if (cached) handleIncomingJob(cached, store);
  if (jobResult.status === 'fulfilled') {
    handleIncomingJob(jobResult.value, store);
  } else if (jobResult.reason?.code === 'JOB_NOT_FOUND') {
    store.getState().clearMissingTrackedOperation(jobResult.reason);
  } else {
    store.getState().markReconciliationPending(jobResult.reason);
  }

  if (
    sessionResult.status === 'rejected' &&
    jobResult.status === 'fulfilled' &&
    JOB_RANK[jobResult.value.status] < 2
  ) {
    store.getState().markReconciliationPending(sessionResult.reason);
  }
}

export const useMappingWorkflowStore = create((set) => ({
  session: null,
  trackedOperation: null,
  viewerContext: null,
  catalogRefreshRevision: 0,
  processing: false,
  ready: false,
  lastError: null,

  setReady: (ready) => set({ ready }),

  replaceRecoveredSession: (session) =>
    set((state) => recoveredSessionPatch(state, session)),

  // Backward-compatible alias used by the coordinator in earlier revisions.
  setSession: (session) => set((state) => recoveredSessionPatch(state, session)),

  setViewerContext: (viewerContext) => set({ viewerContext }),
  setProcessing: (processing) => set({ processing }),
  setLastError: (lastError) => set({ lastError }),

  selectTrackedJob: ({ jobId, type, requestId, acceptedSession = null, mappingName = null }) =>
    set((state) => {
      const nextSession = acceptedSession ?? (
        type === 'finish_mapping' && state.session
          ? { ...state.session, status: 'finishing' }
          : state.session
      );
      return {
        session: nextSession,
        viewerContext: nextSession
          ? { kind: 'mapping', mappingSessionId: nextSession.mappingSessionId }
          : state.viewerContext,
        trackedOperation: {
          jobId,
          type,
          requestId,
          mappingName,
          status: 'accepted',
          result: null,
          error: null,
        },
        processing: true,
        lastError: null,
      };
    }),

  recordJob: (job) =>
    set((state) => {
      if (!state.trackedOperation || state.trackedOperation.jobId !== job.jobId) {
        return {};
      }
      return {
        trackedOperation: {
          ...state.trackedOperation,
          status: job.status,
          result: job.result,
          error: job.error,
        },
      };
    }),

  rollbackFailedStart: (error) =>
    set({
      session: null,
      viewerContext: null,
      processing: false,
      lastError: error,
    }),

  finishStart: (mappingSessionId) =>
    set((state) => {
      const recoveredName = state.session?.name ?? state.trackedOperation?.mappingName;
      const nextSession = recoveredName
        ? {
            ...(state.session ?? {
              mappingSessionId,
              name: recoveredName,
              startedAt: new Date().toISOString(),
            }),
            mappingSessionId,
            status: 'mapping',
          }
        : null;
      return {
        session: nextSession,
        viewerContext: nextSession ? { kind: 'mapping', mappingSessionId } : null,
        processing: false,
        lastError: nextSession
          ? null
          : Object.assign(new Error('Không thể khôi phục tên phiên mapping'), {
              code: 'MAPPING_SESSION_RECONCILIATION_FAILED',
            }),
      };
    }),

  retainLiveAfterSaveFailure: (error) =>
    set((state) => ({
      session: state.session ? { ...state.session, status: 'save_failed' } : null,
      processing: false,
      lastError: error,
    })),

  finishWithSavedContext: ({ kind = 'saved', mapId, mapRevision }) =>
    set((state) => ({
      session: null,
      viewerContext: { kind, mapId, mapRevision },
      processing: false,
      lastError: null,
      catalogRefreshRevision: state.catalogRefreshRevision + 1,
    })),

  markReconciliationPending: (cause) =>
    set({
      lastError: cause,
    }),

  clearMissingTrackedOperation: (cause) =>
    set({
      trackedOperation: null,
      processing: false,
      lastError: cause,
    }),

  reset: () => {
    observedJobs.clear();
    set({
      session: null,
      trackedOperation: null,
      viewerContext: null,
      catalogRefreshRevision: 0,
      processing: false,
      ready: false,
      lastError: null,
    });
  },
}));
