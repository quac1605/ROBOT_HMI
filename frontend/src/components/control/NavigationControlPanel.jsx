import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, FormControlLabel, Paper, Stack, Switch, Tooltip, Typography,
} from '@mui/material';
import { useShallow } from 'zustand/react/shallow';
import VirtualJoystick from './VirtualJoystick.jsx';
import { NavigationControlContext } from './NavigationControlContext.js';
import { useRobotClient } from '../../hooks/useRobotClient.js';
import { useControlActions } from '../../hooks/useControlActions.js';
import { useTeleopHold } from '../../hooks/useTeleopHold.js';
import { useControlStore } from '../../state/controlStore.js';
import { useRobotStore } from '../../stores/robotStore.js';
import { createPageLeaseIntent } from '../../utils/pageLeaseIntent.js';
import { stopOptionsForReason } from '../../utils/controlStopAction.js';
import { bindTeleopKeyboard } from '../../utils/teleopKeyboard.js';
import { fixedVectorForDirection } from '../../utils/joystickVector.js';
import {
  CONTROL_POLICY, MANUAL_DRIVE_SPEED, controlRobotReasons, selectCanDrive,
} from '@robot-hmi/control-domain/controlPolicy';

const CONTEXT = Object.freeze({ kind: 'manual' });
const REASON_MESSAGES = {
  ROBOT_UNKNOWN: 'Chưa có trạng thái robot.',
  TRANSPORT_UNHEALTHY: 'Trạng thái robot đã cũ hoặc mất kết nối.',
  ROS_UNAVAILABLE: 'Nguồn trạng thái robot chưa sẵn sàng.',
  ESTOP_ACTIVE_OR_UNKNOWN: 'E-stop đang bật hoặc chưa xác định trạng thái.',
  MOTION_INHIBITED_OR_UNKNOWN: 'Robot đang khóa chuyển động hoặc chưa rõ trạng thái khóa.',
  MISSION_ACTIVE_OR_UNKNOWN: 'Robot đang có nhiệm vụ. Dừng nhiệm vụ trước khi bật manual.',
  MAPPING_ACTIVE_OR_UNKNOWN: 'Đang có phiên mapping. Hoàn tất và lưu phiên trước khi bật manual.',
  MODE_NOT_ALLOWED: 'Robot chưa ở chế độ nghỉ để nhận quyền manual.',
  ROBOT_NOT_STATIONARY: 'Robot chưa đứng yên.',
};

function matchesContext(lease) {
  return lease?.context?.kind === CONTEXT.kind;
}

