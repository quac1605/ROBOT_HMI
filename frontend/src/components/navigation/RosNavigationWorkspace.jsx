import { Alert, Stack } from '@mui/material';
import { useRobotFreshness } from '../../hooks/useRobotFreshness.js';
import { useRobotStore } from '../../stores/robotStore.js';
import { resolveRosMapPose } from '../../utils/rosMapPose.js';
import Map2D from '../map/Map2D.jsx';
import { useNavigationManualState } from '../control/NavigationControlContext.js';
import { useNavigationWorkflowStore } from '../../state/navigationWorkflowStore.js';

export default function RosNavigationWorkspace({ model, selectionMode, initialPosition, onInitialPoseSelect, onGoalSelected }) {
  const manualEnabled = useNavigationManualState();
  const goal = useNavigationWorkflowStore(state => state.routeDraft.poses[0] || null);
  const snapshot = useRobotStore(state => state.snapshot);
  const { stale } = useRobotFreshness(2000);
  const { pose, reason } = resolveRosMapPose(snapshot, model.geometry, { transportStale: stale });
  const poseQuality = snapshot?.localization?.status === 'lost' ? 'lost' : 'odom';

  const message = {
    'no-odom': 'Đang chờ dữ liệu /odom để hiển thị robot.',
    'stale-odom': 'Dữ liệu /odom đã cũ hoặc mất kết nối; vị trí robot tạm ẩn.',
    'missing-transform': `Pose /odom ở hệ ${snapshot?.pose?.frameId || 'không rõ'}; cần TF từ hệ này sang ${model.geometry.frameId} để đặt robot lên bản đồ.`,
    'outside-map': 'Vị trí robot hiện nằm ngoài phạm vi bản đồ /map.',
  }[reason];

  return <Stack spacing={1}>
    <Map2D model={model} pose={pose} poseQuality={poseQuality} initialPose={initialPosition} goal={goal}
      tool={!manualEnabled && ['initial', 'goal'].includes(selectionMode) ? selectionMode : 'pan'}
      onInitialPoseSelect={onInitialPoseSelect} onGoalChange={onGoalSelected} />
    {message && <Alert severity="info" sx={{ py: 0 }}>{message}</Alert>}
  </Stack>;
}
