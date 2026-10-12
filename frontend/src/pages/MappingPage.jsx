import { useEffect, useMemo, useRef, useState } from 'react';
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
import MappingControlPanel from '../components/control/MappingControlPanel.jsx';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { useControlActions } from '../hooks/useControlActions.js';
import { useControlStore } from '../state/controlStore.js';
import { useMapGrid } from '../hooks/useMapGrid.js';
import { useOccupancyRaster } from '../hooks/useOccupancyRaster.js';
import { useRobotFreshness } from '../hooks/useRobotFreshness.js';
import { useRobotStore } from '../stores/robotStore.js';
import { useMappingWorkflowStore, trackAcceptedJob } from '../state/mappingWorkflowStore.js';
import { waitForMappingStop } from '../utils/waitForMappingStop.js';
import { resolveVisiblePose } from '../utils/mapCoordinates.js';
import { sameMapContext } from '../utils/mapRenderModel.js';
import { resolvePoseQuality } from '../utils/poseQuality.js';

export default function MappingPage() {
  const client = useRobotClient();
  const snapshot = useRobotStore((state) => state.snapshot);
  const controlProfile = useControlStore((state) => state.controlProfile);
  const controlActions = useControlActions();
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

  const [finishPending, setFinishPending] = useState(false);
  const finishAbortRef = useRef(null);
  const finishAttemptRef = useRef(null); // Giữ payload/requestId khi HTTP chưa rõ kết quả.
  const [finishUnknown, setFinishUnknown] = useState(false);
  useEffect(() => () => {
    finishAbortRef.current?.abort();
  }, []);

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

  const toggleLayer = (layerName) => {
    setLayers((prev) => ({ ...prev, [layerName]: !prev[layerName] }));
  };

  async function handleStartMapping(e) {
    e.preventDefault();
    const trimmedName = mapNameInput.trim();
    if (!trimmedName || isSubmittingRef.current || isProcessing) return;

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

  async function submitFinishMapping(retry) {
    const current = useMappingWorkflowStore.getState().session;
    if (isSubmittingRef.current || finishAttemptRef.current || isProcessing || !isCoordinatorReady || !current) return;
    if (retry ? current.status !== 'save_failed' : current.status !== 'mapping') return;

    isSubmittingRef.current = true;
    setFinishPending(true);
    setLocalActionError(null);
    const abort = new AbortController();
    finishAbortRef.current = abort;
    try {
      // Stop action ghi stopUnconfirmed đồng bộ: hook dừng publisher ngay.
      // Backend revoke lease và zero. Nếu đang có stop inFlight thì dùng cùng promise.
      const acceptedStop = await controlActions.requestStop();
      await waitForMappingStop({
        requestId: acceptedStop.requestId,
        mappingSessionId: current.mappingSessionId,
        controlStore: useControlStore,
        mappingStore: useMappingWorkflowStore,
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      const latest = useMappingWorkflowStore.getState().session;
      if (latest?.mappingSessionId !== current.mappingSessionId ||
          !['mapping', 'save_failed'].includes(latest.status)) {
        throw new Error('Phiên mapping đã đổi trước khi lưu.');
      }
      // Backend kiểm tra lại no lease + fresh stationary + gate trước khi accept.
      // UI chỉ track một AcceptedJob thật từ server, không tự tạo accepted giả.
      const attempt = {
        mappingSessionId: latest.mappingSessionId,
        name: latest.name,
        requestId: crypto.randomUUID(),
      };
      // Ghi trước network call: timeout không được làm mất ID nghiệp vụ này.
      finishAttemptRef.current = attempt;
      const response = await client.finishMapping(attempt);
      if (!abort.signal.aborted) {
        await trackAcceptedJob(response, 'finish_mapping', attempt.requestId, client, useMappingWorkflowStore);
        finishAttemptRef.current = null;
        setFinishUnknown(false);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        setFinishUnknown(Boolean(finishAttemptRef.current));
        setLocalActionError(error.message || 'Chưa thể dừng và lưu bản đồ.');
      }
    } finally {
      if (finishAbortRef.current === abort) {
        finishAbortRef.current = null;
        isSubmittingRef.current = false;
        if (!abort.signal.aborted) setFinishPending(false);
      }
    }
  }

  async function retryUncertainFinish() {
    const attempt = finishAttemptRef.current;
    if (!attempt || isSubmittingRef.current || !isCoordinatorReady) return;
    isSubmittingRef.current = true;
    setFinishPending(true);
    const abort = new AbortController();
    finishAbortRef.current = abort;
    try {
      // Người dùng bấm retry cùng payload. Không tự retry; không tạo requestId mới.
      // Replay vẫn hợp lệ khi backend đã kết thúc session, nên không đòi session
      // còn mapping trước call này. Ledger sẽ trả đúng job cũ.
      const response = await client.finishMapping(attempt);
      if (!abort.signal.aborted) {
        await trackAcceptedJob(response, 'finish_mapping', attempt.requestId, client, useMappingWorkflowStore);
        finishAttemptRef.current = null;
        setFinishUnknown(false);
        setLocalActionError(null);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        setFinishUnknown(true);
        setLocalActionError(error.message || 'Chưa lấy lại được kết quả lưu.');
      }
    } finally {
      if (finishAbortRef.current === abort) {
        finishAbortRef.current = null;
        isSubmittingRef.current = false;
        if (!abort.signal.aborted) setFinishPending(false);
      }
    }
  }

  function handleFinishMapping() {
    return submitFinishMapping(false);
  }

  function handleRetryFinishMapping() {
    // Chỉ dùng cho SAVE_FAILED đã có kết quả xác định, tạo requestId mới.
    return submitFinishMapping(true);
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
        {/* Banner hướng dẫn mapping */}
        <Alert severity="info" variant="outlined">
          Bắt đầu phiên mapping, chọn camera quan sát rồi nhận quyền lái. Giữ joystick để
          di chuyển robot; SLAM xây dựng bản đồ từ dữ liệu cảm biến. Hoàn tất sẽ dừng robot,
          chờ xác nhận đứng yên và gửi yêu cầu lưu.
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

                <Chip
                  label={controlProfile === 'mock' ? 'Mô phỏng' :
                    controlProfile === 'hardware' ? 'ROS / phần cứng' : 'Chưa xác định nguồn'}
                  variant="outlined"
                  size="small"
                />
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

        {/* Cửa sổ Bản đồ 2D & Điều khiển Mapping */}
        <Box sx={{
          display: 'grid',
          // Cột phải chứa camera + joystick; nới rộng để khung camera (16:9) to hơn
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 340px', lg: 'minmax(0, 1fr) 420px', xl: 'minmax(0, 1fr) 480px' },
          alignItems: 'start', gap: 2,
        }}>
          <Card variant="outlined" sx={{
            overflow: 'hidden', minWidth: 0,
            display: 'flex', flexDirection: 'column',
            minHeight: { xs: 450, md: 'calc(100vh - 270px)' },
          }}>
            <CardContent sx={{
              p: 1, '&:last-child': { pb: 1 },
              flex: 1, display: 'flex', flexDirection: 'column',
            }}>
              {renderModel ? (
                <Map2D
                  model={renderModel}
                  pose={visiblePose}
                  poseQuality={poseQuality}
                  showGrid={layers.grid}
                  showRobot={layers.robot}
                  showPath={layers.path}
                  tool="pan"
                  viewportMaxHeight="calc(100vh - 300px)"
                />
              ) : (
                <Box sx={{
                  flex: 1,
                  minHeight: { xs: 380, md: 'calc(100vh - 300px)' },
                  display: 'grid', placeItems: 'center', p: 2, gap: 2,
                  bgcolor: '#eceff1', borderRadius: 1,
                }}>
                  {(isStarting || isFinishing) && <CircularProgress size={36} />}
                  <Typography variant="body2" color="text.secondary">
                    {isStarting
                      ? 'Đang khởi động SLAM…'
                      : isFinishing
                        ? 'Đang lưu bản đồ…'
                        : session
                          ? 'Đang chờ OccupancyGrid của phiên mapping…'
                          : isSavedView
                            ? 'Đang nạp bản đồ đã lưu…'
                            : 'Bắt đầu phiên mapping để xây dựng bản đồ.'}
                  </Typography>
                </Box>
              )}
            </CardContent>
          </Card>
          <Box sx={{ width: { xs: '100%', md: 340, lg: 420, xl: 480 }, flexShrink: 0 }}>
            <MappingControlPanel
              key={session?.mappingSessionId ?? 'no-mapping-session'}
              mappingSessionId={session?.mappingSessionId ?? null}
              enabled={isMappingActive && !finishPending && !finishUnknown && !isProcessing}
            />
          </Box>
        </Box>

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

            {finishUnknown && (
              <Alert severity="warning" sx={{ mb: 2 }} action={
                <Button disabled={finishPending || !isCoordinatorReady} onClick={retryUncertainFinish}>
                  Lấy lại kết quả cùng yêu cầu
                </Button>
              }>
                Chưa xác định kết quả lưu. Giữ joystick khóa và lấy lại kết quả trước khi tạo yêu cầu mới.
              </Alert>
            )}

            {isMappingActive && (
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Button
                  variant="contained"
                  color="success"
                  disabled={isProcessing || finishPending || finishUnknown}
                  onClick={handleFinishMapping}
                  data-testid="mapping-finish-button"
                >
                  {finishPending ? 'Đang dừng và chờ xác nhận…' : isProcessing ? 'Đang xử lý…' : 'Hoàn tất & Lưu bản đồ'}
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
                  disabled={isProcessing || finishPending || finishUnknown}
                  onClick={handleRetryFinishMapping}
                  data-testid="mapping-retry-button"
                >
                  {finishPending ? 'Đang kiểm tra điều kiện dừng…' : isProcessing ? 'Đang xử lý…' : 'Thử lại lưu bản đồ'}
                </Button>
                <Typography variant="body2" color="error">
                  Lưu thất bại ở lần thử trước. Dữ liệu quét vẫn được bảo toàn nguyên vẹn.
                </Typography>
              </Stack>
            )}
          </CardContent>
        </Card>
      </Stack>
    </PageFrame>
  );
}