function fixedSpeedFits(lease) {
  const limits = lease?.limits;
  return Number.isFinite(limits?.maxLinearX) && Number.isFinite(limits?.maxAngularZ) &&
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

// Bật manual là một ý định nhận lease mới của chính trang này. Lease ở store
// hoặc một response cũ không được tự bật công tắc/khởi động joystick.
export function NavigationControlProvider({ children }) {
  const client = useRobotClient();
  const actions = useControlActions();
  // Camera ghi timestamp mỗi frame; UI lấy timestamp mới ở tick hiển thị 250 ms.
  // Lease/stop/generation vẫn thông báo ngay, publisher luôn đọc getState() mới.
  const controlState = useControlStore(useShallow(state => ({ ...state, lastFrameAt: null })));
  const control = { ...controlState, lastFrameAt: useControlStore.getState().lastFrameAt };
  const robot = useRobotStore();
  const intentRef = useRef(null);
  const joystickFocusRef = useRef(null);
  const [acquiring, setAcquiring] = useState(false);
  const [ownedLeaseId, setOwnedLeaseId] = useState(null);
  const [displayNow, setDisplayNow] = useState(0);

  const reportError = useCallback(error => {
    if (!['UNAUTHENTICATED', 'OPERATION_SUPERSEDED', 'LEASE_NOT_OWNED'].includes(error.code)) {
      useControlStore.getState().setControlState({ controlError: error.message });
    }
  }, []);

  useEffect(() => {
    const refresh = () => setDisplayNow(performance.now());
    refresh();
    const timer = setInterval(refresh, 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const intent = createPageLeaseIntent({
      client,
      getAcquirePayload: () => ({ context: CONTEXT }),
      onPending: setAcquiring,
      onError: reportError,
      onLeaseChange: setOwnedLeaseId,
      isLeaseCurrent: lease => {
        const current = useControlStore.getState();
        return matchesContext(lease) && fixedSpeedFits(lease) &&
          !current.stopUnconfirmed && current.lease?.leaseId === lease.leaseId &&
          current.controlGeneration === lease.controlGeneration;
      },
    });
    intentRef.current = intent;
    const unsubscribe = useControlStore.subscribe((current, previous) => {
      // Cần hủy cả acquire đang chờ, kể cả người dùng chưa giữ joystick.
      // Response muộn vẫn được pageLeaseIntent release đúng ID đã nhận.
      if (current.selectedCameraId !== previous.selectedCameraId ||
          current.selectedGeneration !== previous.selectedGeneration) intent.abandon();
      if (!current.lease && previous.lease) intent.forgetRevokedLease();
    });
    return () => {
      unsubscribe();
      intent.dispose();
      if (intentRef.current === intent) intentRef.current = null;
    };
  }, [client, reportError]);

  const getLatest = useCallback(() => {
    const current = useControlStore.getState();
    const currentRobot = useRobotStore.getState();
    const decision = selectCanDrive({
      authenticated: true, control: current,
      robot: {
        snapshot: currentRobot.snapshot,
        lastReceivedAt: currentRobot.lastReceivedAt,
        error: currentRobot.error,
      },
      camera: cameraOf(current), context: CONTEXT, now: performance.now(),
    });
    return {
      ...decision,
      allowed: decision.allowed && matchesContext(current.lease) && fixedSpeedFits(current.lease) &&
        Boolean(intentRef.current?.canUseLease(current.lease?.leaseId)),
      lease: current.lease,
      freshnessToken: current.freshnessToken,
    };
  }, []);
  const sendVelocity = useCallback(message => client.sendVelocity(message), [client]);
  const requestStop = useCallback(reason => {
    intentRef.current?.invalidatePending();
    // requestStop đặt stopUnconfirmed đồng bộ trước khi release bất đồng bộ.
    // Không dùng release/ACK thay cho observation xác nhận robot đã đứng yên.
    const pending = actions.requestStop(stopOptionsForReason(reason));
    intentRef.current?.abandon();
    return pending;
  }, [actions]);
  const { start, update, stop, cancel } = useTeleopHold({
    getLatest, sendVelocity, requestStop, onError: reportError,
  });
  const manualStop = useCallback(() => {
    if (!stop('MANUAL')) void requestStop().catch(reportError);
  }, [stop, requestStop, reportError]);
  const disableManual = useCallback(() => {
    // Fence local velocity timer first; releasing the exact lease zeros robot velocity.
    cancel();
    intentRef.current?.abandon();
  }, [cancel]);

  useEffect(() => bindTeleopKeyboard({
    target: window, start, stop, manualStop, vectorFor: fixedVectorForDirection,
  }), [start, stop, manualStop]);

  const now = Math.max(displayNow, ...[
    control.lastFrameAt, control.heartbeatReceivedAt, robot.lastReceivedAt,
  ].filter(Number.isFinite));
  const cameraFresh = !control.cameraError &&
    ['front', 'rear'].includes(control.selectedCameraId) &&
    control.cameraId === control.selectedCameraId &&
    control.generation === control.selectedGeneration &&
    Number.isFinite(control.lastFrameAt) && now >= control.lastFrameAt &&
    now - control.lastFrameAt < CONTROL_POLICY.cameraStaleMs;
  const robotFresh = !robot.error && Number.isFinite(robot.lastReceivedAt) &&
    now >= robot.lastReceivedAt && now - robot.lastReceivedAt < CONTROL_POLICY.robotStaleMs;
  const reasons = controlRobotReasons(robot.snapshot, !robotFresh, 'acquire', CONTEXT);
  const profileReady = control.controlProfile === 'mock' ||
    (control.controlProfile === 'hardware' && control.hardwareReady === true);
  const ownsCurrentLease = Boolean(ownedLeaseId) && ownedLeaseId === control.lease?.leaseId;
  const manualEnabled = acquiring || ownsCurrentLease;
  const canAcquire = profileReady && control.ready && !control.stopUnconfirmed &&
    !control.lease && ['idle', 'revoked'].includes(control.phase) && !acquiring &&
    cameraFresh && reasons.length === 0;
  const decision = selectCanDrive({
    authenticated: true, control,
    robot: { snapshot: robot.snapshot, lastReceivedAt: robot.lastReceivedAt, error: robot.error },
    camera: cameraOf(control), context: CONTEXT, now,
  });
  const joystickEnabled = decision.allowed && matchesContext(control.lease) &&
    fixedSpeedFits(control.lease) && ownsCurrentLease;
  const blocker = !control.ready ? 'Đang kết nối bộ điều khiển.'
    : !profileReady ? 'Hồ sơ điều khiển chưa cho phép vận hành.'
      : control.stopUnconfirmed ? 'Chờ xác nhận robot đã dừng.'
        : control.lease && !ownsCurrentLease ? 'Quyền lái đang thuộc một thao tác khác.'
          : reasons.length ? (REASON_MESSAGES[reasons[0]] || reasons[0])
            : !cameraFresh ? 'Chờ hình mới từ camera đang chọn.'
              : '';

  // Thanh công cụ và joystick dùng chung một lease, keyboard binding và hold.
  // Giữ provider ổn định khi đổi bản đồ để không gián đoạn camera/điều khiển.
  return (
    <NavigationControlContext.Provider value={{
      control, acquiring, manualEnabled, canAcquire, joystickEnabled, blocker,
      intentRef, joystickFocusRef, manualStop, disableManual, start, update, stop, actions, reportError,
    }}>
      {children}
    </NavigationControlContext.Provider>
  );
}

export function NavigationControlToolbar({ selectionMode, onSelectMode, canSelectInitial, canSelectGoal, selectionStatus }) {
  const {
    control, acquiring, manualEnabled, canAcquire, joystickEnabled, blocker,
    intentRef, joystickFocusRef, manualStop, disableManual, actions, reportError,
  } = useContext(NavigationControlContext);

  return (
    <Box data-testid="navigation-control-toolbar">
      <Stack spacing={1}>
        <Stack direction="row" spacing={1.5} useFlexGap
          sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <Tooltip title={!manualEnabled ? blocker : 'Tắt manual để dừng và trả quyền lái'}>
            <span>
              <FormControlLabel sx={{ m: 0 }}
                control={<Switch checked={manualEnabled} disabled={!manualEnabled && !canAcquire}
                  slotProps={{ input: { 'aria-label': 'Chế độ manual', 'data-testid': 'manual-mode-toggle' } }}
                  onChange={(_event, checked) => {
                    if (checked) {
                      onSelectMode(null);
                      void intentRef.current?.acquire();
                    }
                    else disableManual();
                    // Chuyển focus khỏi input Switch để W/A/S/D điều khiển được.
                    // Các ô nhập liệu khác vẫn giữ nguyên quy tắc không phát lệnh.
                    joystickFocusRef.current?.focus({ preventScroll: true });
                  }} />}
                label={acquiring ? 'Đang bật manual…' : manualEnabled ? 'Manual đang bật' : 'Bật chế độ manual'} />
            </span>
          </Tooltip>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button size="small" variant={selectionMode === 'initial' ? 'contained' : 'outlined'}
              disabled={manualEnabled || !canSelectInitial} aria-pressed={selectionMode === 'initial'}
              data-testid="select-initial-pose"
              onClick={() => onSelectMode(selectionMode === 'initial' ? null : 'initial')}>
              Chọn điểm hiện tại
            </Button>
            <Button size="small" variant={selectionMode === 'goal' ? 'contained' : 'outlined'}
              disabled={manualEnabled || !canSelectGoal} aria-pressed={selectionMode === 'goal'}
              data-testid="select-goal-pose"
              onClick={() => onSelectMode(selectionMode === 'goal' ? null : 'goal')}>
              Chọn điểm đích
            </Button>
          </Stack>
          <Stack spacing={0.5} sx={{ minWidth: 180 }}>
            <Button color="error" variant="contained" size="small" onClick={manualStop} data-testid="manual-stop">
              Yêu cầu dừng
            </Button>
            <Typography variant="caption" align="center" data-testid="stop-status">
              {control.stopUnconfirmed ? 'Đang chờ xác nhận dừng' :
                control.stopState?.status === 'confirmed' ? 'Đã xác nhận robot dừng' : 'Chưa có yêu cầu dừng'}
            </Typography>
          </Stack>
        </Stack>
        {selectionStatus && <Typography variant="caption" data-testid="pose-selection-status">{selectionStatus}</Typography>}
        {blocker && (!manualEnabled || !joystickEnabled) &&
          <Alert severity="info" data-testid="manual-blocker">{blocker}</Alert>}
        {control.lease && !fixedSpeedFits(control.lease) &&
          <Alert severity="error">Giới hạn lease không cho phép tốc độ 0.3 m/s và 0.3 rad/s.</Alert>}
        {control.controlError && <Alert severity="error" data-testid="control-error">{control.controlError}</Alert>}
        {control.stopRequestPhase === 'uncertain' &&
          <Button size="small" data-testid="retry-stop" onClick={() => {
            void actions.requestStop({ retry: true }).catch(reportError);
          }}>Thử lại cùng yêu cầu dừng</Button>}
      </Stack>
    </Box>
  );
}

export default function NavigationControlPanel() {
  const { joystickEnabled, start, update, stop, joystickFocusRef } = useContext(NavigationControlContext);

  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, width: '100%', boxSizing: 'border-box' }}
      data-testid="navigation-control-panel">
      <Stack spacing={1}>
        <Typography variant="subtitle2">Điều khiển thủ công</Typography>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
          <Box sx={{ flexShrink: 0 }}>
            <VirtualJoystick disabled={!joystickEnabled} start={start} update={update} stop={stop}
              testId="navigation-joystick" focusRef={joystickFocusRef} />
          </Box>
          <Stack spacing={0.75} sx={{ minWidth: 0 }}>
            <Typography variant="caption">W/A/S/D hoặc mũi tên: giữ để lái. Space: dừng.</Typography>
            <Typography variant="caption" color="text.secondary">
              Chọn camera tùy ý. Hướng lái theo robot.
            </Typography>
          </Stack>
        </Stack>
      </Stack>
    </Paper>
  );
}
