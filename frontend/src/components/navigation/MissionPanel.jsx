import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, CardContent, LinearProgress, Stack, Typography } from '@mui/material';
import { useRobotClient } from '../../hooks/useRobotClient.js';
import { useRobotFreshness } from '../../hooks/useRobotFreshness.js';
import { useRobotStore } from '../../stores/robotStore.js';
import { useNavigationWorkflowStore } from '../../state/navigationWorkflowStore.js';
import { useMissionStore } from '../../state/missionStore.js';
import { checkMissionPreconditions, checkMapActivationPreconditions, checkRouteBounds, checkSavedMap } from '../../utils/navigationGuards.js';
import { isPending } from '../../utils/navigationPolicy.js';
import { sendMissionIntent, cancelMissionIntent, sendJobIntent } from '../../utils/navigationCommands.js';
import OriginalPositionDialog from './OriginalPositionDialog.jsx';

const toDegrees = rad => (rad * 180 / Math.PI).toFixed(1);

export default function MissionPanel({ selectedMap }) {
  const client = useRobotClient();
  const snapshot = useRobotStore(state => state.snapshot);
  const { stale } = useRobotFreshness(2000);
  const nav = useNavigationWorkflowStore();
  const missions = useMissionStore();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const cancelLock = useRef(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  // undefined: đang tải; null: chưa nhập; object: đã nhập (một lần, không sửa).
  const [originalPosition, setOriginalPosition] = useState(undefined);
  const [originalPositionError, setOriginalPositionError] = useState(null);
  const [askOriginalPosition, setAskOriginalPosition] = useState(false);
  const mission = missions.missionsById[missions.selectedMissionId];
  const active = missions.missionsById[missions.activeMissionId];
  const poses = nav.routeDraft.poses;
  const ready = missions.reconciliationState === 'ready';
  const unresolved = ['sending', 'uncertain'].includes(missions.missionRequest?.status);
  const mapCheck = checkSavedMap(selectedMap);
  const submitCheck = checkMissionPreconditions({
    robotSnapshot: snapshot, mapId: selectedMap?.id, mapRevision: selectedMap?.revision, transportStale: stale,
  });
  const activationCheck = checkMapActivationPreconditions({ robotSnapshot: snapshot, transportStale: stale });
  const boundsCheck = selectedMap ? checkRouteBounds(poses, selectedMap) : { ok: false, reason: 'Chưa chọn map.' };
  const isActiveMap = snapshot?.activeMap?.id === selectedMap?.id && snapshot?.activeMap?.revision === selectedMap?.revision;
  const submitReason = !ready ? 'Đang chờ đối soát trạng thái robot.'
    : unresolved ? 'Có yêu cầu chưa rõ kết quả; đối soát bằng requestId cũ.'
      : isPending(nav.activation?.status) ? 'Đang xử lý kích hoạt bản đồ.'
        : !poses.length ? 'Hãy thêm ít nhất một waypoint.'
          : !mapCheck.ok ? mapCheck.reason : !boundsCheck.ok ? boundsCheck.reason
            : !submitCheck.ok ? submitCheck.reason : null;

  useEffect(() => {
    let active = true;
    client.getOriginalPosition().then(result => {
      if (active) { setOriginalPosition(result.originalPosition); setOriginalPositionError(null); }
    }).catch(cause => {
      if (active) setOriginalPositionError(cause.message);
    });
    return () => { active = false; };
  }, [client]);

  async function exclusive(work) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try { await work(); }
    finally { lock.current = false; setBusy(false); }
  }
  async function cancelExclusive(work) {
    // Stopping is a separate intent. A slow create/preview HTTP response must
    // never lock Cancel once an authoritative event identifies the mission.
    if (cancelLock.current) return;
    cancelLock.current = true;
    setCancelBusy(true);
    try { await work(); }
    finally { cancelLock.current = false; setCancelBusy(false); }
  }
  function missionRequest() {
    return {
      requestId: crypto.randomUUID(), kind: poses.length === 1 ? 'navigate_to_pose' : 'navigate_through_poses',
      mapId: selectedMap.id, mapRevision: selectedMap.revision, poses: structuredClone(poses),
    };
  }
  function jobRequest(includePoses) {
    return {
      requestId: crypto.randomUUID(), mapId: selectedMap.id, mapRevision: selectedMap.revision,
      ...(includePoses ? { poses: structuredClone(poses) } : {})
    };
  }
  function startMission() {
    // Lần đầu vào mode auto phải nhập vị trí ban đầu của robot trước khi gửi đích.
    if (!originalPosition) { setAskOriginalPosition(true); return; }
    void exclusive(() => sendMissionIntent(client, missionRequest()));
  }
  async function submitOriginalPosition(position) {
    let stored;
    try {
      stored = (await client.setOriginalPosition(position)).originalPosition;
    } catch (cause) {
      // Tab khác đã nhập trước: dùng giá trị đã lưu, không ghi đè.
      if (cause.code !== 'ORIGINAL_POSITION_ALREADY_SET') throw cause;
      stored = (await client.getOriginalPosition()).originalPosition;
    }
    setOriginalPosition(stored);
    setOriginalPositionError(null);
    setAskOriginalPosition(false);
    await exclusive(() => sendMissionIntent(client, missionRequest()));
  }
  const errors = [
    missions.lastError, missions.missionRequest?.error, missions.cancelRequest?.error,
    nav.activation?.error, nav.preview?.error,
  ].filter(Boolean);

  return (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <Typography variant="subtitle1" fontWeight="bold">Điều khiển nhiệm vụ</Typography>
          <Typography variant="body2">
            {isActiveMap ? 'Map đang xem đã active trên robot.' : 'Map đang xem chưa active trên robot.'}
          </Typography>
          <Button data-testid="activate-map" variant="outlined"
            disabled={busy || !ready || !mapCheck.ok || isActiveMap || !activationCheck.ok ||
              isPending(nav.activation?.status) || unresolved}
            onClick={() => exclusive(() => sendJobIntent(client, 'activation', jobRequest(false)))}>
            Kích hoạt bản đồ cho robot
          </Button>
          {nav.activation && <Typography variant="caption">
            Activation: {nav.activation.status} — {nav.activation.request.mapId}
          </Typography>}
          {!activationCheck.ok && !isActiveMap && <Typography variant="caption">{activationCheck.reason}</Typography>}
          {nav.activation?.status === 'uncertain' && <Button disabled={busy}
            onClick={() => exclusive(() => sendJobIntent(client, 'activation', nav.activation.request))}>
            Đối soát / thử lại activation cùng requestId
          </Button>}

          {mission && <Stack spacing={0.5} data-testid="mission-feedback">
            <Typography>Nhiệm vụ: {mission.status}</Typography>
            <Typography variant="caption">
              Map: {mission.mapId} / {mission.mapRevision}. Điểm {(mission.currentPoseIndex ?? 0) + 1}/{mission.poses.length}.
              Còn lại: {mission.distanceRemainingM?.toFixed(2) ?? '?'} m.
            </Typography>
            {mission.status === 'executing' && <LinearProgress />}
            {mission.error && <Alert severity="error">{mission.error.code}: {mission.error.message}</Alert>}
          </Stack>}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button data-testid="preview-route" variant="outlined"
              disabled={busy || !poses.length || !mapCheck.ok || !boundsCheck.ok || isPending(nav.preview?.status)}
              onClick={() => exclusive(() => sendJobIntent(client, 'preview', jobRequest(true)))}>
              Xem trước
            </Button>
            <Button data-testid="mission-submit" variant="contained"
              disabled={busy || Boolean(submitReason) || Boolean(active) || originalPosition === undefined}
              onClick={startMission}>
              Bắt đầu
            </Button>
            {active && <Button data-testid="mission-cancel" color="error" variant="contained"
              disabled={cancelBusy || active.status === 'canceling' || missions.cancelRequest?.status === 'sending'}
              onClick={() => cancelExclusive(() => cancelMissionIntent(client,
                missions.cancelRequest?.status === 'uncertain' &&
                  missions.cancelRequest.request.missionId === active.missionId
                  ? missions.cancelRequest.request
                  : { missionId: active.missionId, requestId: crypto.randomUUID() }))}>
              {active.status === 'canceling' ? 'Đang dừng...' : 'Dừng lại'}
            </Button>}
          </Stack>
          {submitReason && <Typography data-testid="submit-block-reason" variant="caption">{submitReason}</Typography>}
          <Typography variant="caption" data-testid="original-position">
            {originalPosition
              ? `Vị trí ban đầu: X = ${originalPosition.x.toFixed(2)} m, Y = ${originalPosition.y.toFixed(2)} m, góc = ${toDegrees(originalPosition.theta)}°.`
              : originalPosition === null ? 'Chưa nhập vị trí ban đầu; sẽ được hỏi khi bấm Bắt đầu lần đầu.' : 'Đang tải vị trí ban đầu…'}
          </Typography>
          {originalPositionError && <Alert severity="error">{originalPositionError}</Alert>}
          {nav.preview && <Typography variant="caption">Preview: {nav.preview.status}</Typography>}
          {nav.preview?.status === 'uncertain' && <Button disabled={busy}
            onClick={() => exclusive(() => sendJobIntent(client, 'preview', nav.preview.request))}>
            Thử lại preview cùng requestId
          </Button>}
          {missions.missionRequest?.status === 'uncertain' && <Stack spacing={1}>
            <Alert severity="warning">
              Chưa rõ kết quả yêu cầu {missions.missionRequest.request.requestId}.
              Payload gốc gồm {missions.missionRequest.request.poses.length} điểm trên {missions.missionRequest.request.mapId}.
              Không tự gửi lại draft mới.
            </Alert>
            <Button disabled={busy}
              onClick={() => exclusive(() => sendMissionIntent(client, missions.missionRequest.request, true))}>
              Đối soát / thử lại cùng requestId
            </Button>
          </Stack>}
          <Button size="small" disabled={busy} onClick={() => missions.requestRecovery()}>
            Đối soát trạng thái
          </Button>
          {errors.map((error, index) => <Alert key={index} severity="error">{error.code}: {error.message}</Alert>)}
        </Stack>
        <OriginalPositionDialog open={askOriginalPosition} map={selectedMap}
          onCancel={() => setAskOriginalPosition(false)} onSubmit={submitOriginalPosition} />
      </CardContent>
    </Card>
  );
}
