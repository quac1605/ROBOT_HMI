// state/controlStore.js
import { create } from 'zustand';

export const useControlStore = create((set) => ({
    // --- Control phase & identity ---
    phase: 'idle',          // 'idle'|'acquiring'|'granted'|'driving'|'stopping'|'revoked'|'reconciling'|'error'
    controlGeneration: 0,
    controlProfile: 'unknown', // 'mock'|'hardware'|'unknown'
    hardwareReady: false,
    ready: false,

    // --- Lease detail (chỉ có khi phase='granted'/'driving') ---
    lease: null,            // AcquireControlResponse

    // --- Heartbeat / freshness token ---
    heartbeatReceivedAt: null,  // performance.now() khi nhận heartbeat
    freshnessToken: null,
    tokenDeadline: null,        // performance.now() + tokenValidForMs
    leaseDeadline: null,        // performance.now() + leaseRemainingMs

    // --- Stop state ---
    stopUnconfirmed: false,
    pendingStopRequestId: null,
    stopRequestPhase: null, // pending HTTP / accepted / uncertain; not robot stop evidence.
    controlError: null,
    stopState: null,        // { requestId, status, confirmation }
    lastRevocationReason: null,

    // --- Command result (ACK từng velocity command) ---
    commandResult: null,

    // --- Camera state ---
    selectedCameraId: 'front',
    selectedGeneration: 0,  // Tăng mỗi khi switch camera — là KEY cho CameraPanel
    cameraId: null,         // Camera đang thực sự render
    generation: 0,
    lastFrameAt: null,      // performance.now() của frame mới nhất
    cameraError: null,

    // === Actions (được coordinator gọi, KHÔNG component gọi trực tiếp) ===
    setControlState: (partial) => set(partial),

    // Switch camera: tăng selectedGeneration → CameraPanel mount mới với key mới
    selectCamera: (cameraId) => set(state => ({
        selectedCameraId: cameraId,
        selectedGeneration: state.selectedGeneration + 1,
        lastFrameAt: null,
        cameraError: null,
        // Xóa cameraId/generation cũ để selectCanDrive fail closed khi đang switch
        cameraId: null,
        generation: 0,
    })),

    // Callback từ CameraPanel mỗi khi decode được frame
    onFrame: (cameraId, generation, lastFrameAt) => set(state => {
        // Bỏ qua frame từ camera/generation cũ
        if (state.selectedCameraId !== cameraId || state.selectedGeneration !== generation) return {};
        return { cameraId, generation, lastFrameAt, cameraError: null };
    }),

    // Callback từ CameraPanel khi có lỗi
    onCameraError: (cameraId, generation, error) => set(state => {
        if (state.selectedCameraId !== cameraId || state.selectedGeneration !== generation) return {};
        return { cameraError: error?.message ?? String(error), lastFrameAt: null };
    }),
}));
