import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, ButtonGroup, Chip, Paper, Stack, Typography } from '@mui/material';
import CameraPanel from '../CameraPanel.jsx';
import VirtualJoystick from './VirtualJoystick.jsx';
import { useRobotClient } from '../../hooks/useRobotClient.js';
import { useControlActions } from '../../hooks/useControlActions.js';
import { useTeleopHold } from '../../hooks/useTeleopHold.js';
import { useRobotStore } from '../../stores/robotStore.js';
import { useControlStore } from '../../state/controlStore.js';
import { useMappingWorkflowStore } from '../../state/mappingWorkflowStore.js';
import { createPageLeaseIntent } from '../../utils/pageLeaseIntent.js';
import { bindTeleopKeyboard } from '../../utils/teleopKeyboard.js';
import { fixedVectorForDirection } from '../../utils/joystickVector.js';
import {
  CONTROL_POLICY, MANUAL_DRIVE_SPEED, controlRobotReasons, selectCanDrive,
} from '@robot-hmi/control-domain/controlPolicy';

function matchesContext(lease, mappingSessionId) {
  return lease?.context?.kind === 'mapping' &&
    lease.context.mappingSessionId === mappingSessionId;
}

function fixedSpeedFits(lease) {
  const limits = lease?.limits;
  return Number.isFinite(limits?.maxLinearX) &&
    Number.isFinite(limits?.maxAngularZ) &&
    limits.maxLinearX >= MANUAL_DRIVE_SPEED.linearX &&
    limits.maxAngularZ >= MANUAL_DRIVE_SPEED.angularZ;
}

function cameraOf(control) {
  return {
    selectedCameraId: control.selectedCameraId,
    selectedGeneration: control.selectedGeneration,
    cameraId: control.cameraId,
    generation: control.generation,
    lastFrameAt: control.lastFrameAt,
    error: control.cameraError,
  };
}

function sessionIsCurrent(mappingSessionId) {
  const session = useMappingWorkflowStore.getState().session;
  return Boolean(mappingSessionId && session?.mappingSessionId === mappingSessionId &&
    session.status === 'mapping');
}

