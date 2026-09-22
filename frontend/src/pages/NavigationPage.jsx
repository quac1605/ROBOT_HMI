import { useEffect, useState } from 'react';
import { Alert, Box, CircularProgress, MenuItem, Select, Stack, Typography } from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';
import NavigationWorkspace from '../components/navigation/NavigationWorkspace.jsx';
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
        {loading ? <CircularProgress /> : selectedMap
          ? <Box><NavigationWorkspace currentMap={selectedMap} /></Box>
          : <Typography>Không có bản đồ sẵn sàng.</Typography>}
      </Stack>
    </PageFrame>
  );
}
