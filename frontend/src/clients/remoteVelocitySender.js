/**
 * frontend/src/clients/remoteVelocitySender.js
 * 
 * SYNCHRONOUS VELOCITY SENDER CHO CONTROL TRANSPORT (M9 / F9.4).
 */

export function createVelocitySender({ requestSchema, requireContext, maxBufferedBytes = 16_384 }) {
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
    throw new TypeError('INVALID_SEND_BUFFER_LIMIT');
  }
  return function sendVelocity(request) {
    const payload = requestSchema.parse(request);
    const context = requireContext();
    const socket = context.socket;
    if (!socket || socket.readyState !== 1 || context.leaseId !== payload.leaseId) {
      throw new Error('CONTROL_TRANSPORT_NOT_READY');
    }
    const frame = JSON.stringify({ version: 1, type: 'teleop.velocity', payload });
    const bytes = new TextEncoder().encode(frame).byteLength;
    if (!Number.isFinite(socket.bufferedAmount) || socket.bufferedAmount + bytes > maxBufferedBytes) {
      throw new Error('CONTROL_TRANSPORT_BACKPRESSURE');
    }
    socket.send(frame);
    // Cố ý không return Promise/ACK và không cache frame cho reconnect.
  };
}
