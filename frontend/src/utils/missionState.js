const terminalStates = new Set(['succeeded', 'failed', 'canceled']);

const allowedTransitions = {
  accepted: new Set(['executing', 'canceling', 'failed', 'succeeded']),
  executing: new Set(['canceling', 'succeeded', 'failed']),
  canceling: new Set(['canceled', 'succeeded', 'failed']),
  succeeded: new Set(),
  failed: new Set(),
  canceled: new Set(),
};

export function isMissionTerminal(status) {
  return terminalStates.has(status);
}

export function canTransitionMission(fromStatus, toStatus) {
  if (fromStatus === toStatus) return true;
  return Boolean(allowedTransitions[fromStatus]?.has(toStatus));
}

export function transitionMission(mission, nextStatus, patch = {}) {
  if (mission.status === nextStatus) {
    return { ...mission, ...patch, status: nextStatus };
  }

  if (!canTransitionMission(mission.status, nextStatus)) {
    throw Object.assign(
      new Error(`Chuyển trạng thái mission không hợp lệ: ${mission.status} -> ${nextStatus}`),
      { code: 'INVALID_MISSION_TRANSITION' },
    );
  }

  return {
    ...mission,
    ...patch,
    status: nextStatus,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  };
}
