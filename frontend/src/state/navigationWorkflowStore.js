import { create } from 'zustand';
import { JobSchema, NavigationJobEventSchema } from '../schemas/job.js';
import { emptyCursor, gateEvent } from '../utils/navigationEventGate.js';
import { matchesMap, errorDto } from '../utils/navigationPolicy.js';

const rank = { accepted: 0, running: 1, completed: 2, failed: 2 };
const toPose = ({ frameId, x, y, yaw }) => ({ frameId, x, y, yaw });
function initial(generation = 0) {
  return {
    generation, selectionGeneration: 0, selectedMap: null, waypoints: [],
    selectedWaypointId: null, routeDraft: { poses: [] }, draftRevision: 0,
    previewPath: null, preview: null, activation: null, savedRoutes: [],
    jobsById: {}, jobCursor: emptyCursor(), error: null,
  };
}
function changedDraft(state, waypoints, selected = state.selectedWaypointId) {
  return {
    waypoints, selectedWaypointId: selected,
    routeDraft: { poses: waypoints.map(toPose) }, draftRevision: state.draftRevision + 1,
    previewPath: null, preview: null, error: null
  };
}
function boundJobPatch(state, kind, job) {
  const tracked = state[kind];
  if (!tracked || tracked.jobId !== job.jobId) return {};
  const next = { ...tracked, status: job.status, error: job.error };
  const patch = { [kind]: next };
  if (job.status === 'failed') patch.error = job.error;
  if (kind === 'preview' && job.status === 'completed' &&
    tracked.draftRevision === state.draftRevision &&
    tracked.selectionGeneration === state.selectionGeneration &&
    matchesMap(job.result, state.selectedMap) &&
    job.result.mapId === tracked.request.mapId && job.result.mapRevision === tracked.request.mapRevision) {
    patch.previewPath = { ...structuredClone(job.result), draftRevision: tracked.draftRevision };
  }
  return patch;
}

export const useNavigationWorkflowStore = create((set, get) => ({
  ...initial(),
  setSelectedMap(map) {
    set(state => {
      if (state.selectedMap?.id === map?.id && state.selectedMap?.revision === map?.revision) {
        return { selectedMap: map };
      }
      return {
        selectedMap: map, selectionGeneration: state.selectionGeneration + 1,
        ...changedDraft(state, [], null), savedRoutes: []
      };
    });
  },
  setRouteDraft(poses) {
    set(state => {
      const waypoints = poses.map(pose => ({ ...toPose(pose), id: crypto.randomUUID() }));
      return changedDraft(state, waypoints, waypoints[0]?.id || null);
    });
  },
  appendWaypoint(pose) {
    set(state => {
      if (state.waypoints.length >= 100) return { error: { code: 'WAYPOINT_LIMIT', message: 'Tối đa 100 waypoint.' } };
      const point = { ...toPose(pose), id: crypto.randomUUID() };
      return changedDraft(state, [...state.waypoints, point], point.id);
    });
  },
  selectWaypoint(id) { set({ selectedWaypointId: id }); },
  updateWaypoint(id, pose) {
    set(state => changedDraft(state, state.waypoints.map(point => point.id === id ? { ...toPose(pose), id } : point)));
  },
  deleteWaypoint(id) {
    set(state => {
      const points = state.waypoints.filter(point => point.id !== id);
      return changedDraft(state, points, state.selectedWaypointId === id ? points[0]?.id || null : state.selectedWaypointId);
    });
  },
  moveWaypoint(id, offset) {
    set(state => {
      const points = [...state.waypoints];
      const index = points.findIndex(point => point.id === id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= points.length) return {};
      [points[index], points[target]] = [points[target], points[index]];
      return changedDraft(state, points);
    });
  },
  clearDraft() { set(state => changedDraft(state, [], null)); },
  beginOperation(kind, request) {
    set(state => ({
      [kind]: {
        request: structuredClone(request), jobId: null, status: 'sending', error: null,
        draftRevision: state.draftRevision, selectionGeneration: state.selectionGeneration,
      }, error: null
    }));
  },
  updateOperation(kind, requestId, patch) {
    set(state => state[kind]?.request.requestId === requestId
      ? { [kind]: { ...state[kind], ...patch } } : {});
  },
  bindJob(kind, requestId, jobId) {
    get().updateOperation(kind, requestId, { jobId, status: 'accepted' });
    const job = get().jobsById[jobId];
    if (job) get().recordJob(job);
  },
  recordJob(raw) {
    const job = JobSchema.parse(raw);
    set(state => {
      const old = state.jobsById[job.jobId];
      if (old && rank[job.status] < rank[old.status]) return {};
      if (old && rank[old.status] === 2 && JSON.stringify(old) !== JSON.stringify(job)) {
        return { error: { code: 'JOB_TERMINAL_CONFLICT', message: 'Job terminal thay đổi trái hợp đồng.' } };
      }
      const jobs = { ...state.jobsById, [job.jobId]: job };
      // Cache chỉ để bắt event đến trước HTTP response, không phải lịch sử vô hạn.
      const protectedIds = new Set([state.activation?.jobId, state.preview?.jobId]);
      const keys = Object.keys(jobs);
      for (const id of keys.slice(0, Math.max(0, keys.length - 50))) {
        if (!protectedIds.has(id)) delete jobs[id];
      }
      return { jobsById: jobs, ...boundJobPatch(state, 'activation', job), ...boundJobPatch(state, 'preview', job) };
    });
  },
  ingestJob(raw) {
    const event = NavigationJobEventSchema.parse(raw);
    const gate = gateEvent(get().jobCursor, event);
    if (gate.action === 'ignore') return 'ignore';
    set({ jobCursor: gate.cursor });
    if (gate.action === 'accept') get().recordJob(event.payload);
    return gate.action;
  },
  setSavedRoutes(routes, selectionGeneration) {
    if (selectionGeneration === get().selectionGeneration) set({ savedRoutes: routes });
  },
  setError(error) { set({ error: error ? errorDto(error) : null }); },
  reset() { set(state => initial(state.generation + 1)); },
}));
