/**
 * backend/src/ros/rosbridgeClient.js
 *
 * CLIENT TỐI GIẢN CHO GIAO THỨC ROSBRIDGE V2 (WebSocket + JSON) CỦA ROS 2.
 * Một kết nối dùng chung cho cả subscribe (/odom, /cmd_in) và publish (/cmd_out).
 * Tự kết nối lại khi mất kết nối; sau mỗi lần mở đăng ký lại toàn bộ topic.
 */
import { WebSocket } from 'ws';

export function createRosbridgeClient({
    url,
    reconnectMs = 2000,
    WebSocketImpl = WebSocket,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle),
    logger,
}) {
    const subscriptions = new Map();
    const advertisements = new Map();
    let socket = null;
    let reconnectTimer = null;
    let connected = false;
    let connectionEpoch = 0;
    let started = false;
    let disposed = false;

    function subscribeOp(topic, sub) {
        return {
            op: 'subscribe',
            id: `hmi:${topic}`,
            topic,
            type: sub.type,
            throttle_rate: sub.throttleMs,
            queue_length: 1,
            ...(sub.qos ? { qos: sub.qos } : {}),
        };
    }

    const sendOp = (ws, op) => ws.send(JSON.stringify(op));
    const publishOp = (topic, msg) => ({ op: 'publish', topic, msg });

    function setConnected(value) {
        if (connected === value) return;
        connected = value;
        logger?.info({ url, connected }, 'rosbridge connection changed');
    }

    function scheduleReconnect() {
        if (disposed || reconnectTimer) return;
        reconnectTimer = setTimer(connect, reconnectMs);
        reconnectTimer?.unref?.();
    }

    function connect() {
        reconnectTimer = null;
        if (disposed) return;
        let ws;
        try {
            ws = new WebSocketImpl(url);
        } catch {
            scheduleReconnect();
            return;
        }
        socket = ws;
        ws.on('open', () => {
            if (socket !== ws) return;
            connectionEpoch++;
            setConnected(true);
            for (const [topic, sub] of subscriptions) sendOp(ws, subscribeOp(topic, sub));
            for (const [topic, adv] of advertisements) {
                sendOp(ws, { op: 'advertise', id: `hmi:${topic}`, topic, type: adv.type });
                // Topic tự quyết định có phát lại gì sau khi nối lại (ví dụ gói cuối với vận tốc 0).
                let replay = null;
                try { replay = adv.onReconnect?.() ?? null; } catch { /* cô lập lỗi callback */ }
                if (replay) sendOp(ws, publishOp(topic, replay));
            }
        });
        ws.on('message', data => {
            if (socket !== ws) return;
            let message;
            try { message = JSON.parse(String(data)); } catch { return; }
            if (message?.op !== 'publish') return;
            const sub = subscriptions.get(message.topic);
            if (!sub) return;
            try { sub.handler(message.msg); } catch { /* lỗi handler không làm đứt kết nối */ }
        });
        // 'close' luôn theo sau 'error', việc kết nối lại xử lý ở đó.
        ws.on('error', () => {});
        ws.on('close', () => {
            if (socket !== ws) return;
            socket = null;
            setConnected(false);
            scheduleReconnect();
        });
    }

    return {
        subscribe(topic, { type, throttleMs = 0, qos = null }, handler) {
            if (started) throw new Error('ROSBRIDGE_SUBSCRIBE_AFTER_START');
            subscriptions.set(topic, { type, throttleMs, qos, handler });
        },
        advertise(topic, { type, onReconnect = null }) {
            if (started) throw new Error('ROSBRIDGE_ADVERTISE_AFTER_START');
            advertisements.set(topic, { type, onReconnect });
        },
        // Không xếp hàng: mất kết nối thì gói bị bỏ, trả false để caller biết.
        publish(topic, msg) {
            if (!advertisements.has(topic)) throw new Error('ROSBRIDGE_TOPIC_NOT_ADVERTISED');
            if (!connected || !socket) return false;
            sendOp(socket, publishOp(topic, msg));
            return true;
        },
        start() {
            if (started || disposed) return;
            started = true;
            connect();
        },
        isConnected: () => connected,
        getConnectionEpoch: () => connectionEpoch,
        dispose() {
            if (disposed) return;
            disposed = true;
            if (reconnectTimer) clearTimer(reconnectTimer);
            reconnectTimer = null;
            const ws = socket;
            socket = null;
            connected = false;
            ws?.terminate?.();
            subscriptions.clear();
            advertisements.clear();
        },
    };
}
