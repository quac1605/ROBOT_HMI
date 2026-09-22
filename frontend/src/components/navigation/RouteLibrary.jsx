import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Stack, TextField, Typography } from '@mui/material';
import { useRobotClient } from '../../hooks/useRobotClient.js';
import { useNavigationWorkflowStore } from '../../state/navigationWorkflowStore.js';
import { checkSavedMap } from '../../utils/navigationGuards.js';
import { stableStringify } from '../../utils/stableStringify.js';

export default function RouteLibrary({ currentMap }) {
  const client = useRobotClient();
  const nav = useNavigationWorkflowStore();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const requestRef = useRef(null);
  const lock = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    const generation = useNavigationWorkflowStore.getState().selectionGeneration;
    client.listRoutes({ mapId: currentMap.id, mapRevision: currentMap.revision })
      .then(routes => { if (active) useNavigationWorkflowStore.getState().setSavedRoutes(routes, generation); })
      .catch(cause => { if (active) setError(cause.message); });
    setNotice(null);
    setError(null);
    requestRef.current = null;
    return () => { active = false; };
  }, [client, currentMap.id, currentMap.revision]);

  async function save() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const generation = nav.generation;
    const selectionGeneration = nav.selectionGeneration;
    const payload = { name: name.trim(), mapId: currentMap.id, mapRevision: currentMap.revision,
      poses: structuredClone(nav.routeDraft.poses) };
    const fingerprint = stableStringify(payload);
    if (requestRef.current?.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, request: { ...payload, requestId: crypto.randomUUID() } };
    }
    const request = requestRef.current.request;
    try {
      await client.saveRoute(request);
      const routes = await client.listRoutes({ mapId: request.mapId, mapRevision: request.mapRevision });
      const latest = useNavigationWorkflowStore.getState();
      if (latest.generation !== generation || latest.selectionGeneration !== selectionGeneration) return;
      latest.setSavedRoutes(routes, selectionGeneration);
      if (mounted.current) setNotice('Đã lưu tuyến demo. Bấm Nạp để đưa vào bản nháp; không tự chạy.');
    } catch (cause) {
      if (mounted.current && useNavigationWorkflowStore.getState().selectionGeneration === selectionGeneration) {
        setError(cause.message + ' Bấm Lưu lại cùng nội dung sẽ dùng lại requestId.');
      }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">Thư viện tuyến demo</Typography>
      <Typography variant="caption">Lưu trong bộ nhớ; logout hoặc tải lại toàn bộ trang sẽ mất tuyến.</Typography>
      <TextField size="small" label="Tên tuyến" value={name} onChange={event => setName(event.target.value)} />
      <Button data-testid="save-route" disabled={busy || !name.trim() || !nav.waypoints.length || !checkSavedMap(currentMap).ok}
        onClick={save}>Lưu tuyến</Button>
      {nav.savedRoutes.map(route => <Button key={route.routeId}
        onClick={() => nav.setRouteDraft(route.poses)}>Nạp tuyến: {route.name} ({route.poses.length} điểm)</Button>)}
      {notice && <Alert severity="success">{notice}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
    </Stack>
  );
}
