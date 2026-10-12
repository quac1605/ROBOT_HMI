// components/ControlOperationCoordinator.jsx
import { useEffect, useMemo, useRef } from 'react';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { createControlCoordinator } from '../utils/controlCoordinator.js';
import { useControlStore } from '../state/controlStore.js';
import { createControlStopAction } from '../utils/controlStopAction.js';
import { ControlActionsContext } from '../hooks/useControlActions.js';

export default function ControlOperationCoordinator({ children }) {
    const client = useRobotClient();
    const actionRef = useRef(null);
    const actions = useMemo(() => ({
        requestStop(options) {
            if (!actionRef.current) return Promise.reject(new Error('CONTROL_ACTION_NOT_READY'));
            return actionRef.current.request(options);
        },
    }), []);

    useEffect(() => {
        let alive = true;
        const stopAction = createControlStopAction({
            client,
            onPending(requestId) {
                if (!alive) return;
                useControlStore.getState().setControlState({
                    pendingStopRequestId: requestId, stopUnconfirmed: true,
                    stopRequestPhase: 'pending', controlError: null,
                    stopState: { requestId, status: 'requested', confirmation: null },
                });
            },
            onAccepted(requestId) {
                const state = useControlStore.getState();
                if (alive && state.pendingStopRequestId === requestId) {
                    state.setControlState({ stopRequestPhase: 'accepted' });
                }
            },
            onError(requestId, error) {
                const state = useControlStore.getState();
                if (alive && state.pendingStopRequestId === requestId) {
                    state.setControlState({ stopRequestPhase: 'uncertain', controlError: error.message });
                }
            },
        });
        actionRef.current = stopAction;
        const coordinator = createControlCoordinator(client);
        return () => {
            alive = false;
            coordinator.dispose();
            // Keep the action alive until descendant passive cleanup has sent
            // its best-effort stop; never lose it on an ordinary page switch.
            queueMicrotask(() => {
                stopAction.dispose();
                if (actionRef.current === stopAction) actionRef.current = null;
            });
            // Reset store khi auth boundary (không phải khi chuyển page)
            useControlStore.getState().setControlState({
                phase: 'idle', ready: false, controlProfile: 'unknown',
                lease: null, heartbeatReceivedAt: null,
                freshnessToken: null, tokenDeadline: null, leaseDeadline: null,
                stopUnconfirmed: false, stopState: null,
                pendingStopRequestId: null, stopRequestPhase: null, controlError: null,
                commandResult: null, controlGeneration: 0, hardwareReady: false,
                cameraId: null, generation: 0, lastFrameAt: null, cameraError: null,
            });
        };
    }, [client]);

    return <ControlActionsContext.Provider value={actions}>{children}</ControlActionsContext.Provider>;
}
