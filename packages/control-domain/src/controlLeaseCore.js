/**
 * [READ FLOW STEP 15] Máy trạng thái lease: một chủ thể giữ quyền lái hữu hạn.
 * Core đồng bộ, dùng chung cho mock frontend và authority backend; không mở
 * WebSocket, không tạo timer và không trực tiếp publish ROS Twist. Authority
 * inject guard/callback vận tốc, chạy tick và biến revocation thành event.
 *
 * policy mặc định: command watchdog 300 ms, freshness token 500 ms, lease 15 s.
 * Đây là ngưỡng phần mềm; không thay thế watchdog hoặc E-stop vật lý trên robot.
 * @module control-domain/controlLeaseCore
 */
import { TeleopVelocityMessageSchema, ControlLimitsSchema, ControlContextSchema } from '@robot-hmi/contracts/control';
import { CONTROL_POLICY, ZERO, MANUAL_DRIVE_SPEED, MANUAL_MAPPING_LIMITS, isFixedMappingVelocity } from './controlPolicy.js';

/**
 * Tạo vùng nhớ quyền điều khiển của một robot, độc lập với React/HTTP/ROS.
 * @param {object} options Phụ thuộc nội bộ đã tin cậy, không nhận từ request body.
 * @param {() => number} [options.now] Đồng hồ monotonic ms để xét deadline.
 * @param {() => number} [options.wallNow] Đồng hồ epoch ms để tạo timestamp UI.
 * @param {() => string} [options.uuid] Sinh ID lease và freshness token.
 * @param {object} [options.policy=CONTROL_POLICY] TTL và ngân sách watchdog.
 * @param {object} [options.limits] Trần vận tốc manual; mapping có profile 0.3 riêng.
 * @param {Function} options.checkAcquire Context -> null hoặc mã lỗi trước cấp lease.
 * @param {Function} options.checkDrive Context -> null hoặc mã lỗi khi đang lái.
 * @param {Function} options.setVelocity Nhận {linearX, angularZ}, cập nhật command sink.
 * @param {Function} options.claimMode Nhận leaseId/context để nhận quyền mode/motion.
 * @param {Function} options.releaseMode Nhận leaseId/context để trả đúng quyền đã giữ.
 * @returns {object} API acquire/heartbeat/send/release/stop/view/tick/dispose.
 * @throws {Error} Lỗi Zod nếu limits cấu hình không đúng contract.
 */
