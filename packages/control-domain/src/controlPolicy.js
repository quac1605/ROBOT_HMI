// utils/controlPolicy.js
// Không có import, không có side effect. Pure functions + constants.

export const CONTROL_POLICY = Object.freeze({
    publishMs: 50,           // Gửi velocity mỗi 50ms
    heartbeatMs: 100,        // Server phát freshnessToken mỗi 100ms
    watchdogPollMs: 25,      // core.tick() được adapter gọi mỗi 25ms
    commandTimeoutMs: 300,   // Không có command hợp lệ trong 300ms → revoke lease
    tokenTtlMs: 500,         // freshnessToken sống 500ms
    leaseTtlMs: 15000,       // Lease tồn tại 15 giây, KHÔNG tự renew
    cameraStaleMs: 1500,     // Frame camera cũ hơn 1500ms → không được lái
    robotStaleMs: 2000,      // Telemetry cũ hơn 2000ms → không được lái
    heartbeatStaleMs: 350,   // Không nhận heartbeat trong 350ms → không được lái
    motionSampleMaxAgeMs: 200, // Mock observation budget, not a motor watchdog guarantee.
    cameraRequiredForTeleop: true, // Demo policy: bắt buộc camera fresh mới cho lái
    zeroTolerance: 1e-6,
});

export const MANUAL_DRIVE_SPEED = Object.freeze({ linearX: 0.3, angularZ: 0.3 });
export const MANUAL_MAPPING_LIMITS = Object.freeze({
    maxLinearX: MANUAL_DRIVE_SPEED.linearX,
    maxAngularZ: MANUAL_DRIVE_SPEED.angularZ,
});
export function isFixedMappingVelocity(velocity) {
    if (!velocity) return false;
    const { linearX: v, angularZ: w } = velocity;
    // Zero vẫn hợp lệ. Không dùng epsilon để nhận một tốc độ ngoài profile.
    return (v === 0 && (w === 0 || Math.abs(w) === MANUAL_DRIVE_SPEED.angularZ)) ||
        (w === 0 && Math.abs(v) === MANUAL_DRIVE_SPEED.linearX);
}


// ZERO velocity dùng làm sentinel
export const ZERO = Object.freeze({ linearX: 0, angularZ: 0 });

// Kiểm tra velocity có phải zero không (với epsilon nhỏ)
export function isZero(velocity, epsilon = CONTROL_POLICY.zeroTolerance) {
    return Boolean(
        velocity &&
        Number.isFinite(velocity.linearX) &&
        Number.isFinite(velocity.angularZ) &&
        Math.abs(velocity.linearX) <= epsilon &&
        Math.abs(velocity.angularZ) <= epsilon,
    );
}

// Guard kiểm tra robot có cho phép chuyển động không.
// phase='acquire': kiểm tra khi nhấn "Nhận quyền lái" (mode phải idle, velocity=0)
// phase='drive':   kiểm tra mỗi 50ms khi đang lái (mode phải teleop)
//
// NGUYÊN TẮC FAIL-CLOSED: chỉ cho qua khi TƯỜNG MINH là OK.
// null/undefined → chặn, không bỏ qua.
export function controlRobotReasons(snapshot, transportStale, phase = 'acquire', context = { kind: 'manual' }) {
    const reasons = [];
    if (!snapshot) return ['ROBOT_UNKNOWN'];
    if (transportStale !== false) reasons.push('TRANSPORT_UNHEALTHY');
    if (snapshot.rosConnected !== true) reasons.push('ROS_UNAVAILABLE');
    if (snapshot.physicalEstopActive !== false) reasons.push('ESTOP_ACTIVE_OR_UNKNOWN');
    if (snapshot.motionInhibited !== false) reasons.push('MOTION_INHIBITED_OR_UNKNOWN');
    if (snapshot.activeMissionId !== null) reasons.push('MISSION_ACTIVE_OR_UNKNOWN');

    if (context?.kind === 'mapping') {
        if (typeof context.mappingSessionId !== 'string' || !context.mappingSessionId ||
            snapshot.activeMappingSessionId !== context.mappingSessionId) {
            reasons.push('MAPPING_CONTEXT_MISMATCH');
        }
        if (snapshot.mode !== 'mapping') reasons.push('MODE_NOT_ALLOWED');
    } else if (context?.kind === 'manual') {
        if (snapshot.activeMappingSessionId !== null) reasons.push('MAPPING_ACTIVE_OR_UNKNOWN');
        if (snapshot.mode !== (phase === 'acquire' ? 'idle' : 'teleop')) reasons.push('MODE_NOT_ALLOWED');
    } else {
        reasons.push('CONTROL_CONTEXT_UNKNOWN');
    }

    if (phase === 'acquire' && !isZero(snapshot.velocity)) reasons.push('ROBOT_NOT_STATIONARY');
    return reasons;
}


