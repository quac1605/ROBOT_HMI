import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';
import Map2D from '../components/map/Map2D.jsx';
import NavigationCameraPanel from '../components/navigation/NavigationCameraPanel.jsx';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { useControlActions } from '../hooks/useControlActions.js';
import { useControlStore } from '../state/controlStore.js';
import { useMapGrid } from '../hooks/useMapGrid.js';
import { useRosMap } from '../hooks/useRosMap.js';
import { useOccupancyRaster } from '../hooks/useOccupancyRaster.js';
import { useRobotFreshness } from '../hooks/useRobotFreshness.js';
import { useRobotStore } from '../stores/robotStore.js';
import { useMappingWorkflowStore, trackAcceptedJob } from '../state/mappingWorkflowStore.js';
import { waitForMappingStop } from '../utils/waitForMappingStop.js';
import { resolveVisiblePose } from '../utils/mapCoordinates.js';
import { sameMapContext } from '../utils/mapRenderModel.js';
import { resolvePoseQuality } from '../utils/poseQuality.js';
import { resolveRosMapPose } from '../utils/rosMapPose.js';

async function trackAcceptedFinish(client, attempt, response) {
  const workflow = useMappingWorkflowStore.getState();
  // A delayed response and a user replay can both return the same AcceptedJob.
  // Exactly one of them may install tracking for this request ID.
  if (!workflow.claimAcceptedFinish(attempt.requestId)) return;

  try {
    await trackAcceptedJob(response, 'finish_mapping', attempt.requestId, client,
      useMappingWorkflowStore, {
        isCurrent: () =>
          useMappingWorkflowStore.getState().finishAttempt?.requestId === attempt.requestId,
        mappingSessionId: attempt.mappingSessionId,
      });
    useMappingWorkflowStore.getState().clearFinishAttempt(attempt.requestId);
  } catch (error) {
    useMappingWorkflowStore.getState().transitionFinishAttempt(
      attempt.requestId, 'tracking', 'unknown'
    );
    throw error;
  }
}

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
  const finishAttempt = useMappingWorkflowStore((state) => state.finishAttempt);
  const finishUnknown = finishAttempt?.phase === 'unknown';

  const [mapNameInput, setMapNameInput] = useState('');
  const [localActionError, setLocalActionError] = useState(null);
  const [layers] = useState({ grid: true, robot: true, path: true });
  const isSubmittingRef = useRef(false);

  const [startPending, setStartPending] = useState(false);
  const [finishPending, setFinishPending] = useState(false);
  const finishAbortRef = useRef(null);
  useEffect(() => () => {
    finishAbortRef.current?.abort();
    const attempt = useMappingWorkflowStore.getState().finishAttempt;
    if (attempt?.phase === 'pending') {
      useMappingWorkflowStore.getState().transitionFinishAttempt(
        attempt.requestId, 'pending', 'unknown'
      );
    }
  }, []);

  // Hook lấy dữ liệu OccupancyGrid theo viewerContext (live mapping hoặc vừa lưu)
  const { normalizedGrid, status: gridStatus, error: gridError } = useMapGrid(viewerContext, {
    expectedFrameId: 'map',
  });
  const { raster, rasterError } = useOccupancyRaster(normalizedGrid);
  const { model: rosMapModel, metadata: rosMapMetadata, error: rosMapError } = useRosMap();

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

  // Bản đồ /map thật được ưu tiên cho màn hình live; pose /odom chỉ được vẽ
  // sau khi đã ở cùng frame (trực tiếp hoặc qua TF do backend cung cấp).
  const showingRosMap = Boolean(rosMapModel && viewerContext?.kind !== 'saved');
  const displayedModel = showingRosMap ? rosMapModel : renderModel;
  const rosPose = resolveRosMapPose(snapshot, rosMapModel?.geometry, { transportStale });
  const displayedPose = showingRosMap
    ? rosPose.pose
    : visiblePose;

  const poseQuality = showingRosMap && displayedPose
    ? snapshot?.localization?.status === 'lost' ? 'lost' : 'odom'
    : resolvePoseQuality(snapshot, { transportStale });

  async function handleStartMapping(e) {
    e.preventDefault();
    const trimmedName = mapNameInput.trim();
    if (!trimmedName || isSubmittingRef.current || isProcessing ||
        !isCoordinatorReady || session || finishAttempt) return;

    isSubmittingRef.current = true;
    setStartPending(true);
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
      setStartPending(false);
    }
  }

  async function submitFinishMapping(retry) {
    const current = useMappingWorkflowStore.getState().session;
    if (isSubmittingRef.current || useMappingWorkflowStore.getState().finishAttempt ||
        isProcessing || !isCoordinatorReady || !current) return;
    if (retry ? current.status !== 'save_failed' : current.status !== 'mapping') return;

    isSubmittingRef.current = true;
    setFinishPending(true);
    setLocalActionError(null);
    const abort = new AbortController();
    finishAbortRef.current = abort;
    let attempt = null;
    try {
      // Stop action ghi stopUnconfirmed đồng bộ: hook dừng publisher ngay.
      // Backend revoke lease và zero. Nếu đang có stop inFlight thì dùng cùng promise.
      // Dừng để lưu bản đồ, không phải người dùng chọn mode stop.
      const acceptedStop = await controlActions.requestStop({ keepMode: true });
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
      attempt = {
        mappingSessionId: latest.mappingSessionId,
        name: latest.name,
        requestId: crypto.randomUUID(),
      };
      // Ghi trước network call: timeout không được làm mất ID nghiệp vụ này.
      if (!useMappingWorkflowStore.getState().beginFinishAttempt(attempt)) return;
      const response = await client.finishMapping(attempt);
      // Page may have unmounted while HTTP was pending. The coordinator and
      // request identity live outside this route, so keep following the job.
      await trackAcceptedFinish(client, attempt, response);
    } catch (error) {
      if (attempt) {
        useMappingWorkflowStore.getState().transitionFinishAttempt(
          attempt.requestId, 'pending', 'unknown'
        );
      }
      if (!abort.signal.aborted) {
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
    const attempt = useMappingWorkflowStore.getState().finishAttempt;
    if (attempt?.phase !== 'unknown' || isSubmittingRef.current || !isCoordinatorReady) return;
    if (!useMappingWorkflowStore.getState().transitionFinishAttempt(
      attempt.requestId, 'unknown', 'pending'
    )) return;
    isSubmittingRef.current = true;
    setFinishPending(true);
    const abort = new AbortController();
    finishAbortRef.current = abort;
    try {
      // Người dùng bấm retry cùng payload. Không tự retry; không tạo requestId mới.
      // Replay vẫn hợp lệ khi backend đã kết thúc session, nên không đòi session
      // còn mapping trước call này. Ledger sẽ trả đúng job cũ.
      const response = await client.finishMapping({
        mappingSessionId: attempt.mappingSessionId,
        name: attempt.name,
        requestId: attempt.requestId,
      });
      await trackAcceptedFinish(client, attempt, response);
      if (!abort.signal.aborted) {
        setLocalActionError(null);
      }
    } catch (error) {
      useMappingWorkflowStore.getState().transitionFinishAttempt(
        attempt.requestId, 'pending', 'unknown'
      );
      if (!abort.signal.aborted) {
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
  // Hiển thị Dừng ngay khi gửi start, nhưng chỉ cho finish khi phiên đã active.
  // Không chuyển về Bắt đầu cho tới khi lưu được xác nhận bởi coordinator.
  const showStop = startPending || Boolean(session);
  const actionBusy = startPending || isStarting || isFinishing || finishPending || isProcessing ||
    finishAttempt?.phase === 'pending' || finishAttempt?.phase === 'tracking';

  return (
    <PageFrame
      title="Xây dựng Bản đồ SLAM (Mapping)"
      subtitle="Khởi tạo phiên quét SLAM 2D Occupancy Grid thời gian thực và lưu vào danh mục"
    >
      <Stack spacing={3}>
        {localActionError && <Alert severity="error">{localActionError}</Alert>}
        {lastError && <Alert severity="error">Lỗi quy trình: {lastError.message || String(lastError)}</Alert>}
        {gridError && <Alert severity="warning">Lỗi dữ liệu lưới: {gridError.message}</Alert>}
        {rasterError && <Alert severity="error">Lỗi render ảnh: {rasterError.message}</Alert>}
        {rosMapError && viewerContext?.kind !== 'saved' &&
          <Alert severity="warning">Không đọc được bản đồ ROS /map: {rosMapError.message}</Alert>}

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
                {showingRosMap && (
                  <Chip label={`Nguồn: ROS /map${rosMapError ? ' (kết nối gián đoạn)' : ''} · ${rosMapMetadata.geometry.width}×${rosMapMetadata.geometry.height} · ${rosMapMetadata.geometry.resolution.toFixed(3)} m/ô`}
                    size="small" variant="outlined" color={rosMapError ? 'warning' : 'success'} />
                )}
                {!showingRosMap && gridStatus?.sourceState && (
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

        {/* Bản đồ bên trái; camera và quy trình start/finish bên phải. */}
        <Box sx={{
          display: 'grid',
          // Camera luôn ở cùng vị trí; phiên/job chỉ thay đổi form bên dưới.
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
              {displayedModel ? (
                <Map2D
                  model={displayedModel}
                  pose={displayedPose}
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
                        : rosMapMetadata?.status === 'waiting' && !viewerContext
                          ? 'Đang chờ dữ liệu ROS /map…'
                        : rosMapMetadata?.status === 'offline' && !viewerContext
                          ? 'Nguồn ROS /map chưa sẵn sàng. Kiểm tra node map và backend.'
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
          <Stack spacing={2} sx={{ minWidth: 0 }}>
            {/* Không key theo mappingSessionId: start/finish không được mở lại WHEP. */}
            <NavigationCameraPanel compact showGestureStatus={false}
              caption="Chọn camera quan sát. Hướng lái theo robot." />
            <Card variant="outlined" sx={{ borderRadius: 2 }}>
              <CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
                <Box component="form" onSubmit={event => {
                  if (showStop) { event.preventDefault(); return; }
                  void handleStartMapping(event);
                }}>
                  <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                    <TextField size="small" placeholder="Tên bản đồ"
                      value={session?.name ?? mapNameInput}
                      onChange={event => setMapNameInput(event.target.value)}
                      disabled={showStop || actionBusy || !isCoordinatorReady || finishUnknown}
                      slotProps={{ htmlInput: { 'data-testid': 'mapping-name-input', 'aria-label': 'Tên bản đồ' } }}
                      sx={{ flex: 1, minWidth: 0, '& .MuiOutlinedInput-root': {
                        borderRadius: 1, '& fieldset': { border: '2px solid #000' },
                      } }} />
                    <Button type={showStop ? 'button' : 'submit'} variant="contained"
                      data-testid={showStop ? 'mapping-finish-button' : 'mapping-start-button'}
                      aria-busy={actionBusy}
                      onClick={showStop ? handleFinishMapping : undefined}
                      disabled={actionBusy || !isCoordinatorReady || finishUnknown ||
                        (showStop ? !isMappingActive : !mapNameInput.trim())}
                      sx={{ minWidth: 112, py: 1, border: '2px solid #000', borderRadius: 3,
                        textTransform: 'none', fontSize: '1.15rem',
                        bgcolor: showStop ? '#d32f2f' : '#81c784', color: showStop ? '#fff' : '#000',
                        '&:hover': { bgcolor: showStop ? '#b71c1c' : '#66bb6a' },
                        '&.Mui-disabled': { bgcolor: showStop ? '#d32f2f' : '#81c784',
                          color: showStop ? '#fff' : '#263238', opacity: 0.65 },
                      }}>
                      {showStop ? 'Dừng' : 'Bắt đầu'}
                    </Button>
                  </Stack>
                </Box>
                <Typography variant="body2" color="text.secondary" role="status" sx={{ mt: 1.5 }}>
                  {startPending || isStarting ? 'Đang khởi động phiên mapping…' :
                    finishPending ? 'Đang dừng robot và chờ xác nhận đứng yên…' :
                    isFinishing ? 'Đang lưu bản đồ…' :
                    'Dừng sẽ yêu cầu robot đứng yên, chờ xác nhận rồi lưu bản đồ.'}
                </Typography>
                {finishUnknown && (
                  <Alert severity="warning" sx={{ mt: 1.5 }} action={
                    <Button disabled={finishPending || !isCoordinatorReady} onClick={retryUncertainFinish}>
                      Lấy lại kết quả cùng yêu cầu
                    </Button>
                  }>
                    Chưa xác định kết quả lưu. Lấy lại kết quả trước khi tạo yêu cầu mới.
                  </Alert>
                )}
                {isSaveFailed && (
                  <Stack spacing={1} sx={{ mt: 1.5 }}>
                    <Alert severity="error">Lưu thất bại. Dữ liệu quét vẫn được giữ để thử lại.</Alert>
                    <Button variant="outlined" color="warning" data-testid="mapping-retry-button"
                      disabled={actionBusy || finishUnknown || !isCoordinatorReady}
                      onClick={handleRetryFinishMapping}>Thử lại lưu bản đồ</Button>
                  </Stack>
                )}
              </CardContent>
            </Card>
          </Stack>
        </Box>


      </Stack>
    </PageFrame>
  );
}
