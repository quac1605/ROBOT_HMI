/**
 * backend/src/services/robotStateService.js
 * 
 * QUẢN LÝ SNAPSHOT VÀ STREAM TRẠNG THÁI ROBOT (M8 / F8.1).
 * Tuân thủ nghiêm ngặt RobotStateSchema: deep clone, không rò rỉ mutable ref,
 * source age không bị heartbeat làm mới.
 */
import { RobotStateSchema } from '@robot-hmi/contracts/robotState';

export function createRobotStateService({ sharedRobotState, registry, lifecycle }) {
    let sequence = 0;

    function getRobotState() {
        const snapshot = sharedRobotState.getSnapshot();
        return RobotStateSchema.parse(snapshot);
    }

    function stateFrame(state) {
        const validState = RobotStateSchema.parse(state);
        return {
            version: 1,
            type: 'robot.state',
            streamEpoch: lifecycle?.authBootEpoch || 'epoch-1',
            sequence: ++sequence,
            sentAt: new Date().toISOString(),
            payload: validState,
        };
    }

    function broadcastState(state) {
        if (!registry) return;
        registry.broadcastApp(stateFrame(state));
    }

    function sendSnapshot(connectionId) {
        if (!registry) return false;
        return registry.send(connectionId, stateFrame(getRobotState()));
    }

    const unsubscribe = sharedRobotState.subscribe(state => {
        try {
            broadcastState(state);
        } catch {
            /* ignore broadcast error if closed */
        }
    });

    return {
        getRobotState,
        broadcastState,
        sendSnapshot,
        dispose() {
            unsubscribe();
        },
    };
}
