import { isZero } from './controlPolicy.js';

// Drive đang chạy cần nguồn đo còn sống, dù mẫu đó có vận tốc khác zero.
// Cùng epoch/cursor và tuổi monotonic ngăn heartbeat/packet cũ giả mạo freshness.
export function acceptsFreshMotionSample({ sample, cursor, nowMono, maxAgeMs = 200 }) {
    return Boolean(sample && cursor &&
        typeof sample.sourceEpoch === 'string' && sample.sourceEpoch === cursor.sourceEpoch &&
        Number.isSafeInteger(sample.sourceSequence) && sample.sourceSequence > 0 &&
        sample.sourceSequence === cursor.sourceSequence &&
        Number.isFinite(sample.observedMono) && Number.isFinite(nowMono) &&
        nowMono >= sample.observedMono && nowMono - sample.observedMono < maxAgeMs &&
        Number.isFinite(sample.velocity?.linearX) && Number.isFinite(sample.velocity?.angularZ));
}

export function acceptsStationarySample({ sample, cursor, command, requiredRevision, nowMono, maxAgeMs = 200 }) {
    return Boolean(sample && cursor && command &&
        sample.sourceEpoch === cursor.sourceEpoch && sample.sourceEpoch === command.sourceEpoch &&
        Number.isSafeInteger(sample.sourceSequence) && sample.sourceSequence > 0 &&
        sample.sourceSequence === cursor.sourceSequence &&
        Number.isSafeInteger(command.commandRevision) && command.commandRevision >= 0 &&
        Number.isSafeInteger(sample.appliedCommandRevision) &&
        sample.appliedCommandRevision === command.commandRevision &&
        sample.appliedCommandRevision >= requiredRevision &&
        Number.isFinite(sample.observedMono) && Number.isFinite(nowMono) &&
        nowMono >= sample.observedMono && nowMono - sample.observedMono < maxAgeMs &&
        isZero(sample.velocity) && isZero(command.velocity));
}

export function acceptsStopSample({
    sample,
    baseline,
    stopCommandRevision,
    issuedMono,
    nowMono,
    healthy,
    missionSettled,
    maxAgeMs = 200,
    epsilon = 1e-6,
}) {
    if (healthy !== true || missionSettled !== true || !sample || !baseline) return false;
    if (sample.sourceEpoch !== baseline.sourceEpoch) return false;
    if (!Number.isSafeInteger(sample.sourceSequence) || sample.sourceSequence <= baseline.sourceSequence) return false;
    if (!Number.isSafeInteger(stopCommandRevision) || stopCommandRevision < 1 ||
        sample.appliedCommandRevision !== stopCommandRevision) return false;
    if (!Number.isFinite(issuedMono) || !Number.isFinite(sample.observedMono) ||
        !Number.isFinite(nowMono) || sample.observedMono <= issuedMono ||
        nowMono < sample.observedMono || nowMono - sample.observedMono >= maxAgeMs) return false;
    const v = sample.velocity;
    return Boolean(
        v &&
        Number.isFinite(v.linearX) &&
        Number.isFinite(v.angularZ) &&
        Math.abs(v.linearX) <= epsilon &&
        Math.abs(v.angularZ) <= epsilon
    );
}
