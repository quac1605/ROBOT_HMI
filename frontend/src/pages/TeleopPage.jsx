// pages/TeleopPage.jsx
import { useControlActions } from '../hooks/useControlActions.js';
import { createPageLeaseIntent } from '../utils/pageLeaseIntent.js';
import { bindTeleopKeyboard } from '../utils/teleopKeyboard.js';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Button, ButtonGroup, Chip, Paper,
  Stack, Typography, Divider,
} from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';
import CameraPanel from '../components/CameraPanel.jsx';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { useRobotStore } from '../stores/robotStore.js';
import { useControlStore } from '../state/controlStore.js';
import { useTeleopHold } from '../hooks/useTeleopHold.js';
import { selectCanDrive, CONTROL_POLICY } from '../utils/controlPolicy.js';

// Dịch lý do từ chối sang tiếng Việt
const REASON_VI = {
  AUTH_REQUIRED: 'Chưa đăng nhập',
  CONTROL_PROFILE_UNKNOWN: 'Hệ thống chưa xác định profile',
  HARDWARE_NOT_READY: 'Phần cứng chưa sẵn sàng',
  CONTROL_NOT_READY: 'Hệ thống điều khiển chưa khởi động',
  STOP_UNCONFIRMED: 'Lệnh dừng chưa được xác nhận',
  CONTROL_PHASE_BLOCKED: 'Đang xử lý lệnh điều khiển',
  LEASE_REQUIRED: 'Chưa có quyền lái (cần nhận quyền)',
  LEASE_EXPIRED: 'Quyền lái đã hết hạn',
  HEARTBEAT_STALE: 'Mất liên lạc heartbeat điều khiển',
  TOKEN_EXPIRED: 'Token điều khiển hết hạn',
  CAMERA_NOT_FRESH: 'Camera không live (frame quá cũ hoặc lỗi)',
  ESTOP_ACTIVE_OR_UNKNOWN: 'E-Stop vật lý đang kích hoạt hoặc chưa biết',
  MOTION_INHIBITED_OR_UNKNOWN: 'Chuyển động bị khóa hệ thống',
  MODE_NOT_ALLOWED: 'Robot không ở chế độ teleop',
  MISSION_ACTIVE_OR_UNKNOWN: 'Đang thực hiện nhiệm vụ điều hướng',
  MAPPING_ACTIVE_OR_UNKNOWN: 'Đang thực hiện mapping',
  TRANSPORT_UNHEALTHY: 'Mất kết nối transport/ROS',
  ROS_UNAVAILABLE: 'ROS không khả dụng',
  ROBOT_NOT_STATIONARY: 'Robot chưa đứng yên',
  ROBOT_UNKNOWN: 'Chưa nhận được trạng thái robot',
};

// Tốc độ mặc định: 50% limits (limits là 0.2 m/s và 0.5 rad/s)
const DEFAULT_LINEAR_SPEED = 0.1;   // m/s
const DEFAULT_ANGULAR_SPEED = 0.25; // rad/s

// Stable component identity keeps pointer capture intact across video/heartbeat renders.
function DPadButton({ label, ariaLabel, direction, vector, drive, disabled }) {
  return (
    <Button
      variant="contained" color="primary" aria-label={ariaLabel}
      data-testid={`dpad-${direction}`}
      data-teleop-direction={direction}
      disabled={disabled}
      sx={{ touchAction: 'none', userSelect: 'none', minWidth: 52, height: 44, p: 0 }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const owner = `pointer:${event.pointerId}`;
        if (!drive.start(owner, vector)) return;
        try { event.currentTarget.setPointerCapture(event.pointerId); }
        catch { drive.stop('CAPTURE_FAILED', owner); }
      }}
      onPointerUp={event => drive.stop('POINTER_UP', `pointer:${event.pointerId}`)}
      onPointerCancel={event => drive.stop('POINTER_CANCEL', `pointer:${event.pointerId}`)}
      onLostPointerCapture={event => drive.stop('CAPTURE_LOST', `pointer:${event.pointerId}`)}
    >{label}</Button>
  );
}

function driveState(control, robot, now) {
  return selectCanDrive({
    authenticated: true, control,
    robot: { snapshot: robot.snapshot, lastReceivedAt: robot.lastReceivedAt, error: robot.error },
    camera: {
      selectedCameraId: control.selectedCameraId, selectedGeneration: control.selectedGeneration,
      cameraId: control.cameraId, generation: control.generation,
      lastFrameAt: control.lastFrameAt, error: control.cameraError
    }, now
  });
}

