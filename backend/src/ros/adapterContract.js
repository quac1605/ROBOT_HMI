/**
 * backend/src/ros/adapterContract.js
 * 
 * ĐỊNH NGHĨA NĂNG LỰC ADAPTER VÀ KHUNG CONTRACT CHO ROBOT RUNTIME (M8 / F8.1 - F8.5).
 */

export const ADAPTER_CAPABILITIES = Object.freeze({
    state: true,
    motion: true,
    mapping: true,
    activation: true,
    routePreview: true,
    mission: true,
});

export function assertAdapterCapability(adapter, capability) {
    if (!adapter || typeof adapter !== 'object' || !adapter.capabilities?.[capability]) {
        throw Object.assign(new Error(`ADAPTER_CAPABILITY_MISSING: ${capability}`), {
            code: 'ADAPTER_CAPABILITY_MISSING',
            status: 501,
        });
    }
}
