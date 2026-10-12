import { useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Typography,
} from '@mui/material';
import Metric from './Metric.jsx';
import { useRobotStore } from '../../stores/robotStore.js';
import { useRobotFreshness } from '../../hooks/useRobotFreshness.js';
import { robotClient } from '../../clients/index.js';

// Gộp từ StatusPage cũ: xác định nhãn/màu tình trạng kết nối theo cùng thứ tự ưu tiên với AppShell
function connectionState(snapshot, stale) {
  if (!snapshot) return { label: 'Đang chờ dữ liệu', color: 'default' };
  if (stale) return { label: 'Mất tín hiệu', color: 'warning' };
  if (!snapshot.rosConnected) return { label: 'Offline', color: 'error' };
  if (snapshot.localization?.status === 'lost') return { label: 'Mất định vị', color: 'warning' };
  return { label: 'Online', color: 'success' };
}

function batteryColor(percent) {
  if (percent === null || percent === undefined) return 'inherit';
  if (percent <= 20) return 'error';
  if (percent <= 40) return 'warning';
  return 'success';
}

/**
 * Ô trạng thái robot nằm trong bố cục trang Điều hướng (cột bên phải, cạnh bản đồ):
 * tọa độ X/Y, góc quay, vận tốc, tình trạng kết nối và pin. Có thể thu gọn.
 */
export default function RobotStatusCard() {
  const snapshot = useRobotStore((state) => state.snapshot);
  const error = useRobotStore((state) => state.error);
  const { stale, ageMs } = useRobotFreshness(2000);
  const [expanded, setExpanded] = useState(true);
  const [selectedScenario, setSelectedScenario] = useState(() => (
    robotClient.getDemoScenario ? robotClient.getDemoScenario() : 'online'
  ));

  const connection = connectionState(snapshot, stale);
  const isOnline = snapshot?.rosConnected && !stale;
  const pose = snapshot?.pose;
  const velocity = snapshot?.velocity;
  const battery = snapshot?.batteryPercent;

  const handleScenarioChange = (event) => {
    setSelectedScenario(event.target.value);
    robotClient.setDemoScenario(event.target.value);
  };

  return (
    <Paper
      variant="outlined"
      component="section"
      data-testid="robot-status-card"
      aria-label="Trạng thái robot"
      sx={{ overflow: 'hidden' }}
    >
      {/* Thanh tiêu đề: luôn hiển thị kể cả khi thu gọn */}
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', px: 1.5, py: 0.75, bgcolor: 'primary.main', color: 'primary.contrastText' }}
      >
        <Typography component="h2" variant="subtitle2" sx={{ fontWeight: 600, flexGrow: 1 }}>
          Trạng thái robot
        </Typography>
        <Chip
          data-testid="robot-status-connection"
          label={connection.label}
          color={connection.color}
          size="small"
          sx={{ height: 20, fontSize: 11, bgcolor: connection.color === 'default' ? 'grey.300' : undefined }}
        />
        <IconButton
          size="small"
          color="inherit"
          aria-label={expanded ? 'Thu gọn trạng thái robot' : 'Mở rộng trạng thái robot'}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          sx={{ p: 0.25 }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
            style={{ transform: expanded ? 'none' : 'rotate(180deg)', transition: 'transform 150ms' }}>
            <path d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
          </svg>
        </IconButton>
      </Stack>

      <Collapse in={expanded}>
        <Stack spacing={1} sx={{ p: 1.5 }}>
          {error && <Alert severity="error" sx={{ py: 0 }}>{error}</Alert>}

          {!snapshot && !error && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">Đang chờ telemetry...</Typography>
            </Stack>
          )}

          {snapshot && (
            <Box sx={{ opacity: isOnline ? 1 : 0.6 }}>
              <Stack spacing={0.25}>
                <Metric dense label="X" value={pose ? pose.x.toFixed(2) : null} unit="m" />
                <Metric dense label="Y" value={pose ? pose.y.toFixed(2) : null} unit="m" />
                <Metric dense label="Góc quay" value={pose ? ((pose.yaw * 180) / Math.PI).toFixed(1) : null} unit="°" />
              </Stack>
              <Divider sx={{ my: 0.75 }} />
              <Stack spacing={0.25}>
                <Metric dense label="V dài" value={velocity ? velocity.linearX.toFixed(2) : null} unit="m/s" />
                <Metric dense label="V góc" value={velocity ? velocity.angularZ.toFixed(2) : null} unit="rad/s" />
              </Stack>
              <Divider sx={{ my: 0.75 }} />
              <Metric dense label="Pin" value={battery} unit="%" />
              {battery !== null && battery !== undefined && (
                <LinearProgress
                  variant="determinate"
                  value={Math.max(0, Math.min(100, battery))}
                  color={batteryColor(battery)}
                  sx={{ mt: 0.5, height: 6, borderRadius: 3 }}
                />
              )}
            </Box>
          )}

          {snapshot && (
            <Typography variant="caption" color={stale ? 'warning.main' : 'text.secondary'}>
              Định vị: {(snapshot.localization?.status || 'unknown').toUpperCase()}
              {' · '}Trễ: {ageMs !== null ? `${Math.round(ageMs)} ms` : '--'}
            </Typography>
          )}

          {/* Bộ chọn kịch bản giả lập (chuyển từ StatusPage cũ), chỉ hiện ở DEV với mock client */}
          {import.meta.env.DEV && robotClient.kind === 'mock' && (
            <Select
              size="small"
              value={selectedScenario}
              onChange={handleScenarioChange}
              inputProps={{ 'aria-label': '[DEV] Kịch bản robot' }}
              sx={{ fontSize: 12, '& .MuiSelect-select': { py: 0.5 } }}
            >
              <MenuItem value="online">[DEV] Online bình thường</MenuItem>
              <MenuItem value="offline">[DEV] ROS2 mất kết nối</MenuItem>
              <MenuItem value="lost">[DEV] Mất định vị</MenuItem>
              <MenuItem value="stale">[DEV] Đứt truyền thông (&gt; 2s)</MenuItem>
              <MenuItem value="unknown-battery">[DEV] Chưa có dữ liệu pin</MenuItem>
            </Select>
          )}
        </Stack>
      </Collapse>
    </Paper>
  );
}
