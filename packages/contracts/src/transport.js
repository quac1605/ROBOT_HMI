/**
 * packages/contracts/src/transport.js
 * 
 * SCHEMA QUẢN LÝ KẾT NỐI VÀ HANDSHAKE TRANSPORT (M2/M9).
 */
import { z } from 'zod';

/**
 * Trạng thái kết nối mạng của RobotClient (dùng cho subscribeConnectionStatus)
 */
export const ConnectionStatusSchema = z.object({
  status: z.enum(['connecting', 'connected', 'disconnected']),
  connectionEpoch: z.number().int().safe().nonnegative(),
  controlProfile: z.enum(['mock', 'hardware', 'unknown']),
}).strict();

/**
 * Khung bắt tay ban đầu khi WebSocket mở thành công (server gửi về tab)
 */
export const TransportHelloSchema = z.object({
  version: z.literal(1),
  type: z.literal('transport.hello'),
  connectionId: z.string().trim().min(1).max(128),
  // ownerToken dạng hex 64 ký tự (32 byte), sinh ngẫu nhiên cho tab
  ownerToken: z.string().regex(/^[0-9a-fA-F]{64}$/),
  serverBootEpoch: z.string().trim().min(1).max(128),
  controlProfile: z.literal('mock'), // Chặng 9 không chấp nhận hardware profile.
}).strict();

// /map-stream has its own connection identity for cleanup, but must never
// receive an HTTP control capability. Keep this a separate strict schema so
// omitting ownerToken on /ws cannot accidentally become valid.
export const MapTransportHelloSchema = TransportHelloSchema.omit({ ownerToken: true });

/**
 * Cấu trúc tin nhắn lỗi chung của giao vận HTTP
 */
export const HttpErrorPayloadSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(96),
    message: z.string().min(1).max(512),
  }).strict(),
  requestId: z.string().min(1).max(128).optional(),
}).strict();