export default function TeleopPage() {
  const client = useRobotClient();
  const robotStore = useRobotStore();
  const controlStore = useControlStore();
  const [acquiring, setAcquiring] = useState(false);
  const [displayNow, setDisplayNow] = useState(0);
  const [pageLeaseId, setPageLeaseId] = useState(null);
  const controlActions = useControlActions();

  const pageIntentRef = useRef(null);

  useEffect(() => {
    const update = () => setDisplayNow(performance.now());
    update();
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, []);

  const reportControlError = useCallback((error) => {
    if (!['UNAUTHENTICATED', 'OPERATION_SUPERSEDED', 'LEASE_NOT_OWNED'].includes(error.code)) {
      useControlStore.getState().setControlState({ controlError: error.message });
    }
  }, []);

  // Lease intention belongs to the page; stop action belongs to authenticated app.
  useEffect(() => {
    const pageIntent = createPageLeaseIntent({
      client,
      onPending: setAcquiring,
      onError: reportControlError,
      onLeaseChange: setPageLeaseId,
      isLeaseCurrent: lease => {
        const state = useControlStore.getState();
        return !state.stopUnconfirmed && state.lease?.leaseId === lease.leaseId &&
          state.controlGeneration === lease.controlGeneration;
      },
    });
    pageIntentRef.current = pageIntent;

    return () => {
      pageIntent.dispose();
      pageIntentRef.current = null;
    };
  }, [client, reportControlError]);

  // Đồng bộ trạng thái lease giữa controlStore và pageLeaseIntent
  // Khi lease bị thu hồi / kết thúc / mất quyền sở hữu, xóa owned trong pageIntent để người dùng có thể acquire lại
  useEffect(() => {
    if (!controlStore.lease) {
      pageIntentRef.current?.forgetRevokedLease();
    }
  }, [controlStore.lease]);

  // getLatest: Đọc store thời gian thực và xác thực quyền sở hữu lease
  const getLatest = useCallback(() => {
    const now = performance.now();
    const ctrl = useControlStore.getState();
    const rob = useRobotStore.getState();

    const canDrive = selectCanDrive({
      authenticated: true,
      control: ctrl,
      robot: {
        snapshot: rob.snapshot,
        lastReceivedAt: rob.lastReceivedAt,
        error: rob.error,
      },
      camera: {
        selectedCameraId: ctrl.selectedCameraId,
        selectedGeneration: ctrl.selectedGeneration,
        cameraId: ctrl.cameraId,
        generation: ctrl.generation,
        lastFrameAt: ctrl.lastFrameAt,
        error: ctrl.cameraError,
      },
      now,
    });

    const isLeaseOwned = pageIntentRef.current?.canUseLease(ctrl.lease?.leaseId);

    return {
      ...canDrive,
      allowed: canDrive.allowed && Boolean(isLeaseOwned),
      lease: ctrl.lease,
      freshnessToken: ctrl.freshnessToken,
    };
  }, []);

  const sendVelocity = useCallback((raw) => {
    client.sendVelocity(raw);
  }, [client]);

  const requestStop = useCallback(() => {
    return controlActions.requestStop();
  }, [controlActions]);

  const onError = useCallback((error) => {
    reportControlError(error);
  }, [reportControlError]);

  const drive = useTeleopHold({ getLatest, sendVelocity, requestStop, onError });
  const { start: driveStart, stop: driveStop } = drive;

  // Dọn dẹp hold khi unmount trang để đảm bảo dừng lái an toàn
  useEffect(() => {
    return () => {
      driveStop('UNMOUNT');
    };
  }, [driveStop]);

  // Xử lý dừng thủ công (E-Stop phần mềm)
  const handleManualStop = useCallback(() => {
    pageIntentRef.current?.invalidatePending();
    if (!driveStop('MANUAL')) {
      void controlActions.requestStop().catch(reportControlError);
    }
  }, [driveStop, reportControlError, controlActions]);

  // Xử lý nhận quyền lái
  const handleAcquire = useCallback(async () => {
    if (!pageIntentRef.current) return;
    await pageIntentRef.current.acquire();
  }, []);

  // Tính vector vận tốc theo giới hạn hiện tại của lease
  const vectorFor = useCallback((direction) => {
    const limits = useControlStore.getState().lease?.limits;
    const maxLinear = limits?.maxLinearX ?? (DEFAULT_LINEAR_SPEED * 2);
    const maxAngular = limits?.maxAngularZ ?? (DEFAULT_ANGULAR_SPEED * 2);
    const linear = maxLinear * 0.5;
    const angular = maxAngular * 0.5;

    switch (direction) {
      case 'forward': return { linearX: linear, angularZ: 0 };
      case 'backward': return { linearX: -linear, angularZ: 0 };
      case 'left': return { linearX: 0, angularZ: angular };
      case 'right': return { linearX: 0, angularZ: -angular };
      default: return null;
    }
  }, []);

  // Bắt phím bàn phím an toàn
  useEffect(() => {
    return bindTeleopKeyboard({
      target: window,
      start: driveStart,
      stop: driveStop,
      manualStop: handleManualStop,
      vectorFor,
    });
  }, [driveStart, driveStop, handleManualStop, vectorFor]);

  // Xử lý chuyển đổi camera: dừng lái và hủy intent lease cũ
  const handleSelectCamera = useCallback((id) => {
    if (controlStore.selectedCameraId === id) return;
    driveStop('CAMERA_SWITCH');
    pageIntentRef.current?.abandon();
    useControlStore.getState().selectCamera(id);
  }, [controlStore.selectedCameraId, driveStop]);


  // --- Camera callbacks (stable) ---
  const onFrame = useCallback(({ cameraId, generation, lastFrameAt }) => {
    useControlStore.getState().onFrame(cameraId, generation, lastFrameAt);
  }, []);

  const onFailure = useCallback(({ cameraId, generation, message }) => {
    useControlStore.getState().onCameraError(cameraId, generation, { message });
  }, []);

  // --- Camera health badge ---
  // Fresh local receipt timestamps can arrive between the display timer ticks.
  const observedNow = Math.max(displayNow, ...[
    controlStore.lastFrameAt, controlStore.heartbeatReceivedAt, robotStore.lastReceivedAt,
  ].filter(Number.isFinite));
  const cameraAge = controlStore.lastFrameAt != null
    ? observedNow - controlStore.lastFrameAt
    : null;
  const cameraHealth = controlStore.cameraError
    ? 'error'
    : cameraAge == null
      ? 'loading'
      : cameraAge < CONTROL_POLICY.cameraStaleMs
        ? 'fresh'
        : 'stale';

  // --- Computed ---
  const canDriveCurrent = driveState(controlStore, robotStore, observedNow);
  const padEnabled = canDriveCurrent.allowed && Boolean(pageLeaseId) && pageLeaseId === controlStore.lease?.leaseId;
  const canAcquire = Boolean(
    controlStore.ready &&
    (controlStore.phase === 'idle' || controlStore.phase === 'revoked') &&
    !controlStore.stopUnconfirmed &&
    !acquiring &&
    (robotStore.snapshot?.rosConnected === true || robotStore.snapshot?.connected === true) &&
    robotStore.snapshot?.mode === 'idle' &&
    !robotStore.snapshot?.activeMissionId &&
    !robotStore.snapshot?.activeMappingSessionId &&
    robotStore.snapshot?.motionInhibited === false &&
    robotStore.snapshot?.physicalEstopActive === false &&
    cameraHealth === 'fresh'
  );

  return (
    <PageFrame title="Camera & điều khiển">
      <Stack spacing={2}>

        {/* Cảnh báo mock */}
        <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'warning.light' }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            ⚠ Mô phỏng — không kết nối motor thật. Không dùng để vận hành robot thực.
          </Typography>
        </Paper>

        {/* Camera section */}
        <Paper variant="outlined" sx={{ p: 0, overflow: 'hidden', borderRadius: 3 }}>
          {/* Camera selector */}
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 1.5, bgcolor: 'grey.900' }}>
            <ButtonGroup size="small" variant="contained">
              {['front', 'rear'].map(id => (
                <Button
                  key={id}
                  color={controlStore.selectedCameraId === id ? 'primary' : 'inherit'}
                  onClick={() => handleSelectCamera(id)}
                  data-testid={`camera-select-${id}`}
                >
                  {id === 'front' ? 'Trước' : 'Sau'}
                </Button>
              ))}
            </ButtonGroup>
            <Chip
              data-testid="camera-health"
              label={
                cameraHealth === 'fresh' ? 'Live ✓' :
                  cameraHealth === 'stale' ? 'Stale !' :
                    cameraHealth === 'error' ? `Lỗi: ${controlStore.cameraError}` :
                      'Đang tải...'
              }
              color={
                cameraHealth === 'fresh' ? 'success' :
                  cameraHealth === 'stale' ? 'warning' :
                    cameraHealth === 'error' ? 'error' : 'default'
              }
              size="small"
            />
          </Box>

          {/* CameraPanel: key={selectedGeneration} để cô lập hoàn toàn khi switch */}
          <CameraPanel
            key={`${controlStore.selectedCameraId}-${controlStore.selectedGeneration}`}
            client={client}
            cameraId={controlStore.selectedCameraId}
            generation={controlStore.selectedGeneration}
            onFrame={onFrame}
            onFailure={onFailure}
          />
        </Paper>

        {/* Control status */}
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
          <Stack spacing={1}>
            <Typography variant="subtitle2">Trạng thái điều khiển</Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Chip label={`Phase: ${controlStore.phase}`} size="small" />
              <Chip label={`Profile: ${controlStore.controlProfile}`} size="small" />
              {controlStore.lease && (
                <Chip
                  label={`TTL: ${Math.max(0,
                    Math.round((controlStore.leaseDeadline - observedNow) / 1000)
                  )}s`}
                  size="small"
                  color="info"
                />
              )}
            </Box>
            {/* Stop status */}
            <Typography variant="caption" data-testid="stop-status">
              Stop: {
                controlStore.stopRequestPhase === 'uncertain'
                  ? 'Chưa biết yêu cầu đã được xử lý; hãy thử lại cùng yêu cầu.'
                  : controlStore.stopState?.status === 'requested'
                    ? 'Đang gửi yêu cầu dừng...'
                  : controlStore.stopState?.status === 'confirmed'
                  ? `Đã xác nhận (${controlStore.controlProfile})`
                  : controlStore.stopState?.status === 'accepted'
                    ? 'Đã tiếp nhận, đang chờ xác nhận...'
                    : 'Không có'
              }
            </Typography>
            {controlStore.controlError && <Typography color="error" data-testid="control-error">{controlStore.controlError}</Typography>}
            {controlStore.stopRequestPhase === 'uncertain' && (
              <Button data-testid="retry-stop" onClick={() => {
                void controlActions.requestStop({ retry: true }).catch(reportControlError);
              }}>Thử lại yêu cầu dừng</Button>
            )}
            {/* Lý do không được lái */}
            {!canDriveCurrent.allowed && (
              <Box>
                <Typography variant="caption" color="error">Không thể lái vì:</Typography>
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {canDriveCurrent.reasons.map(r => (
                    <li key={r}>
                      <Typography variant="caption">{REASON_VI[r] ?? r}</Typography>
                    </li>
                  ))}
                </ul>
              </Box>
            )}
          </Stack>
        </Paper>

        {/* Controls */}
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
          <Stack spacing={2}>
            {/* Acquire */}
            <Button
              variant="outlined"
              onClick={handleAcquire}
              disabled={!canAcquire}
              aria-label="Nhận quyền lái"
              data-testid="acquire-control"
              fullWidth
            >
              Nhận quyền lái
            </Button>

            <Divider />

            {/* D-Pad */}
            <Typography variant="subtitle2" sx={{ textAlign: 'center' }}>
              Điều khiển D-Pad (giữ để di chuyển)
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1, maxWidth: 200, mx: 'auto' }}>
              <Box />
              <DPadButton
                drive={drive} disabled={!padEnabled}
                label="▲" direction="forward" ariaLabel="Tiến theo đầu robot"
                vector={{ linearX: DEFAULT_LINEAR_SPEED, angularZ: 0 }}
              />
              <Box />
              <DPadButton
                drive={drive} disabled={!padEnabled}
                label="◄" direction="left" ariaLabel="Quay trái"
                vector={{ linearX: 0, angularZ: DEFAULT_ANGULAR_SPEED }}
              />
              <DPadButton
                drive={drive} disabled={!padEnabled}
                label="▼" direction="backward" ariaLabel="Lùi theo đầu robot"
                vector={{ linearX: -DEFAULT_LINEAR_SPEED, angularZ: 0 }}
              />
              <DPadButton
                drive={drive} disabled={!padEnabled}
                label="►" direction="right" ariaLabel="Quay phải"
                vector={{ linearX: 0, angularZ: -DEFAULT_ANGULAR_SPEED }}
              />
            </Box>

            <Typography variant="caption" sx={{ textAlign: 'center' }} color="text.secondary">
              linearX dương = Tiến, angularZ dương = Quay trái (theo thân robot)
            </Typography>

            <Divider />

            {/* Manual stop */}
            <Button
              variant="contained"
              color="error"
              onClick={handleManualStop}
              aria-label="Yêu cầu dừng"
              data-testid="manual-stop"
              fullWidth
              sx={{ fontWeight: 700, fontSize: '1rem', py: 1.5 }}
            >
              🛑 Yêu cầu dừng
            </Button>
            <Typography variant="caption" sx={{ textAlign: 'center' }} color="text.secondary">
              Phím Space (khi không focus ô nhập) cũng gọi lệnh dừng
            </Typography>
          </Stack>
        </Paper>

      </Stack>
    </PageFrame>
  );
}
