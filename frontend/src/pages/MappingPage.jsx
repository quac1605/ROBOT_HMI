import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';
import Map2D from '../components/map/Map2D.jsx';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { useMapGrid } from '../hooks/useMapGrid.js';
import { useOccupancyRaster } from '../hooks/useOccupancyRaster.js';
import { useRobotFreshness } from '../hooks/useRobotFreshness.js';
import { useRobotStore } from '../stores/robotStore.js';
import { useMappingWorkflowStore, trackAcceptedJob } from '../state/mappingWorkflowStore.js';
import { resolveVisiblePose } from '../utils/mapCoordinates.js';
import { sameMapContext } from '../utils/mapRenderModel.js';
import { resolvePoseQuality } from '../utils/poseQuality.js';

export default function MappingPage() {
  const client = useRobotClient();
  const snapshot = useRobotStore((state) => state.snapshot);
  const { stale: transportStale } = useRobotFreshness(2000);

  // Workflow state từ coordinator nằm ngoài route
  const session = useMappingWorkflowStore((state) => state.session);
  const viewerContext = useMappingWorkflowStore((state) => state.viewerContext);
  const isProcessing = useMappingWorkflowStore((state) => state.processing);
  const isCoordinatorReady = useMappingWorkflowStore((state) => state.ready);
  const lastError = useMappingWorkflowStore((state) => state.lastError);
  const trackedOperation = useMappingWorkflowStore((state) => state.trackedOperation);

  const [mapNameInput, setMapNameInput] = useState('');
  const [localActionError, setLocalActionError] = useState(null);
  const [layers, setLayers] = useState({ grid: true, robot: true, path: true });
  const isSubmittingRef = useRef(false);

  // Hook lấy dữ liệu OccupancyGrid theo viewerContext (live mapping hoặc vừa lưu)
  const { normalizedGrid, status: gridStatus, error: gridError } = useMapGrid(viewerContext, {
    expectedFrameId: 'map',
  });
  const { raster, rasterError } = useOccupancyRaster(normalizedGrid);

  // Context Guard: Chỉ tạo renderModel khi raster thực sự khớp với viewerContext
  const renderModel = useMemo(() => {
    if (raster && sameMapContext(raster.context, viewerContext)) {
      return raster;
    }
    return null;
  }, [raster, viewerContext]);

  // Context-safe Robot Pose: Ẩn pose nếu pose từ context khác
  const visiblePose = useMemo(() => {
    if (!viewerContext || !snapshot || !renderModel?.geometry) return null;
    return resolveVisiblePose(snapshot, {
      kind: viewerContext.kind,
      mappingSessionId: viewerContext.kind === 'mapping' ? viewerContext.mappingSessionId : undefined,
      mapId: viewerContext.kind === 'saved' ? viewerContext.mapId : undefined,
      mapRevision: viewerContext.kind === 'saved' ? viewerContext.mapRevision : undefined,
      frameId: renderModel.geometry.frameId,
    });
  }, [snapshot, viewerContext, renderModel]);
  const poseQuality = resolvePoseQuality(snapshot, { transportStale });

  function toggleLayer(layer) {
    setLayers((current) => ({ ...current, [layer]: !current[layer] }));
  }

  async function handleStartMapping(e) {
    e.preventDefault();
    if (isSubmittingRef.current || isProcessing || !isCoordinatorReady) return;

    const trimmedName = mapNameInput.trim();
    if (!trimmedName) {
      setLocalActionError('Vui lòng nhập tên bản đồ hợp lệ.');
      return;
    }

    isSubmittingRef.current = true;
    setLocalActionError(null);

    try {
      const requestId = `req-start-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const resp = await client.startMapping({ name: trimmedName, requestId });
      await trackAcceptedJob(
        resp,
        'start_mapping',
        requestId,
        client,
        useMappingWorkflowStore,
        { name: trimmedName }
      );
    } catch (err) {
      setLocalActionError(err.message || 'Lỗi khi bắt đầu tạo bản đồ');
    } finally {
      isSubmittingRef.current = false;
    }
  }

  async function handleFinishMapping() {
    if (isSubmittingRef.current || isProcessing || !session) return;

    isSubmittingRef.current = true;
    setLocalActionError(null);

    try {
      const requestId = `req-finish-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const resp = await client.finishMapping({
        mappingSessionId: session.mappingSessionId,
        name: session.name,
        requestId,
      });
      await trackAcceptedJob(resp, 'finish_mapping', requestId, client, useMappingWorkflowStore);
    } catch (err) {
      setLocalActionError(err.message || 'Lỗi khi yêu cầu kết thúc phiên mapping');
    } finally {
      isSubmittingRef.current = false;
    }
  }

  async function handleRetryFinishMapping() {
    if (isSubmittingRef.current || isProcessing || !session) return;

    isSubmittingRef.current = true;
    setLocalActionError(null);

    try {
      // Retry tạo requestId mới độc lập theo đúng quy tắc idempotency
      const retryRequestId = `req-retry-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const resp = await client.finishMapping({
        mappingSessionId: session.mappingSessionId,
        name: session.name,
        requestId: retryRequestId,
      });
      await trackAcceptedJob(resp, 'finish_mapping', retryRequestId, client, useMappingWorkflowStore);
    } catch (err) {
      setLocalActionError(err.message || 'Lỗi khi thử lại lưu bản đồ');
    } finally {
      isSubmittingRef.current = false;
    }
  }

  const isMappingActive = Boolean(session && session.status === 'mapping');
  const isStarting = Boolean(session && session.status === 'starting');
  const isFinishing = Boolean(session && session.status === 'finishing');
  const isSaveFailed = Boolean(session && session.status === 'save_failed');
  const isSavedView = Boolean(!session && viewerContext?.kind === 'saved');

  return (
    <PageFrame
      title="Xây dựng Bản đồ SLAM (Mapping)"
      subtitle="Khởi tạo phiên quét SLAM 2D Occupancy Grid thời gian thực và lưu vào danh mục"
    >
      <Stack spacing={3}>
        {/* Banner cảnh báo giới hạn Chặng 6 */}
        <Alert severity="info" variant="outlined">
          <strong>Lưu ý:</strong> Mock lưu trong bộ nhớ; tải lại toàn bộ trang sẽ mất phiên. Chuyển đổi giữa các trang trong ứng dụng vẫn bảo toàn phiên làm việc.
        </Alert>

        {localActionError && <Alert severity="error">{localActionError}</Alert>}
        {lastError && <Alert severity="error">Lỗi quy trình: {lastError.message || String(lastError)}</Alert>}
        {gridError && <Alert severity="warning">Lỗi dữ liệu lưới: {gridError.message}</Alert>}
        {rasterError && <Alert severity="error">Lỗi render ảnh: {rasterError.message}</Alert>}

        {/* Thanh trạng thái phiên */}
        <Card variant="outlined">
          <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  Trạng thái:
                </Typography>
                {isStarting && <Chip label="Đang khởi động..." color="warning" size="small" />}
                {isMappingActive && <Chip label="Đang quét SLAM (Live)" color="success" size="small" />}
                {isFinishing && <Chip label="Đang lưu bản đồ..." color="info" size="small" />}
                {isSaveFailed && <Chip label="Lưu thất bại" color="error" size="small" />}
                {isSavedView && <Chip label="Bản đồ đã lưu" color="primary" size="small" />}
                {!session && !isSavedView && <Chip label="Chưa có phiên" color="default" size="small" />}

                <Chip label="Mô phỏng" variant="outlined" size="small" />
                {trackedOperation && (
                  <Chip
                    data-testid="mapping-job-status"
                    label={`Job ${trackedOperation.type}: ${trackedOperation.status}`}
                    variant="outlined"
                    size="small"
                    color={trackedOperation.status === 'failed' ? 'error' : 'info'}
                  />
                )}
                {gridStatus?.sourceState && (
                  <Chip
                    label={`Nguồn: ${gridStatus.sourceState}${gridStatus.lastSourceUpdateAgeMs != null ? ` (${Math.round(gridStatus.lastSourceUpdateAgeMs / 1000)}s)` : ''}`}
                    size="small"
                    variant="outlined"
                    color={gridStatus.sourceState === 'stale' ? 'warning' : gridStatus.sourceState === 'offline' ? 'error' : 'default'}
                  />
                )}
              </Stack>

              {session && (
                <Typography variant="body2" color="text.secondary">
                  Phiên: <strong>{session.name}</strong> ({session.mappingSessionId})
                </Typography>
              )}
            </Stack>
          </CardContent>
        </Card>

        {/* Cửa sổ Bản đồ 2D */}
        <Card variant="outlined" sx={{ overflow: 'hidden' }}>
          <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
            {renderModel ? (
              <Map2D
                model={renderModel}
                pose={visiblePose}
                poseQuality={poseQuality}
                showGrid={layers.grid}
                showRobot={layers.robot}
                showPath={layers.path}
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
                {isStarting || isFinishing ? (
                  <CircularProgress size={36} />
                ) : null}
                <Typography variant="body2" color="text.secondary">
                  {isStarting
                    ? 'Đang khởi động cảm biến SLAM và chuẩn bị bản đồ...'
                    : isFinishing
                      ? 'Đang tổng hợp dữ liệu và ghi nhận bản đồ vào kho lưu trữ...'
                      : session
                        ? 'Đang chờ khung dữ liệu Occupancy Grid đầu tiên...'
                        : isSavedView
                          ? `Đang nạp bản đồ đã lưu (${viewerContext.mapId} rev ${viewerContext.mapRevision})...`
                          : 'Chưa có phiên hoạt động. Hãy bắt đầu phiên tạo bản đồ mới.'}
                </Typography>
              </Box>
            )}
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={{ xs: 1, md: 3 }}
              sx={{ alignItems: { md: 'center' }, justifyContent: 'space-between' }}
            >
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{ fontWeight: 600 }}>Chú giải:</Typography>
                {[
                  ['Unknown', '#b0bec5'],
                  ['Free', '#ffffff'],
                  ['Occupied', '#000000'],
                ].map(([label, color]) => (
                  <Stack key={label} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                    <Box sx={{ width: 16, height: 16, bgcolor: color, border: '1px solid #78909c' }} />
                    <Typography variant="caption">{label}</Typography>
                  </Stack>
                ))}
              </Stack>
              <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                <FormControlLabel
                  control={<Checkbox checked={layers.grid} onChange={() => toggleLayer('grid')} size="small" />}
                  label="Lưới"
                />
                <FormControlLabel
                  control={<Checkbox checked={layers.robot} onChange={() => toggleLayer('robot')} size="small" />}
                  label="Robot"
                />
                <FormControlLabel
                  control={<Checkbox checked={layers.path} onChange={() => toggleLayer('path')} size="small" />}
                  label="Đường đi"
                />
              </Stack>
            </Stack>
          </CardContent>
        </Card>

        {/* Thanh công cụ điều khiển phiên */}
        <Card variant="outlined">
          <CardContent sx={{ p: 2.5, '&:last-child': { pb: 2.5 } }}>
            {!session && (
              <Box component="form" onSubmit={handleStartMapping}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'center' }}>
                  <TextField
                    size="small"
                    label="Tên bản đồ mới"
                    placeholder="VD: Kho tầng 1, Khu vực A"
                    value={mapNameInput}
                    onChange={(e) => setMapNameInput(e.target.value)}
                    slotProps={{ htmlInput: { 'data-testid': 'mapping-name-input' } }}
                    sx={{ minWidth: 320 }}
                    disabled={isProcessing || !isCoordinatorReady}
                  />
                  <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    disabled={isProcessing || !isCoordinatorReady || !mapNameInput.trim()}
                    data-testid="mapping-start-button"
                  >
                    {isProcessing ? 'Đang xử lý...' : 'Bắt đầu tạo bản đồ'}
                  </Button>
                </Stack>
              </Box>
            )}

            {isMappingActive && (
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Button
                  variant="contained"
                  color="success"
                  disabled={isProcessing}
                  onClick={handleFinishMapping}
                  data-testid="mapping-finish-button"
                >
                  {isProcessing ? 'Đang xử lý...' : 'Hoàn tất & Lưu bản đồ'}
                </Button>
                <Typography variant="body2" color="text.secondary">
                  Di chuyển robot để mở rộng vùng quét. Nhấn lưu khi đã quét đủ diện tích.
                </Typography>
              </Stack>
            )}

            {isSaveFailed && (
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Button
                  variant="contained"
                  color="warning"
                  disabled={isProcessing}
                  onClick={handleRetryFinishMapping}
                  data-testid="mapping-retry-button"
                >
                  {isProcessing ? 'Đang xử lý...' : 'Thử lại lưu bản đồ'}
                </Button>
                <Typography variant="body2" color="error">
                  Lưu thất bại ở lần thử trước. Dữ liệu quét vẫn được bảo toàn nguyên vẹn.
                </Typography>
              </Stack>
            )}

            {isFinishing && (
              <Typography variant="body2" color="text.secondary">
                Đang tiến hành lưu bản đồ, vui lòng không tắt trình duyệt...
              </Typography>
            )}

            {isSavedView && (
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Alert severity="success" sx={{ py: 0.5, flex: 1 }}>
                  Bản đồ <strong>{viewerContext.mapId}</strong> (rev {viewerContext.mapRevision}) đã được lưu thành công!
                </Alert>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() => {
                    useMappingWorkflowStore.getState().setViewerContext(null);
                    setMapNameInput('');
                  }}
                >
                  Tạo bản đồ khác
                </Button>
              </Stack>
            )}
          </CardContent>
        </Card>
      </Stack>
    </PageFrame>
  );
}
