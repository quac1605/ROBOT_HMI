// utils/controlLeaseCore.js
import { TeleopVelocityMessageSchema, ControlLimitsSchema, ControlContextSchema } from '@robot-hmi/contracts/control';
import { CONTROL_POLICY, ZERO, MANUAL_MAPPING_LIMITS, isFixedMappingVelocity } from './controlPolicy.js';

export function createControlLeaseCore({
    now = () => performance.now(),    // Monotonic clock (performance.now)
    wallNow = () => Date.now(),       // Wall clock (để tạo ISO string)
    uuid = () => crypto.randomUUID(), // UUID generator (inject để test)
    policy = CONTROL_POLICY,
    limits = { maxLinearX: 0.2, maxAngularZ: 0.5 },
    // Callbacks (trusted internal, không phải plugin tùy ý):
    checkAcquire,   // (context) => null | string — null = OK, string = error code
    checkDrive,     // (context) => null | string — gọi mỗi tick và mỗi send
    setVelocity,    // ({ linearX, angularZ }) => void — ghi vào sharedRobotState
    claimMode,      // (leaseId, context) => void — đặt mode='teleop' (hoặc giữ mode nếu mapping)
    releaseMode,    // (leaseId, context) => void — trả mode='idle' nếu còn teleop
}) {
    // Validate limits ngay khi tạo
    limits = ControlLimitsSchema.parse(limits);

    let owner = null;      // Record của người đang giữ lease, null = không ai
    let generation = 0;    // Tăng mỗi khi acquire hoặc revoke
    let blocked = false;   // Chặn re-entry trong callback
    let disposed = false;
    const revoked = [];    // Queue revocation để adapter drain

    // Helpers
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    const usable = () => { if (disposed) fail('SERVICE_DISPOSED'); };
    const sessionRequired = session => { if (!session) fail('UNAUTHENTICATED'); };

    // Tạo DTO từ record (chỉ expose những gì cần thiết)
    const dto = record => ({
        leaseId: record.leaseId,
        controlGeneration: record.generation,
        expiresAt: record.expiresAt,
        limits: structuredClone(record.limits),
        context: structuredClone(record.context),
    });

    // revoke: hủy owner, zero velocity, tăng generation
    // THỨ TỰ QUAN TRỌNG: null owner TRƯỚC KHI gọi callback (fence re-entry)
    function revoke(reason) {
        const previous = owner;
        owner = null;       // ← Fence TRƯỚC. Callback không thể thấy owner cũ.
        generation += 1;
        blocked = true;
        try {
            setVelocity(ZERO);
            if (previous) releaseMode(previous.leaseId, structuredClone(previous.context));
        } finally { blocked = false; }
        if (previous) {
            revoked.push({
                sessionId: previous.sessionId,
                leaseId: previous.leaseId,
                controlGeneration: generation,
                reason,
            });
        }
        return generation;
    }

    // Guard là callback đồng bộ nhưng có thể ném lỗi hoặc thu hồi lease qua
    // một callback lồng nhau. Chỉ record đang thực sự sở hữu robot mới được
    // phép đi tiếp; mọi lỗi guard phải chốt zero trước khi trả quyền điều khiển.
    function checkRuntimeDrive(record) {
        let reason;
        try {
            reason = checkDrive(structuredClone(record.context));
        } catch {
            reason = 'DRIVE_GUARD_ERROR';
        }
        if (owner !== record || generation !== record.generation) {
            return 'LEASE_NOT_OWNED';
        }
        if (reason) revoke(reason);
        return reason || null;
    }

    // tick: được adapter gọi mỗi 25ms qua setInterval
    // Kiểm tra lease TTL và watchdog timeout
    function tick() {
        usable();
        if (!owner) return;
        const record = owner;
        const time = now();
        // Lease hết hạn
        if (time >= record.deadline) {
            revoke('LEASE_EXPIRED');
            return;
        }
        // Watchdog: chỉ arm SAU command hợp lệ đầu tiên (lastCommandAt !== null)
        // null = chưa có command nào → watchdog chưa chạy (lease vẫn valid)
        if (record.lastCommandAt !== null &&
            time - record.lastCommandAt >= policy.commandTimeoutMs) {
            revoke('WATCHDOG_TIMEOUT');
            return;
        }
        // Kiểm tra điều kiện drive runtime
        checkRuntimeDrive(record);
    }

    // assertOwner: dùng trong send/release để xác nhận người gọi là owner
    function assertOwner(sessionId, leaseId) {
        usable();
        sessionRequired(sessionId);
        tick(); // Luôn tick TRƯỚC khi kiểm tra owner
        if (blocked || !owner ||
            owner.sessionId !== sessionId ||
            owner.leaseId !== leaseId ||
            owner.generation !== generation) {
            fail('LEASE_NOT_OWNED');
        }
        return owner;
    }

    return {
        // Xin quyền lái
        acquire(sessionId, rawContext = { kind: 'manual' }) {
            usable();
            sessionRequired(sessionId);
            tick();
            if (blocked) fail('CONTROL_MUTATION_IN_PROGRESS');
            if (owner) fail('CONTROL_BUSY');
            const context = ControlContextSchema.parse(rawContext);
            const reason = checkAcquire(structuredClone(context));
            if (reason) fail(reason);

            const record = {
                sessionId,
                context: structuredClone(context),
                limits: ControlLimitsSchema.parse(context.kind === 'mapping'
                    ? MANUAL_MAPPING_LIMITS : limits),
                leaseId: uuid(),
                generation: ++generation,
                deadline: now() + policy.leaseTtlMs,           // Monotonic deadline
                expiresAt: new Date(wallNow() + policy.leaseTtlMs).toISOString(), // ISO cho UI
                lastCommandAt: null, // null = watchdog chưa arm
                lastSequence: 0,
                tokens: new Map(), // freshnessToken → deadline (monotonic)
            };

            owner = record; // Claim TRƯỚC khi notify
            blocked = true;
            try { claimMode(record.leaseId, structuredClone(record.context)); }
            catch (error) { blocked = false; revoke('CLAIM_FAILED'); throw error; }
            finally { blocked = false; }

            if (owner !== record) fail('ACQUIRE_SUPERSEDED');
            return dto(record);
        },

        // Phát freshnessToken mới cho owner (gọi mỗi 100ms)
        heartbeat(sessionId) {
            usable();
            sessionRequired(sessionId);
            tick();
            if (!owner || owner.sessionId !== sessionId || blocked) return null;

            const time = now();
            // Dọn token hết hạn
            for (const [token, deadline] of owner.tokens) {
                if (time >= deadline) owner.tokens.delete(token);
            }

            const freshnessToken = uuid();
            // Token không sống quá deadline của lease
            owner.tokens.set(freshnessToken,
                Math.min(owner.deadline, time + policy.tokenTtlMs));

            // Giới hạn bộ nhớ: tối đa 16 tokens
            while (owner.tokens.size > 16) {
                owner.tokens.delete(owner.tokens.keys().next().value);
            }

            const tokenValidForMs = owner.tokens.get(freshnessToken) - time;
            return {
                leaseId: owner.leaseId,
                controlGeneration: generation,
                leaseExpiresAt: owner.expiresAt,
                leaseRemainingMs: owner.deadline - time,
                freshnessToken,
                tokenValidForMs,
                tokenExpiresAt: new Date(wallNow() + tokenValidForMs).toISOString(),
            };
        },

        // Gửi velocity command — SYNCHRONOUS
        // THỨ TỰ: parse → assertOwner (deadline check) → token → sequence → limits → drive check → update
        send(sessionId, raw) {
            usable();
            sessionRequired(sessionId);
            const message = TeleopVelocityMessageSchema.parse(raw);
            // assertOwner gọi tick() → kiểm tra deadline TRƯỚC khi tiếp tục
            const record = assertOwner(sessionId, message.leaseId);

            // Kiểm tra token (freshnessToken phải còn valid)
            const tokenDeadline = record.tokens.get(message.freshnessToken);
            if (tokenDeadline === undefined || now() >= tokenDeadline) fail('TOKEN_EXPIRED');

            // Chống replay: sequence phải luôn tăng
            if (message.sequence <= record.lastSequence) fail('SEQUENCE_REPLAY');

            // Kiểm tra giới hạn vận tốc
            if (Math.abs(message.linearX) > record.limits.maxLinearX ||
                Math.abs(message.angularZ) > record.limits.maxAngularZ) {
                fail('VELOCITY_OUT_OF_BOUNDS');
            }

            if (record.context.kind === 'mapping' && !isFixedMappingVelocity(message)) {
                fail('VELOCITY_NOT_FIXED');
            }

            // Kiểm tra điều kiện drive một lần nữa (runtime)
            const reason = checkRuntimeDrive(record);
            if (reason) fail(reason);

            // Cập nhật state — CHỈ SAU KHI tất cả checks pass
            record.lastSequence = message.sequence;
            record.lastCommandAt = now(); // Chỉ command HỢP LỆ mới nuôi watchdog
            setVelocity({ linearX: message.linearX, angularZ: message.angularZ });
            // void return — KHÔNG trả Promise
        },

        // Trả quyền lái
        release(sessionId, leaseId) {
            assertOwner(sessionId, leaseId);
            revoke('RELEASED');
        },

        // Dừng khẩn cấp (không cần sessionId — adapter phải auth trước khi gọi)
        stop() {
            usable();
            return revoke('STOP_REQUESTED');
        },

        // Thu hồi session (gọi khi logout)
        revokeSession(sessionId) {
            usable();
            if (owner?.sessionId === sessionId) revoke('SESSION_ENDED');
        },

        // Xem trạng thái (không có side effect)
        view(sessionId) {
            usable();
            sessionRequired(sessionId);
            tick();
            return {
                controlGeneration: generation,
                ownership: !owner ? 'none' : owner.sessionId === sessionId ? 'self' : 'other',
                lease: owner?.sessionId === sessionId ? dto(owner) : null,
            };
        },

        tick, // Để adapter gọi từ setInterval

        // Drain revocations sau mỗi operation (kể cả khi throw)
        takeRevocations() { return revoked.splice(0); },

        dispose() {
            if (disposed) return;
            disposed = true;
            revoke('SERVICE_DISPOSED');
        },
    };
}