export function createControlLeaseCore({
    now = () => performance.now(),    // Monotonic clock (performance.now)
    wallNow = () => Date.now(),       // Wall clock (để tạo ISO string)
    uuid = () => crypto.randomUUID(), // UUID generator (inject để test)
    policy = CONTROL_POLICY,
    limits = { maxLinearX: MANUAL_DRIVE_SPEED.linearX, maxAngularZ: MANUAL_DRIVE_SPEED.angularZ },
    // Callbacks (trusted internal, không phải plugin tùy ý):
    checkAcquire,   // (context) => null | string — null = OK, string = error code
    checkDrive,     // (context) => null | string — gọi mỗi tick và mỗi send
    setVelocity,    // ({ linearX, angularZ }) => void — ghi vào sharedRobotState
    claimMode,      // (leaseId, context) => void — đặt mode='teleop' (hoặc giữ mode nếu mapping)
    releaseMode,    // (leaseId, context) => void — trả mode='idle' nếu còn teleop
}) {
    // Validate limits ngay khi tạo
    limits = ControlLimitsSchema.parse(limits);

    // sessionId ở core là khóa chủ thể nội bộ. Backend bind theo WS/tab rồi mới
    // gọi core; cùng tài khoản hoặc cùng cookie không tự trở thành cùng owner.
    let owner = null;      // Record của người đang giữ lease, null = không ai
    let generation = 0;    // Tăng mỗi khi acquire hoặc revoke
    let blocked = false;   // Chặn re-entry trong callback
    let disposed = false;
    const revoked = [];    // Queue revocation để adapter drain

    /**
     * @param {string} code Mã lỗi domain để lớp HTTP/WS quyết định cách trả về.
     * @returns {never}
     * @throws {Error} Luôn ném Error có thuộc tính code, không tự nuốt lỗi.
     */
    const fail = code => { throw Object.assign(new Error(code), { code }); };
    /** @returns {void} @throws {Error} SERVICE_DISPOSED khi API đã đóng. */
    const usable = () => { if (disposed) fail('SERVICE_DISPOSED'); };
    /**
     * @param {string} session Khóa chủ thể đã được authority xác thực.
     * @returns {void}
     * @throws {Error} UNAUTHENTICATED nếu thiếu khóa; core không đọc cookie.
     */
    const sessionRequired = session => { if (!session) fail('UNAUTHENTICATED'); };

    /**
     * @param {object} record Lease nội bộ, có token, sequence và deadline monotonic.
     * @returns {object} DTO sao chép context/limits; giấu khóa owner và kho token.
     */
    const dto = record => ({
        leaseId: record.leaseId,
        controlGeneration: record.generation,
        expiresAt: record.expiresAt,
        limits: structuredClone(record.limits),
        context: structuredClone(record.context),
    });

    /**
     * Hủy quyền trước callback để callback lồng nhau không dùng lại owner cũ.
     * Generation tăng cả khi chưa có owner, giúp fence thao tác đã lỗi thời.
     * @param {string} reason Mã lý do dùng cho control.revoked ở authority.
     * @returns {number} Generation sau thu hồi; chưa phải xác nhận robot đã dừng.
     * @throws {Error} Lỗi callback setVelocity/releaseMode được truyền ra caller.
     */
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

    /**
     * Guard có thể gọi lồng nhau hoặc ném lỗi; kiểm tra lại identity + generation
     * sau callback để một record đã bị thay thế không thể tiếp tục gửi vận tốc.
     * @param {object} record Owner mà thao tác đang kiểm tra.
     * @returns {?string} null nếu được lái; mã lỗi nếu guard/ownership không hợp lệ.
     * @throws {Error} Lỗi callback khi revoke; lỗi checkDrive được đổi thành reason.
     */
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

    /**
     * Authority gọi định kỳ (mặc định 25 ms) và core gọi trước một số thao tác.
     * Xét deadline bằng >= để lệnh đến đúng ranh giới không hồi sinh lease.
     * @returns {void} Có thể revoke và ghi zero khi TTL/watchdog/guard thất bại.
     * @throws {Error} SERVICE_DISPOSED hoặc lỗi callback trong revoke.
     */
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

    /**
     * @param {string} sessionId Khóa chủ thể được lớp ngoài xác thực.
     * @param {string} leaseId ID mà caller đang giữ.
     * @returns {object} Owner còn sống sau khi xét deadline và runtime guard.
     * @throws {Error} LEASE_NOT_OWNED, lỗi lifecycle hoặc lỗi callback tick.
     */
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
        /**
         * Cấp lease độc quyền khi guard đồng ý. Deadline không tự gia hạn bởi
         * heartbeat; context mapping giữ vòng đời SLAM, chỉ nhận quyền chuyển động.
         * @param {string} sessionId Khóa chủ thể, không phải username.
         * @param {object} [rawContext={kind:'manual'}] Manual hoặc mappingSessionId.
         * @returns {object} Lease DTO gồm generation, hạn ISO, limits và context.
         * @throws {Error} CONTROL_BUSY, lỗi context/guard/lifecycle hoặc claimMode.
         */
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

        /**
         * Trả vé ngắn hạn cho chủ thể hiện tại; nhận heartbeat không nuôi watchdog
         * lệnh. Token cũ vẫn dùng được tới TTL để chịu độ trễ mạng bình thường.
         * @param {string} sessionId Chủ thể nhận token; authority gọi mỗi 100 ms.
         * @returns {?object} Heartbeat riêng của owner hoặc null với observer.
         * @throws {Error} Lỗi lifecycle hoặc callback tick.
         */
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

        /**
         * Xác thực rồi ghi vận tốc ngay, không có hàng đợi/retry/replay khi mất mạng.
         * Thứ tự: schema -> owner/deadline -> token -> sequence -> limits -> guard.
         * @param {string} sessionId Chủ thể gửi lệnh đã bind với kết nối.
         * @param {unknown} raw DTO leaseId/freshnessToken/sequence/linearX/angularZ.
         * @returns {void} Đồng bộ; success chỉ nghĩa lệnh đã được chuyển cho sink.
         * @throws {Error} Lỗi schema/owner/token/sequence/limits/guard hoặc sink.
         */
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

        /**
         * @param {string} sessionId Chủ thể trả quyền.
         * @param {string} leaseId Lease đang giữ; caller khác không được trả thay.
         * @returns {void} Thu hồi và gửi zero; xác nhận đứng yên thuộc authority.
         * @throws {Error} Lỗi ownership/lifecycle/callback.
         */
        release(sessionId, leaseId) {
            assertOwner(sessionId, leaseId);
            revoke('RELEASED');
        },

        /**
         * Yêu cầu dừng phần mềm: lớp HTTP/authority phải xác thực trước khi gọi.
         * Không đồng nghĩa nút E-stop vật lý, cũng không chứng minh bánh đã đứng.
         * @returns {number} Generation mới để authority gắn với measured stop.
         * @throws {Error} SERVICE_DISPOSED hoặc lỗi callback revoke.
         */
        stop() {
            usable();
            return revoke('STOP_REQUESTED');
        },

        /**
         * @param {string} sessionId Chủ thể bị đóng/logout; owner khác không đổi.
         * @returns {void}
         * @throws {Error} SERVICE_DISPOSED hoặc lỗi callback revoke.
         */
        revokeSession(sessionId) {
            usable();
            if (owner?.sessionId === sessionId) revoke('SESSION_ENDED');
        },

        /**
         * Đọc có xét tick nên có thể thu hồi lease hết hạn; không phải pure getter.
         * @param {string} sessionId Chủ thể đang hỏi để phân biệt self/other/none.
         * @returns {object} Snapshot chỉ kèm lease khi người hỏi chính là owner.
         * @throws {Error} Lỗi lifecycle hoặc callback tick.
         */
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

        /**
         * @returns {Array<object>} Lấy và xóa queue; authority drain kể cả khi API lỗi
         * để thông báo revoke không bị bỏ sót hoặc phát lại nhiều lần.
         */
        takeRevocations() { return revoked.splice(0); },

        /**
         * Đóng idempotent và gửi zero một lần; timer ngoài core do authority dọn.
         * @returns {void}
         * @throws {Error} Lỗi callback revoke; disposed vẫn đã được chốt trước đó.
         */
        dispose() {
            if (disposed) return;
            disposed = true;
            revoke('SERVICE_DISPOSED');
        },
    };
}
