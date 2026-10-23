import { useEffect, useRef, useState } from 'react';
import { Alert, Chip, CircularProgress, Grid, MenuItem, Select, Stack, Typography } from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';
import NavigationWorkspace from '../components/navigation/NavigationWorkspace.jsx';
import RosNavigationWorkspace from '../components/navigation/RosNavigationWorkspace.jsx';
import NavigationDriveCamera from '../components/navigation/NavigationDriveCamera.jsx';
import NavigationControlPanel, {
  NavigationControlProvider, NavigationControlToolbar,
} from '../components/control/NavigationControlPanel.jsx';
import MissionPanel from '../components/navigation/MissionPanel.jsx';
import WaypointEditor from '../components/navigation/WaypointEditor.jsx';
import RobotStatusCard from '../components/status/RobotStatusCard.jsx';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { useRosMap } from '../hooks/useRosMap.js';
import { useNavigationWorkflowStore } from '../state/navigationWorkflowStore.js';
import { useMappingWorkflowStore } from '../state/mappingWorkflowStore.js';
import { useControlStore } from '../state/controlStore.js';
import { useMissionStore } from '../state/missionStore.js';

const keyOf = map => JSON.stringify([map.id, map.revision]);
export default function NavigationPage() {
  const client = useRobotClient();
  const [maps, setMaps] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [mapSource, setMapSource] = useState(() =>
    typeof client.getRosMap === 'function' ? 'ros' : 'saved');
  const [selectionMode, setSelectionMode] = useState(null);
  const [selectionStatus, setSelectionStatus] = useState('');
  const [originalPosition, setOriginalPosition] = useState(undefined);
  const [poseBusy, setPoseBusy] = useState(false);
  const poseLock = useRef(false);
  const catalogRevision = useMappingWorkflowStore(state => state.catalogRefreshRevision);
  const selectedMap = useNavigationWorkflowStore(state => state.selectedMap);
  const activeMissionId = useMissionStore(state => state.activeMissionId);
  const { model: rosMapModel, metadata: rosMapMetadata, error: rosMapError } = useRosMap();
  const supportsRosMap = typeof client.getRosMap === 'function';
  const showRosSource = mapSource === 'ros';
  const savedMapKey = selectedMap && maps.some(map => keyOf(map) === keyOf(selectedMap))
    ? keyOf(selectedMap) : '';
  const showSavedMap = !showRosSource && Boolean(selectedMap) && !loading;

  useEffect(() => {
    let active = true;
    client.getOriginalPosition().then(result => {
      if (active) setOriginalPosition(result.originalPosition);
    }).catch(cause => {
      if (active) setSelectionStatus(`Không đọc được vị trí ban đầu: ${cause.message}`);
    });
    return () => { active = false; };
  }, [client]);

  async function selectInitialPose(pose) {
    if (poseLock.current || originalPosition === undefined || activeMissionId ||
        useControlStore.getState().lease || useControlStore.getState().phase === 'acquiring') return;
    poseLock.current = true;
    setPoseBusy(true);
    try {
      const result = await client.setOriginalPosition({ x: pose.x, y: pose.y, theta: pose.yaw });
      setOriginalPosition(result.originalPosition);
      setSelectionStatus('Đã lưu vị trí và hướng ban đầu của robot.');
      setSelectionMode(null);
    } catch (cause) {
      setSelectionStatus(`Không lưu được vị trí ban đầu: ${cause.message}`);
    } finally {
      poseLock.current = false;
      setPoseBusy(false);
    }
  }

  async function selectGoalPose(goal) {
    if (poseLock.current || activeMissionId || useControlStore.getState().lease) return;
    poseLock.current = true;
    setPoseBusy(true);
    try {
      const target = goal ? [{ x: goal.x, y: goal.y, theta: goal.yaw }] : [];
      await client.setTarget({ target });
      useNavigationWorkflowStore.getState().setRouteDraft(goal ? [goal] : []);
      setSelectionMode(null);
      setSelectionStatus(goal ? 'Đã gửi điểm đích và hướng tới robot qua /cmd_in.' : 'Đã xóa điểm đích.');
    } catch (cause) {
      setSelectionStatus(`Không gửi được điểm đích: ${cause.message}`);
    } finally {
      poseLock.current = false;
      setPoseBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    client.listMaps().then(catalog => {
      if (!active) return;
      setMaps(catalog);
      setError(null);
      const store = useNavigationWorkflowStore.getState();
      const selected = catalog.find(map => store.selectedMap && keyOf(map) === keyOf(store.selectedMap))
        || catalog.find(map => map.status === 'ready') || null;
      store.setSelectedMap(selected);
    }).catch(cause => {
      if (active) setError(cause.message);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, catalogRevision, refresh]);

  return (
    <PageFrame>
      <Stack spacing={2}>
        <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="h6">Điều hướng</Typography>
          <Select id="map-selector-select" size="small" displayEmpty
            value={showRosSource ? 'ros' : savedMapKey}
            onOpen={() => setRefresh(value => value + 1)}
            onChange={event => {
              if (event.target.value === 'ros') {
                setSelectionMode(null);
                setMapSource('ros');
                return;
              }
              const selected = maps.find(map => keyOf(map) === event.target.value);
              if (selected) {
                setSelectionMode(null);
                setMapSource('saved');
                useNavigationWorkflowStore.getState().setSelectedMap(selected);
              }
            }}>
            <MenuItem value="" disabled>Chọn bản đồ để xem</MenuItem>
            {supportsRosMap && <MenuItem value="ros">ROS /map (trực tiếp)</MenuItem>}
            {maps.map(map => <MenuItem key={keyOf(map)} value={keyOf(map)}>
              {map.name} ({map.revision})
            </MenuItem>)}
          </Select>
          {showRosSource && rosMapModel && <Chip size="small" color={rosMapError ? 'warning' : 'success'} variant="outlined"
            label={`ROS /map${rosMapError ? ' (kết nối gián đoạn)' : ''} · ${rosMapModel.geometry.width}×${rosMapModel.geometry.height} · ${rosMapModel.geometry.resolution.toFixed(3)} m/ô`} />}
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        {showRosSource && rosMapError && <Alert severity="warning">Không đọc được ROS /map: {rosMapError.message}</Alert>}
        {/* Camera và lease owner giữ cùng vị trí qua loading/chọn map.
            Chỉ vùng bản đồ thay đổi; không dựng lại video khi catalog cập nhật. */}
        <NavigationControlProvider>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 8 }}>
              <Stack spacing={1.5}>
                <NavigationControlToolbar selectionMode={selectionMode}
                  onSelectMode={mode => {
                    setSelectionMode(mode);
                    setSelectionStatus(mode === 'initial'
                      ? 'Nhấn vào vị trí robot trên bản đồ rồi kéo theo hướng robot đang quay.'
                      : mode === 'goal'
                        ? 'Nhấn vào điểm đích trên bản đồ rồi kéo theo hướng robot cần quay.' : '');
                  }}
                  canSelectInitial={!poseBusy && originalPosition !== undefined && !activeMissionId &&
                    (showRosSource ? Boolean(rosMapModel) : showSavedMap)}
                  canSelectGoal={!poseBusy && !activeMissionId && (showRosSource ? Boolean(rosMapModel) : showSavedMap)}
                  selectionStatus={selectionStatus} />
                {showRosSource
                  ? rosMapModel
                    ? <RosNavigationWorkspace model={rosMapModel} selectionMode={selectionMode}
                      initialPosition={originalPosition}
                      onInitialPoseSelect={selectInitialPose} onGoalSelected={selectGoalPose} />
                    : <Typography>{rosMapMetadata?.status === 'waiting'
                      ? 'Đang chờ dữ liệu ROS /map…'
                      : 'Nguồn ROS /map chưa sẵn sàng. Kiểm tra node map và backend.'}</Typography>
                  : showSavedMap
                    ? <NavigationWorkspace currentMap={selectedMap} selectionMode={selectionMode}
                      initialPosition={originalPosition}
                      onSelectMode={setSelectionMode} onInitialPoseSelect={selectInitialPose}
                      onGoalSelected={selectGoalPose} />
                    : loading ? <CircularProgress /> : <Typography>Không có bản đồ sẵn sàng.</Typography>}
                {showRosSource && <Alert severity="info">
                  Có thể chọn điểm đích trên ROS /map để cập nhật /cmd_in. Chọn bản đồ đã lưu để tạo tuyến và quản lý nhiệm vụ.
                </Alert>}
              </Stack>
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <Stack spacing={2}>
                <NavigationDriveCamera />
                <NavigationControlPanel />
                <RobotStatusCard />
                {showSavedMap && <MissionPanel selectedMap={selectedMap}
                  originalPosition={originalPosition} onOriginalPositionChange={setOriginalPosition} />}
                {showSavedMap && <WaypointEditor currentMap={selectedMap} />}
              </Stack>
            </Grid>
          </Grid>
        </NavigationControlProvider>
      </Stack>
    </PageFrame>
  );
}
