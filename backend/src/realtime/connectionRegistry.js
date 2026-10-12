/**
 * backend/src/realtime/connectionRegistry.js
 * 
 * BẢNG ĐĂNG KÝ QUẢN LÝ KẾT NỐI WEBSOCKET THEO DANH TÍNH TAB VÀ SESSION (M6 / F6.2).
 */
import { createOutboundQueue } from './outboundQueue.js';

export function createConnectionRegistry() {
    // Map lưu trữ: connectionId -> ConnectionRecord
    const connections = new Map();
    // Map chỉ mục ngược: sessionId -> Set<connectionId> để thu hồi nhanh khi logout
    const sessionToConnections = new Map();

    /**
     * Đăng ký một kết nối WebSocket mới vào registry
     */
    function register(record) {
        if (!record.connectionId || !record.sessionId) {
            throw new Error('INVALID_CONNECTION_RECORD: Thiếu connectionId hoặc sessionId');
        }
        if (connections.has(record.connectionId)) {
            throw new Error('DUPLICATE_CONNECTION_ID');
        }

        record.outbound = createOutboundQueue({
            ws: record.ws, kind: record.kind,
            onFailure: reason => revoke(record.connectionId, reason),
        });
        connections.set(record.connectionId, record);

        if (!sessionToConnections.has(record.sessionId)) {
            sessionToConnections.set(record.sessionId, new Set());
        }
        sessionToConnections.get(record.sessionId).add(record.connectionId);
    }

    /**
     * Lấy thông tin record của một connection
     */
    function get(connectionId) {
        return connections.get(connectionId);
    }

    /**
     * Thu hồi và đóng một kết nối cụ thể (idempotent)
     */
    function revoke(connectionId, reason = 'REVOKED') {
        const record = connections.get(connectionId);
        if (!record) return;

        // Đánh dấu closed đồng bộ trước khi thực hiện tác vụ mạng
        record.closed = true;
        connections.delete(connectionId);
        record.outbound?.dispose();

        const connSet = sessionToConnections.get(record.sessionId);
        if (connSet) {
            connSet.delete(connectionId);
            if (connSet.size === 0) {
                sessionToConnections.delete(record.sessionId);
            }
        }

        // Hủy toàn bộ subscription nếu có gắn vào record này
        if (record.subscriptions && typeof record.subscriptions[Symbol.iterator] === 'function') {
            for (const unsubscribe of record.subscriptions) {
                try { unsubscribe(); } catch { /* Fence stays closed. */ }
            }
            record.subscriptions.clear();
        }

        try { record.onRevoke?.(reason); } catch { /* Registry fence remains closed. */ }

        // Đóng WebSocket nếu còn mở
        try {
            if (record.ws && (record.ws.readyState === 0 || record.ws.readyState === 1)) {
                record.ws.close(1008, reason);
                const timer = setTimeout(() => record.ws.terminate(), 250);
                timer.unref?.();
            }
        } catch {
            /* ignore close error */
        }
    }

    /**
     * Chấm dứt toàn bộ kết nối thuộc một sessionId khi user Logout hoặc Session hết hạn
     */
    function terminateSession(sessionId, reason = 'SESSION_TERMINATED') {
        const connSet = sessionToConnections.get(sessionId);
        if (!connSet) return;

        const ids = Array.from(connSet);
        for (const connId of ids) {
            revoke(connId, reason);
        }
        sessionToConnections.delete(sessionId);
    }

    /**
     * Đóng toàn bộ socket khi server shutdown
     */
    function closeAll() {
        for (const [connId] of connections) {
            revoke(connId, 'SERVER_SHUTDOWN');
        }
        connections.clear();
        sessionToConnections.clear();
    }

    function size() {
        return connections.size;
    }

    function send(connectionId, frame) {
        const record = connections.get(connectionId);
        if (!record || record.closed) return false;
        try { record.watcher?.assertFresh(); }
        catch { revoke(connectionId, 'AUTH_PROOF_EXPIRED'); return false; }
        return record.outbound.enqueue(frame);
    }

    function broadcastApp(frame) {
        let sent = 0;
        for (const [connId, record] of connections) {
            if (record.kind === 'app' && !record.closed) {
                if (send(connId, frame)) sent++;
            }
        }
        return sent;
    }

    function broadcastMap(frame) {
        let sent = 0;
        for (const [connId, record] of connections) {
            if (record.kind === 'map' && !record.closed) {
                if (send(connId, frame)) sent++;
            }
        }
        return sent;
    }

    return {
        register,
        get,
        revoke,
        terminateSession,
        closeAll,
        size,
        send,
        broadcastApp,
        broadcastMap,
    };
}
