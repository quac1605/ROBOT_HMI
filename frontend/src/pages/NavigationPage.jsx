import { useEffect, useState } from 'react';
import { Alert, Box, CircularProgress, Grid, MenuItem, Select, Stack, Typography } from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';
import NavigationWorkspace from '../components/navigation/NavigationWorkspace.jsx';
import NavigationDriveCamera from '../components/navigation/NavigationDriveCamera.jsx';
import NavigationControlPanel from '../components/control/NavigationControlPanel.jsx';
import MissionPanel from '../components/navigation/MissionPanel.jsx';
import WaypointEditor from '../components/navigation/WaypointEditor.jsx';
import RobotStatusCard from '../components/status/RobotStatusCard.jsx';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { useNavigationWorkflowStore } from '../state/navigationWorkflowStore.js';
import { useMappingWorkflowStore } from '../state/mappingWorkflowStore.js';

const keyOf = map => JSON.stringify([map.id, map.revision]);
export default function NavigationPage() {
  const client = useRobotClient();
  const [maps, setMaps] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const catalogRevision = useMappingWorkflowStore(state => state.catalogRefreshRevision);
  const selectedMap = useNavigationWorkflowStore(state => state.selectedMap);

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
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <Typography variant="h6">Điều hướng</Typography>
          <Select id="map-selector-select" size="small" displayEmpty
            value={selectedMap && maps.some(map => keyOf(map) === keyOf(selectedMap)) ? keyOf(selectedMap) : ''}
            onOpen={() => setRefresh(value => value + 1)}
            onChange={event => {
              const selected = maps.find(map => keyOf(map) === event.target.value);
              if (selected) useNavigationWorkflowStore.getState().setSelectedMap(selected);
            }}>
            <MenuItem value="" disabled>Chọn bản đồ để xem</MenuItem>
            {maps.map(map => <MenuItem key={keyOf(map)} value={keyOf(map)}>
              {map.name} ({map.revision})
            </MenuItem>)}
          </Select>
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        {/* Camera và lease owner giữ cùng vị trí qua loading/chọn map.
            Chỉ vùng bản đồ thay đổi; không dựng lại video khi catalog cập nhật. */}
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 8 }}>
            <Stack spacing={1.5}>
              {selectedMap && !loading
                ? <NavigationWorkspace currentMap={selectedMap} />
                : loading ? <CircularProgress /> : <Typography>Không có bản đồ sẵn sàng.</Typography>}
              <NavigationControlPanel />
            </Stack>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <Stack spacing={2}>
              <Box sx={{ position: { md: 'sticky' }, top: 16, zIndex: 1, bgcolor: 'background.paper', borderRadius: 2 }}>
                <NavigationDriveCamera />
              </Box>
              <RobotStatusCard />
              {selectedMap && <MissionPanel selectedMap={selectedMap} />}
              {selectedMap && <WaypointEditor currentMap={selectedMap} />}
            </Stack>
          </Grid>
        </Grid>
      </Stack>
    </PageFrame>
  );
}