// enabled=false khi starting/finishing/save_failed hoặc đang làm thủ tục dừng/lưu.
export default function MappingControlPanel({ mappingSessionId, enabled }) {
  const client = useRobotClient();
  const actions = useControlActions();
  const control = useControlStore();
  const robot = useRobotStore();
  const intentRef = useRef(null);
  const [acquiring, setAcquiring] = useState(false);
  const [ownedLeaseId, setOwnedLeaseId] = useState(null);
  const [displayNow, setDisplayNow] = useState(0);
  const context = useMemo(() => ({ kind: 'mapping', mappingSessionId }), [mappingSessionId]);

  const reportError = useCallback(error => {
    if (!['UNAUTHENTICATED', 'OPERATION_SUPERSEDED', 'LEASE_NOT_OWNED'].includes(error.code)) {
      useControlStore.getState().setControlState({ controlError: error.message });
    }
  }, []);

  useEffect(() => {
    const update = () => setDisplayNow(performance.now());
    update();
    const timer = setInterval(update, 100); // Chỉ refresh nhãn UI, không publish velocity.
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const intent = createPageLeaseIntent({
      client,
      getAcquirePayload: () => ({ context }),
      onPending: setAcquiring,
      onError: reportError,
      onLeaseChange: setOwnedLeaseId,
      isLeaseCurrent: lease => {
        const current = useControlStore.getState();
        return enabled && sessionIsCurrent(mappingSessionId) &&
          matchesContext(lease, mappingSessionId) && fixedSpeedFits(lease) &&
          !current.stopUnconfirmed && current.lease?.leaseId === lease.leaseId &&
          current.controlGeneration === lease.controlGeneration;
      },
    });
    intentRef.current = intent;
    return () => {
      intent.dispose(); // Release đúng lease; response pending cũ cũng bị release.
      if (intentRef.current === intent) intentRef.current = null;
    };
  }, [client, context, enabled, mappingSessionId, reportError]);

  useEffect(() => {
    if (!control.lease) intentRef.current?.forgetRevokedLease();
  }, [control.lease]);

  const getLatest = useCallback(() => {
    const current = useControlStore.getState();
    const currentRobot = useRobotStore.getState();
    const decision = selectCanDrive({
      authenticated: true,
      control: current,
      robot: {
        snapshot: currentRobot.snapshot,
        lastReceivedAt: currentRobot.lastReceivedAt,
        error: currentRobot.error,
      },
      camera: cameraOf(current),
      context,
      now: performance.now(),
    });
    return {
      ...decision,
      allowed: decision.allowed && enabled && sessionIsCurrent(mappingSessionId) &&
        matchesContext(current.lease, mappingSessionId) && fixedSpeedFits(current.lease) &&
        Boolean(intentRef.current?.canUseLease(current.lease?.leaseId)),
      lease: current.lease,
      freshnessToken: current.freshnessToken,
    };
  }, [context, enabled, mappingSessionId]);

  const sendVelocity = useCallback(message => client.sendVelocity(message), [client]);
  const requestStop = useCallback(() => actions.requestStop(), [actions]);
  const { start, update, stop } = useTeleopHold({
    getLatest, sendVelocity, requestStop, onError: reportError,
  });

  const manualStop = useCallback(() => {
    intentRef.current?.invalidatePending();
    if (!stop('MANUAL')) void actions.requestStop().catch(reportError);
  }, [stop, actions, reportError]);

  useEffect(() => bindTeleopKeyboard({
    target: window,
    start,
    stop,
    manualStop,
    vectorFor: fixedVectorForDirection,
  }), [start, stop, manualStop]);

  const selectCamera = useCallback(id => {
    if (useControlStore.getState().selectedCameraId === id) return;
    stop('CAMERA_SWITCH');
    intentRef.current?.abandon();
    // Xóa health và tăng generation trước khi stream mới được mount.
    useControlStore.getState().selectCamera(id);
  }, [stop]);

  const onFrame = useCallback(({ cameraId, generation, lastFrameAt }) => {
    useControlStore.getState().onFrame(cameraId, generation, lastFrameAt);
  }, []);
  const onFailure = useCallback(({ cameraId, generation, message }) => {
    useControlStore.getState().onCameraError(cameraId, generation, { message });
  }, []);

  // Một frame có thể tới giữa hai tick cập nhật nhãn. Không tính tuổi âm.
  const now = Math.max(displayNow, ...[
    control.lastFrameAt, control.heartbeatReceivedAt, robot.lastReceivedAt,
  ].filter(Number.isFinite));
  const cameraFresh = !control.cameraError &&
    control.cameraId === control.selectedCameraId &&
    control.generation === control.selectedGeneration &&
    Number.isFinite(control.lastFrameAt) && now >= control.lastFrameAt &&
    now - control.lastFrameAt < CONTROL_POLICY.cameraStaleMs;
  const robotFresh = !robot.error && Number.isFinite(robot.lastReceivedAt) &&
    now >= robot.lastReceivedAt && now - robot.lastReceivedAt < CONTROL_POLICY.robotStaleMs;
  const reasons = controlRobotReasons(robot.snapshot, !robotFresh, 'acquire', context);
  const profileReady = control.controlProfile === 'mock' ||
    (control.controlProfile === 'hardware' && control.hardwareReady === true);
  const canAcquire = enabled && sessionIsCurrent(mappingSessionId) &&
    profileReady && control.ready && !control.stopUnconfirmed && !control.lease &&
    ['idle', 'revoked'].includes(control.phase) && !acquiring && cameraFresh && reasons.length === 0;
  const decision = selectCanDrive({
    authenticated: true, control,
    robot: { snapshot: robot.snapshot, lastReceivedAt: robot.lastReceivedAt, error: robot.error },
    camera: cameraOf(control), context, now,
  });
  const joystickEnabled = enabled && sessionIsCurrent(mappingSessionId) &&
    decision.allowed && matchesContext(control.lease, mappingSessionId) &&
    fixedSpeedFits(control.lease) && Boolean(ownedLeaseId) && ownedLeaseId === control.lease?.leaseId;

  return (
    <Stack spacing={1} data-testid="mapping-control-panel">
      <Paper variant="outlined" sx={{ overflow: 'hidden', borderRadius: 2 }}>
        <Box sx={{ p: 0.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <ButtonGroup size="small">
            {['front', 'rear'].map(id => (
              <Button key={id} variant={control.selectedCameraId === id ? 'contained' : 'outlined'}
                onClick={() => selectCamera(id)} data-testid={`camera-select-${id}`}
                sx={{ px: 0.75, py: 0.25, fontSize: '0.7rem' }}>
                {id === 'front' ? 'Cam trước' : 'Cam sau'}
              </Button>
            ))}
          </ButtonGroup>
          <Chip size="small" data-testid="camera-health"
            label={cameraFresh ? 'Live' : control.cameraError ? 'Lỗi camera' : 'Chờ frame'}
            color={cameraFresh ? 'success' : 'warning'}
            sx={{ height: 20, fontSize: '0.65rem' }} />
        </Box>
        <CameraPanel
          key={`${control.selectedCameraId}-${control.selectedGeneration}`}
          client={client} cameraId={control.selectedCameraId} generation={control.selectedGeneration}
          onFrame={onFrame} onFailure={onFailure}
        />
      </Paper>
      <Typography variant="caption" sx={{ fontSize: '0.68rem', color: 'text.secondary', display: 'block', px: 0.5, lineHeight: 1.2 }}>
        Chọn camera quan sát. Hướng lái theo robot.
      </Typography>
      <Paper variant="outlined" sx={{ p: 1, borderRadius: 2 }}>
        <Stack spacing={0.75}>
          <Button variant="outlined" size="small" disabled={!canAcquire} data-testid="acquire-control"
            onClick={() => { void intentRef.current?.acquire(); }}
            sx={{ py: 0.4, fontSize: '0.72rem', lineHeight: 1.2 }}>
            {acquiring ? 'Đang nhận quyền…' : 'Nhận quyền lái (Mapping)'}
          </Button>
          <VirtualJoystick disabled={!joystickEnabled} start={start} update={update} stop={stop} />
          <Typography variant="caption" align="center" sx={{ fontSize: '0.65rem', lineHeight: 1.15 }}>
            W/A/S/D hoặc mũi tên: giữ để lái. Space: dừng.
          </Typography>
          <Button color="error" variant="contained" size="small" onClick={manualStop} data-testid="manual-stop"
            sx={{ py: 0.4, fontSize: '0.75rem' }}>
            Yêu cầu dừng
          </Button>
          <Typography variant="caption" align="center" data-testid="stop-status" sx={{ fontSize: '0.7rem' }}>
            {control.stopUnconfirmed ? 'Đang chờ xác nhận dừng' :
              control.stopState?.status === 'confirmed' ? 'Đã xác nhận robot dừng' : 'Chưa có yêu cầu dừng'}
          </Typography>
          {!enabled && (
            <Alert severity="info" sx={{ py: 0.25, px: 1, '& .MuiAlert-message': { fontSize: '0.68rem', p: 0 } }}>
              Bắt đầu mapping để nhận quyền lái.
            </Alert>
          )}
          {control.lease && !fixedSpeedFits(control.lease) && (
            <Alert severity="error" sx={{ py: 0.25, px: 1, '& .MuiAlert-message': { fontSize: '0.68rem', p: 0 } }}>
              Giới hạn lease không cho phép tốc độ.
            </Alert>
          )}
          {control.controlError && (
            <Alert severity="error" data-testid="control-error" sx={{ py: 0.25, px: 1, '& .MuiAlert-message': { fontSize: '0.68rem', p: 0 } }}>
              {control.controlError}
            </Alert>
          )}
          {control.stopRequestPhase === 'uncertain' && (
            <Button size="small" data-testid="retry-stop" onClick={() => {
              void actions.requestStop({ retry: true }).catch(reportError);
            }} sx={{ fontSize: '0.7rem' }}>Thử lại cùng yêu cầu dừng</Button>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}
