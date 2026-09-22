import {
    MissionRequestSchema, MissionSchema, CancelMissionRequestSchema,
    MissionEventEnvelopeSchema, NavigationPathEnvelopeSchema, preflightNavigationPath,
} from '../schemas/mission.js';
import { isMissionTerminal, transitionMission } from '../utils/missionState.js';
import { checkMissionPreconditions, checkMissionRuntime, checkSavedMap, checkRouteBounds } from '../utils/navigationGuards.js';
import { createLifecycleTimers } from '../utils/lifecycleTimers.js';
import { navigationError, errorDto, ZERO_VELOCITY } from '../utils/navigationPolicy.js';

export function createMockMissionService({ sharedRobotState, telemetry, mapRepository, idempotency }) {
    const missions = new Map();
    const paths = new Map();
    const listeners = new Set();
    const pathListeners = new Map();
    const timers = createLifecycleTimers();
    let activeMissionId = null;
    let lastMissionId = null;
    let streamEpoch = crypto.randomUUID();
    let sequence = 0;
    let scenario = 'normal';

    function missionEvent(mission) {
        return MissionEventEnvelopeSchema.parse({
            version: 1, type: 'mission.updated', streamEpoch, sequence: ++sequence,
            sentAt: new Date().toISOString(), payload: mission,
        });
    }
    function notify(set, event) {
        for (const listener of set || []) {
            try { listener(structuredClone(event)); } catch (error) { console.error(error); }
        }
    }
    function publish(mission) {
        const checked = MissionSchema.parse(mission);
        missions.set(checked.missionId, checked);
        lastMissionId = checked.missionId;
        notify(listeners, missionEvent(checked));
    }
    function pathEvent(missionId) {
        const event = {
            version: 1, type: 'navigation.path', streamEpoch, sequence: ++sequence,
            sentAt: new Date().toISOString(), payload: paths.get(missionId),
        };
        preflightNavigationPath(event);
        return NavigationPathEnvelopeSchema.parse(event);
    }
    function release(missionId) {
        if (activeMissionId === missionId) activeMissionId = null;
        const state = sharedRobotState.getSnapshot();
        if (state.activeMissionId !== missionId) return;
        const stillOwner = state.mode === 'navigating';
        sharedRobotState.update({
            activeMissionId: null,
            ...(stillOwner ? { mode: 'idle', velocity: ZERO_VELOCITY }
                : state.mode === 'fault' ? { velocity: ZERO_VELOCITY } : {}),
        });
    }
    function terminal(mission, status, error = null) {
        const result = transitionMission(mission, status, {
            error, ...(status === 'succeeded' ? { distanceRemainingM: 0 } : {}),
        });
        missions.set(result.missionId, result);
        release(result.missionId);
        publish(result);
    }
    function remaining(pose, poses, index) {
        let meters = Math.hypot(poses[index].x - pose.x, poses[index].y - pose.y);
        for (let i = index; i < poses.length - 1; i += 1) {
            meters += Math.hypot(poses[i + 1].x - poses[i].x, poses[i + 1].y - poses[i].y);
        }
        return meters;
    }

    return {
        createMission(raw, principalId = 'demo-admin') {
            const request = MissionRequestSchema.parse(raw);
            const epoch = timers.capture();
            return idempotency.run({
                principalId, operation: 'createMission',
                requestId: request.requestId, payload: request
            }, async () => {
                const map = await mapRepository.getMap(request.mapId, request.mapRevision);
                timers.assert(epoch);
                const control = telemetry.getControlState();
                for (const check of [
                    checkSavedMap(map), checkRouteBounds(request.poses, map),
                    checkMissionPreconditions({
                        robotSnapshot: control.snapshot,
                        mapId: request.mapId, mapRevision: request.mapRevision, transportStale: control.transportStale
                    }),
                ]) {
                    if (!check.ok) throw navigationError(check.code, check.reason);
                }
                const missionId = crypto.randomUUID();
                const now = new Date().toISOString();
                const mission = MissionSchema.parse({
                    ...request, missionId, status: 'accepted', currentPoseIndex: 0,
                    distanceRemainingM: remaining(control.snapshot.pose, request.poses, 0),
                    error: null, createdAt: now, updatedAt: now,
                });
                const runScenario = scenario;
                missions.set(missionId, mission);
                activeMissionId = missionId;
                paths.set(missionId, {
                    missionId, mapId: request.mapId, mapRevision: request.mapRevision, frameId: 'map',
                    kind: 'planned', poses: [control.snapshot.pose, ...request.poses].map(({ x, y, yaw }) => ({ x, y, yaw })),
                });
                // Claim trước khi phát event: listener không thể tạo mission thứ hai qua re-entry.
                sharedRobotState.update({ activeMissionId: missionId, mode: 'navigating', velocity: ZERO_VELOCITY });
                publish(mission);
                notify(pathListeners.get(missionId), pathEvent(missionId));

                timers.schedule(epoch, () => {
                    const current = missions.get(missionId);
                    if (!current || current.status !== 'accepted') return;
                    if (runScenario === 'goal-rejected') {
                        terminal(current, 'failed', { code: 'GOAL_REJECTED', message: 'Mock action từ chối đích.' });
                        return;
                    }
                    const state = telemetry.getControlState();
                    const check = checkMissionRuntime({
                        robotSnapshot: state.snapshot,
                        mission: current, transportStale: state.transportStale
                    });
                    if (!check.ok) { terminal(current, 'failed', { code: check.code, message: check.reason }); return; }
                    publish(transitionMission(current, 'executing'));
                    let lastTick = performance.now();
                    const executionStart = lastTick;

                    const tick = () => {
                        const live = missions.get(missionId);
                        if (!live || live.status !== 'executing') return;
                        try {
                            const controlNow = telemetry.getControlState();
                            const allowed = checkMissionRuntime({
                                robotSnapshot: controlNow.snapshot,
                                mission: live, transportStale: controlNow.transportStale
                            });
                            if (!allowed.ok) throw navigationError(allowed.code, allowed.reason);
                            if (runScenario === 'blocked-failed' && performance.now() - executionStart >= 400) {
                                throw navigationError('PATH_BLOCKED', 'Mock bị chặn trên tuyến minh họa.');
                            }
                            const nowTick = performance.now();
                            // Dùng thời gian thực; cap 250ms để tab bị treo không teleport.
                            const dt = Math.min(0.25, Math.max(0, (nowTick - lastTick) / 1000));
                            lastTick = nowTick;
                            const pose = controlNow.snapshot.pose;
                            let index = live.currentPoseIndex;
                            while (index < live.poses.length - 1 &&
                                Math.hypot(live.poses[index].x - pose.x, live.poses[index].y - pose.y) < 0.04) {
                                index += 1;
                            }
                            const target = live.poses[index];
                            const dx = target.x - pose.x;
                            const dy = target.y - pose.y;
                            const distance = Math.hypot(dx, dy);
                            if (index === live.poses.length - 1 && distance < 0.04) {
                                if (!telemetry.commitPose(target, { velocity: ZERO_VELOCITY })) {
                                    timers.schedule(epoch, tick, 100);
                                    return;
                                }
                                terminal({ ...live, currentPoseIndex: index }, 'succeeded');
                                return;
                            }
                            const step = Math.min(distance, 0.4 * dt);
                            const yaw = distance > 0 ? Math.atan2(dy, dx) : target.yaw;
                            const next = {
                                frameId: 'map', x: pose.x + step * Math.cos(yaw),
                                y: pose.y + step * Math.sin(yaw), yaw
                            };
                            if (!telemetry.commitPose(next, { velocity: { linearX: dt > 0 ? step / dt : 0, angularZ: 0 } })) {
                                // No fresh pose: wait for a real mock source update or
                                // let the next runtime guard fail at POSE_STALE_MS.
                                timers.schedule(epoch, tick, 100);
                                return;
                            }
                            publish({
                                ...live, currentPoseIndex: index,
                                distanceRemainingM: remaining(next, live.poses, index), updatedAt: new Date().toISOString()
                            });
                            timers.schedule(epoch, tick, 100);
                        } catch (error) {
                            terminal(live, 'failed', errorDto(error));
                        }
                    };
                    timers.schedule(epoch, tick, 100);
                }, 100);
                return { missionId, status: 'accepted' };
            });
        },
        cancelMission(raw, principalId = 'demo-admin') {
            const request = CancelMissionRequestSchema.parse(raw);
            timers.capture();
            return idempotency.run({
                principalId, operation: 'cancelMission',
                requestId: request.requestId, payload: request
            }, () => {
                const current = this.getMission(request.missionId);
                if (isMissionTerminal(current.status)) return { missionId: current.missionId, status: current.status };
                if (current.status === 'canceling') return { missionId: current.missionId, status: 'canceling' };
                timers.clear();
                const epoch = timers.capture();
                sharedRobotState.update({ velocity: ZERO_VELOCITY });
                publish(transitionMission(current, 'canceling'));
                timers.schedule(epoch, () => {
                    const latest = missions.get(current.missionId);
                    if (latest?.status === 'canceling') terminal(latest, 'canceled');
                }, 100);
                return { missionId: current.missionId, status: 'canceling' };
            });
        },
        getMission(missionId) {
            if (!missions.has(missionId)) throw navigationError('MISSION_NOT_FOUND', 'Không tìm thấy mission.');
            return structuredClone(missions.get(missionId));
        },
        getActiveMission() {
            return { mission: activeMissionId ? this.getMission(activeMissionId) : null };
        },
        subscribeMissions(listener) {
            timers.capture();
            if (lastMissionId) listener(missionEvent(this.getMission(lastMissionId)));
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        subscribeNavigationPath({ missionId }, listener) {
            timers.capture();
            if (!pathListeners.has(missionId)) pathListeners.set(missionId, new Set());
            if (paths.has(missionId)) listener(pathEvent(missionId));
            pathListeners.get(missionId).add(listener);
            return () => {
                const set = pathListeners.get(missionId);
                set?.delete(listener);
                if (!set?.size) pathListeners.delete(missionId);
            };
        },
        setScenario(next) {
            if (!['normal', 'goal-rejected', 'blocked-failed'].includes(next)) {
                throw navigationError('INVALID_SCENARIO', 'Mission scenario không hợp lệ.');
            }
            scenario = next;
        },
        clear() {
            timers.clear();
            if (activeMissionId) release(activeMissionId);
            missions.clear(); paths.clear(); listeners.clear(); pathListeners.clear();
            activeMissionId = null; lastMissionId = null; scenario = 'normal';
            streamEpoch = crypto.randomUUID(); sequence = 0;
        },
        dispose() { this.clear(); timers.dispose(); },
    };
}
