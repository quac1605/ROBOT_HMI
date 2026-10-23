/**
 * backend/src/services/rosStatusService.js
 *
 * TRẠNG THÁI ROBOT TỪ ROS 2: /odom -> pose, /tf -> mapPose,
 * /cmd_out -> velocity (theo config/ros_status.yaml).
 * Gom message mới nhất rồi ghi vào sharedRobotState với tần số cố định (publish_rate_hz),
 * nên frontend luôn nhận 'robot.state' đều đặn kể cả khi robot đứng yên (heartbeat).
 */
import { odometryToPose, twistToVelocity } from '../ros/rosStatusMessages.js';
import { createRosTfResolver } from '../ros/rosTfTransforms.js';

const ZERO = Object.freeze({ linearX: 0, angularZ: 0 });

export function createRosStatusService({
    sharedRobotState,
    spec,
    client,
    now = () => performance.now(),
    setEvery = (fn, ms) => setInterval(fn, ms),
    clearEvery = handle => clearInterval(handle),
    logger,
    mapFrameId = () => null,
    // false khi client dùng chung (runtime tự start/dispose, vì /cmd_in cũng đi qua nó).
    ownsClient = true,
}) {
    const { pose: poseSpec, velocity: velocitySpec } = spec.status;
    let pose = null;
    let poseAt = null;
    let poseConnectionEpoch = null;
    let velocity = null;
    let velocityAt = null;
    let velocityConnectionEpoch = null;
    let droppedMessages = 0;
    let timer = null;
    let observedConnectionEpoch = client.getConnectionEpoch?.() ?? 0;
    const tf = createRosTfResolver({ now, maxDynamicAgeMs: poseSpec.timeout_ms });

    function currentConnectionEpoch() {
        const epoch = client.getConnectionEpoch?.() ?? 0;
        if (epoch !== observedConnectionEpoch || !client.isConnected()) {
            tf.clear();
            observedConnectionEpoch = epoch;
        }
        return epoch;
    }

    client.subscribe(poseSpec.topic, { type: poseSpec.type, throttleMs: poseSpec.throttle_ms }, msg => {
        const epoch = currentConnectionEpoch();
        const next = odometryToPose(msg, poseSpec.default_frame_id);
        if (!next) { droppedMessages++; return; }
        pose = next;
        poseAt = now();
        poseConnectionEpoch = epoch;
    });
    client.subscribe(velocitySpec.topic, { type: velocitySpec.type, throttleMs: velocitySpec.throttle_ms }, msg => {
        const epoch = currentConnectionEpoch();
        const next = twistToVelocity(msg);
        if (!next) { droppedMessages++; return; }
        velocity = next;
        velocityAt = now();
        velocityConnectionEpoch = epoch;
    });
    client.subscribe('/tf', {
        type: 'tf2_msgs/msg/TFMessage', throttleMs: 50,
        qos: { history: 'keep_last', depth: 10, reliability: 'best_effort', durability: 'volatile' },
    }, msg => {
        currentConnectionEpoch();
        tf.ingest(msg);
    });
    client.subscribe('/tf_static', {
        type: 'tf2_msgs/msg/TFMessage', throttleMs: 0,
        qos: { history: 'keep_last', depth: 100, reliability: 'reliable', durability: 'transient_local' },
    }, msg => {
        currentConnectionEpoch();
        tf.ingest(msg, { isStatic: true });
    });

    function snapshot() {
        const epoch = currentConnectionEpoch();
        const t = now();
        const poseAge = poseAt === null ? null : Math.max(0, t - poseAt);
        const poseFresh = client.isConnected() && poseAge !== null &&
            poseAge <= poseSpec.timeout_ms && poseConnectionEpoch === epoch;
        const velocityFresh = client.isConnected() && velocityConnectionEpoch === epoch &&
            velocityAt !== null && t - velocityAt <= velocitySpec.timeout_ms;
        const frame = mapFrameId();
        return {
            rosConnected: poseFresh,
            pose: pose && { ...pose },
            mapPose: poseFresh && typeof frame === 'string' && frame.trim()
                ? tf.resolvePose(pose, frame) : null,
            poseSourceUpdateAgeMs: poseAge === null ? null : Math.round(poseAge),
            // Mất /cmd_out quá timeout thì coi như robot không còn được ra lệnh chạy.
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
