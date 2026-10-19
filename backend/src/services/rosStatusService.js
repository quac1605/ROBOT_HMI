/**
 * backend/src/services/rosStatusService.js
 *
 * TRẠNG THÁI ROBOT TỪ ROS 2: /odom -> pose, /cmd_in -> velocity (theo config/ros_status.yaml).
 * Gom message mới nhất rồi ghi vào sharedRobotState với tần số cố định (publish_rate_hz),
 * nên frontend luôn nhận 'robot.state' đều đặn kể cả khi robot đứng yên (heartbeat).
 */
import { odometryToPose, twistToVelocity } from '../ros/rosStatusMessages.js';

const ZERO = Object.freeze({ linearX: 0, angularZ: 0 });

export function createRosStatusService({
    sharedRobotState,
    spec,
    client,
    now = () => performance.now(),
    setEvery = (fn, ms) => setInterval(fn, ms),
    clearEvery = handle => clearInterval(handle),
    logger,
    // false khi client dùng chung (runtime tự start/dispose, vì /cmd_out cũng đi qua nó).
    ownsClient = true,
}) {
    const { pose: poseSpec, velocity: velocitySpec } = spec.status;
    let pose = null;
    let poseAt = null;
    let velocity = null;
    let velocityAt = null;
    let droppedMessages = 0;
    let timer = null;

    client.subscribe(poseSpec.topic, { type: poseSpec.type, throttleMs: poseSpec.throttle_ms }, msg => {
        const next = odometryToPose(msg, poseSpec.default_frame_id);
        if (!next) { droppedMessages++; return; }
        pose = next;
        poseAt = now();
    });
    client.subscribe(velocitySpec.topic, { type: velocitySpec.type, throttleMs: velocitySpec.throttle_ms }, msg => {
        const next = twistToVelocity(msg);
        if (!next) { droppedMessages++; return; }
        velocity = next;
        velocityAt = now();
    });

    function snapshot() {
        const t = now();
        const poseAge = poseAt === null ? null : Math.max(0, t - poseAt);
        const velocityFresh = velocityAt !== null && t - velocityAt <= velocitySpec.timeout_ms;
        return {
            rosConnected: client.isConnected() && poseAge !== null && poseAge <= poseSpec.timeout_ms,
            pose: pose && { ...pose },
            poseSourceUpdateAgeMs: poseAge === null ? null : Math.round(poseAge),
            // Mất /cmd_in quá timeout thì coi như robot không còn được ra lệnh chạy.
            velocity: velocityFresh ? { ...velocity } : { ...ZERO },
        };
    }

    function publish() {
        try {
            sharedRobotState.update(snapshot());
        } catch (error) {
            logger?.warn({ err: error }, 'ros status publish failed');
        }
    }

    return {
        start() {
            if (timer) return;
            if (ownsClient) client.start();
            publish();
            timer = setEvery(publish, 1000 / spec.publish_rate_hz);
            timer?.unref?.();
        },
        publish,
        getStatus: () => ({ ...snapshot(), droppedMessages }),
        dispose() {
            if (timer) clearEvery(timer);
            timer = null;
            if (ownsClient) client.dispose();
        },
    };
}
