/**
 * backend/src/realtime/bindHttpOwner.js
 * 
 * XÁC THỰC QUYỀN SỞ HỮU TAB CHO CÁC MUTATION ĐIỀU KHIỂN HTTP (M6 / F6.1).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const denied = () => Object.assign(new Error('OWNER_BINDING_REJECTED'),
  { code: 'OWNER_BINDING_REJECTED', status: 403 });

export function bindHttpOwner(req, registry, lifecycle) {
  const id = req.get('x-hmi-connection-id');
  const token = req.get('x-hmi-owner-token');

  // Kiểm tra định dạng cơ bản: id max 128 chars, token là chuỗi hex 64 ký tự (32 byte)
  if (typeof id !== 'string' || id.length > 128 ||
      typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) {
    throw denied();
  }

  // Đảm bảo session HTTP hiện tại còn nguyên vẹn, chưa bị logout/restart
  lifecycle.assertRequestSessionCurrent(req);

  // Tìm kiếm connection record tương ứng trong registry
  const record = registry.get(id);
  if (!record || record.kind !== 'app' || record.closed || record.ws.readyState !== 1 ||
      record.sessionId !== req.sessionID || record.userId !== req.user?.id) {
    throw denied();
  }

  // So sánh digest SHA-256 của token bằng timingSafeEqual để chống timing attack
  const supplied = createHash('sha256').update(token).digest();
  if (!Buffer.isBuffer(record.ownerTokenDigest) || record.ownerTokenDigest.length !== 32 ||
      !timingSafeEqual(supplied, record.ownerTokenDigest)) {
    throw denied();
  }

  // Kiểm tra thêm tính hợp lệ từ lifecycle fence của kết nối
  lifecycle.assertConnectionCurrent(record);
  // A cookie can outlive the last successful DB proof. Do not let a stale
  // socket's capability authorize an HTTP side effect while revalidation hangs.
  record.watcher?.assertFresh();

  return record; // Record nội bộ máy chủ, tuyệt đối không gửi ngược ra client
}
