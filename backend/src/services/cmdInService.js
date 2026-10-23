/** Build and publish accepted /cmd_in commands. No live command is emitted at startup. */
import {
    CmdInModeSchema, PlanarPoseSchema, PoseStampedSchema, SetTargetRequestSchema,
    buildCmdInMessage, poseToPoseStamped,
} from '@robot-hmi/contracts/cmdIn';
import { ZERO } from '@robot-hmi/control-domain/controlPolicy';

const conflict = code => Object.assign(new Error(code), { code, status: 409 });

export function createCmdInService({
    publishers = [], logger = null, now = () => Date.now(), getSafetyState = () => null,
} = {}) {
    let mode = 'STOP';
    let target = [];
    let originalPlanar = null;
    let originalPosition = null;
    let mappingActive = false;
    let navigationActive = false;
    let disposed = false;

    function publish(velocity = ZERO) {
        if (disposed) return;
        const message = buildCmdInMessage({ mode, velocity, target, originalPosition });
        for (const publisher of publishers) {
            try { publisher.publish(message); }
            catch (error) { logger?.warn?.({ err: error }, 'cmd_in publish failed'); }
        }
    }

    function setMode(nextMode) {
        CmdInModeSchema.parse(nextMode);
        mode = nextMode;
        if (nextMode !== 'AUTO') target = [];
        publish(ZERO);
    }

    function assertAutoSafe() {
        const state = getSafetyState();
        if (state?.physicalEstopActive !== false) throw conflict('ESTOP_ACTIVE_OR_UNKNOWN');
        if (state.motionInhibited !== false) throw conflict('MOTION_INHIBITED_OR_UNKNOWN');
        if (state.rosConnected !== true) throw conflict('ROS_UNAVAILABLE');
    }

    function setTarget(raw) {
        if (disposed) throw conflict('SERVICE_DISPOSED');
        if (navigationActive || mappingActive) throw conflict('TARGET_DURING_MISSION');
        assertAutoSafe();
        const stamp = now();
        target = Array.isArray(raw) && raw.length > 0 && raw.every(pose => pose?.header)
            ? raw.map(pose => PoseStampedSchema.parse(pose))
            : SetTargetRequestSchema.parse({ target: raw }).target.map(pose => poseToPoseStamped(pose, { stamp }));
        mode = 'AUTO';
        publish(ZERO);
        return structuredClone(target);
    }

    function setOriginalPose(raw) {
        if (disposed) throw conflict('SERVICE_DISPOSED');
        if (navigationActive || mappingActive) throw conflict('ORIGINAL_POSITION_DURING_MISSION');
        assertAutoSafe();
        if (raw?.header) {
            originalPosition = PoseStampedSchema.parse(raw);
            const q = originalPosition.pose.orientation;
            originalPlanar = { x: originalPosition.pose.position.x, y: originalPosition.pose.position.y,
                theta: 2 * Math.atan2(q.z, q.w) };
        } else {
            originalPlanar = PlanarPoseSchema.parse(raw);
            originalPosition = poseToPoseStamped(originalPlanar, { stamp: now() });
        }
        mode = 'AUTO';
        publish(ZERO);
        return { ...originalPlanar };
    }

    return {
        setMode,
        setTarget,
        getTarget: () => structuredClone(target),
        setOriginalPose,
        setOriginalPosition: setOriginalPose,
        getOriginalPosition: () => (originalPlanar ? { ...originalPlanar } : null),
        getMode: () => mode,
        onMotionCommand({ origin, velocity = ZERO, poses }) {
            if (origin === 'mission') {
                if (Array.isArray(poses) && poses.length) {
                    const stamp = now();
                    target = poses.map(pose => poseToPoseStamped(
                        { x: pose.x, y: pose.y, theta: pose.yaw }, { stamp }));
                    mode = 'AUTO';
                }
                if (mode === 'AUTO') publish(ZERO);
            } else if (origin === 'teleop') {
                // Only an accepted lease or mapping session may have selected a drive mode.
                if (mode === 'MANUAL' || mode === 'SLAM') publish(velocity);
                else publish(ZERO);
            } else if (origin === 'cancel') {
                setMode('STOP');
            } else if (origin === 'stop') {
                publish(ZERO);
            }
        },
        onRobotState(state) {
            navigationActive = Boolean(state?.activeMissionId) || state?.mode === 'navigating';
            const active = state?.mode === 'mapping';
            if (active && !mappingActive) {
                mappingActive = true;
                setMode('SLAM');
            } else if (!active && mappingActive) {
                mappingActive = false;
                setMode('STOP');
            }
        },
        emergencyStop: () => setMode('STOP'),
        // Compatibility for the control authority hook.
        selectMode: setMode,
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const publisher of publishers) {
                try { publisher.dispose?.(); } catch { /* isolate publisher */ }
            }
        },
    };
}
