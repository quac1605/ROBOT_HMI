// utils/controlEvidence.js
import { StopConfirmationSchema } from '@robot-hmi/contracts/control';
import { isZero } from './controlPolicy.js';

export function isStopEvidenceForProfile(profile, confirmation) {
    if (profile === 'mock') return confirmation?.evidenceKind === 'mock-source-observation';
    if (profile === 'hardware') return confirmation?.evidenceKind === 'robot-measured';
    return false;
}

export function matchesPendingStop(profile, pending, raw) {
    const parsed = StopConfirmationSchema.safeParse(raw);
    if (!parsed.success || !pending) return false;
    const confirmation = parsed.data;
    return (
        isStopEvidenceForProfile(profile, confirmation) &&
        pending.requestId === confirmation.requestId &&
        pending.controlGeneration === confirmation.controlGeneration &&
        isZero(confirmation.velocity)
    );
}
