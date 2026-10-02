/**
 * backend/src/auth/authWebSockets.js
 * 
 * WEBSOCKET UPGRADE ROUTER VÀ HANDSHAKE TRANSPORT HELLO (M6 - M8).
 */
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import signature from 'cookie-signature';
import { TransportHelloSchema, MapTransportHelloSchema } from '@robot-hmi/contracts/transport';
import { createConnectionRegistry } from '../realtime/connectionRegistry.js';
import { APP_BUFFER_BUDGET, MAP_BUFFER_BUDGET } from '../realtime/outboundQueue.js';
import { ControlEventEnvelopeSchema } from '@robot-hmi/contracts/control';
import { MapContextSchema } from '@robot-hmi/contracts/mapGrid';
import { z } from 'zod';

const MapSubscribeSchema = z.object({
  version: z.literal(1),
  type: z.literal('map.subscribe'),
  subscriptionId: z.string().trim().min(1).max(128),
  context: MapContextSchema,
}).strict();
const MapUnsubscribeSchema = z.object({
  version: z.literal(1),
  type: z.literal('map.unsubscribe'),
  subscriptionId: z.string().trim().min(1).max(128),
}).strict();

const PATHS = new Set(['/ws', '/map-stream']);
const MAX_SOCKETS = 128;
const MAX_SOCKETS_PER_SESSION = 8;
const MAX_SOCKETS_PER_IP = 32;
const UPGRADE_DEADLINE_MS = 5000;
const MAX_MESSAGES_PER_SECOND = 30;
const HEARTBEAT_INTERVAL_MS = 15_000;

function sessionIdFromCookie(header, secret) {
  if (typeof header !== 'string' || header.length > 4096) return null;
  const values = header.split(';').map(part => part.trim()).filter(part =>
    part.startsWith('connect.sid='));
  if (values.length !== 1) return null;
  let signed;
  try { signed = decodeURIComponent(values[0].slice('connect.sid='.length)); }
  catch { return null; }
  if (!signed.startsWith('s:')) return null;
  const sid = signature.unsign(signed.slice(2), secret);
  return typeof sid === 'string' && sid.length <= 256 ? sid : null;
}

