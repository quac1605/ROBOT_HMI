import { create } from 'zustand';
import { MissionEventEnvelopeSchema, NavigationPathEnvelopeSchema, preflightNavigationPath } from '../schemas/mission.js';
import { isMissionTerminal } from '../utils/missionState.js';
import { emptyCursor, gateEvent } from '../utils/navigationEventGate.js';
import { MAX_TRAJECTORY_POINTS, errorDto } from '../utils/navigationPolicy.js';

function initial(generation = 0) {
  return {
    generation, missionsById: {}, activeMissionId: null, selectedMissionId: null,
    ...emptyCursor(), eventVersion: 0, pathCursor: emptyCursor(),
    plannedPath: null, trajectory: null,
    reconciliationState: 'loading', recoveryRevision: 0, lastError: null,
    missionRequest: null, cancelRequest: null,
  };
}
function missionPatch(state, mission) {
  const isActive = !isMissionTerminal(mission.status);
  const nextSelected = isActive ? mission.missionId : state.selectedMissionId || mission.missionId;
  const changed = state.selectedMissionId !== nextSelected;
  const request = state.missionRequest?.request.requestId === mission.requestId
    ? { ...state.missionRequest, missionId: mission.missionId, status: 'acknowledged', error: null }
    : state.missionRequest;
  return {
    missionsById: { ...state.missionsById, [mission.missionId]: structuredClone(mission) },
    activeMissionId: isActive ? mission.missionId
      : state.activeMissionId === mission.missionId ? null : state.activeMissionId,
    selectedMissionId: nextSelected,
    ...(changed ? { plannedPath: null, trajectory: null, pathCursor: emptyCursor() } : {}),
    missionRequest: request,
    cancelRequest: state.cancelRequest?.request.missionId === mission.missionId && isMissionTerminal(mission.status)
      ? { ...state.cancelRequest, status: 'acknowledged', error: null } : state.cancelRequest,
  };
}

export const useMissionStore = create((set, get) => ({
  ...initial(),
  ingestMission(raw) {
    const event = MissionEventEnvelopeSchema.parse(raw);
    const state = get();
    const gate = gateEvent(state, event);
    if (gate.action === 'ignore') return 'ignore';
    set({
      ...gate.cursor, eventVersion: state.eventVersion + 1,
      ...(gate.action === 'accept' ? missionPatch(state, event.payload) : {
        reconciliationState: 'loading', recoveryRevision: state.recoveryRevision + 1,
        plannedPath: null, trajectory: null,
      }),
    });
    return gate.action;
  },
  applyRecovery(activeMission, selectedMission) {
    set(state => {
      const selected = activeMission || selectedMission;
      const patch = selected ? missionPatch(state, selected) : {};
      return {
        ...patch,
        activeMissionId: activeMission?.missionId || null,
        selectedMissionId: selected?.missionId || null,
        ...(!selected || selected.missionId !== state.selectedMissionId
          ? { plannedPath: null, trajectory: null, pathCursor: emptyCursor() } : {}),
        reconciliationState: 'ready', lastError: null,
      };
    });
  },
  ingestPath(raw) {
    preflightNavigationPath(raw);
    const event = NavigationPathEnvelopeSchema.parse(raw);
    const state = get();
    const mission = state.missionsById[state.selectedMissionId];
    const path = event.payload;
    if (!mission || mission.missionId !== path.missionId ||
      mission.mapId !== path.mapId || mission.mapRevision !== path.mapRevision || path.frameId !== 'map') return;
    const gate = gateEvent(state.pathCursor, event);
    if (gate.action === 'ignore') return;
    set({
      pathCursor: gate.cursor,
      plannedPath: gate.action === 'accept' ? structuredClone(path) : null
    });
    if (gate.action === 'recover') get().requestRecovery();
  },
  appendTelemetry(snapshot) {
    const state = get();
    const mission = state.missionsById[state.activeMissionId];
    if (state.reconciliationState !== 'ready' || mission?.status !== 'executing' ||
      snapshot.activeMissionId !== mission.missionId || snapshot.activeMappingSessionId ||
      snapshot.activeMap?.id !== mission.mapId || snapshot.activeMap?.revision !== mission.mapRevision ||
      !snapshot.rosConnected || snapshot.localization?.status !== 'tracking' ||
      snapshot.pose?.frameId !== 'map' || !Number.isFinite(snapshot.poseSourceUpdateAgeMs) ||
      snapshot.poseSourceUpdateAgeMs > 2000) return;
    const previous = state.trajectory?.missionId === mission.missionId ? state.trajectory.poses : [];
    const last = previous.at(-1);
    if (last && Math.hypot(last.x - snapshot.pose.x, last.y - snapshot.pose.y) < 0.02 &&
      Math.abs(last.yaw - snapshot.pose.yaw) < 0.1) return;
    set({
      trajectory: {
        missionId: mission.missionId, mapId: mission.mapId, mapRevision: mission.mapRevision,
        frameId: 'map', poses: [...previous, structuredClone(snapshot.pose)].slice(-MAX_TRAJECTORY_POINTS),
      }
    });
  },
  beginRequest(kind, request) {
    set({ [kind]: { request: structuredClone(request), status: 'sending', error: null } });
  },
  updateRequest(kind, requestId, patch) {
    set(state => state[kind]?.request.requestId === requestId
      ? { [kind]: { ...state[kind], ...patch } } : {});
  },
  selectMission(missionId) {
    set(state => ({
      selectedMissionId: missionId,
      ...(state.selectedMissionId !== missionId
        ? { plannedPath: null, trajectory: null, pathCursor: emptyCursor() } : {}),
    }));
  },
  requestRecovery() {
    set(state => ({ recoveryRevision: state.recoveryRevision + 1, reconciliationState: 'loading' }));
  },
  setRecovering() { set({ reconciliationState: 'loading', lastError: null }); },
  recoveryFailed(error) { set({ reconciliationState: 'error', lastError: errorDto(error) }); },
  clearMission() { set(state => initial(state.generation + 1)); },
}));
