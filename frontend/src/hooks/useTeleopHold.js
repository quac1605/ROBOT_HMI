// hooks/useTeleopHold.js
import { useEffect, useRef, useCallback } from 'react';
import { createTeleopHoldController } from '../utils/teleopHoldController.js';
import { useControlStore } from '../state/controlStore.js';

// getLatest, sendVelocity, requestStop, onError phải là STABLE references.
// Dùng module-level functions hoặc useCallback với deps ổn định.
// Nếu truyền arrow mới mỗi render → cleanup/recreate liên tục → bug.
export function useTeleopHold({ getLatest, sendVelocity, requestStop, onError }) {
    const controllerRef = useRef(null);

    useEffect(() => {
        const hold = createTeleopHoldController({
            getLatest, sendVelocity, requestStop, onError,
        });
        controllerRef.current = hold;
        // Stop action đánh dấu stopUnconfirmed đồng bộ. Fence publisher ngay
        // trong notification đó, kể cả React chưa render disabled trên joystick.
        const unsubscribeControl = useControlStore.subscribe(() => {
            if (hold.isActive() && !getLatest().allowed) hold.stop('CONTROL_GUARD_CHANGED');
        });

        // Dừng khi window mất focus
        const onBlur = () => hold.stop('BLUR');
        // Dừng khi tab bị ẩn (Tab Visibility API)
        const onVisibility = () => { if (document.hidden) hold.stop('HIDDEN'); };

        window.addEventListener('blur', onBlur);
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            window.removeEventListener('blur', onBlur);
            document.removeEventListener('visibilitychange', onVisibility);
            unsubscribeControl();
            hold.dispose(); // Gọi stop('UNMOUNT') bên trong
            if (controllerRef.current === hold) controllerRef.current = null;
        };
    }, [getLatest, sendVelocity, requestStop, onError]);

    const start = useCallback(
        (owner, vector) => controllerRef.current?.start(owner, vector) ?? false,
        [],
    );
    const update = useCallback(
        (owner, vector) => controllerRef.current?.update(owner, vector) ?? false,
        [],
    );
    const stop = useCallback(
        (reason, owner) => controllerRef.current?.stop(reason, owner) ?? false,
        [],
    );

    return { start, update, stop };
}
