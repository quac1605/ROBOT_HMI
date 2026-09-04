import { useState } from 'react';
import { Box, Button, Chip, Paper, Stack, Typography } from '@mui/material';
import Metric from '../components/status/Metric.jsx';
import PageFrame from '../components/layout/PageFrame.jsx';

const demoRobot = {
  localization: 'TRACKING',
  pose: { x: 4.12, y: 0.18, yaw: 0.415388 },
  velocity: { linearX: 0.04, angularZ: 0 },
  battery: null,
};

export default function StatusPage() {
  const [simulatedOnline, setSimulatedOnline] = useState(true);
  const yawDegrees = (demoRobot.pose.yaw * 180) / Math.PI;

  return (
    <PageFrame title="Trạng thái robot">
      <Stack spacing={3}>
        <Box aria-live="polite">
          <Chip
            color={simulatedOnline ? 'success' : 'warning'}
            label={simulatedOnline ? 'Kết nối mô phỏng: online' : 'Mất kết nối — dữ liệu cuối cùng'}
          />
        </Box>

        <Paper variant="outlined" sx={{ p: 3, opacity: simulatedOnline ? 1 : 0.6 }}>
          <Stack spacing={2}>
            <Typography variant="h6" color="primary">Định vị</Typography>
            <Metric label="Trạng thái" value={simulatedOnline ? demoRobot.localization : 'UNKNOWN'} />
            <Metric label="X" value={demoRobot.pose.x.toFixed(2)} unit="m" />
            <Metric label="Y" value={demoRobot.pose.y.toFixed(2)} unit="m" />
            <Metric label="Yaw" value={yawDegrees.toFixed(1)} unit="°" />
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 3, opacity: simulatedOnline ? 1 : 0.6 }}>
          <Stack spacing={2}>
            <Typography variant="h6" color="primary">Vận tốc</Typography>
            <Metric label="Dài (vx)" value={demoRobot.velocity.linearX.toFixed(2)} unit="m/s" />
            <Metric label="Góc (wz)" value={demoRobot.velocity.angularZ.toFixed(2)} unit="rad/s" />
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 3, opacity: simulatedOnline ? 1 : 0.6 }}>
          <Stack spacing={2}>
            <Typography variant="h6" color="primary">Nguồn điện</Typography>
            <Metric
              label="Mức pin"
              value={simulatedOnline ? demoRobot.battery : null}
              unit="%"
            />
          </Stack>
        </Paper>

        <Button
          variant="outlined"
          onClick={() => setSimulatedOnline((previous) => !previous)}
          sx={{ alignSelf: 'flex-start' }}
        >
          {simulatedOnline ? 'Giả lập mất kết nối' : 'Khôi phục kết nối mô phỏng'}
        </Button>
      </Stack>
    </PageFrame>
  );
}
