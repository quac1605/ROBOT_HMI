import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, ButtonGroup, Chip, Paper, Stack, Typography } from '@mui/material';
import { CONTROL_POLICY } from '@robot-hmi/control-domain/controlPolicy';
import CameraPanel from '../CameraPanel.jsx';
import { useRobotClient } from '../../hooks/useRobotClient.js';

// Navigation chỉ xem camera. State này độc lập với controlStore của Mapping,
// nên đổi camera ở đây không xin/nhả lease hoặc đổi hướng joystick.
export default function NavigationCameraPanel() {
  const client = useRobotClient();
  const [selection, setSelection] = useState({ cameraId: 'front', generation: 0 });
  const [frame, setFrame] = useState(null);
  const [now, setNow] = useState(() => performance.now());

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
      sx={{ overflow: 'hidden', maxWidth: 360, borderRadius: 2 }}>
      <Stack direction="row" spacing={1} sx={{ p: 1, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Typography variant="subtitle2">Camera quan sát</Typography>
        <Chip size="small" data-testid="navigation-camera-health"
          label={currentFrame?.error ? 'Lỗi camera' : playing ? 'Đang phát' : 'Chờ hình'}
          color={currentFrame?.error ? 'error' : playing ? 'success' : 'warning'} />
      </Stack>
      <ButtonGroup size="small" sx={{ px: 1, pb: 1 }} aria-label="Chọn camera điều hướng">
        {['front', 'rear'].map(id => (
          <Button key={id} data-testid={`navigation-camera-select-${id}`}
            variant={selection.cameraId === id ? 'contained' : 'outlined'}
            onClick={() => setSelection(current => current.cameraId === id
              ? current : { cameraId: id, generation: current.generation + 1 })}>
            {id === 'front' ? 'Cam trước' : 'Cam sau'}
          </Button>
        ))}
      </ButtonGroup>
      <CameraPanel key={`${selection.cameraId}-${selection.generation}`}
        client={client} cameraId={selection.cameraId} generation={selection.generation}
        onFrame={onFrame} onFailure={onFailure} />
      {currentFrame?.error && <Alert severity="error">{currentFrame.error}</Alert>}
    </Paper>
  );
}
