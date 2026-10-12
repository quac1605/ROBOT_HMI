import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockControlService } from '../../../frontend/src/clients/mockControl.js';
import { createMockRobotClient } from '../../../frontend/src/clients/mockRobotClient.js';
import { createMockMotionSource } from '../../../frontend/src/clients/mockMotionSource.js';
import { createSharedRobotState } from '../../../frontend/src/clients/sharedRobotState.js';
import { createMotionAdmissionGate } from '../../../frontend/src/utils/motionAdmissionGate.js';
import { createControlCoordinator } from '../../../frontend/src/utils/controlCoordinator.js';
import { ControlEventEnvelopeSchema } from '../../../frontend/src/schemas/control.js';
import { useControlStore } from '../../../frontend/src/state/controlStore.js';
import { createControlRequestRegistry } from '../../../frontend/src/utils/controlRequestRegistry.js';
import { createPageLeaseIntent } from '../../../frontend/src/utils/pageLeaseIntent.js';

function fixture(t, options = {}) {
  let clock = 1000, tick;
  const shared = createSharedRobotState({ rosConnected: true, mode: 'idle',
    velocity: { linearX: 0, angularZ: 0 }, motionInhibited: false, motionInhibitReason: null,
    physicalEstopActive: false, activeMissionId: null, activeMappingSessionId: null });
  const source = createMockMotionSource({ now: () => clock, sourceHealthy: () => true,
    setEvery: fn => { tick = fn; return 1; }, clearEvery: () => {} });
  const gate = createMotionAdmissionGate();
  const service = createMockControlService({ sharedRobotState: shared, motionSource: source, motionGate: gate,
    telemetry: { getControlState: () => ({ snapshot: shared.getSnapshot(), transportStale: false }) },
    missionService: { stopForControl() {} }, mapActivationService: { stopForControl() {} }, now: () => clock,
    ...options });
  t.after(() => { service.dispose(); source.dispose(); });
  return { shared, source, gate, service, sample(ms = 50) { clock += ms; tick(); },
    advance(ms) { clock += ms; }, sid: service.createSession() };
}

test('N8-H01: acquire rejects missing/nonfinite observation metadata and stale epoch/revision', async t => {
  const f = fixture(t); f.sample();
  const original = f.source.latest.bind(f.source), good = original();
  const invalid = [
    { observedMono: undefined }, { observedMono: NaN }, { observedMono: Infinity },
    { appliedCommandRevision: undefined }, { appliedCommandRevision: NaN },
    { sourceEpoch: 'retired' }, { sourceSequence: 0 }, { sourceSequence: NaN },
  ];
  for (const [i, patch] of invalid.entries()) {
    f.source.latest = () => ({ ...good, ...patch });
    await assert.rejects(f.service.acquireControl({ requestId: `invalid-${i}` }, f.sid),
      { code: 'ROBOT_NOT_STATIONARY' });
  }
  f.source.latest = original;
  assert.ok((await f.service.acquireControl({ requestId: 'fresh' }, f.sid)).leaseId);
});

test('N8-H02: stationary observation is stale at the exact 200 ms boundary', async t => {
  const f = fixture(t); f.sample(); f.advance(200);
  await assert.rejects(f.service.acquireControl({ requestId: 'boundary' }, f.sid), { code: 'ROBOT_NOT_STATIONARY' });
});

test('N8-H03: stop re-entry from mission callback serializes and latest stop confirms', async t => {
  let f, nested, once = false;
  f = fixture(t, { missionService: { stopForControl() {
    if (!once) { once = true; nested = f.service.requestStop({ requestId: 'nested' }, f.sid); }
  } } });
  f.sample();
  await f.service.requestStop({ requestId: 'outer' }, f.sid); await nested;
  f.sample();
  const state = (await f.service.getControlState(f.sid)).payload;
  assert.equal(state.stop.requestId, 'nested');
  assert.equal(state.stop.status, 'confirmed');
  assert.doesNotThrow(() => f.gate.enter());
});

test('N8-H04: one revoke notification per active session, no duplicate owner event', async t => {
  const f = fixture(t); f.sample(); let revocations = 0;
  f.service.subscribeControl(f.sid, e => { if (e.type === 'control.revoked') revocations++; });
  const lease = await f.service.acquireControl({ requestId: 'a' }, f.sid);
  await f.service.releaseControl({ requestId: 'r', leaseId: lease.leaseId }, f.sid);
  assert.equal(revocations, 1);
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, timeoutMs = 2200) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) { const v = await read(); if (predicate(v)) return v; await pause(15); }
  assert.fail('Precondition/result did not arrive within deadline');
}
const missionRequest = () => ({ requestId: crypto.randomUUID(), mapId: 'map-demo', mapRevision: 'rev-1',
  kind: 'navigate_to_pose', poses: [{ frameId: 'map', x: 7, y: 3, yaw: 0 }] });

