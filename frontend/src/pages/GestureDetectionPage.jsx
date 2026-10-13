import { useCallback, useState } from 'react';
import { Alert, Box, Chip, Paper, Stack, Typography } from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';
import CameraPanel from '../components/CameraPanel.jsx';
import { useRobotClient } from '../hooks/useRobotClient.js';

// Nhãn hiển thị cho từng lệnh cử chỉ; khóa là giá trị backend/model sẽ trả về
const GESTURE_LABELS = {
  turn_right: 'Rẽ phải',
  turn_left: 'Rẽ trái',
  forward: 'Đi thẳng',
  stop: 'Dừng',
  follow: 'Bám theo',
};

const CAMERA_CHIP = {
  waiting: { label: 'Chờ frame', color: 'warning' },
  live: { label: 'Live', color: 'success' },
  error: { label: 'Lỗi camera', color: 'error' },
};

export default function GestureDetectionPage() {
  const client = useRobotClient();
  const [cameraStatus, setCameraStatus] = useState('waiting'); // waiting | live | error
  const [cameraError, setCameraError] = useState('');
  // TODO: nối kết quả nhận diện từ backend vào đây (khóa trong GESTURE_LABELS, hoặc null khi chưa có)
  const [gesture] = useState(null);

  const onFrame = useCallback(() => setCameraStatus('live'), []);
  const onFailure = useCallback(({ message }) => {
    setCameraStatus('error');
    setCameraError(message);
  }, []);

  const detected = gesture !== null && gesture in GESTURE_LABELS;
  const chip = CAMERA_CHIP[cameraStatus];

  return (
    <PageFrame title="Phát hiện Người & Cử chỉ">
      <Box sx={{ maxWidth: 960, mx: 'auto' }}>
        <Alert severity="info" sx={{ mb: 2 }} data-testid="gesture-demo-notice">
          Đây là giao diện xem camera. Chưa kết nối bộ nhận diện cử chỉ và trang này không gửi lệnh điều khiển robot.
        </Alert>
        <Paper
          variant="outlined"
          sx={{ borderRadius: 3, overflow: 'hidden', boxShadow: '0 2px 12px rgba(25, 91, 120, 0.08)' }}
        >
          {/* Thanh tiêu đề camera */}
          <Stack
            direction="row"
            sx={{
              px: 2, py: 1.25, alignItems: 'center', justifyContent: 'space-between',
              bgcolor: 'grey.50', borderBottom: 1, borderColor: 'divider',
            }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Camera trước</Typography>
            <Chip size="small" variant="outlined" label={chip.label} color={chip.color} data-testid="gesture-camera-health" />
          </Stack>

          {/* Khung camera */}
          <Box sx={{ p: { xs: 1, sm: 2 }, bgcolor: '#0b1a22' }}>
            <CameraPanel client={client} cameraId="front" generation={0} onFrame={onFrame} onFailure={onFailure} />
          </Box>

          {cameraStatus === 'error' && (
            <Alert severity="error" sx={{ borderRadius: 0 }}>{cameraError}</Alert>
          )}

          {/* Dòng trạng thái nhận diện */}
          <Stack
            direction="row"
            spacing={1.5}
            data-testid="gesture-status"
            sx={{ px: 2, py: 1.75, alignItems: 'center', borderTop: 1, borderColor: 'divider' }}
          >
            <Box
              sx={{
                width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                bgcolor: detected ? 'success.main' : 'grey.400',
              }}
            />
            <Typography variant="body2" color="text.secondary">Trạng thái:</Typography>
            <Typography
              variant="h6"
              data-testid="gesture-current"
              color={detected ? 'primary' : 'text.secondary'}
              sx={{ fontWeight: 600 }}
            >
              {detected ? GESTURE_LABELS[gesture] : 'Chưa nhận diện'}
            </Typography>
          </Stack>
        </Paper>
      </Box>
    </PageFrame>
  );
}
