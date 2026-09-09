import {
  Alert,
  Box,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import Metric from '../components/status/Metric.jsx';
import PageFrame from '../components/layout/PageFrame.jsx';
import { useRobotStore } from '../stores/robotStore.js';
import { useRobotFreshness } from '../hooks/useRobotFreshness.js';
import { robotClient } from '../clients/index.js';
import { useState } from 'react';

export default function StatusPage() {
  const snapshot = useRobotStore((state) => state.snapshot);
  const error = useRobotStore((state) => state.error);
  const { stale, ageMs } = useRobotFreshness(2000);
  const [selectedScenario, setSelectedScenario] = useState(() => (
    robotClient.getDemoScenario ? robotClient.getDemoScenario() : 'online'
  ));

  const handleScenarioChange = (e) => {
    const val = e.target.value;
    setSelectedScenario(val);
    robotClient.setDemoScenario(val);
  };

  const isOnline = snapshot?.rosConnected && !stale;

  return (
    <PageFrame title="Trạng thái robot">
      <Stack spacing={3}>
        {/* Panel giả lập tình huống: luôn hiển thị ở DEV để không bị kẹt khi snapshot null hoặc stale */}
        {import.meta.env.DEV && robotClient.kind === 'mock' && (
          <Paper sx={{ p: 2, bgcolor: '#eef2f6', border: '1px dashed #90caf9' }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'center' }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                [DEV] Thử nghiệm tình huống robot:
              </Typography>
              <FormControl size="small" sx={{ minWidth: 200 }}>
                <InputLabel id="scenario-select-label">Kịch bản</InputLabel>
                <Select
                  labelId="scenario-select-label"
                  value={selectedScenario}
                  label="Kịch bản"
                  onChange={handleScenarioChange}
                >
                  <MenuItem value="online">1. Online bình thường</MenuItem>
                  <MenuItem value="offline">2. ROS2 mất kết nối (Offline)</MenuItem>
                  <MenuItem value="lost">3. Mất định vị (Localization Lost)</MenuItem>
                  <MenuItem value="stale">4. Đứt truyền thông (Stale &gt; 2s)</MenuItem>
                  <MenuItem value="unknown-battery">5. Chưa có dữ liệu Pin (null)</MenuItem>
                </Select>
              </FormControl>
            </Stack>
          </Paper>
        )}

        {/* Lỗi Schema nếu có */}
        {error && <Alert severity="error">{error}</Alert>}

        {/* Đang chờ gói tin đầu tiên */}
        {!snapshot && !error && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, p: 4, bgcolor: 'background.paper', borderRadius: 2 }}>
            <CircularProgress size={28} />
            <Typography>
              Đang chờ gói tin telemetry từ robot... (Nếu đang thử kịch bản Stale, hãy chọn sang Online ở bảng trên để khôi phục)
            </Typography>
          </Box>
        )}

        {/* Khi đã có snapshot */}
        {snapshot && (
          <>
            {/* Cảnh báo trạng thái kết nối và độ tươi dữ liệu (Độc lập nhau) */}
            <Stack spacing={1.5}>
              {!snapshot.rosConnected && (
                <Alert severity="error">Robot mất kết nối ROS2 (Offline)</Alert>
              )}

              {stale && (
                <Alert severity="warning">
                  Dữ liệu telemetry bị gián đoạn (Độ trễ: {ageMs !== null ? (ageMs / 1000).toFixed(1) : '--'}s) — Đang hiển thị giá trị cuối cùng
                </Alert>
              )}

              {snapshot.rosConnected && !stale && snapshot.localization?.status === 'lost' && (
                <Alert severity="warning">
                  Cảnh báo: Robot bị mất định vị ({snapshot.localization.reason || 'Mất tín hiệu định vị'})
                </Alert>
              )}

              {snapshot.rosConnected && !stale && snapshot.localization?.status === 'tracking' && (
                <Alert severity="success">Hệ thống hoạt động bình thường (Online — 5 Hz)</Alert>
              )}

              {/* Hiển thị thời điểm nhận gói tin (receivedAt) và độ trễ */}
              <Box sx={{ display: 'flex', justifyContent: 'space-between', px: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  Gói tin cuối: <strong>{snapshot.receivedAt ? new Date(snapshot.receivedAt).toLocaleTimeString('vi-VN') : 'Chưa có'}</strong>
                </Typography>
                <Typography variant="caption" color={stale ? 'warning.main' : 'text.secondary'}>
                  Độ trễ truyền thông: <strong>{ageMs !== null ? `${Math.round(ageMs)} ms` : '--'}</strong>
                </Typography>
              </Box>
            </Stack>

            {/* Khối Định vị */}
            <Paper variant="outlined" sx={{ p: 3, opacity: isOnline ? 1 : 0.6 }}>
              <Stack spacing={2}>
                <Typography variant="h6" color="primary">Định vị</Typography>
                <Metric
                  label="Trạng thái"
                  value={snapshot.localization?.status === 'tracking' ? 'TRACKING' : (snapshot.localization?.status || 'UNKNOWN').toUpperCase()}
                />
                <Metric label="Khung tọa độ (Frame)" value={snapshot.pose ? snapshot.pose.frameId : null} />
                <Metric label="Tọa độ X" value={snapshot.pose ? snapshot.pose.x.toFixed(2) : null} unit="m" />
                <Metric label="Tọa độ Y" value={snapshot.pose ? snapshot.pose.y.toFixed(2) : null} unit="m" />
                <Metric
                  label="Góc hướng (Yaw)"
                  value={snapshot.pose ? ((snapshot.pose.yaw * 180) / Math.PI).toFixed(1) : null}
                  unit="°"
                />
              </Stack>
            </Paper>

            {/* Khối Vận tốc */}
            <Paper variant="outlined" sx={{ p: 3, opacity: isOnline ? 1 : 0.6 }}>
              <Stack spacing={2}>
                <Typography variant="h6" color="primary">Vận tốc</Typography>
                <Metric label="Dài (linearX)" value={snapshot.velocity ? snapshot.velocity.linearX.toFixed(2) : null} unit="m/s" />
                <Metric label="Góc (angularZ)" value={snapshot.velocity ? snapshot.velocity.angularZ.toFixed(2) : null} unit="rad/s" />
              </Stack>
            </Paper>

            {/* Khối Nguồn điện */}
            <Paper variant="outlined" sx={{ p: 3, opacity: isOnline ? 1 : 0.6 }}>
              <Stack spacing={2}>
                <Typography variant="h6" color="primary">Nguồn điện</Typography>
                <Metric label="Mức pin" value={snapshot.batteryPercent} unit="%" />
              </Stack>
            </Paper>
          </>
        )}
      </Stack>
    </PageFrame>
  );
}
