/**
 * frontend/src/clients/mockControl.js
 *
 * RE-EXPORT VÀ TÁI SỬ DỤNG CONTROL AUTHORITY DÙNG CHUNG CHO MOCK FRONTEND (M7 / PARITY C8).
 */
import { createControlAuthority } from '@robot-hmi/control-domain/controlAuthority';

export function createMockControlService(options) {
    return createControlAuthority(options);
}
