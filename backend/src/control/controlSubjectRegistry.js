/**
 * backend/src/control/controlSubjectRegistry.js
 * 
 * QUẢN LÝ ÁNH XẠ CONTROL SUBJECT INTERNAL CHO WEBSOCKET TABS VÀ HTTP SESSIONS (M7 / F7.1).
 * Không expose internal subjectId ra browser; phân tách quyền lái app vs stop-only session.
 */
export function createControlSubjectRegistry(authority) {
    const connSubjects = new Map(); // connectionId -> subjectId
    const sessionSubjects = new Map(); // sessionId -> subjectId

    return {
        /**
         * Lấy hoặc tạo subjectId đầy đủ quyền cho kết nối WebSocket tab ứng dụng.
         */
        getOrCreateAppSubject(connectionId) {
            if (!connSubjects.has(connectionId)) {
                const subjectId = `conn:${connectionId}`;
                authority.createSession(subjectId, { stopOnly: false });
                connSubjects.set(connectionId, subjectId);
            }
            return connSubjects.get(connectionId);
        },

        /**
         * Lấy hoặc tạo subjectId loại STOP-ONLY cho HTTP session (dừng khẩn cấp không cần WS).
         */
        getOrCreateStopSubject(sessionId) {
            if (!sessionSubjects.has(sessionId)) {
                const subjectId = `session:${sessionId}`;
                authority.createSession(subjectId, { stopOnly: true });
                sessionSubjects.set(sessionId, subjectId);
            }
            return sessionSubjects.get(sessionId);
        },

        stopSubjectFor(sessionId) {
            return this.getOrCreateStopSubject(sessionId);
        },

        appSubjectFor(connectionId) {
            return connSubjects.get(connectionId) || null;
        },

        removeAppSubject(connectionId) {
            const subjectId = connSubjects.get(connectionId);
            if (subjectId) {
                connSubjects.delete(connectionId);
                authority.revokeSession(subjectId);
            }
        },

        removeSessionSubject(sessionId) {
            const subjectId = sessionSubjects.get(sessionId);
            if (subjectId) {
                sessionSubjects.delete(sessionId);
                authority.revokeSession(subjectId);
            }
        },

        dispose() {
            for (const subjectId of connSubjects.values()) {
                try { authority.revokeSession(subjectId); } catch { /* ignore */ }
            }
            for (const subjectId of sessionSubjects.values()) {
                try { authority.revokeSession(subjectId); } catch { /* ignore */ }
            }
            connSubjects.clear();
            sessionSubjects.clear();
        },
    };
}
