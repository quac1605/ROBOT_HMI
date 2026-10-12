import { z } from 'zod';

// --- Primitives tái dùng ---
const Id = z.string().min(1).max(128);
const Token = z.string().min(1).max(256);
const Counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PositiveCounter = Counter.refine(v => v > 0, { message: 'Phải > 0' });
const Iso = z.iso.datetime();
const ErrorDto = z.object({
    code: z.string().min(1).max(96),
    message: z.string().min(1).max(512),
}).strict();

// --- Velocity & Limits ---
export const VelocitySchema = z.object({
    linearX: z.number().finite(),
    angularZ: z.number().finite(),
}).strict();

export const ControlLimitsSchema = z.object({
    maxLinearX: z.number().finite().positive(),
    maxAngularZ: z.number().finite().positive(),
}).strict();


// Context là ý định xin quyền; backend kiểm session thật trước khi cấp lease.
export const ControlContextSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }).strict(),
    z.object({ kind: z.literal('mapping'), mappingSessionId: Id }).strict(),
]);

// --- Acquire (nhận quyền lái) ---
// Default chỉ để giữ client/fixture cũ. Mapping phải nêu đúng sessionId.
export const AcquireControlRequestSchema = z.object({
    requestId: Id,
    context: ControlContextSchema.default({ kind: 'manual' }),
}).strict();

// Server trả về: lease đầy đủ
export const AcquireControlResponseSchema = z.object({
    leaseId: Id,
    expiresAt: Iso,
    limits: ControlLimitsSchema,
    context: ControlContextSchema.default({ kind: 'manual' }),
    controlGeneration: PositiveCounter,
}).strict();


// --- Release (trả quyền lái) ---
export const ReleaseControlRequestSchema = z.object({
    leaseId: Id,
    requestId: Id,
}).strict();

export const ReleaseControlResponseSchema = z.object({
    leaseId: Id,
    requestId: Id,
    status: z.literal('released'),
}).strict();

// --- Stop (yêu cầu dừng) ---
export const RequestStopRequestSchema = z.object({
    requestId: Id,
}).strict();

export const RequestStopResponseSchema = z.object({
    requestId: Id,
    status: z.literal('accepted'),
}).strict();

// --- Velocity command (gửi mỗi 50ms khi đang lái) ---
// sequence: số thứ tự tăng dần của command velocity (KHÁC với sequence trong stream envelope)
// freshnessToken: UUID do server cấp qua heartbeat, hết hạn sau 500ms
export const TeleopVelocityMessageSchema = z.object({
    leaseId: Id,
    sequence: PositiveCounter,
    freshnessToken: Token,
    linearX: z.number().finite(),
    angularZ: z.number().finite(),
}).strict();

// --- Heartbeat (server phát mỗi 100ms cho owner) ---
export const ControlHeartbeatSchema = z.object({
    leaseId: Id,
    controlGeneration: PositiveCounter,
    leaseExpiresAt: Iso,
    leaseRemainingMs: z.number().finite().nonnegative(),
    freshnessToken: Token,
    tokenExpiresAt: Iso,
    tokenValidForMs: z.number().finite().positive(),
}).strict();

// --- Stop Confirmation (xác nhận robot đứng yên) ---
// Discriminated union: mock dùng 'mock-source-observation', hardware dùng 'robot-measured'
const StopConfirmationBase = {
    requestId: Id,
    controlGeneration: PositiveCounter,
    sourceEpoch: Id,
    sourceSequence: PositiveCounter,
    observedAt: Iso,
    velocity: VelocitySchema,
};

export const StopConfirmationSchema = z.discriminatedUnion('evidenceKind', [
    z.object({
        ...StopConfirmationBase,
        evidenceKind: z.literal('mock-source-observation'),
    }).strict(),
    z.object({
        ...StopConfirmationBase,
        evidenceKind: z.literal('robot-measured'),
        sourceId: Id,
        sourceAgeMs: z.number().finite().nonnegative(),
        clockDomain: z.enum(['ros-time', 'system-time']),
    }).strict(),
]);