// Selector tổng hợp "có được lái không" — GỌI VỚI performance.now() MỖI LẦN SEND.
// KHÔNG cache `now` từ lần render trước.
// Trả { allowed: boolean, reasons: string[] }
export function selectCanDrive({ authenticated, control, robot, camera, now, context = { kind: 'manual' } }) {
    const reasons = [];
    // fresh(at, ttl): at là timestamp monotonic khi nhận, ttl là ngưỡng ms
    const fresh = (at, ttl) =>
        Number.isFinite(at) && now >= at && now - at < ttl;

    if (!authenticated) reasons.push('AUTH_REQUIRED');
    if (!['mock', 'hardware'].includes(control.controlProfile)) {
        reasons.push('CONTROL_PROFILE_UNKNOWN');
    }
    if (control.controlProfile === 'hardware' && control.hardwareReady !== true) {
        reasons.push('HARDWARE_NOT_READY');
    }
    if (!control.ready || control.phase === 'reconciling') reasons.push('CONTROL_NOT_READY');
    if (control.stopUnconfirmed) reasons.push('STOP_UNCONFIRMED');
    if (!['granted', 'driving'].includes(control.phase)) reasons.push('CONTROL_PHASE_BLOCKED');
    if (!control.lease || control.lease.controlGeneration !== control.controlGeneration) {
        reasons.push('LEASE_REQUIRED');
    }
    if (!(Number.isFinite(control.leaseDeadline) && now < control.leaseDeadline)) {
        reasons.push('LEASE_EXPIRED');
    }
    if (!fresh(control.heartbeatReceivedAt, CONTROL_POLICY.heartbeatStaleMs)) {
        reasons.push('HEARTBEAT_STALE');
    }
    if (!control.freshnessToken ||
        !(Number.isFinite(control.tokenDeadline) && now < control.tokenDeadline)) {
        reasons.push('TOKEN_EXPIRED');
    }

    const leaseContext = control.lease?.context ?? { kind: 'manual' };
    if (!context || leaseContext.kind !== context.kind ||
        (context.kind === 'mapping' &&
            leaseContext.mappingSessionId !== context.mappingSessionId)) {
        reasons.push('MAPPING_CONTEXT_MISMATCH');
    }

    // Guard robot state
    const robotFresh = !robot.error && fresh(robot.lastReceivedAt, CONTROL_POLICY.robotStaleMs);
    reasons.push(...controlRobotReasons(
        robot.snapshot,
        robotFresh ? false : true,
        'drive',
        context,
    ));

    // Guard camera
    if (CONTROL_POLICY.cameraRequiredForTeleop) {
        // Một frame mới với hai ID cùng thiếu hoặc cùng sai không xác nhận
        // người vận hành đang xem đúng một camera được ứng dụng hỗ trợ.
        const cameraOk = ['front', 'rear'].includes(camera.selectedCameraId) &&
            Number.isSafeInteger(camera.selectedGeneration) && camera.selectedGeneration >= 0 &&
            Number.isSafeInteger(camera.generation) && camera.generation >= 0 &&
            !camera.error &&
            camera.cameraId === camera.selectedCameraId &&
            camera.generation === camera.selectedGeneration &&
            fresh(camera.lastFrameAt, CONTROL_POLICY.cameraStaleMs);
        if (!cameraOk) reasons.push('CAMERA_NOT_FRESH');
    }
    return { allowed: reasons.length === 0, reasons: [...new Set(reasons)] };
}
