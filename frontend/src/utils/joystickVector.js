import { MANUAL_DRIVE_SPEED } from '@robot-hmi/control-domain/controlPolicy';

export const JOYSTICK_DEAD_ZONE = 0.2;

// Vị trí x/y được chuẩn hóa theo bán kính vùng điều khiển.
// x > 0: ngón tay bên phải. y > 0: ngón tay phía dưới màn hình.
// Robot dùng linearX > 0: tiến; angularZ > 0: quay trái.
// Không nhận cameraId: camera không tham gia tính hướng điều khiển.
export function joystickVector(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { linearX: 0, angularZ: 0 };
  }
  if (Math.hypot(x, y) <= JOYSTICK_DEAD_ZONE) {
    return { linearX: 0, angularZ: 0 };
  }

  // Đúng đường phân giác: dừng, tránh tự chọn một hướng tùy ý.
  if (Math.abs(x) === Math.abs(y)) {
    return { linearX: 0, angularZ: 0 };
  }
  if (Math.abs(y) > Math.abs(x)) {
    return {
      linearX: y < 0 ? MANUAL_DRIVE_SPEED.linearX : -MANUAL_DRIVE_SPEED.linearX,
      angularZ: 0,
    };
  }
  return {
    linearX: 0,
    angularZ: x < 0 ? MANUAL_DRIVE_SPEED.angularZ : -MANUAL_DRIVE_SPEED.angularZ,
  };
}

// Bàn phím dùng cùng một nguồn tốc độ với joystick.
export function fixedVectorForDirection(direction) {
  switch (direction) {
    case 'forward': return joystickVector(0, -1);
    case 'backward': return joystickVector(0, 1);
    case 'left': return joystickVector(-1, 0);
    case 'right': return joystickVector(1, 0);
    default: return null;
  }
}