// StopState: trạng thái của một lần stop (accepted → confirmed)
// superRefine đảm bảo: status='confirmed' phải có confirmation, và ngược lại
export const StopStateSchema = z.object({
    requestId: Id,
    controlGeneration: PositiveCounter,
    status: z.enum(['accepted', 'confirmed']),
    confirmation: StopConfirmationSchema.nullable(),
}).strict().superRefine((v, ctx) => {
    const confirmed = v.status === 'confirmed';
    if (confirmed !== (v.confirmation !== null)) {
        ctx.addIssue({ code: 'custom', message: 'Stop confirmation/status không nhất quán.' });
    }
    if (v.confirmation && (
        v.confirmation.requestId !== v.requestId ||
        v.confirmation.controlGeneration !== v.controlGeneration
    )) {
        ctx.addIssue({ code: 'custom', message: 'Confirmation không khớp request dừng.' });
    }
});

// ControlSnapshot: trạng thái quyền điều khiển tại một thời điểm
// superRefine đảm bảo: chỉ owner (ownership='self') mới thấy lease detail
export const ControlSnapshotSchema = z.object({
    controlGeneration: Counter,
    ownership: z.enum(['none', 'self', 'other']),
    lease: AcquireControlResponseSchema.nullable(),
    heartbeat: ControlHeartbeatSchema.nullable(),
    stop: StopStateSchema.nullable(),
}).strict().superRefine((v, ctx) => {
    if ((v.ownership === 'self') !== Boolean(v.lease)) {
        ctx.addIssue({ code: 'custom', message: 'Chỉ owner được nhận lease DTO.' });
    }
    if (v.lease && v.lease.controlGeneration !== v.controlGeneration) {
        ctx.addIssue({ code: 'custom', message: 'Lease generation lệch snapshot.' });
    }
    if (v.heartbeat && (!v.lease ||
        v.heartbeat.leaseId !== v.lease.leaseId ||
        v.heartbeat.controlGeneration !== v.controlGeneration)) {
        ctx.addIssue({ code: 'custom', message: 'Heartbeat không thuộc lease hiện tại.' });
    }
});

// --- Event Envelope (stream events từ subscribeControl) ---
// Mỗi event có header: version, streamEpoch, sequence (stream sequence), sentAt
// sequence ở đây là thứ tự EVENT trên stream — KHÁC với commandSequence của velocity
const Header = {
    version: z.literal(1),
    streamEpoch: Id,
    sequence: PositiveCounter,
    sentAt: Iso,
};

const envelope = (type, payload) => z.object({
    ...Header,
    type: z.literal(type),
    payload,
}).strict();

// ACK của từng velocity command: liên kết bằng leaseId + commandSequence
const CommandResult = z.object({
    leaseId: Id,
    commandSequence: PositiveCounter,
    success: z.boolean(),
    error: ErrorDto.nullable(),
}).strict().superRefine((v, ctx) => {
    if (v.success !== (v.error === null)) {
        ctx.addIssue({ code: 'custom', message: 'ACK/error không nhất quán.' });
    }
});

// Tất cả event types có thể nhận từ subscribeControl()
export const ControlEventEnvelopeSchema = z.discriminatedUnion('type', [
    envelope('control.granted', AcquireControlResponseSchema),
    envelope('control.heartbeat', ControlHeartbeatSchema),
    envelope('control.revoked', z.object({
        leaseId: Id,
        controlGeneration: PositiveCounter,
        reason: z.string().min(1).max(96),
    }).strict()),
    envelope('control.snapshot', ControlSnapshotSchema),
    envelope('control.stopConfirmed', StopConfirmationSchema),
    envelope('teleop.commandResult', CommandResult),
]);

// getControlState() trả envelope loại snapshot
export const GetControlStateResponseSchema = envelope('control.snapshot', ControlSnapshotSchema);
