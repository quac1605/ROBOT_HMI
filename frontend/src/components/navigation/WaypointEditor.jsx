import { useEffect, useState } from 'react';
import { Alert, Box, Button, List, ListItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { useNavigationWorkflowStore } from '../../state/navigationWorkflowStore.js';
import { isInsideMap } from '../../utils/mapCoordinates.js';
import RouteLibrary from './RouteLibrary.jsx';

export default function WaypointEditor({ currentMap }) {
    const nav = useNavigationWorkflowStore();
    const selected = nav.waypoints.find(point => point.id === nav.selectedWaypointId);
    const [x, setX] = useState('');
    const [y, setY] = useState('');
    const [degrees, setDegrees] = useState('');
    const [error, setError] = useState(null);

    useEffect(() => {
        setX(selected ? String(selected.x) : '');
        setY(selected ? String(selected.y) : '');
        setDegrees(selected ? String(selected.yaw * 180 / Math.PI) : '');
        setError(null);
    }, [selected, currentMap.id, currentMap.revision]);

    function readPose() {
        if ([x, y, degrees].some(value => value.trim() === '')) throw new Error('Vui lòng nhập đầy đủ X, Y, góc quay.');
        const values = [Number(x), Number(y), Number(degrees)];
        if (!values.every(Number.isFinite)) throw new Error('Giá trị phải là số hữu hạn.');
        if (Math.abs(values[2]) > 36000) throw new Error('Góc quay nằm ngoài phạm vi số hợp lệ (-36000° đến 36000°).');
        let angle = values[2] % 360;
        if (angle > 180) angle -= 360;
        if (angle < -180) angle += 360;
        const pose = { frameId: currentMap.frameId, x: values[0], y: values[1], yaw: angle * Math.PI / 180 };
        if (!isInsideMap(pose, currentMap)) throw new Error('Tọa độ nằm ngoài phạm vi hình học của bản đồ.');
        return pose;
    }
    function apply(mode) {
        setError(null);
        try {
            const pose = readPose();
            if (mode === 'single') nav.setRouteDraft([pose]);
            else if (mode === 'append' || !selected) nav.appendWaypoint(pose);
            else nav.updateWaypoint(selected.id, pose);
        } catch (cause) { setError(cause.message); }
    }
    return (
        <Paper sx={{ p: 2 }}>
            <Stack spacing={1.5}>
                <Typography variant="subtitle1">Waypoint và tuyến</Typography>
                <Box component="form" onSubmit={event => { event.preventDefault(); apply('edit'); }}>
                    <Stack spacing={1}>
                        <TextField label="X (m)" size="small" value={x} onChange={event => setX(event.target.value)} />
                        <TextField label="Y (m)" size="small" value={y} onChange={event => setY(event.target.value)} />
                        <TextField label="Góc (°)" size="small" value={degrees} onChange={event => setDegrees(event.target.value)} />
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                            <Button type="submit" variant="outlined">Áp dụng</Button>
                            <Button onClick={() => apply('append')} disabled={nav.waypoints.length >= 100}>Thêm điểm</Button>
                            <Button onClick={() => apply('single')}>Thay bằng một đích</Button>
                        </Stack>
                    </Stack>
                </Box>
                {error && <Alert severity="error">{error}</Alert>}
                {nav.error && <Alert severity="error">{nav.error.message}</Alert>}
                {selected ? (
                    <Stack spacing={0.5}>
                        <Typography variant="body2">
                            Tọa độ: X = {selected.x.toFixed(2)}m, Y = {selected.y.toFixed(2)}m.
                            Yaw = {(selected.yaw * 180 / Math.PI).toFixed(1)}°.
                        </Typography>
                    </Stack>
                ) : (
                    <Typography variant="body2" color="text.secondary">Chưa chọn mục tiêu.</Typography>
                )}
                <Typography variant="caption">
                    Chưa gửi mission khi chỉ chỉnh bản nháp; dùng nút Bắt đầu trong bảng nhiệm vụ để gửi.
                    Áp dụng chỉ sửa điểm đang chọn, không xóa các điểm khác.
                </Typography>
                <Typography variant="subtitle2">Danh sách Waypoints ({nav.waypoints.length}/100)</Typography>
                <List disablePadding>
                    {nav.waypoints.map((point, index) => <ListItem key={point.id} disableGutters divider>
                        <Stack spacing={0.5} sx={{ width: '100%' }}>
                            <Button aria-pressed={point.id === selected?.id} onClick={() => nav.selectWaypoint(point.id)}>
                                Chọn điểm {index + 1}: ({point.x.toFixed(2)}, {point.y.toFixed(2)})
                            </Button>
                            <Typography variant="caption">Yaw: {(point.yaw * 180 / Math.PI).toFixed(1)}°</Typography>
                            <Stack direction="row" spacing={0.5}>
                                <Button aria-label={'Đưa điểm ' + (index + 1) + ' lên'} disabled={index === 0}
                                    onClick={() => nav.moveWaypoint(point.id, -1)}>Lên</Button>
                                <Button aria-label={'Đưa điểm ' + (index + 1) + ' xuống'} disabled={index === nav.waypoints.length - 1}
                                    onClick={() => nav.moveWaypoint(point.id, 1)}>Xuống</Button>
                                <Button color="error" aria-label={'Xóa điểm ' + (index + 1)}
                                    onClick={() => nav.deleteWaypoint(point.id)}>Xóa</Button>
                            </Stack>
                        </Stack>
                    </ListItem>)}
                </List>
                <Stack direction="row" spacing={1}>
                    <Button disabled={!nav.waypoints.length} onClick={() => nav.deleteWaypoint(nav.waypoints.at(-1).id)}>Xóa điểm cuối</Button>
                    <Button color="error" disabled={!nav.waypoints.length} onClick={nav.clearDraft}>Xóa hết</Button>
                </Stack>
                <RouteLibrary currentMap={currentMap} />
            </Stack>
        </Paper>
    );
}
