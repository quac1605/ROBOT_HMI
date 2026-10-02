/**
 * backend/src/ros/mockRosAdapter.js
 * 
 * ADAPTER MÔ PHỎNG NGUỒN VẬN TỐC VÀ CẢM BIẾN ROBOT (M7 / M8 / F8.1 - F8.5).
 */
import { createMockMotionSource } from '@robot-hmi/control-domain/mockMotionSource';
import { ADAPTER_CAPABILITIES } from './adapterContract.js';

function createRoomGrid(mappingSessionId, step = 0) {
    const width = 200;
    const height = 160;
    const cells = new Array(width * height).fill(-1);
    for (let r = 10; r < height - 10; r++) {
        for (let c = 10; c < width - 10; c++) {
            cells[c + r * width] = 0;
        }
    }
    for (let r = 10; r < height - 10; r++) {
        cells[10 + r * width] = 100;
        cells[width - 11 + r * width] = 100;
    }
    for (let c = 10; c < width - 10; c++) {
        cells[c + 10 * width] = 100;
        cells[c + (height - 11) * width] = 100;
    }
    return {
        source: 'mock',
        mode: 'snapshot',
        encoding: 'occupancy-0-100-v1',
        context: { kind: 'mapping', mappingSessionId },
        gridRevision: step + 1,
        grid: {
            header: { frame_id: 'map', stamp: { sec: 100, nanosec: 0 } },
            info: {
                map_load_time: { sec: 100, nanosec: 0 },
                resolution: 0.05,
                width,
                height,
                origin: {
                    position: { x: 0, y: 0, z: 0 },
                    orientation: { x: 0, y: 0, z: 0, w: 1 },
                },
            },
            data: cells,
        },
    };
}

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

    const mappingGrids = new Map();
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
            if (!mappingGrids.has(mappingSessionId)) {
                throw Object.assign(new Error('MAPPING_GRID_UNAVAILABLE'), {
                    code: 'MAPPING_GRID_UNAVAILABLE',
                    status: 503,
                });
            }
            return structuredClone(mappingGrids.get(mappingSessionId));
        },
        startMapping(mappingSessionId) {
            mappingGrids.set(mappingSessionId, createRoomGrid(mappingSessionId, 0));
        },
        finishMapping(mappingSessionId) {
            mappingGrids.delete(mappingSessionId);
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
            mappingGrids.clear();
            disposeSource();
        },
    });
}
