import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { joystickVector } from '../../utils/joystickVector.js';

const CENTER = Object.freeze({ x: 0, y: 0 });

export default function VirtualJoystick({ disabled, start, update, stop, testId = 'mapping-joystick', focusRef }) {
  const gesture = useRef(null);
  const [point, setPoint] = useState(CENTER);

  const finish = useCallback((reason) => {
    const current = gesture.current;
    // Xóa ref trước releasePointerCapture vì nó có thể phát lostpointercapture.
    gesture.current = null;
    setPoint(CENTER);
    if (!current) return;
    stop(reason, `pointer:${current.id}`);
    try {
      if (current.element.hasPointerCapture(current.id)) {
        current.element.releasePointerCapture(current.id);
      }
    } catch {
      // Node có thể đã bị tháo khỏi DOM; stop phía trên vẫn đã được yêu cầu.
    }
  }, [stop]);

  useEffect(() => {
    if (disabled) finish('JOYSTICK_DISABLED');
  }, [disabled, finish]);

  useEffect(() => () => {
    const current = gesture.current;
    gesture.current = null;
    if (current) stop('JOYSTICK_UNMOUNT', `pointer:${current.id}`);
  }, [stop]);

  function applyPosition(event) {
    const current = gesture.current;
    if (!current || event.pointerId !== current.id) return;
    if (disabled) {
      finish('JOYSTICK_DISABLED');
      return;
    }
    const rect = current.element.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    if (!(radius > 0)) {
      finish('JOYSTICK_GEOMETRY_INVALID');
      return;
    }
    const rawX = (event.clientX - rect.left - rect.width / 2) / radius;
    const rawY = (event.clientY - rect.top - rect.height / 2) / radius;
    const length = Math.max(1, Math.hypot(rawX, rawY));
    const x = rawX / length;
    const y = rawY / length;
    setPoint({ x, y });
    const vector = joystickVector(x, y);
    if (vector.linearX === 0 && vector.angularZ === 0) {
      // Pointerdown tại tâm chưa lái: được kéo ra một hướng.
      // Đã từng lái rồi quay về tâm: kết thúc gesture, không tự chạy lại.
      if (current.started) finish('JOYSTICK_CENTER');
      return;
    }
    const owner = `pointer:${current.id}`;
    const accepted = current.started ? update(owner, vector) : start(owner, vector);
    if (!accepted) {
      finish('JOYSTICK_REJECTED');
      return;
    }
    current.started = true;
  }

  return (
    <Box sx={{ display: 'grid', justifyItems: 'center', gap: 0.5 }}>
      <Typography variant="caption" sx={{ fontWeight: 600 }}>Giữ joystick để lái</Typography>
      <Box
        ref={focusRef}
        tabIndex={0}
        role="group"
        aria-label="Joystick bốn hướng; W A S D hoặc phím mũi tên cũng điều khiển robot"
        aria-disabled={disabled}
        data-testid={testId}
        onPointerDown={event => {
          if (disabled || gesture.current || !event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          // Capture thành công trước khi phát command đầu tiên.
          try { event.currentTarget.setPointerCapture(event.pointerId); }
          catch { return; }
          gesture.current = { id: event.pointerId, element: event.currentTarget, started: false };
          applyPosition(event);
        }}
        onPointerMove={event => {
          if (gesture.current?.id !== event.pointerId) return;
          event.preventDefault();
          applyPosition(event);
        }}
        onPointerUp={event => {
          if (gesture.current?.id === event.pointerId) finish('POINTER_UP');
        }}
        onPointerCancel={event => {
          if (gesture.current?.id === event.pointerId) finish('POINTER_CANCEL');
        }}
        onLostPointerCapture={event => {
          if (gesture.current?.id === event.pointerId) finish('CAPTURE_LOST');
        }}
        sx={{
          position: 'relative', width: 104, height: 104, borderRadius: '50%',
          border: '2px solid', borderColor: disabled ? 'grey.400' : 'primary.main',
          bgcolor: disabled ? 'grey.200' : 'action.hover',
          touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
          cursor: disabled ? 'not-allowed' : 'grab',
        }}
      >
        <Box aria-hidden="true" sx={{ position: 'absolute', top: 2, left: '50%', transform: 'translateX(-50%)', fontSize: 10, lineHeight: 1 }}>↑</Box>
        <Box aria-hidden="true" sx={{ position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)', fontSize: 10, lineHeight: 1 }}>↓</Box>
        <Box aria-hidden="true" sx={{ position: 'absolute', left: 3, top: '50%', transform: 'translateY(-50%)', fontSize: 10, lineHeight: 1 }}>←</Box>
        <Box aria-hidden="true" sx={{ position: 'absolute', right: 3, top: '50%', transform: 'translateY(-50%)', fontSize: 10, lineHeight: 1 }}>→</Box>
        <Box
          aria-hidden="true"
          sx={{
            position: 'absolute', left: '50%', top: '50%', width: 26, height: 26,
            borderRadius: '50%', bgcolor: disabled ? 'grey.500' : 'primary.main',
            pointerEvents: 'none',
            transform: `translate(calc(-50% + ${point.x * 32}px), calc(-50% + ${point.y * 32}px))`,
          }}
        />
      </Box>
      <Typography variant="caption" align="center" sx={{ fontSize: '0.65rem', lineHeight: 1.15 }}>
        0.3 m/s · 0.3 rad/s · Nhả để dừng
      </Typography>
    </Box>
  );
}
