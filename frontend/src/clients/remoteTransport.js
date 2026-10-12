import {
    TransportHelloSchema, MapTransportHelloSchema, ConnectionStatusSchema,
    HttpErrorPayloadSchema,
} from '@robot-hmi/contracts/transport';
import { boundedUtf8StringLength, parseRawMapMessage } from '@robot-hmi/contracts/mapGrid';

const MAX_APP_BYTES = 512 * 1024;
const MAX_PENDING = 64;
const CSRF_TOKEN = /^[0-9a-fA-F]{64}$/;

function transportError(code, extra = {}) {
    return Object.assign(new Error(code), { code, ...extra });
}

// One transport owns one authenticated browser session. A reconnect creates a
// new tab capability; only map subscriptions are replayed, never velocity.
export function createRemoteTransport({
    baseUrl = '', wsUrl = '', timeoutMs = 8000, maxResponseBytes = 2 * 1024 * 1024,
    WebSocketClass = globalThis.WebSocket ?? null,
    fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
        !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 ||
        typeof fetchImpl !== 'function') throw new TypeError('INVALID_TRANSPORT_OPTIONS');

    let csrfToken = null;
    let csrfPromise = null;
    let authEpoch = 0;
    let connectionEpoch = 0;
    let status = 'disconnected';
    let helloData = null;
    let mapHelloData = null;
    let appSocket = null;
    let mapSocket = null;
    let desired = false;
    let disposed = false;
    let retryTimer = null;
    let mapRetryTimer = null;
    let retryDelayMs = 250;
    const pending = new Set();
    const statusListeners = new Set();
    const eventListeners = new Map();
    const mapStreamListeners = new Set();
    const mapSubscriptions = new Map();

    function wsTarget(path) {
        if (wsUrl) return wsUrl.replace(/\/+$/, '') + path;
        if (typeof window !== 'undefined' && window.location) {
            return (window.location.protocol === 'https:' ? 'wss:' : 'ws:') +
                '//' + window.location.host + path;
        }
        return 'ws://127.0.0.1:3001' + path;
    }

    function emitStatus(next) {
        status = next;
        const value = ConnectionStatusSchema.parse({
            status, connectionEpoch,
            controlProfile: helloData?.controlProfile ?? 'unknown',
        });
        for (const listener of [...statusListeners]) {
            try { listener(value); } catch { /* isolate UI listener */ }
        }
    }

    function abortPending() {
        for (const controller of pending) controller.abort();
        pending.clear();
    }

    async function readBounded(response) {
        let raw;
        if (response.body?.getReader) {
            const reader = response.body.getReader();
            const chunks = [];
            let bytes = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    bytes += value.byteLength;
                    if (bytes > maxResponseBytes) throw transportError('RESPONSE_TOO_LARGE');
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
            const buffer = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
            raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        } else {
            raw = await response.text();
            if (boundedUtf8StringLength(raw, maxResponseBytes) > maxResponseBytes) {
                throw transportError('RESPONSE_TOO_LARGE');
            }
        }
        if (!raw) return null;
        try { return JSON.parse(raw); }
        catch { throw transportError('INVALID_HTTP_JSON'); }
    }

    async function execute(path, { method = 'GET', headers = {}, ...options } = {}) {
        if (disposed) throw transportError('CLIENT_DISPOSED');
        if (typeof path !== 'string' || !path.startsWith('/api/') ||
            path.startsWith('//')) throw transportError('INVALID_HTTP_PATH');
        if (pending.size >= MAX_PENDING) throw transportError('HTTP_PENDING_LIMIT');
        const epoch = authEpoch;
        const ownerEpoch = connectionEpoch;
        // Login rotates the session and logout revokes it. The backend may
        // close the old socket before sending the HTTP response; that close
        // is expected for these two auth transitions, not a failed request.
        const sessionTransition = path === '/api/auth/login' || path === '/api/auth/logout';
        const controller = new AbortController();
        pending.add(controller);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(baseUrl + path, {
                ...options, method, headers, credentials: 'same-origin',
                signal: controller.signal,
            });
            const body = response.status === 204 ? null : await readBounded(response);
            if (epoch !== authEpoch || disposed ||
                (!sessionTransition && ownerEpoch !== connectionEpoch)) {
                throw transportError('OPERATION_SUPERSEDED', { outcomeUnknown: method !== 'GET' });
            }
            const rotated = response.headers.get('X-CSRF-Token');
            if (rotated) {
                if (!CSRF_TOKEN.test(rotated)) throw transportError('INVALID_CSRF_RESPONSE');
                csrfToken = rotated;
            }
            if (!response.ok) {
                const parsed = HttpErrorPayloadSchema.safeParse(body);
                if (parsed.success) {
                    throw transportError(parsed.data.error.code, {
                        status: response.status, requestId: parsed.data.requestId,
                    });
                }
                throw transportError('HTTP_ERROR', { status: response.status });
            }
            return body;
        } catch (error) {
            if (epoch !== authEpoch || disposed) throw transportError('OPERATION_SUPERSEDED');
            if (controller.signal.aborted && epoch === authEpoch && !disposed) {
                throw transportError('REQUEST_TIMEOUT', { outcomeUnknown: method !== 'GET' });
            }
            if (error.code === 'RESPONSE_TOO_LARGE') controller.abort();
            if (error.code) throw error;
            throw transportError('NETWORK_ERROR', { outcomeUnknown: method !== 'GET' });
        } finally {
            clearTimeout(timer);
            pending.delete(controller);
        }
    }

    async function fetchCsrf() {
        if (!csrfPromise) {
            csrfPromise = (async () => {
                const response = await execute('/api/auth/csrf');
                if (typeof response?.csrfToken !== 'string' ||
                    !CSRF_TOKEN.test(response.csrfToken)) {
                    throw transportError('INVALID_CSRF_RESPONSE');
                }
                csrfToken = response.csrfToken;
                return csrfToken;
            })().finally(() => { csrfPromise = null; });
        }
        return csrfPromise;
    }

    async function request(path, options = {}) {
        const method = (options.method ?? 'GET').toUpperCase();
        const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
        const epoch = authEpoch;
        const headers = new Headers(options.headers ?? {});
        if (mutation) {
            if (!csrfToken) await fetchCsrf();
            if (epoch !== authEpoch || disposed) throw transportError('OPERATION_SUPERSEDED');
            headers.set('X-CSRF-Token', csrfToken);
        }
        return execute(path, { ...options, method, headers });
    }

    function clearRetry() {
        clearTimeout(retryTimer); retryTimer = null;
        clearTimeout(mapRetryTimer); mapRetryTimer = null;
    }

    function closeSocket(socket) {
        if (!socket) return;
        socket.onmessage = null; socket.onerror = null; socket.onclose = null;
        try { socket.close(); } catch { /* already closed */ }
    }

    function disconnectSockets() {
        desired = false;
        clearRetry();
        closeSocket(appSocket); closeSocket(mapSocket);
        appSocket = null; mapSocket = null;
        helloData = null; mapHelloData = null;
        connectionEpoch++; // Fence callbacks and HTTP owner responses.
        emitStatus('disconnected');
    }

    function scheduleAppRetry() {
        if (!desired || disposed || retryTimer || !WebSocketClass) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            connectSockets();
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 2000);
    }

    function dropApp(socket) {
        if (appSocket !== socket) return;
        clearTimeout(mapRetryTimer); mapRetryTimer = null;
        closeSocket(appSocket); closeSocket(mapSocket);
        appSocket = null; mapSocket = null;
        helloData = null; mapHelloData = null;
        connectionEpoch++;
        emitStatus('disconnected');
        scheduleAppRetry();
    }

    function scheduleMapRetry() {
        if (!desired || disposed || !appSocket || mapRetryTimer) return;
        mapRetryTimer = setTimeout(() => {
            mapRetryTimer = null;
            connectMap(connectionEpoch);
        }, 250);
    }

    function sendMapFrame(frame) {
        if (!mapHelloData || !mapSocket || mapSocket.readyState !== 1) return;
        try { mapSocket.send(JSON.stringify(frame)); }
        catch {
            const old = mapSocket;
            closeSocket(old);
            if (mapSocket === old) { mapSocket = null; mapHelloData = null; scheduleMapRetry(); }
        }
    }

    function connectMap(epoch) {
        if (!desired || disposed || !appSocket || mapSocket || !WebSocketClass) return;
        const socket = new WebSocketClass(wsTarget('/map-stream'));
        mapSocket = socket;
        socket.onmessage = event => {
            if (epoch !== connectionEpoch || socket !== mapSocket || disposed) return;
            try {
                const frame = parseRawMapMessage(event.data);
                if (!mapHelloData) {
                    mapHelloData = MapTransportHelloSchema.parse(frame);
                    for (const subscription of mapSubscriptions.values()) sendMapFrame(subscription);
                    return;
                }
                for (const listener of [...mapStreamListeners]) {
                    try { listener(frame); } catch { /* isolate listener */ }
                }
            } catch {
                if (!mapHelloData) {
                    closeSocket(socket); mapSocket = null; scheduleMapRetry();
                }
            }
        };
        socket.onerror = () => {
            if (socket === mapSocket) { closeSocket(socket); mapSocket = null;
                mapHelloData = null; scheduleMapRetry(); }
        };
        socket.onclose = socket.onerror;
    }

    function connectSockets() {
        if (!desired || disposed || appSocket) return;
        if (!WebSocketClass) {
            emitStatus('disconnected');
            return;
        }
        connectionEpoch++;
        const epoch = connectionEpoch;
        helloData = null;
        emitStatus('connecting');
        const socket = new WebSocketClass(wsTarget('/ws'));
        appSocket = socket;
        socket.onmessage = event => {
            if (epoch !== connectionEpoch || socket !== appSocket || disposed) return;
            try {
                if (typeof event.data !== 'string' ||
                    boundedUtf8StringLength(event.data, MAX_APP_BYTES) > MAX_APP_BYTES) {
                    throw transportError('INVALID_APP_FRAME');
                }
                const frame = JSON.parse(event.data);
                if (!helloData) {
                    helloData = TransportHelloSchema.parse(frame);
                    retryDelayMs = 250;
                    emitStatus('connected');
                    return;
                }
                for (const listener of [...(eventListeners.get(frame.type) ?? [])]) {
                    try { listener(frame); } catch { /* isolate listener */ }
                }
            } catch {
                if (!helloData) dropApp(socket); // No binding without a valid hello.
            }
        };
        socket.onerror = () => dropApp(socket);
        socket.onclose = () => dropApp(socket);
        connectMap(epoch);
    }

    function beginConnection() {
        if (disposed) throw transportError('CLIENT_DISPOSED');
        desired = true;
        connectSockets();
    }

    function resetSession() {
        authEpoch++;
        csrfToken = null;
        csrfPromise = null;
        abortPending();
        mapSubscriptions.clear();
        disconnectSockets();
    }

    return {
        request, fetchCsrf, connectSockets: beginConnection, disconnectSockets,
        resetSession,
        getConnectionEpoch: () => connectionEpoch,
        getStatus: () => status,
        getHelloData: () => helloData ? structuredClone(helloData) : null,
        getControlProfile: () => helloData?.controlProfile ?? 'unknown',
        getAppSocket: () => status === 'connected' && appSocket?.readyState === 1
            ? appSocket : null,
        subscribeEvent(type, callback) {
            if (!eventListeners.has(type)) eventListeners.set(type, new Set());
            const listeners = eventListeners.get(type);
            listeners.add(callback);
            return () => {
                listeners.delete(callback);
                if (!listeners.size) eventListeners.delete(type);
            };
        },
        subscribeMapStream(callback) {
            mapStreamListeners.add(callback);
            return () => mapStreamListeners.delete(callback);
        },
        sendMapStream(frame) {
            if (frame.type === 'map.subscribe') {
                mapSubscriptions.set(frame.subscriptionId, frame);
            } else if (frame.type === 'map.unsubscribe') {
                mapSubscriptions.delete(frame.subscriptionId);
            }
            sendMapFrame(frame);
        },
        subscribeConnectionStatus(listener) {
            statusListeners.add(listener);
            try { listener(ConnectionStatusSchema.parse({
                status, connectionEpoch,
                controlProfile: helloData?.controlProfile ?? 'unknown',
            })); } catch { /* isolate listener */ }
            return () => statusListeners.delete(listener);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            resetSession();
            statusListeners.clear(); eventListeners.clear(); mapStreamListeners.clear();
        },
    };
}
