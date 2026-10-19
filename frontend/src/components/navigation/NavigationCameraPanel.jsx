import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, ButtonGroup, Chip, Paper, Stack, Typography } from '@mui/material';
import { CONTROL_POLICY } from '@robot-hmi/control-domain/controlPolicy';
import CameraPanel from '../CameraPanel.jsx';
import { useRobotClient } from '../../hooks/useRobotClient.js';

// Nhãn hiển thị cho từng lệnh cử chỉ; khóa là giá trị backend/model sẽ trả về
const GESTURE_LABELS = {
  turn_right: 'Rẽ phải',
  turn_left: 'Rẽ trái',
  forward: 'Đi thẳng',
  stop: 'Dừng',
  follow: 'Bám theo',
};

// Phát hiện người & cử chỉ chỉ chạy trên camera trước.
function GestureStatus({ active, gesture }) {
  const detected = active && gesture !== null && gesture in GESTURE_LABELS;
  const text = !active ? 'Chỉ nhận diện ở cam trước'
    : detected ? GESTURE_LABELS[gesture] : 'Chưa nhận diện';
  return (
    <Stack direction="row" spacing={0.75} data-testid="gesture-status"
      title="Phát hiện người & cử chỉ (camera trước). Chỉ hiển thị, không gửi lệnh điều khiển robot."
      sx={{
        alignItems: 'center', px: 1.25, py: 0.5, borderRadius: 5, minWidth: 0,
        border: 1, borderColor: detected ? 'success.light' : 'divider',
        bgcolor: detected ? 'rgba(46, 125, 50, 0.08)' : 'background.paper',
      }}>
      <Box sx={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        bgcolor: detected ? 'success.main' : 'grey.400',
        boxShadow: detected ? '0 0 0 3px rgba(46, 125, 50, 0.2)' : 'none',
      }} />
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>Cử chỉ:</Typography>
      <Typography variant="caption" data-testid="gesture-current" noWrap
        color={detected ? 'success.dark' : 'text.secondary'}
        sx={{ fontWeight: detected ? 700 : 500 }}>
        {text}
      </Typography>
    </Stack>
  );
}

// Navigation chỉ xem camera. State này độc lập với controlStore của Mapping,
// nên đổi camera ở đây không xin/nhả lease hoặc đổi hướng joystick.
export default function NavigationCameraPanel() {
  const client = useRobotClient();
  const [selection, setSelection] = useState({ cameraId: 'front', generation: 0 });
  const [frame, setFrame] = useState(null);
  const [now, setNow] = useState(() => performance.now());
  // TODO: nối kết quả nhận diện từ backend vào đây (khóa trong GESTURE_LABELS, hoặc null khi chưa có)
  const [gesture] = useState(null);

  useEffect(() => {
    // requestVideoFrameCallback ngừng gọi khi video đứng. Timer giúp nhãn
    // "Đang phát" hết hạn thay vì giữ trạng thái xanh vô thời hạn.
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const onFrame = useCallback(next => {
    setFrame(current => current?.generation > next.generation ? current : {
      cameraId: next.cameraId,
      generation: next.generation,
      lastFrameAt: next.lastFrameAt,
      error: null,
    });
  }, []);

  const onFailure = useCallback(next => {
    setFrame(current => current?.generation > next.generation ? current : {
      cameraId: next.cameraId,
      generation: next.generation,
      lastFrameAt: null,
      error: next.message,
    });
  }, []);

  const currentFrame = frame?.cameraId === selection.cameraId &&
    frame.generation === selection.generation ? frame : null;
  const playing = !currentFrame?.error && Number.isFinite(currentFrame?.lastFrameAt) &&
    now >= currentFrame.lastFrameAt &&
    now - currentFrame.lastFrameAt < CONTROL_POLICY.cameraStaleMs;

  return (
    <Paper variant="outlined" data-testid="navigation-camera-panel"
      sx={{ overflow: 'hidden', borderRadius: 3, boxShadow: '0 2px 12px rgba(25, 91, 120, 0.08)' }}>
      {/* Thanh tiêu đề: tên khung + tình trạng luồng hình */}
      <Stack direction="row" spacing={1}
        sx={{
          px: 1.5, py: 1, alignItems: 'center', justifyContent: 'space-between',
          bgcolor: 'grey.50', borderBottom: 1, borderColor: 'divider',
        }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Camera quan sát</Typography>
        <Chip size="small" variant="outlined" data-testid="navigation-camera-health"
          label={currentFrame?.error ? 'Lỗi camera' : playing ? 'Đang phát' : 'Chờ hình'}
          color={currentFrame?.error ? 'error' : playing ? 'success' : 'warning'} />
      </Stack>
      {/* Chọn camera bên trái, trạng thái cử chỉ lấp khoảng trống bên phải */}
      <Stack direction="row" spacing={1} useFlexGap
        sx={{ px: 1.5, py: 1, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <ButtonGroup size="small" aria-label="Chọn camera điều hướng">
          {['front', 'rear'].map(id => (
            <Button key={id} data-testid={`navigation-camera-select-${id}`}
              variant={selection.cameraId === id ? 'contained' : 'outlined'}
              onClick={() => setSelection(current => current.cameraId === id
                ? current : { cameraId: id, generation: current.generation + 1 })}>
              {id === 'front' ? 'Cam trước' : 'Cam sau'}
            </Button>
          ))}
        </ButtonGroup>
        <GestureStatus active={selection.cameraId === 'front'} gesture={gesture} />
      </Stack>
      <Box sx={{ px: 1, pb: 1 }}>
        <CameraPanel key={`${selection.cameraId}-${selection.generation}`}
          client={client} cameraId={selection.cameraId} generation={selection.generation}
          onFrame={onFrame} onFailure={onFailure} />
      </Box>
      {currentFrame?.error && <Alert severity="error" sx={{ borderRadius: 0 }}>{currentFrame.error}</Alert>}
    </Paper>
  );
}
