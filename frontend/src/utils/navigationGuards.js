import { POSE_STALE_MS } from './navigationPolicy.js';
import { isInsideMap } from './mapCoordinates.js';

const denied = (code, reason) => ({ ok: false, code, reason });

export function checkRobotHealth(robotSnapshot, { transportStale = false } = {}) {
    if (!robotSnapshot) return denied('ROBOT_OFFLINE', 'Chưa có trạng thái robot.');
    if (transportStale) return denied('TELEMETRY_STALE', 'Mất dữ liệu mới từ robot; hãy đối soát trước.');
    if (!robotSnapshot.rosConnected) return denied('ROS_DISCONNECTED', 'ROS chưa kết nối.');
    if (robotSnapshot.mode === 'fault') return denied('ROBOT_FAULT', 'Robot đang fault.');
    if (robotSnapshot.physicalEstopActive !== false) {
        return denied('ESTOP_NOT_CLEAR', 'E-stop đang bật hoặc chưa xác nhận đã nhả.');
    }
    if (robotSnapshot.motionInhibited !== false) return denied('MOTION_INHIBITED', 'Chuyển động đang bị khóa hoặc chưa xác nhận quyền chạy.');
    return { ok: true };
}

export function checkMapActivationPreconditions({ robotSnapshot, transportStale = false }) {
    const health = checkRobotHealth(robotSnapshot, { transportStale });
    if (!health.ok) return health;
    if (robotSnapshot.activeMappingSessionId) return denied('MAPPING_ACTIVE', 'Đang có phiên mapping.');
    if (robotSnapshot.activeMissionId) return denied('MISSION_ACTIVE', 'Đang có nhiệm vụ chưa kết thúc.');
    if (robotSnapshot.mode !== 'idle') return denied('ROBOT_NOT_IDLE', 'Robot chưa ở chế độ idle.');
    return { ok: true };
}

export function checkNavigationContext(robotSnapshot, mapId, mapRevision) {
    if (robotSnapshot.activeMap?.id !== mapId || robotSnapshot.activeMap?.revision !== mapRevision) {
        return denied('MAP_NOT_ACTIVE', 'Map/revision chưa được kích hoạt trên robot.');
    }
    if (robotSnapshot.localization?.status !== 'tracking') {
        return denied('LOCALIZATION_LOST', 'Robot chưa định vị được trên bản đồ.');
    }
    if (!robotSnapshot.pose || robotSnapshot.pose.frameId !== 'map') {
        return denied('POSE_MISSING', 'Thiếu pose hợp lệ trong frame map.');
    }
    const age = robotSnapshot.poseSourceUpdateAgeMs;
    if (!Number.isFinite(age) || age > POSE_STALE_MS) {
        return denied('POSE_STALE', 'Nguồn pose đã cũ hoặc không xác định tuổi.');
    }
    return { ok: true };
}

export function checkMissionPreconditions({ robotSnapshot, mapId, mapRevision, transportStale = false }) {
    const idle = checkMapActivationPreconditions({ robotSnapshot, transportStale });
    return idle.ok ? checkNavigationContext(robotSnapshot, mapId, mapRevision) : idle;
}

export function checkMissionRuntime({ robotSnapshot, mission, transportStale = false }) {
    const health = checkRobotHealth(robotSnapshot, { transportStale });
    if (!health.ok) return health;
    if (robotSnapshot.activeMissionId !== mission.missionId ||
        robotSnapshot.mode !== 'navigating' || robotSnapshot.activeMappingSessionId) {
        return denied('MISSION_OWNERSHIP_LOST', 'Mission không còn sở hữu chế độ chuyển động.');
    }
    return checkNavigationContext(robotSnapshot, mission.mapId, mission.mapRevision);
}

export function checkSavedMap(map) {
    if (!map || map.status !== 'ready' || !map.capabilities?.hasOccupancyGrid ||
        !map.capabilities?.canLocalize || !map.capabilities?.canNavigate || map.frameId !== 'map') {
        return denied('MAP_NOT_NAVIGABLE', 'Map chưa ready hoặc không có capability navigation/localization.');
    }
    return { ok: true };
}

export function checkRouteBounds(poses, map) {
    return poses.every(pose => pose.frameId === map.frameId && isInsideMap(pose, map))
        ? { ok: true }
        : denied('POSE_OUT_OF_BOUNDS', 'Có waypoint ngoài map hoặc sai frame.');
}
