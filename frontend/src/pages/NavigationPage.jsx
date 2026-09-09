import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';
import Map2D from '../components/map/Map2D.jsx';
import { demoMap, demoMapRotated } from '../clients/demoMap.js';
import { useRobotStore } from '../stores/robotStore.js';
import { isInsideMap } from '../utils/mapCoordinates.js';
import { useRobotFreshness } from '../hooks/useRobotFreshness.js';

export default function NavigationPage() {
  const snapshot = useRobotStore((state) => state.snapshot);
  const { stale } = useRobotFreshness(2000);

  // Đánh giá chất lượng dữ liệu vị trí robot
  const rosConnected = snapshot?.rosConnected ?? false;
  const locStatus = snapshot?.localization?.status ?? 'unknown';

  let poseQuality = 'reliable';
  if (!rosConnected) {
    poseQuality = 'offline';
  } else if (stale) {
    poseQuality = 'stale';
  } else if (locStatus !== 'tracking') {
    poseQuality = 'lost';
  }

  // Quản lý map hiện tại (hỗ trợ đổi giữa map chuẩn và map xoay)
  const [currentMap, setCurrentMap] = useState(demoMap);

  // Trạng thái mục tiêu và công cụ chuột
  const [goalDraft, setGoalDraft] = useState(null);
  const [tool, setTool] = useState('goal');

  // Trạng thái cho form nhập tọa độ bằng bàn phím
  const [manualX, setManualX] = useState('');
  const [manualY, setManualY] = useState('');
  const [manualYawDeg, setManualYawDeg] = useState('0');
  const [inputError, setInputError] = useState(null);

  // Xử lý đổi bản đồ: reset mục tiêu và chuyển map
  function handleMapChange(event) {
    const selectedId = event.target.value;
    const nextMap = selectedId === demoMapRotated.id ? demoMapRotated : demoMap;
    setCurrentMap(nextMap);
    setGoalDraft(null); // Reset goal khi đổi map revision/id
    setInputError(null);
  }

  // Xử lý đổi công cụ (Pan hoặc Chọn đích)
  function handleToolChange(event, newTool) {
    if (newTool !== null) {
      setTool(newTool);
    }
  }

  // Xử lý nhập tọa độ thủ công bằng bàn phím
  function handleApplyManualCoordinates(e) {
    e.preventDefault();
    setInputError(null);

    const xTrim = manualX.trim();
    const yTrim = manualY.trim();
    const yawTrim = manualYawDeg.trim();

    // Kiểm tra chuỗi rỗng: không tự ý biến chuỗi rỗng thành 0
    if (xTrim === '' || yTrim === '' || yawTrim === '') {
      setInputError('Vui lòng nhập đầy đủ các trường X, Y và Góc quay.');
      return;
    }

    const numX = Number(xTrim);
    const numY = Number(yTrim);
    const numDeg = Number(yawTrim);

    if (!Number.isFinite(numX) || !Number.isFinite(numY) || !Number.isFinite(numDeg)) {
      setInputError('Tọa độ hoặc góc quay không phải là số hợp lệ.');
      return;
    }

    // Chặn góc quá lớn gây tràn số IEEE 754 (ví dụ 1e308 nhân PI ra Infinity)
    if (Math.abs(numDeg) > 36000) {
      setInputError('Góc quay phải nằm trong khoảng hợp lệ (-36000° đến 36000°).');
      return;
    }

    // Chuẩn hóa góc về đoạn [-180, 180] độ
    let normalizedDeg = numDeg % 360;
    if (normalizedDeg > 180) normalizedDeg -= 360;
    if (normalizedDeg < -180) normalizedDeg += 360;

    const numYawRad = (normalizedDeg * Math.PI) / 180;
    if (!Number.isFinite(numYawRad)) {
      setInputError('Góc quay không thể quy đổi sang Radian hợp lệ.');
      return;
    }

    const candidate = {
      frameId: currentMap.frameId,
      x: numX,
      y: numY,
      yaw: numYawRad,
    };

    if (!isInsideMap(candidate, currentMap)) {
      setInputError(
        `Tọa độ (${numX.toFixed(2)}, ${numY.toFixed(2)}) nằm ngoài phạm vi bản đồ!`
      );
      return;
    }

    setGoalDraft(candidate);
  }

  // Xóa đích đã chọn
  function handleClearGoal() {
    setGoalDraft(null);
    setInputError(null);
  }

  // Đổi yaw từ Radian sang Độ để hiển thị
  const goalYawDegrees = goalDraft ? ((goalDraft.yaw * 180) / Math.PI).toFixed(1) : '0.0';

  return (
    <PageFrame title="Điều hướng & Chọn đích (2D Map)">
      <Stack spacing={2.5}>
        {/* Thanh điều khiển trên cùng: Chọn Map & Chọn Tool */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}
        >
          {/* Bộ chọn Map */}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography id="map-select-label" variant="body2" sx={{ fontWeight: 600 }}>
              Bản đồ:
            </Typography>
            <Select
              id="map-select"
              labelId="map-select-label"
              size="small"
              value={currentMap.id}
              onChange={handleMapChange}
              inputProps={{ 'aria-label': 'Chọn bản đồ' }}
              sx={{ minWidth: 260 }}
            >
              <MenuItem value={demoMap.id}>{demoMap.name}</MenuItem>
              <MenuItem value={demoMapRotated.id}>{demoMapRotated.name}</MenuItem>
            </Select>
          </Stack>

          {/* Bộ chọn Công cụ (Tool) */}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Thao tác:
            </Typography>
            <ToggleButtonGroup
              size="small"
              value={tool}
              exclusive
              onChange={handleToolChange}
              aria-label="Công cụ bản đồ"
            >
              <ToggleButton value="goal" aria-label="Chọn điểm đích">
                🎯 Chọn đích
              </ToggleButton>
              <ToggleButton value="pan" aria-label="Di chuyển bản đồ">
                ✋ Di chuyển (Pan)
              </ToggleButton>
            </ToggleButtonGroup>
          </Stack>
        </Stack>

        {/* Khung bản đồ 2D */}
        <Map2D
          key={`${currentMap.id}:${currentMap.revision}`}
          map={currentMap}
          pose={snapshot?.pose ?? null}
          poseQuality={poseQuality}
          goal={goalDraft}
          tool={tool}
          onGoalChange={setGoalDraft}
        />

        {/* Khu vực thông tin mục tiêu & Điều khiển */}
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          {/* Bảng hiển thị mục tiêu đã chọn */}
          <Card variant="outlined" sx={{ flex: 1 }}>
            <CardContent>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                MỤC TIÊU ĐANG CHỌN
              </Typography>

              {goalDraft ? (
                <Stack spacing={1}>
                  <Typography variant="h6" color="primary">
                    X: {goalDraft.x.toFixed(2)} m | Y: {goalDraft.y.toFixed(2)} m
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Hướng đích (Yaw): {goalYawDegrees}° ({(goalDraft.yaw).toFixed(3)} rad)
                  </Typography>
                  <Box sx={{ pt: 1 }}>
                    <Button
                      size="small"
                      color="error"
                      variant="outlined"
                      onClick={handleClearGoal}
                    >
                      Xóa đích
                    </Button>
                  </Box>
                </Stack>
              ) : (
                <Typography variant="body1" color="text.secondary" sx={{ py: 1 }}>
                  Chưa chọn đích. Hãy click và kéo trên bản đồ hoặc nhập tọa độ bên cạnh.
                </Typography>
              )}
            </CardContent>
          </Card>

          {/* Form nhập tọa độ bàn phím (Accessibility) */}
          <Card variant="outlined" sx={{ flex: 1.2 }}>
            <CardContent>
              <Typography variant="subtitle2" color="text.secondary" gutterBottom>
                NHẬP TỌA ĐỘ BẰNG BÀN PHÍM
              </Typography>

              <Box component="form" onSubmit={handleApplyManualCoordinates} sx={{ mt: 1 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                  <TextField
                    label="X (m)"
                    size="small"
                    value={manualX}
                    onChange={(e) => setManualX(e.target.value)}
                    placeholder="ví dụ 3.5"
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    label="Y (m)"
                    size="small"
                    value={manualY}
                    onChange={(e) => setManualY(e.target.value)}
                    placeholder="ví dụ 2.0"
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    label="Góc (°)"
                    size="small"
                    value={manualYawDeg}
                    onChange={(e) => setManualYawDeg(e.target.value)}
                    placeholder="ví dụ 45"
                    sx={{ flex: 1 }}
                  />
                  <Button type="submit" variant="contained" size="small" sx={{ px: 2.5 }}>
                    Áp dụng
                  </Button>
                </Stack>

                {inputError && (
                  <Alert severity="error" sx={{ mt: 1.5, py: 0 }}>
                    {inputError}
                  </Alert>
                )}
              </Box>
            </CardContent>
          </Card>
        </Stack>

        <Divider />

        {/* Nút gửi lệnh đi đến đích (sẽ mở ở chặng 7) */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          sx={{ justifyContent: 'flex-end', alignItems: 'center' }}
        >
          <Typography variant="caption" color="text.secondary">
            * Chức năng gửi lệnh Mission sẽ được kết nối ở Chặng 7.
          </Typography>
          <Button
            disabled
            variant="contained"
            color="success"
            size="large"
            sx={{ minWidth: 200 }}
          >
            Đi đến đích
          </Button>
        </Stack>
      </Stack>
    </PageFrame>
  );
}
