/**
 * backend/src/ros/mockRosAdapter.js
 * 
 * ADAPTER MÔ PHỎNG NGUỒN VẬN TỐC VÀ CẢM BIẾN ROBOT (M7 / M8 / F8.1 - F8.5).
 */
import { createMockMotionSource } from '@robot-hmi/control-domain/mockMotionSource';
import { createMockMappingSource } from '@robot-hmi/control-domain/mockMappingSource';
import { ADAPTER_CAPABILITIES } from './adapterContract.js';

export function createMockRosAdapter({
    now = () => performance.now(),
    wallNow = () => Date.now(),
    uuid = () => crypto.randomUUID(),
    setEvery = (fn, ms) => setInterval(fn, ms),
    clearEvery = handle => clearInterval(handle),
    sourceHealthy = () => true,
    periodMs = 50,
} = {}) {
    const source = createMockMotionSource({
        now,
        wallNow,
        uuid,
        setEvery,
        clearEvery,
        sourceHealthy,
        periodMs,
    });

    const mappingSource = createMockMappingSource({ now });
    const unsubscribeMappingMotion = source.subscribe(sample => mappingSource.ingest(sample));
    let activeMission = null;
    const disposeSource = source.dispose.bind(source);

    function assertMissionOwner(handle) {
        if (!activeMission || handle !== activeMission) {
            throw Object.assign(new Error('MISSION_RUN_REVOKED'), {
                code: 'MISSION_RUN_REVOKED', status: 409,
            });
        }
    }

    return Object.assign(source, {
        capabilities: ADAPTER_CAPABILITIES,
        motionSource: source,
        getMappingGrid(mappingSessionId) {
            const observation = mappingSource.get(mappingSessionId);
            if (!observation) {
                throw Object.assign(new Error('MAP_NOT_READY'), { code: 'MAP_NOT_READY', status: 503 });
            }
            return observation.snapshot;
        },
        startMapping(mappingSessionId) {
            mappingSource.start(mappingSessionId, source.cursor());
            source.sample();
        },
        finishMapping(mappingSessionId) {
            return mappingSource.stop(mappingSessionId);
        },
        getMappingObservation(mappingSessionId) {
            return mappingSource.get(mappingSessionId);
        },
        subscribeMapping(listener) {
            return mappingSource.subscribe(listener);
        },
        activateMap({ mapId, mapRevision }) {
            return { mapId, mapRevision, status: 'ready' };
        },
        previewRoute({ mapId, mapRevision, poses }) {
            // Nội suy điểm đường đi minh họa (tối thiểu 1 điểm, tối đa 2000 điểm)
            const path = [];
            for (let i = 0; i < poses.length; i++) {
                const current = poses[i];
                path.push({ x: current.x, y: current.y, yaw: current.yaw });
                if (i < poses.length - 1) {
                    const next = poses[i + 1];
                    // Nội suy 3 điểm trung gian giữa mỗi cặp waypoint
                    for (let step = 1; step <= 3; step++) {
                        const t = step / 4;
                        path.push({
                            x: +(current.x + (next.x - current.x) * t).toFixed(3),
                            y: +(current.y + (next.y - current.y) * t).toFixed(3),
                            yaw: +(current.yaw + (next.yaw - current.yaw) * t).toFixed(3),
                        });
                    }
                }
            }
            return path;
        },
        beginMission(missionId) {
            if (activeMission || typeof missionId !== 'string' || !missionId) {
                throw Object.assign(new Error('MISSION_ACTIVE_OR_UNKNOWN'), {
                    code: 'MISSION_ACTIVE_OR_UNKNOWN', status: 409,
                });
            }
            source.ensureStopped();
            activeMission = Object.freeze({ missionId, runId: uuid() });
            return activeMission;
        },
        writeMissionVelocity(handle, velocity) {
            assertMissionOwner(handle);
            return source.writeCommand(velocity);
        },
        finishMission(handle) {
            assertMissionOwner(handle);
            activeMission = null; // Fence callbacks before the zero command.
            return source.ensureStopped();
        },
        cancelMission(handle) {
            if (handle !== activeMission) return false;
            activeMission = null; // Late progress cannot write after stop.
            source.ensureStopped();
            return true;
        },
        dispose() {
            activeMission = null;
            unsubscribeMappingMotion();
            mappingSource.dispose();
            disposeSource();
        },
    });
}
