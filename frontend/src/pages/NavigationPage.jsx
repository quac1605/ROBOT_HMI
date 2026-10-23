import { useEffect, useState } from 'react';
import { Alert, Box, Chip, CircularProgress, Grid, MenuItem, Select, Stack, Typography } from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';
import NavigationWorkspace from '../components/navigation/NavigationWorkspace.jsx';
import RosNavigationWorkspace from '../components/navigation/RosNavigationWorkspace.jsx';
import NavigationDriveCamera from '../components/navigation/NavigationDriveCamera.jsx';
import NavigationControlPanel from '../components/control/NavigationControlPanel.jsx';
import MissionPanel from '../components/navigation/MissionPanel.jsx';
import WaypointEditor from '../components/navigation/WaypointEditor.jsx';
import RobotStatusCard from '../components/status/RobotStatusCard.jsx';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { useRosMap } from '../hooks/useRosMap.js';
import { useNavigationWorkflowStore } from '../state/navigationWorkflowStore.js';
import { useMappingWorkflowStore } from '../state/mappingWorkflowStore.js';

const keyOf = map => JSON.stringify([map.id, map.revision]);
export default function NavigationPage() {
  const client = useRobotClient();
  const [maps, setMaps] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [mapSource, setMapSource] = useState(() =>
    typeof client.getRosMap === 'function' ? 'ros' : 'saved');
  const catalogRevision = useMappingWorkflowStore(state => state.catalogRefreshRevision);
  const selectedMap = useNavigationWorkflowStore(state => state.selectedMap);
  const { model: rosMapModel, metadata: rosMapMetadata, error: rosMapError } = useRosMap();
  const supportsRosMap = typeof client.getRosMap === 'function';
  const showRosSource = mapSource === 'ros';
  const savedMapKey = selectedMap && maps.some(map => keyOf(map) === keyOf(selectedMap))
    ? keyOf(selectedMap) : '';
  const showSavedMap = !showRosSource && Boolean(selectedMap) && !loading;

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
                setMapSource('ros');
                return;
              }
              const selected = maps.find(map => keyOf(map) === event.target.value);
              if (selected) {
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
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 8 }}>
            <Stack spacing={1.5}>
              {showRosSource
                ? rosMapModel
                  ? <RosNavigationWorkspace model={rosMapModel} />
                  : <Typography>{rosMapMetadata?.status === 'waiting'
                    ? 'Đang chờ dữ liệu ROS /map…'
                    : 'Nguồn ROS /map chưa sẵn sàng. Kiểm tra node map và backend.'}</Typography>
                : showSavedMap
                  ? <NavigationWorkspace currentMap={selectedMap} />
                  : loading ? <CircularProgress /> : <Typography>Không có bản đồ sẵn sàng.</Typography>}
              {showRosSource && <Alert severity="info">
                Bản đồ ROS /map dùng để quan sát. Chọn bản đồ đã lưu để đặt đích, thêm waypoint và điều khiển nhiệm vụ.
              </Alert>}
              <NavigationControlPanel />
            </Stack>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <Stack spacing={2}>
              <Box sx={{ position: { md: 'sticky' }, top: 16, zIndex: 1, bgcolor: 'background.paper', borderRadius: 2 }}>
                <NavigationDriveCamera />
              </Box>
              <RobotStatusCard />
              {showSavedMap && <MissionPanel selectedMap={selectedMap} />}
              {showSavedMap && <WaypointEditor currentMap={selectedMap} />}
            </Stack>
          </Grid>
        </Grid>
      </Stack>
    </PageFrame>
  );
}
