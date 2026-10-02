/**
 * frontend/src/clients/mockMotionSource.js
 *
 * RE-EXPORT MOCK MOTION SOURCE TỪ DOMAIN DÙNG CHUNG (M7 / PARITY C8).
 */
// Preserve the Stage 8 import while both frontend and backend use one core.
export { createMockMotionSource,
    createMockMotionSource as createMockVelocitySource,
} from '@robot-hmi/control-domain/mockMotionSource';
