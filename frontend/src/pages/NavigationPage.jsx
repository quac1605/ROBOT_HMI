import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
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
import { useRobotStore } from '../stores/robotStore.js';
import { isInsideMap, resolveVisiblePose } from '../utils/mapCoordinates.js';
import { sameMapContext, sameGeometry } from '../utils/mapRenderModel.js';
import { resolvePoseQuality } from '../utils/poseQuality.js';
import { useRobotFreshness } from '../hooks/useRobotFreshness.js';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { useMapGrid } from '../hooks/useMapGrid.js';
import { useOccupancyRaster } from '../hooks/useOccupancyRaster.js';
import { useMappingWorkflowStore } from '../state/mappingWorkflowStore.js';

export default function NavigationPage() {
  const client = useRobotClient();
  const snapshot = useRobotStore((state) => state.snapshot);
  const { stale } = useRobotFreshness(2000);
  const catalogRefreshRevision = useMappingWorkflowStore((state) => state.catalogRefreshRevision);
  const workflowViewerContext = useMappingWorkflowStore((state) => state.viewerContext);
  const savedTargetKey = workflowViewerContext?.kind === 'saved'
    ? `${workflowViewerContext.mapId}:${workflowViewerContext.mapRevision}`
    : '';

  // 1. Danh mục bản đồ từ client
  const [mapCatalog, setMapCatalog] = useState([]);
  const [currentMap, setCurrentMap] = useState(null);
  const [catalogError, setCatalogError] = useState(null);

  useEffect(() => {
    let active = true;
    client
      .listMaps()
      .then((maps) => {
        if (!active) return;
        setCatalogError(null);
        setMapCatalog(maps);
        setCurrentMap((prev) => {
          if (workflowViewerContext?.kind === 'saved') {
            const justSaved = maps.find(
              (m) =>
                m.id === workflowViewerContext.mapId &&
                m.revision === workflowViewerContext.mapRevision
            );
            if (justSaved) return justSaved;
          }
          if (prev) {
            const matched = maps.find((m) => m.id === prev.id && m.revision === prev.revision);
            if (matched) return matched;
          }
          return maps[0] ?? null;
        });
      })
      .catch((err) => {
        if (active) setCatalogError(err.message);
      });
    return () => {
      active = false;
    };
  }, [client, catalogRefreshRevision, savedTargetKey, workflowViewerContext]);

  // 2. Ngữ cảnh bản đồ và hình học kỳ vọng
  const expectedContext = useMemo(() => {
    if (!currentMap) return null;
    return {
      kind: 'saved',
      mapId: currentMap.id,
      mapRevision: currentMap.revision,
    };
  }, [currentMap]);

  const expectedGeometry = useMemo(() => {
    if (!currentMap) return null;
    return {
      frameId: currentMap.frameId,
      width: currentMap.width,
      height: currentMap.height,
      resolution: currentMap.resolution,
      origin: currentMap.origin,
    };
  }, [currentMap]);

  // 3. Hook lấy dữ liệu OccupancyGrid và tạo Raster nguyên tử
  const { normalizedGrid, error: gridError } = useMapGrid(expectedContext, {
    expectedGeometry,
  });
  const { raster, rasterError } = useOccupancyRaster(normalizedGrid);

  // 4. RenderModel nguyên tử kết hợp context, geometry và raster
  const renderModel = useMemo(() => {
    if (
      raster &&
      sameMapContext(raster.context, expectedContext) &&
      sameGeometry(raster.geometry, expectedGeometry)
    ) {
      return raster;
    }
    return null;
  }, [raster, expectedContext, expectedGeometry]);

  // 5. Đánh giá chất lượng vị trí robot
  const poseQuality = resolvePoseQuality(snapshot, { transportStale: stale });

  // Lọc vị trí robot theo đúng ngữ cảnh bản đồ đang xem
  const visiblePose = useMemo(() => {
    if (!currentMap) return null;
    return resolveVisiblePose(snapshot, currentMap);
  }, [snapshot, currentMap]);

  // Trạng thái mục tiêu và công cụ chuột
  const [goalDraft, setGoalDraft] = useState(null);
  const [tool, setTool] = useState('goal');

  // Form nhập tọa độ bàn phím
  const [manualX, setManualX] = useState('');
  const [manualY, setManualY] = useState('');
  const [manualYawDeg, setManualYawDeg] = useState('0');
  const [inputError, setInputError] = useState(null);

  const currentMapKey = currentMap
    ? `${currentMap.id}:${currentMap.revision}`
    : '';

  // Đổi map bằng dropdown hoặc do một save-job hoàn tất trong nền đều phải
  // xóa goal của context cũ. Nếu không, hai map cùng frame `map` có thể vô
  // tình hiển thị lại một goal thuộc asset/revision khác.
  useEffect(() => {
    setGoalDraft(null);
    setInputError(null);
  }, [currentMapKey]);

  function handleMapChange(event) {
    try {
      const [selectedId, selectedRev] = JSON.parse(event.target.value);
      const nextMap = mapCatalog.find((m) => m.id === selectedId && m.revision === selectedRev);
      if (nextMap) {
        setCurrentMap(nextMap);
        setGoalDraft(null);
        setInputError(null);
      }
    } catch {
      // ignore
    }
  }

  function handleToolChange(event, newTool) {
    if (newTool !== null) {
      setTool(newTool);
    }
  }

  function handleApplyManualCoordinates(event) {
    event.preventDefault();
    setInputError(null);

    const x = Number(manualX);
    const y = Number(manualY);
    const yawDeg = Number(manualYawDeg);

    if (
      !manualX.trim() ||
      !manualY.trim() ||
      !manualYawDeg.trim() ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(yawDeg)
    ) {
      setInputError('Tọa độ hoặc góc quay phải là số hợp lệ.');
      return;
    }

    if (!currentMap) {
      setInputError('Chưa có thông tin bản đồ.');
      return;
    }

    const candidate = { x, y };
    if (!isInsideMap(candidate, currentMap)) {
      setInputError(
        `Điểm (${x}, ${y}) nằm ngoài phạm vi hình học của bản đồ đang chọn.`
      );
      return;
    }

    const yaw = (yawDeg * Math.PI) / 180;
    if (!Number.isFinite(yaw)) {
      setInputError('Góc quay nằm ngoài phạm vi số có thể xử lý.');
      return;
    }
    setGoalDraft({ frameId: currentMap.frameId, x, y, yaw });
  }

  return (
    <PageFrame
      title="Điều hướng Đi đến đích (Navigation)"
      subtitle="Chọn mục tiêu điều hướng trên bản đồ 2D Occupancy Grid hoặc nhập tọa độ"
    >
      <Stack spacing={3}>
        <Alert severity="warning" variant="outlined">
          Ô trống trên Occupancy Grid chỉ phản ánh dữ liệu cảm biến đầu vào;
          chưa có planner nên không khẳng định footprint robot đi qua an toàn
          hoặc đã có đường tránh vật cản.
        </Alert>
        {catalogError && <Alert severity="error">Lỗi nạp danh mục bản đồ: {catalogError}</Alert>}
        {gridError && <Alert severity="warning">Lỗi dữ liệu lưới: {gridError.message}</Alert>}
        {rasterError && <Alert severity="error">Lỗi xử lý hình ảnh bản đồ: {rasterError.message}</Alert>}

        {/* Thanh công cụ chọn bản đồ và chế độ chuột */}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 100 }}>
              Chọn bản đồ:
            </Typography>
            <Box id="map-selector-dropdown">
              <Select
                id="map-selector-select"
                size="small"
                value={currentMap ? JSON.stringify([currentMap.id, currentMap.revision]) : ''}
                onChange={handleMapChange}
                sx={{ minWidth: 260 }}
                disabled={mapCatalog.length === 0}
              >
                {mapCatalog.map((m) => (
                  <MenuItem key={JSON.stringify([m.id, m.revision])} value={JSON.stringify([m.id, m.revision])}>
                    {m.name} ({m.id} rev {m.revision})
                  </MenuItem>
                ))}
              </Select>
            </Box>
          </Stack>

          <ToggleButtonGroup
            value={tool}
            exclusive
            onChange={handleToolChange}
            size="small"
            aria-label="Công cụ tương tác chuột"
          >
            <ToggleButton value="goal" aria-label="Đặt mục tiêu">
              Đặt đích (Goal)
            </ToggleButton>
            <ToggleButton value="pan" aria-label="Kéo xem bản đồ">
              Kéo xem
            </ToggleButton>
          </ToggleButtonGroup>
        </Stack>

        {/* Cửa sổ bản đồ 2D */}
        <Card variant="outlined" sx={{ overflow: 'hidden' }}>
          <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
            {renderModel ? (
              <Map2D
                model={renderModel}
                pose={visiblePose}
                poseQuality={poseQuality}
                goal={goalDraft}
                tool={tool}
                onGoalChange={(nextGoal) => setGoalDraft(nextGoal)}
              />
            ) : (
              <Box
                sx={{
                  height: 440,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 1.5,
                  bgcolor: '#eceff1',
                  borderRadius: 2,
                }}
              >
                <CircularProgress size={36} />
                <Typography variant="body2" color="text.secondary">
                  {currentMap
                    ? `Đang nạp dữ liệu lưới ${currentMap.name} (rev ${currentMap.revision})...`
                    : 'Đang chuẩn bị bản đồ...'}
                </Typography>
              </Box>
            )}
          </CardContent>
        </Card>

        {/* Panel tọa độ và gửi lệnh */}
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <Card variant="outlined" sx={{ flex: 1 }}>
            <CardContent>
              <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
                Nhập tọa độ mục tiêu (m)
              </Typography>
              <Box component="form" onSubmit={handleApplyManualCoordinates}>
                <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                  <TextField
                    size="small"
                    label="X (m)"
                    value={manualX}
                    onChange={(e) => setManualX(e.target.value)}
                  />
                  <TextField
                    size="small"
                    label="Y (m)"
                    value={manualY}
                    onChange={(e) => setManualY(e.target.value)}
                  />
                  <TextField
                    size="small"
                    label="Góc (°)"
                    value={manualYawDeg}
                    onChange={(e) => setManualYawDeg(e.target.value)}
                  />
                  <Button type="submit" variant="outlined" size="small">
                    Áp dụng
                  </Button>
                </Stack>
                {inputError && (
                  <Alert severity="error" sx={{ mt: 1.5 }}>
                    {inputError}
                  </Alert>
                )}
              </Box>
            </CardContent>
          </Card>

          <Card variant="outlined" sx={{ flex: 1 }}>
            <CardContent>
              <Typography variant="subtitle2" gutterBottom sx={{ fontWeight: 600 }}>
                Mục tiêu đã chọn
              </Typography>
              {goalDraft ? (
                <Stack spacing={1}>
                  <Typography variant="body2">
                    Tọa độ: X = <strong>{goalDraft.x.toFixed(2)}m</strong>, Y = <strong>{goalDraft.y.toFixed(2)}m</strong>
                  </Typography>
                  <Typography variant="body2">
                    Hướng đích (Yaw): <strong>{((goalDraft.yaw * 180) / Math.PI).toFixed(1)}°</strong>
                  </Typography>
                  <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                    <Button
                      variant="contained"
                      color="primary"
                      size="small"
                      disabled
                      aria-describedby="navigation-submit-disabled-reason"
                    >
                      Bắt đầu di chuyển
                    </Button>
                    <Button variant="outlined" color="inherit" size="small" onClick={() => setGoalDraft(null)}>
                      Hủy mục tiêu
                    </Button>
                  </Stack>
                  <Typography
                    id="navigation-submit-disabled-reason"
                    variant="caption"
                    color="text.secondary"
                  >
                    Chưa gửi mission: chức năng điều hướng sẽ được nối ở Chặng 7.
                  </Typography>
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic', mt: 1 }}>
                  Chưa chọn mục tiêu. Dùng chuột click hoặc nhập tọa độ để đặt điểm đến.
                </Typography>
              )}
            </CardContent>
          </Card>
        </Stack>
      </Stack>
    </PageFrame>
  );
}
