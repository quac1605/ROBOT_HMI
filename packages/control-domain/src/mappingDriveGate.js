// packages/control-domain/src/mappingDriveGate.js
// Lifecycle của phiên mapping; không thay thế lease owner hoặc stop gate.
// Mọi mutation đồng bộ: không mở cửa sổ acquire giữa check và đổi phase.
const fail = code => { throw Object.assign(new Error(code), { code, status: 409 }); };

export function createMappingDriveGate() {
    let current = null;
    function exact(id) {
        if (!current || current.mappingSessionId !== id) fail('MAPPING_CONTEXT_MISMATCH');
        return current;
    }
    function assertFinish(id) {
        const state = exact(id);
        if (!['active', 'save_failed'].includes(state.phase)) fail('MAPPING_PHASE_BLOCKED');
    }
    return {
        beginSession(id) {
            if (typeof id !== 'string' || !id || id.length > 128) fail('MAPPING_CONTEXT_MISMATCH');
            if (current) fail('MAPPING_ACTIVE_OR_UNKNOWN');
            current = { mappingSessionId: id, phase: 'starting' };
        },
        activateSession(id) {
            const state = exact(id);
            if (state.phase !== 'starting') fail('MAPPING_PHASE_BLOCKED');
            state.phase = 'active';
        },
        canDrive(id) {
            return current?.mappingSessionId === id && current.phase === 'active';
        },
        getState() { return current ? { ...current } : null; },
        assertFinish,
        beginFinish(id) {
            assertFinish(id);
            current.phase = 'finishing';
        },
        finishFailed(id) {
            const state = exact(id);
            if (state.phase !== 'finishing') fail('MAPPING_PHASE_BLOCKED');
            // Cho retry save; KHÔNG tự mở lại joystick sau một lỗi lưu.
            state.phase = 'save_failed';
        },
        finishSucceeded(id) {
            if (exact(id).phase !== 'finishing') fail('MAPPING_PHASE_BLOCKED');
            current = null;
        },
        clearSession(id) {
            // Callback/logout cũ không được xóa phiên mới.
            if (current?.mappingSessionId !== id) return false;
            current = null;
            return true;
        },
    };
}
