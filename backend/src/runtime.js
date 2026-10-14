/**
 * backend/src/runtime.js
 * 
 * ROBOT RUNTIME & SINGLE AUTHORITY COMPOSITION (M8 / F8.1 - F8.6).
 */
import { createMotionAdmissionGate } from '@robot-hmi/control-domain/motionAdmissionGate';
import { createMappingDriveGate } from '@robot-hmi/control-domain/mappingDriveGate';
import { createControlAuthority } from '@robot-hmi/control-domain/controlAuthority';
import { RobotStateSchema } from '@robot-hmi/contracts/robotState';
import { createMockRosAdapter } from './ros/mockRosAdapter.js';
import { createControlSubjectRegistry } from './control/controlSubjectRegistry.js';
import { createRobotStateService } from './services/robotStateService.js';
import { createMapGridService } from './services/mapGridService.js';
import { createJobService } from './services/jobService.js';
import { createMappingService } from './services/mappingService.js';
import { createMapActivationService } from './services/mapActivationService.js';
import { createRoutesRepository } from './repositories/routes.js';
import { createMissionsRepository } from './repositories/missions.js';
import { createRouteService } from './services/routeService.js';
import { createMissionService } from './services/missionService.js';
import { createCameraService } from './services/cameraService.js';

function createInitialRobotState() {
    return {
        robotId: 'robot-01',
        mode: 'idle',
        rosConnected: false,
        localization: { status: 'unknown', reason: 'STARTUP_UNINITIALIZED' },
        activeMap: null,
        activeMappingSessionId: null,
        activeMissionId: null,
        motionInhibited: true,
        motionInhibitReason: 'STARTUP_UNINITIALIZED',
        pose: null,
        poseSourceUpdateAgeMs: null,
        velocity: { linearX: 0, angularZ: 0 },
        batteryPercent: null,
        physicalEstopActive: null,
        receivedAt: new Date().toISOString(),
    };
}

export function createBackendRobotState() {
    let current = createInitialRobotState();
    const listeners = new Set();

    return {
        getSnapshot: () => structuredClone(current),
        update(patch) {
            const next = typeof patch === 'function' ? patch(structuredClone(current)) : patch;
            const candidate = {
                ...current,
                ...next,
                receivedAt: new Date().toISOString(),
            };
            const validated = RobotStateSchema.parse(candidate);
            current = structuredClone(validated);
            for (const l of listeners) {
                try { l(structuredClone(current)); } catch { /* ignore */ }
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

export function createRobotRuntime({
    pool,
    config,
    logger,
    lifecycle,
    connectionRegistry,
    mapPersistence,
    assetStore,
}) {
    const sharedRobotState = createBackendRobotState();
    const motionGate = createMotionAdmissionGate();
    const mappingDriveGate = createMappingDriveGate();

    const adapter = createMockRosAdapter({
        sourceHealthy: () => {
            const state = sharedRobotState.getSnapshot();
            return state.rosConnected === true;
        },
    });

    const telemetry = {
        getControlState: () => ({
            snapshot: sharedRobotState.getSnapshot(),
            transportStale: false,
        }),
    };

    let missionServiceInstance = null;
    let mapActivationServiceInstance = null;

    const controlAuthority = createControlAuthority({
        sharedRobotState,
        telemetry,
        missionService: {
            stopForControl: () => missionServiceInstance?.stopForControl?.(),
        },
        mapActivationService: {
            stopForControl: () => mapActivationServiceInstance?.stopForControl?.(),
        },
        motionGate,
        motionSource: adapter,
        mappingDriveGate,
    });

    const controlSubjectRegistry = createControlSubjectRegistry(controlAuthority);

    const robotStateService = createRobotStateService({
        sharedRobotState,
        registry: connectionRegistry,
        lifecycle,
    });

    const mapGridService = createMapGridService({
        pool,
        mapPersistence,
        adapter,
        registry: connectionRegistry,
        lifecycle,
    });

    const jobService = createJobService({
        pool,
        registry: connectionRegistry,
        lifecycle,
    });

    const mappingService = createMappingService({
        pool,
        mapPersistence,
        adapter,
        motionGate,
        mappingDriveGate,
        assertMappingFinishSafe: id => controlAuthority.assertMappingFinishSafe(id),
        sharedRobotState,
        jobService,
        lifecycle,
    });

    mapActivationServiceInstance = createMapActivationService({
        pool,
        mapPersistence,
        adapter,
        motionGate,
        sharedRobotState,
        jobService,
    });

    const routesRepo = createRoutesRepository(pool);
    const missionsRepo = createMissionsRepository(pool);

    const routeService = createRouteService({
        pool,
        routesRepo,
        mapPersistence,
        adapter,
        jobService,
    });

    missionServiceInstance = createMissionService({
        pool,
        missionsRepo,
        mapPersistence,
        adapter,
        motionGate,
        sharedRobotState,
        registry: connectionRegistry,
        lifecycle,
    });

    const cameraService = createCameraService({
        mode: config.CAMERA_MEDIA_MODE,
        whepBaseUrl: config.CAMERA_WHEP_BASE_URL,
        lifecycle,
    });

    function publishMappingPose() {
        const state = sharedRobotState.getSnapshot();
        if (state.mode !== 'mapping' || !state.activeMappingSessionId) return;
        let observation;
        try { observation = adapter.getMappingObservation(state.activeMappingSessionId); }
        catch { return; }
        if (!observation) return;
        sharedRobotState.update({
            pose: observation.pose,
            poseSourceUpdateAgeMs: observation.lastSourceUpdateAgeMs,
            // Chỉ nguồn mới chứng minh tracking; heartbeat stale không giả tạo pose mới.
            localization: observation.sourceState === 'live'
                ? { status: 'tracking', reason: null }
                : { status: 'lost', reason: 'MAPPING_POSE_STALE' },
        });
    }
    const unsubscribeMappingPose = adapter.subscribeMapping(publishMappingPose);
    const mappingAgeTimer = setInterval(publishMappingPose, 200);
    mappingAgeTimer.unref?.();

    return {
        sharedRobotState,
        motionGate,
        mappingDriveGate,
        adapter,
        controlAuthority,
        controlSubjectRegistry,
        robotStateService,
        mapGridService,
        jobService,
        mappingService,
        mapActivationService: mapActivationServiceInstance,
        routesRepo,
        missionsRepo,
        routeService,
        missionService: missionServiceInstance,
        cameraService,
        dispose() {
            cameraService.dispose();
            clearInterval(mappingAgeTimer);
            unsubscribeMappingPose();
            mapGridService.dispose();
            missionServiceInstance.dispose();
            robotStateService.dispose();
            controlSubjectRegistry.dispose();
            controlAuthority.dispose();
            adapter.dispose();
        },
    };
}
