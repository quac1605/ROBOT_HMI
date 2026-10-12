import { MapGridEventEnvelopeSchema, ShallowMapGridEventEnvelopeSchema,
  parseMapGridSnapshot } from '@robot-hmi/contracts/mapGrid';

export const APP_BUFFER_BUDGET = 256 * 1024;
export const MAP_BUFFER_BUDGET = 2 * 1024 * 1024;
const MAX_APP_PENDING = 32;

const APP_TYPES = new Set([
  'robot.state', 'job.updated', 'mission.updated', 'navigation.path',
  'control.granted', 'control.revoked', 'control.heartbeat',
  'control.snapshot', 'control.stopConfirmed', 'teleop.commandResult',
  'command.result',
]);
const MAP_TYPES = new Set(['map.grid', 'map.status', 'map.error']);

function invalidFrame() {
  return Object.assign(new Error('INVALID_OUTBOUND_FRAME'), { code: 'INVALID_OUTBOUND_FRAME' });
}

// One native send may be active. A map socket retains only the newest pending
// grid; an app socket retains transitions in order and replaces only state.
export function createOutboundQueue({ ws, kind, onFailure }) {
  if (!ws || !['app', 'map'].includes(kind) || typeof onFailure !== 'function') {
    throw new Error('OUTBOUND_QUEUE_DEPENDENCIES_REQUIRED');
  }
  const budget = kind === 'app' ? APP_BUFFER_BUDGET : MAP_BUFFER_BUDGET;
  let active = false;
  let closed = false;
  const pending = [];

  function fail(reason) {
    if (closed) return;
    closed = true;
    pending.length = 0;
    onFailure(reason);
  }

  function flush() {
    if (closed || active || pending.length === 0) return;
    if (ws.readyState !== 1 || ws.bufferedAmount > budget) {
      fail('SLOW_CONSUMER');
      return;
    }
    const next = pending.shift();
    active = true;
    try {
      ws.send(next.json, error => {
        active = false;
        if (error) fail('SEND_FAILED');
        else flush();
      });
    } catch {
      active = false;
      fail('SEND_FAILED');
    }
  }

  function enqueue(frame) {
    if (closed) return false;
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
        typeof frame.type !== 'string' ||
        !(kind === 'app' ? APP_TYPES : MAP_TYPES).has(frame.type)) throw invalidFrame();
    if (kind === 'map') {
      // Grid uses the bounded preflight + shallow metadata parser. A deep
      // Zod traversal would re-allocate/visit every occupancy cell again.
      if (frame.type === 'map.grid') {
        if (!ShallowMapGridEventEnvelopeSchema.safeParse(frame).success) throw invalidFrame();
        parseMapGridSnapshot(frame.payload);
      } else if (!MapGridEventEnvelopeSchema.safeParse(frame).success) {
        throw invalidFrame();
      }
    }
    let json;
    try { json = JSON.stringify(frame); } catch { throw invalidFrame(); }
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > budget) {
      throw invalidFrame();
    }
    if (ws.readyState !== 1 || ws.bufferedAmount > budget) {
      fail('SLOW_CONSUMER');
      return false;
    }

    if (kind === 'map' && frame.type === 'map.grid') {
      const previous = pending.findIndex(item => item.type === 'map.grid');
      if (previous >= 0) pending.splice(previous, 1);
    }
    if (kind === 'app' && frame.type === 'robot.state') {
      const previous = pending.findIndex(item => item.type === 'robot.state');
      if (previous >= 0) pending.splice(previous, 1);
    }
    if (pending.length >= (kind === 'app' ? MAX_APP_PENDING : 2)) {
      fail('SLOW_CONSUMER');
      return false;
    }
    pending.push({ type: frame.type, json });
    flush();
    return !closed;
  }

  return { enqueue, dispose: () => { closed = true; pending.length = 0; },
    get pendingCount() { return pending.length; } };
}
