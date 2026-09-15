export function createSharedRobotState(initialSnapshot) {
    let currentSnapshot = structuredClone(initialSnapshot);
    const listeners = new Set();

    return {
        getSnapshot() {
            return structuredClone(currentSnapshot);
        },
        update(updater) {
            const next = typeof updater === 'function' ? updater(structuredClone(currentSnapshot)) : updater;
            // Clone sâu patch đầu vào để ngăn chặn mutation từ bên ngoài
            const clonedPatch = structuredClone(next);
            currentSnapshot = structuredClone({ ...currentSnapshot, ...clonedPatch });

            // Mỗi listener nhận một bản clone độc lập
            listeners.forEach((listener) => {
                try {
                    listener(structuredClone(currentSnapshot));
                } catch (err) {
                    console.error('Lỗi listener RobotState:', err);
                }
            });
            return structuredClone(currentSnapshot);
        },
        subscribe(listener) {
            // Initial delivery may execute application code. If it throws,
            // do not retain a listener for which the caller never received an
            // unsubscribe handle.
            listener(structuredClone(currentSnapshot));
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        reset(snapshot) {
            currentSnapshot = structuredClone(snapshot);
            listeners.forEach((listener) => {
                try {
                    listener(structuredClone(currentSnapshot));
                } catch (err) {
                    console.error('Lỗi listener RobotState:', err);
                }
            });
        },
    };
}