function rejectUpgrade(socket, status) {
  if (socket.destroyed) return;
  const phrase = status === 403 ? 'Forbidden' : status === 429 ? 'Too Many Requests'
    : status === 503 ? 'Service Unavailable' : status === 404 ? 'Not Found'
      : 'Unauthorized';
  socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\n` +
    'Cache-Control: no-store\r\nContent-Length: 0\r\n\r\n');
}

export function attachAuthWebSockets({
  server,
  config,
  lifecycle,
  sessionRevalidator,
  registry: customRegistry,
  controlAuthority,
  controlSubjectRegistry,
  mapGridService,
  robotStateService,
}) {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: 64 * 1024,
  });

  const registry = customRegistry || createConnectionRegistry();
  const open = new Map();
  const pending = new Map();
  let closed = false;

  async function onUpgrade(request, socket, head) {
    let path;
    try {
      const url = new URL(request.url, 'http://localhost');
      path = url.pathname;
      if (url.search) { rejectUpgrade(socket, 404); return; }
    }
    catch { rejectUpgrade(socket, 404); return; }
    if (!PATHS.has(path)) { rejectUpgrade(socket, 404); return; }
    if (closed) { rejectUpgrade(socket, 503); return; }
    if (request.headers.origin !== config.APP_ORIGIN) {
      rejectUpgrade(socket, 403); return;
    }
    const sid = sessionIdFromCookie(request.headers.cookie, config.SESSION_SECRET);
    if (!sid) { rejectUpgrade(socket, 401); return; }
    const ip = socket.remoteAddress;
    const records = [...open.values(), ...pending.values()];
    if (records.length >= MAX_SOCKETS ||
      records.filter(record => record.sid === sid).length >= MAX_SOCKETS_PER_SESSION ||
      records.filter(record => record.ip === ip).length >= MAX_SOCKETS_PER_IP) {
      rejectUpgrade(socket, 429); return;
    }
    pending.set(socket, { sid, ip });
    const deadline = setTimeout(() => socket.destroy(), UPGRADE_DEADLINE_MS);
    deadline.unref?.();
    let watcher;
    let websocket;
    let revoked = false;
    let connectionId;
    let heartbeat;
    let unsubscribeControl = null;

    try {
      watcher = await sessionRevalidator.watch({
        sid,
        onInvalidated: (reason) => {
          revoked = true;
          if (heartbeat) clearInterval(heartbeat);
          if (unsubscribeControl) {
            try { unsubscribeControl(); } catch { /* ignore */ }
            unsubscribeControl = null;
          }
          if (connectionId) {
            controlSubjectRegistry?.removeAppSubject(connectionId);
            registry.revoke(connectionId, reason || 'SESSION_REVOKED');
          }
          if (websocket) {
            open.delete(websocket);
            watcher?.dispose();
          } else {
            socket.destroy();
          }
        },
      });

      if (closed || revoked || socket.destroyed) {
        watcher?.dispose();
        rejectUpgrade(socket, 503);
        return;
      }

      webSocketServer.handleUpgrade(request, socket, head, ws => {
        websocket = ws;
        let cleaned = false;
        const cleanup = (reason) => {
          if (cleaned) return;
          cleaned = true;
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
          if (unsubscribeControl) {
            try { unsubscribeControl(); } catch { /* ignore */ }
            unsubscribeControl = null;
          }
          if (connectionId) {
            controlSubjectRegistry?.removeAppSubject(connectionId);
            registry.revoke(connectionId, reason);
          }
          open.delete(ws);
          watcher.dispose();
        };
        ws.on('close', () => cleanup('CLIENT_CLOSED'));
        ws.on('error', () => { cleanup('SOCKET_ERROR'); ws.terminate(); });
        try {
          if (closed || revoked || socket.destroyed) { ws.terminate(); return; }
          watcher.assertFresh();
          connectionId = randomUUID();
          const isAppChannel = path === '/ws';
          const ownerToken = isAppChannel ? randomBytes(32).toString('hex') : undefined;
          const record = {
            connectionId, kind: isAppChannel ? 'app' : 'map', sessionId: sid,
            userId: watcher.userId,
            ownerTokenDigest: ownerToken ? createHash('sha256').update(ownerToken).digest() : null,
            ws, watcher, createdAt: Date.now(), closed: false,
            authBootEpoch: lifecycle.authBootEpoch, subscriptions: new Set(),
            onRevoke: cleanup,
          };
          registry.register(record);
          open.set(ws, { sid, ip, connectionId, watcher, path });
          const payload = {
            version: 1, type: 'transport.hello', connectionId,
            serverBootEpoch: lifecycle.authBootEpoch, controlProfile: 'mock',
            ...(ownerToken ? { ownerToken } : {}),
          };
          const hello = isAppChannel
            ? TransportHelloSchema.parse(payload) : MapTransportHelloSchema.parse(payload);
          ws.send(JSON.stringify(hello), error => {
            if (error) { cleanup('HELLO_SEND_FAILED'); ws.terminate(); }
          });

          // Phát snapshot robot.state ban đầu cho /ws
          if (isAppChannel && robotStateService) {
            try {
              const state = robotStateService.getRobotState();
              ws.send(JSON.stringify({
                version: 1,
                type: 'robot.state',
                streamEpoch: lifecycle.authBootEpoch,
                sequence: 0,
                sentAt: new Date().toISOString(),
                payload: state,
              }));
            } catch { /* ignore */ }
          }

          const sendControlEvent = event => {
            try {
              const validated = ControlEventEnvelopeSchema.parse(event);
              if (!registry.send(connectionId, validated)) {
                cleanup('CONTROL_SEND_REJECTED');
              }
            } catch {
              cleanup('INVALID_CONTROL_EVENT');
              ws.terminate();
            }
          };

          if (isAppChannel && controlAuthority && controlSubjectRegistry) {
            const subjectId = controlSubjectRegistry.getOrCreateAppSubject(connectionId);
            const unsubscribe = controlAuthority.subscribeControl(subjectId, sendControlEvent);
            if (registry.get(connectionId)?.closed || !registry.get(connectionId)) unsubscribe();
            else unsubscribeControl = unsubscribe;
          }

          let awaitingPong = false;
          ws.on('pong', () => { awaitingPong = false; });
          heartbeat = setInterval(() => {
            if (awaitingPong) { cleanup('PING_TIMEOUT'); ws.terminate(); return; }
            awaitingPong = true;
            try { ws.ping(); } catch { cleanup('PING_FAILED'); ws.terminate(); }
          }, HEARTBEAT_INTERVAL_MS);
          heartbeat.unref?.();
        } catch {
          cleanup('UPGRADE_FAILED');
          ws.terminate();
          return;
        }

        let windowStartedAt = Date.now();
        let messageCount = 0;
        const protocolBudget = path === '/ws' ? APP_BUFFER_BUDGET : MAP_BUFFER_BUDGET;
        const sendProtocol = frame => {
          if (ws.readyState !== 1 || ws.bufferedAmount > protocolBudget) {
            cleanup('SLOW_CONSUMER'); ws.terminate(); return;
          }
          try {
            ws.send(JSON.stringify(frame), error => {
              if (error) { cleanup('SEND_FAILED'); ws.terminate(); }
            });
          } catch { cleanup('SEND_FAILED'); ws.terminate(); }
        };

        ws.on('message', (data, isBinary) => {
          try { watcher.assertFresh(); lifecycle.assertConnectionCurrent(registry.get(connectionId)); }
          catch { cleanup('AUTH_PROOF_EXPIRED'); ws.terminate(); return; }
          const current = Date.now();
          if (current - windowStartedAt >= 1000) { windowStartedAt = current; messageCount = 0; }
          if (++messageCount > MAX_MESSAGES_PER_SECOND) {
            cleanup('MESSAGE_RATE_EXCEEDED'); ws.terminate(); return;
          }
          if (isBinary) {
            sendProtocol({
              type: 'error',
              error: { code: 'BINARY_NOT_SUPPORTED', message: 'Binary frame không được hỗ trợ' },
            });
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(data.toString('utf8'));
          } catch {
            sendProtocol({
              type: 'error',
              error: { code: 'INVALID_JSON', message: 'Nội dung tin nhắn không phải JSON hợp lệ' },
            });
            return;
          }

          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            typeof parsed.type !== 'string') {
            sendProtocol({
              type: 'error',
              error: { code: 'UNKNOWN_MESSAGE_TYPE', message: 'Tin nhắn thiếu trường type' },
            });
            return;
          }

          if (parsed.type === 'ping') {
            sendProtocol({ type: 'pong', timestamp: Date.now() });
            return;
          }

          // Lệnh subscribe trên kênh /map-stream
          if (path === '/map-stream' && parsed.type === 'map.subscribe') {
            const valid = MapSubscribeSchema.safeParse(parsed);
            if (!valid.success || !mapGridService) {
              sendProtocol({ type: 'error', error: {
                code: 'INVALID_MAP_SUBSCRIPTION', message: 'Map subscription không hợp lệ',
              } });
              return;
            }
            const rec = registry.get(connectionId);
            mapGridService.subscribeClient(rec, valid.data);
            return;
          }

          if (path === '/map-stream' && parsed.type === 'map.unsubscribe') {
            const valid = MapUnsubscribeSchema.safeParse(parsed);
            if (!valid.success || !mapGridService) {
              sendProtocol({ type: 'error', error: {
                code: 'INVALID_MAP_SUBSCRIPTION', message: 'Map subscription không hợp lệ',
              } });
              return;
            }
            const rec = registry.get(connectionId);
            mapGridService.unsubscribeClient(rec, valid.data.subscriptionId);
            return;
          }

          if (parsed.type === 'teleop.velocity') {
            if (path !== '/ws' || !controlAuthority || !controlSubjectRegistry) {
              sendProtocol({
                type: 'error',
                error: { code: 'NOT_SUPPORTED', message: 'Teleoperation không hỗ trợ trên kênh này' },
              });
              return;
            }
            const subjectId = controlSubjectRegistry.getOrCreateAppSubject(connectionId);
            const dto = (parsed.payload && typeof parsed.payload === 'object') ? parsed.payload : {
              leaseId: parsed.leaseId,
              sequence: parsed.sequence,
              freshnessToken: parsed.freshnessToken,
              linearX: parsed.linearX,
              angularZ: parsed.angularZ,
            };
            try {
              controlAuthority.sendVelocity(dto, subjectId);
            } catch {
              // controlAuthority đã tự động gửi teleop.commandResult qua listener subscription
            }
            return;
          }

          sendProtocol({
            type: 'error',
            error: { code: 'UNKNOWN_MESSAGE_TYPE', message: 'Loại tin nhắn chưa được hỗ trợ' },
          });
        });
      });
    } catch (error) {
      watcher?.dispose();
      if (websocket) websocket.terminate();
      else rejectUpgrade(socket, error.status === 503 ? 503 : 401);
    } finally {
      pending.delete(socket);
      clearTimeout(deadline);
    }
  }

  server.on('upgrade', onUpgrade);

  return {
    get activeCount() { return open.size; },
    get registry() { return registry; },
    async close() {
      if (closed) return;
      closed = true;
      server.off('upgrade', onUpgrade);
      for (const socket of pending.keys()) socket.destroy();
      for (const [ws, record] of open) {
        record.watcher?.dispose();
        controlSubjectRegistry?.removeAppSubject(record.connectionId);
        registry.revoke(record.connectionId, 'SERVER_SHUTDOWN');
        ws.terminate();
      }
      open.clear();
      registry.closeAll();
      await new Promise(resolve => webSocketServer.close(resolve));
    },
  };
}
