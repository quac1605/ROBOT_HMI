import { useMemo, useState } from 'react';
import { Alert, Box, CircularProgress, Grid, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material';
import Map2D from '../map/Map2D.jsx';
import NavigationLegend from './NavigationLegend.jsx';
import WaypointEditor from './WaypointEditor.jsx';
import MissionPanel from './MissionPanel.jsx';
import { useMapGrid } from '../../hooks/useMapGrid.js';
import { useOccupancyRaster } from '../../hooks/useOccupancyRaster.js';
import { useRobotFreshness } from '../../hooks/useRobotFreshness.js';
import { useNavigationWorkflowStore } from '../../state/navigationWorkflowStore.js';
import { useMissionStore } from '../../state/missionStore.js';
import { useRobotStore } from '../../stores/robotStore.js';
import { resolvePoseQuality } from '../../utils/poseQuality.js';
import { resolveVisiblePose } from '../../utils/mapCoordinates.js';
import { sameMapContext, sameGeometry } from '../../utils/mapRenderModel.js';
import { savedContext, matchesMap } from '../../utils/navigationPolicy.js';

export default function NavigationWorkspace({ currentMap }) {
    const [tool, setTool] = useState('goal');
    const snapshot = useRobotStore(state => state.snapshot);
    const { stale } = useRobotFreshness(2000);
    const nav = useNavigationWorkflowStore();
    const missions = useMissionStore();
    const expectedContext = useMemo(() => savedContext(currentMap), [currentMap]);
    const geometry = useMemo(() => ({
        frameId: currentMap.frameId, width: currentMap.width, height: currentMap.height,
        resolution: currentMap.resolution, origin: currentMap.origin,
    }), [currentMap]);
    const { normalizedGrid, error: gridError } = useMapGrid(expectedContext, { expectedGeometry: geometry });
    const { raster, rasterError } = useOccupancyRaster(normalizedGrid);
    const model = raster && sameMapContext(raster.context, expectedContext) && sameGeometry(raster.geometry, geometry)
        ? raster : null;
    const mission = missions.missionsById[missions.selectedMissionId];
    const sameMission = overlay => overlay?.missionId === mission?.missionId && matchesMap(overlay, currentMap);
    const planned = sameMission(missions.plannedPath) ? missions.plannedPath.poses : null;
    const trajectory = sameMission(missions.trajectory) ? missions.trajectory.poses : null;
    const preview = matchesMap(nav.previewPath, currentMap) && nav.previewPath.draftRevision === nav.draftRevision
        ? nav.previewPath.path : null;
    const pose = resolveVisiblePose(snapshot, { ...expectedContext, frameId: currentMap.frameId });
    const poseQuality = resolvePoseQuality(snapshot, { transportStale: stale });
    const selected = nav.waypoints.find(point => point.id === nav.selectedWaypointId);

    return (
        <Stack spacing={2}>
            {(gridError || rasterError) && <Alert severity="error">{(gridError || rasterError).message}</Alert>}
            <Alert severity="info">
                Navigation mock: đường nối waypoint chỉ là minh họa, chưa kiểm tra vật cản/footprint và không phải Nav2.
                Robot thật có thể lập đường khác giữa các waypoint.
            </Alert>
            <Grid container spacing={2}>
                <Grid size={{ xs: 12, md: 8 }}>
                    <Stack spacing={1}>
                        <ToggleButtonGroup value={tool} exclusive size="small"
                            onChange={(_, value) => { if (value) setTool(value); }}>
                            <ToggleButton value="pan" aria-label="Kéo xem bản đồ">Kéo xem</ToggleButton>
                            <ToggleButton value="goal" aria-label="Đặt đích">Đặt một đích</ToggleButton>
                            <ToggleButton value="waypoint" aria-label="Tạo tuyến đường">Thêm waypoint</ToggleButton>
                        </ToggleButtonGroup>
                        {!model ? <Box sx={{ p: 4 }}><CircularProgress /></Box> : (
                            <Map2D model={model} pose={pose} poseQuality={poseQuality}
                                goal={selected || nav.routeDraft.poses[0] || null}
                                routeDraft={nav.routeDraft} previewPath={preview} plannedPath={planned} trajectory={trajectory}
                                tool={tool}
                                onGoalChange={goal => nav.setRouteDraft(goal ? [goal] : [])}
                                onWaypointAdd={nav.appendWaypoint} />
                        )}
                        <NavigationLegend />
                    </Stack>
                </Grid>
                <Grid size={{ xs: 12, md: 4 }}>
                    <Stack spacing={2}>
                        <MissionPanel selectedMap={currentMap} />
                        <WaypointEditor currentMap={currentMap} />
                    </Stack>
                </Grid>
            </Grid>
        </Stack>
    );
}
