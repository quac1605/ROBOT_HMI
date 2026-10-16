import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, ButtonGroup, Chip, Paper, Stack, Typography } from '@mui/material';
import { CONTROL_POLICY } from '@robot-hmi/control-domain/controlPolicy';
import CameraPanel from '../CameraPanel.jsx';
import { useRobotClient } from '../../hooks/useRobotClient.js';

// Viewer tự quản lý camera khi dùng độc lập. Trang có điều khiển có thể truyền
// controlCamera để nối lựa chọn/freshness với controller; viewer không tự xin lease.
export default function NavigationCameraPanel({
  showGestureStatus = true,
  gestureStatus = 'Chưa nhận diện',
  compact = false,
  caption = null,
  controlCamera = null,
}) {
  const client = useRobotClient();
  const [localSelection, setLocalSelection] = useState({ cameraId: 'front', generation: 0 });
  const frameRef = useRef(null);
  const [frame, setFrame] = useState(null);
  const [now, setNow] = useState(() => performance.now());
  const selection = controlCamera ?? localSelection;
  // Chỉ phụ thuộc identity callback, không phụ thuộc object controlCamera mới
  // tạo ở mỗi render: cập nhật health/gesture không được mở lại WHEP reader.
  const externalOnFrame = controlCamera?.onFrame;
  const externalOnFailure = controlCamera?.onFailure;
  const externalOnSelect = controlCamera?.onSelect;

  useEffect(() => {
    // requestVideoFrameCallback ngừng gọi khi video đứng. Timer giúp nhãn
    // "Đang phát" hết hạn thay vì giữ trạng thái xanh vô thời hạn.
    const timer = setInterval(() => {
      setNow(performance.now());
      setFrame(frameRef.current);
    }, 250);
    return () => clearInterval(timer);
  }, []);

  const onFrame = useCallback(next => {
    const current = frameRef.current;
    if (current?.generation > next.generation) return;
    frameRef.current = {
      cameraId: next.cameraId,
      generation: next.generation,
      lastFrameAt: next.lastFrameAt,
      error: null,
    };
    externalOnFrame?.(next);
  }, [externalOnFrame]);

  const onFailure = useCallback(next => {
    const current = frameRef.current;
    if (current?.generation > next.generation) return;
    frameRef.current = {
      cameraId: next.cameraId,
      generation: next.generation,
      lastFrameAt: null,
      error: next.message,
    };
    setNow(performance.now());
    setFrame(frameRef.current);
    externalOnFailure?.(next);
  }, [externalOnFailure]);

  const selectCamera = useCallback(id => {
    if (externalOnSelect) {
      // Controller thực hiện stop/abandon trước khi tăng generation nếu cần.
      externalOnSelect(id);
      return;
    }
    setLocalSelection(current => current.cameraId === id
      ? current : { cameraId: id, generation: current.generation + 1 });
  }, [externalOnSelect]);

  // rVFC vẫn cập nhật guard mỗi frame; nhãn UI chỉ render theo timer 250 ms.
  // Tránh render cả cây MUI/rail ở tốc độ video.
  const currentFrame = frame?.cameraId === selection.cameraId &&
    frame.generation === selection.generation ? frame : null;
  // Một frame mới có thể tới sau tick đồng hồ UI: tránh tuổi âm giả.
  const displayNow = Math.max(now, Number.isFinite(currentFrame?.lastFrameAt) ? currentFrame.lastFrameAt : 0);
  const playing = !currentFrame?.error && Number.isFinite(currentFrame?.lastFrameAt) &&
    displayNow >= currentFrame.lastFrameAt &&
    displayNow - currentFrame.lastFrameAt < CONTROL_POLICY.cameraStaleMs;

  return (
    <Paper variant="outlined" data-testid="navigation-camera-panel"
      sx={{ overflow: 'hidden', width: '100%', minWidth: 0, borderRadius: 2 }}>
      <Stack direction="row" spacing={1} sx={{ p: compact ? 0.5 : 1, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Typography variant="subtitle2" sx={compact ? { fontSize: '0.75rem' } : undefined}>Camera quan sát</Typography>
        <Chip size="small" data-testid="navigation-camera-health"
          label={currentFrame?.error ? 'Lỗi camera' : playing ? (compact ? 'Live' : 'Đang phát') : 'Chờ hình'}
          color={currentFrame?.error ? 'error' : playing ? 'success' : 'warning'} />
      </Stack>
      <ButtonGroup size="small" sx={{ px: compact ? 0.5 : 1, pb: compact ? 0.5 : 1 }} aria-label="Chọn camera quan sát">
        {['front', 'rear'].map(id => (
          <Button key={id} data-testid={`navigation-camera-select-${id}`}
            sx={compact ? { px: 0.75, py: 0.25, fontSize: '0.7rem' } : undefined}
            variant={selection.cameraId === id ? 'contained' : 'outlined'}
            onClick={() => selectCamera(id)}>
            {id === 'front' ? 'Cam trước' : 'Cam sau'}
          </Button>
        ))}
      </ButtonGroup>
      <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0, aspectRatio: '16 / 9' }}>
          <CameraPanel key={`${selection.cameraId}-${selection.generation}`}
            client={client} cameraId={selection.cameraId} generation={selection.generation}
            onFrame={onFrame} onFailure={onFailure} />
        </Box>
        {showGestureStatus && (
          <Box data-testid="camera-gesture-status"
            sx={{ width: 110, flexShrink: 0, position: 'relative', border: '2px solid #000', borderRadius: 3, boxSizing: 'border-box' }}>
            {/* Nội dung không quyết định chiều cao hàng: ô trạng thái luôn cao bằng video. */}
            <Stack spacing={0.75} sx={{ position: 'absolute', inset: 0, p: 1, justifyContent: 'center', alignItems: 'center', overflow: 'auto' }}>
              <Typography variant="caption" align="center" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
                Trạng thái:
              </Typography>
              <Typography variant="body2" align="center" sx={{ lineHeight: 1.35, overflowWrap: 'anywhere' }}>
                {gestureStatus}
              </Typography>
            </Stack>
          </Box>
        )}
      </Box>
      {caption && <Typography variant="caption" sx={{ display: 'block', px: 1, py: 0.5, color: 'text.secondary', lineHeight: 1.3 }}>{caption}</Typography>}
      {currentFrame?.error && <Alert severity="error">{currentFrame.error}</Alert>}
    </Paper>
  );
}
