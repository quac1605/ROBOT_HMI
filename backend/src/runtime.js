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
import { createCmdInService } from './services/cmdInService.js';
import { createRosbridgeCmdInPublisher } from './ros/rosbridgeCmdInPublisher.js';
import { createRosStatusService } from './services/rosStatusService.js';
import { createRosbridgeClient } from './ros/rosbridgeClient.js';
import { createRosMapService } from './ros/rosMapService.js';
import { loadRosStatusSpec } from './ros/rosStatusSpec.js';

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
        mapPose: null,
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
    rosStatusSpecPath,
}) {
    const sharedRobotState = createBackendRobotState();
    const motionGate = createMotionAdmissionGate();
    const mappingDriveGate = createMappingDriveGate();

    // Một rosbridge dùng chung: publish /cmd_in; subscribe /odom, /cmd_out và TF.
    // Không có ROSBRIDGE_URL thì backend không nối ROS, giữ hành vi mock cũ.
    const rosStatusSpec = config?.ROSBRIDGE_URL ? loadRosStatusSpec(rosStatusSpecPath) : null;
    const rosbridge = rosStatusSpec ? createRosbridgeClient({
        url: config.ROSBRIDGE_URL,
        reconnectMs: rosStatusSpec.bridge.reconnect_ms,
        logger,
    }) : null;
    const cmdInPublishers = rosbridge ? [createRosbridgeCmdInPublisher({ client: rosbridge })] : [];
    const cmdInService = createCmdInService({ publishers: cmdInPublishers, logger });
    // Vào phiên tạo bản đồ thì /cmd_in chuyển sang mode slam.
    const unsubscribeCmdInRobotState = sharedRobotState.subscribe(state => cmdInService.onRobotState(state));

    const adapter = createMockRosAdapter({
        sourceHealthy: () => {
            const state = sharedRobotState.getSnapshot();
            return state.rosConnected === true;
        },
        onMotionCommand: command => cmdInService.onMotionCommand(command),
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
        // Chỉ dừng do người dùng chọn mới đổi /cmd_in sang stop; nhả joystick giữ nguyên mode.
        onStopRequested: request => { if (!request?.keepMode) cmdInService.emergencyStop(); },
        // Bật quyền lái là người dùng chọn mode: trang tạo bản đồ là slam, trang điều hướng là manual.
        onControlClaimed: context => cmdInService.setMode(context.kind === 'mapping' ? 'SLAM' : 'MANUAL'),
        onControlReleased: context => { if (context.kind === 'manual') cmdInService.setMode('AUTO'); },
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
    const rosMapService = createRosMapService({
        enabled: config.ROS_MAP_ENABLED === 'true',
        setupPath: config.ROS_MAP_SETUP,
        logger,
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
        getOriginalPosition: () => cmdInService.getOriginalPosition(),
    });

    const cameraService = createCameraService({
        mode: config.CAMERA_MEDIA_MODE,
        whepBaseUrl: config.CAMERA_WHEP_BASE_URL,
        lifecycle,
    });

    // Trạng thái thật từ ROS 2 qua kết nối rosbridge dùng chung.
    let rosStatusService = null;
    if (rosbridge) {
        rosStatusService = createRosStatusService({
            sharedRobotState,
            spec: rosStatusSpec,
            client: rosbridge,
            logger,
            mapFrameId: () => {
                const metadata = rosMapService.getMetadata();
                return metadata.status === 'ready' ? metadata.geometry.frameId : null;
            },
            ownsClient: false,
        });
        // Đăng ký /cmd_in, /cmd_out, /odom và TF trước khi mở kết nối.
        rosbridge.start();
        rosStatusService.start();
    }
    rosMapService.start();

    function publishMappingPose() {
        // Có /odom thật thì pose mock của mapping không được ghi đè lên.
        if (rosStatusService) return;
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
        rosMapService,
        jobService,
        mappingService,
        mapActivationService: mapActivationServiceInstance,
        routesRepo,
        missionsRepo,
        routeService,
        missionService: missionServiceInstance,
        cameraService,
        cmdInService,
        rosStatusService,
        dispose() {
            rosStatusService?.dispose();
            cameraService.dispose();
            clearInterval(mappingAgeTimer);
            unsubscribeMappingPose();
            mapGridService.dispose();
            rosMapService.dispose();
            missionServiceInstance.dispose();
            robotStateService.dispose();
            controlSubjectRegistry.dispose();
            controlAuthority.dispose();
            adapter.dispose();
            unsubscribeCmdInRobotState();
            cmdInService.dispose();
            rosbridge?.dispose();
        },
    };
}