test('N8-H05: cancel before first nonzero measurement still zeros desired command', async t => {
  const c = createMockRobotClient(); t.after(() => c.dispose());
  await c.login({ username: 'admin', password: 'demo-only' });
  c._motionSource.setFrozen(true);
  assert.equal(c._motionSource.latest().velocity.linearX, 0);
  const { missionId } = await c.createMission(missionRequest());
  await until(() => c.getRobotState(), s => s.velocity.linearX > 0);
  await c.cancelMission({ requestId: crypto.randomUUID(), missionId });
  await until(() => c.getMission(missionId), m => m.status === 'canceled');
  c._motionSource.setFrozen(false);
  await pause(100);
  assert.equal(c._motionSource.latest().velocity.linearX, 0);
});

test('N8-H06: source frozen through mission terminal can later confirm the SAME stop', async t => {
  const c = createMockRobotClient(); t.after(() => c.dispose());
  await c.login({ username: 'admin', password: 'demo-only' });
  const { missionId } = await c.createMission(missionRequest());
  await until(() => c._motionSource.latest(), s => s?.velocity.linearX > 0);
  c._motionSource.setFrozen(true);
  await c.requestStop({ requestId: 'frozen-mission-stop' });
  await until(() => c.getMission(missionId), m => m.status === 'canceled');
  assert.equal((await c.getControlState()).payload.stop.status, 'accepted');
  c._motionSource.setFrozen(false);
  await until(() => c.getControlState(), s => s.payload.stop.status === 'confirmed');
});

function coordinator(t, options = {}) {
  useControlStore.setState(useControlStore.getInitialState(), true);
  let listener, sequence = 0;
  const client = { controlProfile: 'mock', subscribeControl(fn) { listener = fn; return () => {}; },
    getControlState: () => new Promise(() => {}), ...options };
  const c = createControlCoordinator(client);
  t.after(() => { c.dispose(); useControlStore.setState(useControlStore.getInitialState(), true); });
  const lease = { leaseId: 'lease-5', controlGeneration: 5,
    expiresAt: new Date(Date.now() + 15000).toISOString(), limits: { maxLinearX: .2, maxAngularZ: .5 } };
  return { lease, state: () => useControlStore.getState(),
    emit(type, payload) { listener(ControlEventEnvelopeSchema.parse({ version: 1, streamEpoch: 'epoch',
      sequence: ++sequence, sentAt: new Date().toISOString(), type, payload })); } };
}
const snapshot = (controlGeneration, stop = null) => ({ controlGeneration, ownership: 'none', lease: null, heartbeat: null, stop });
const heartbeat = lease => ({ leaseId: lease.leaseId, controlGeneration: lease.controlGeneration,
  leaseExpiresAt: lease.expiresAt, leaseRemainingMs: 14000, freshnessToken: 'token-old',
  tokenExpiresAt: new Date(Date.now() + 500).toISOString(), tokenValidForMs: 500 });
test('N8-H07: snapshot with no stop cannot clear a locally pending stop', t => {
  const f = coordinator(t);
  useControlStore.getState().setControlState({ stopUnconfirmed: true, pendingStopRequestId: 'pending',
    stopState: { requestId: 'pending', status: 'accepted', confirmation: null } });
  f.emit('control.snapshot', snapshot(0));
  assert.equal(f.state().stopUnconfirmed, true);
  assert.equal(f.state().stopState.requestId, 'pending');
});
test('N8-H08: old granted/snapshot cannot lower generation inside same stream epoch', t => {
  const f = coordinator(t); f.emit('control.granted', f.lease);
  f.emit('control.granted', { ...f.lease, leaseId: 'old', controlGeneration: 2 });
  assert.equal(f.state().lease.leaseId, f.lease.leaseId);
  f.emit('control.snapshot', snapshot(1));
  assert.equal(f.state().controlGeneration, 5);
});
test('N8-H09: replacement lease clears previous heartbeat token and ACK', t => {
  const f = coordinator(t); f.emit('control.granted', f.lease);
  f.emit('control.heartbeat', heartbeat(f.lease));
  f.emit('control.granted', { ...f.lease, leaseId: 'new', controlGeneration: 6 });
  assert.equal(f.state().freshnessToken, null);
  assert.equal(f.state().heartbeatReceivedAt, null);
});
test('N8-H10: heartbeat requires exact generation, not greater-or-equal', t => {
  const f = coordinator(t); f.emit('control.granted', f.lease);
  f.emit('control.heartbeat', { ...heartbeat(f.lease), controlGeneration: 6 });
  assert.equal(f.state().controlGeneration, 5);
  assert.equal(f.state().freshnessToken, null);
});
test('N8-H11: no lease means late command ACK is ignored', t => {
  const f = coordinator(t);
  f.emit('teleop.commandResult', { leaseId: 'retired', commandSequence: 3, success: true, error: null });
  assert.equal(f.state().commandResult, null);
});
test('N8-H12: revoked generation fences subsequent stale grant', t => {
  const f = coordinator(t); f.emit('control.granted', f.lease);
  f.emit('control.revoked', { leaseId: f.lease.leaseId, controlGeneration: 6, reason: 'RELEASED' });
  f.emit('control.granted', f.lease);
  assert.equal(f.state().lease, null); assert.equal(f.state().controlGeneration, 6);
});

