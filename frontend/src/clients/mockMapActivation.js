import { ActivateMapRequestSchema } from '../schemas/mission.js';
import { checkMapActivationPreconditions, checkRobotHealth, checkSavedMap } from '../utils/navigationGuards.js';
import { createLifecycleTimers } from '../utils/lifecycleTimers.js';
import { navigationError, errorDto, ZERO_VELOCITY } from '../utils/navigationPolicy.js';
import { gridToWorld } from '../utils/mapCoordinates.js';

export function createMockMapActivationService({ sharedRobotState, telemetry, jobService, mapRepository, idempotency }) {
    const timers = createLifecycleTimers();
    let ownerJobId = null;

    function release() {
        const state = sharedRobotState.getSnapshot();
        if (ownerJobId && state.mode === 'localizing') {
            sharedRobotState.update({ mode: 'idle', velocity: ZERO_VELOCITY });
        }
        ownerJobId = null;
    }

    return {
        activateMap(raw, principalId = 'demo-admin') {
            const payload = ActivateMapRequestSchema.parse(raw);
            const epoch = timers.capture();
            return idempotency.run({
                principalId, operation: 'activateMap',
                requestId: payload.requestId, payload
            }, async () => {
                const map = await mapRepository.getMap(payload.mapId, payload.mapRevision);
                timers.assert(epoch);
                const valid = checkSavedMap(map);
                if (!valid.ok) throw navigationError(valid.code, valid.reason);
                const control = telemetry.getControlState();
                const check = checkMapActivationPreconditions({
                    robotSnapshot: control.snapshot, transportStale: control.transportStale,
                });
                if (!check.ok) throw navigationError(check.code, check.reason);

                // Không có await giữa check và claim. Mapping/mission đều sẽ thấy localizing.
                sharedRobotState.update({
                    mode: 'localizing', localization: { status: 'unknown', reason: 'Đang kích hoạt map mock' },
                    pose: null, poseSourceUpdateAgeMs: null, velocity: ZERO_VELOCITY,
                });
                let job;
                try {
                    job = jobService.createJob({ type: 'activate_map' });
                    ownerJobId = job.jobId;
                } catch (error) {
                    sharedRobotState.update({ mode: 'idle' });
                    throw error;
                }
                timers.schedule(epoch, () => {
                    jobService.updateJob(job.jobId, { status: 'running' });
                    timers.schedule(epoch, () => {
                        try {
                            const latest = telemetry.getControlState();
                            const health = checkRobotHealth(latest.snapshot, { transportStale: latest.transportStale });
                            if (!health.ok) throw navigationError(health.code, health.reason);
                            if (ownerJobId !== job.jobId || latest.snapshot.mode !== 'localizing') {
                                throw navigationError('ACTIVATION_OWNERSHIP_LOST', 'Activation không còn sở hữu mode.');
                            }
                            // Seed định vị giả ở tâm geometry; KHÔNG chứng minh ô này đi được.
                            const xy = gridToWorld({ u: map.width / 2, v: map.height / 2 }, map);
                            const confirmed = telemetry.commitPose({ frameId: map.frameId, ...xy, yaw: map.origin.yaw }, {
                                activeMap: { id: map.id, revision: map.revision },
                                localization: { status: 'tracking', reason: null },
                                mode: 'idle', velocity: ZERO_VELOCITY,
                            });
                            if (!confirmed) {
                                throw navigationError('POSE_SOURCE_UNAVAILABLE', 'Nguồn pose không xác nhận định vị trên map mới.');
                            }
                            ownerJobId = null;
                            jobService.updateJob(job.jobId, {
                                status: 'completed',
                                result: { mapId: map.id, mapRevision: map.revision, frameId: map.frameId }
                            });
                        } catch (error) {
                            release();
                            jobService.updateJob(job.jobId, { status: 'failed', result: null, error: errorDto(error) });
                        }
                    }, 200);
                }, 100);
                return { jobId: job.jobId, status: 'accepted' };
            });
        },
        clear() { timers.clear(); release(); },
        reset() { this.clear(); },
        dispose() { this.clear(); timers.dispose(); },
    };
}