test('N8-H13: registry is bounded without forgetting replay/conflict fingerprints', async () => {
  let overloads = 0, executions = 0;
  const registry = createControlRequestRegistry({ maxEntries: 2, onCapacity() { overloads++; } });
  const req = id => ({ sessionId: 's', operation: 'stop', requestId: id, payload: { id } });
  const work = () => ({ execution: ++executions });
  assert.deepEqual(await registry.run(req('a'), work), { execution: 1 });
  await registry.run(req('b'), work);
  await assert.rejects(registry.run(req('c'), work), { code: 'CONTROL_REQUEST_CAPACITY' });
  assert.equal(registry.size, 2); assert.equal(overloads, 1);
  assert.deepEqual(await registry.run(req('a'), work), { execution: 1 });
  await assert.rejects(registry.run({ ...req('a'), operation: 'acquire' }, work), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(executions, 2);
});

test('N8-H14: capacity exhaustion stops motion and cannot clear its inhibit on confirmation', async t => {
  const f = fixture(t, { requestLimit: 1 }); f.sample();
  const lease = await f.service.acquireControl({ requestId: 'a' }, f.sid);
  let hb;
  f.service.subscribeControl(f.sid, e => { if (e.type === 'control.heartbeat') hb = e.payload; });
  await until(() => hb, Boolean);
  f.service.sendVelocity({ leaseId: lease.leaseId,
    sequence: 1, freshnessToken: hb.freshnessToken, linearX: .1, angularZ: 0 }, f.sid);
  assert.equal(f.source.getCommand().velocity.linearX, .1);
  await assert.rejects(f.service.requestStop({ requestId: 'capacity-stop' }, f.sid), { code: 'CONTROL_REQUEST_CAPACITY' });
  assert.equal(f.source.getCommand().velocity.linearX, 0);
  f.sample();
  assert.equal((await f.service.getControlState(f.sid)).payload.stop.status, 'confirmed');
  assert.equal(f.shared.getSnapshot().motionInhibited, true);
  assert.equal(f.shared.getSnapshot().motionInhibitReason, 'CONTROL_RESOURCE_EXHAUSTED');
  f.service.revokeSession(f.sid);
  await assert.rejects(f.service.acquireControl({ requestId: 'new' }, f.service.createSession()),
    { code: 'CONTROL_RESOURCE_EXHAUSTED' });
});

test('N8-H15: late acquire response already revoked is released and never owned by page', async () => {
  let finish, released;
  const intent = createPageLeaseIntent({ client: {
    acquireControl: () => new Promise(resolve => { finish = resolve; }),
    releaseControl: async request => { released = request.leaseId; },
  }, isLeaseCurrent: () => false });
  const pending = intent.acquire();
  finish({ leaseId: 'retired', controlGeneration: 1 });
  assert.equal(await pending, false);
  assert.equal(released, 'retired');
  intent.dispose();
});

test('N8-H16: a new unconfigured coordinator cannot inherit mock profile from a previous client', () => {
  useControlStore.getState().setControlState({ controlProfile: 'mock' });
  const c = createControlCoordinator({ subscribeControl: () => () => {}, getControlState: () => new Promise(() => {}) });
  try { assert.equal(useControlStore.getState().controlProfile, 'unknown'); }
  finally { c.dispose(); useControlStore.setState(useControlStore.getInitialState(), true); }
});

test('N8-H17: matching snapshot reconciles stop whose accepted response/event was lost', t => {
  const f = coordinator(t);
  useControlStore.getState().setControlState({ pendingStopRequestId: 'lost', stopUnconfirmed: true,
    stopState: { requestId: 'lost', status: 'requested', confirmation: null } });
  const confirmation = { requestId: 'lost', controlGeneration: 2, evidenceKind: 'mock-source-observation',
    sourceEpoch: 'source', sourceSequence: 2, observedAt: new Date().toISOString(), velocity: { linearX: 0, angularZ: 0 } };
  f.emit('control.snapshot', snapshot(2, { requestId: 'lost', controlGeneration: 2, status: 'confirmed', confirmation }));
  assert.equal(f.state().stopUnconfirmed, false);
  assert.equal(f.state().pendingStopRequestId, null);
});
