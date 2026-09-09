import { useRef, useState } from 'react';
import { Box, Button, ButtonGroup } from '@mui/material';
import { isInsideMap, svgToWorld, worldToSvg } from '../../utils/mapCoordinates.js';

export default function Map2D({
    map,
    pose,
    poseQuality = 'reliable',
    goal,
    tool = 'goal',
    onGoalChange,
}) {
    const svgRef = useRef(null);
    const drag = useRef(null);
    const PADDING = 8;
    const getInitialView = (m) => ({
        x: -PADDING,
        y: -PADDING,
        w: m.width + PADDING * 2,
        h: m.height + PADDING * 2,
    });

    const [view, setView] = useState(() => getInitialView(map));
    const [dragPreview, setDragPreview] = useState(null);

    function toSvg(clientX, clientY) {
        const svg = svgRef.current;
        const matrix = svg?.getScreenCTM();
        if (!matrix) return null;
        return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    }

    function pointerDown(event) {
        if (event.button !== 0) return;
        // Chặn multi-touch: chỉ xử lý một pointer duy nhất tại một thời điểm
        if (drag.current) return;

        const point = toSvg(event.clientX, event.clientY);
        if (!point) return;

        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // Bỏ qua nếu browser không hỗ trợ capture
        }

        drag.current = {
            pointerId: event.pointerId,
            point,
            tool,
            view: { ...view },
            clientX: event.clientX,
            clientY: event.clientY,
        };
    }

    function pointerMove(event) {
        const start = drag.current;
        if (!start || event.pointerId !== start.pointerId) return;

        if (start.tool === 'pan') {
            // Dùng CTM hiện tại để đổi delta screen thành delta trong world của SVG.
            const matrix = svgRef.current?.getScreenCTM();
            if (!matrix) return;
            const inverse = matrix.inverse();
            const a = new DOMPoint(start.clientX, start.clientY).matrixTransform(inverse);
            const b = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
            setView({ ...start.view, x: start.view.x - (b.x - a.x), y: start.view.y - (b.y - a.y) });
        } else if (start.tool === 'goal') {
            // Hiển thị trực tiếp đường kéo chọn góc quay khi di chuyển chuột
            const currentPoint = toSvg(event.clientX, event.clientY);
            if (currentPoint) {
                const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) >= 5;
                if (moved) {
                    setDragPreview({ start: start.point, current: currentPoint });
                } else {
                    setDragPreview(null);
                }
            }
        }
    }

    function pointerUp(event) {
        const start = drag.current;
        if (!start || event.pointerId !== start.pointerId) return;
        drag.current = null;
        setDragPreview(null);

        try {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
            }
        } catch {
            // Bỏ qua nếu lỗi release
        }

        if (start.tool !== 'goal') return;
        const end = toSvg(event.clientX, event.clientY);
        if (!end) return;
        const position = svgToWorld(start.point, map);
        if (!isInsideMap(position, map)) return;
        const target = svgToWorld(end, map);
        const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) >= 5;
        const yaw = moved ? Math.atan2(target.y - position.y, target.x - position.x) : (goal?.yaw ?? 0);
        onGoalChange({ frameId: map.frameId, ...position, yaw });
    }

    function pointerCancel(event) {
        if (drag.current && event.pointerId === drag.current.pointerId) {
            drag.current = null;
            setDragPreview(null);
        }
    }

    function zoom(factor) {
        if (drag.current) return;
        setView((old) => {
            const w = Math.min(map.width * 4, Math.max(10, old.w * factor));
            const h = (w * map.height) / map.width;
            return { x: old.x + (old.w - w) / 2, y: old.y + (old.h - h) / 2, w, h };
        });
    }

    const robotPoint = pose && pose.frameId === map.frameId ? worldToSvg(pose, map) : null;
    const goalPoint = goal ? worldToSvg(goal, map) : null;

    // Màu sắc và nhãn chất lượng của marker robot
    const robotColor =
        poseQuality === 'reliable'
            ? '#198754'
            : poseQuality === 'stale'
            ? '#f57c00'
            : poseQuality === 'lost'
            ? '#d32f2f'
            : '#9e9e9e';

    const robotLabel =
        poseQuality === 'stale'
            ? 'Vị trí cuối (Cũ)'
            : poseQuality === 'lost'
            ? 'Mất định vị'
            : poseQuality === 'offline'
            ? 'Mất kết nối'
            : null;

    // Định vị nhãn thông minh theo 4 cạnh bao quanh footprint VISTAR 1 (809x500mm)
    // (Lưu ý: Tuyệt đối không clamp marker robot để giữ đúng vị trí thực)
    const labelY = robotPoint ? (robotPoint.y < 20 ? 11 : -9) : -9;
    const labelX = robotPoint ? (robotPoint.x > map.width - 40 ? -12 : 12) : 12;
    const labelAnchor = robotPoint && robotPoint.x > map.width - 40 ? 'end' : 'start';

    return (
        <Box
            sx={{
                userSelect: 'none',
                WebkitUserSelect: 'none',
                touchAction: 'none',
            }}
            onDragStart={(e) => e.preventDefault()}
        >
            {/* Thanh nút công cụ Zoom / Fit bằng MUI ButtonGroup */}
            <Box sx={{ mb: 1, display: 'flex', gap: 1 }}>
                <ButtonGroup size="small" variant="outlined" aria-label="Điều khiển phóng to thu nhỏ bản đồ">
                    <Button onClick={() => zoom(0.8)} aria-label="Phóng to bản đồ">Phóng to (+)</Button>
                    <Button onClick={() => zoom(1.25)} aria-label="Thu nhỏ bản đồ">Thu nhỏ (-)</Button>
                    <Button onClick={() => setView(getInitialView(map))} aria-label="Khung nhìn vừa bản đồ">Vừa bản đồ</Button>
                </ButtonGroup>
            </Box>

            {/* Khung chứa SVG căn giữa và giữ đúng tỉ lệ khung hình của bản đồ */}
            <Box
                sx={{
                    width: '100%',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    bgcolor: '#cfd8dc',
                    borderRadius: 2,
                    overflow: 'hidden',
                    p: { xs: 0.5, sm: 1 },
                }}
            >
                <svg
                    ref={svgRef}
                    viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                    style={{
                        width: '100%',
                        maxWidth: `calc(56vh * ${map.width} / ${map.height})`,
                        height: 'auto',
                        maxHeight: '56vh',
                        aspectRatio: `${map.width} / ${map.height}`,
                        background: '#eceff1',
                        touchAction: 'none',
                        cursor: tool === 'pan' ? 'grab' : 'crosshair',
                        userSelect: 'none',
                        WebkitUserSelect: 'none',
                        display: 'block',
                        borderRadius: 4,
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
                    }}
                    role="img"
                    aria-label="Bản đồ mô phỏng, dùng chuột chọn vị trí và kéo để chọn hướng"
                    onPointerDown={pointerDown}
                    onPointerMove={pointerMove}
                    onPointerUp={pointerUp}
                    onPointerCancel={pointerCancel}
                    onLostPointerCapture={(e) => {
                        if (drag.current && e.pointerId === drag.current.pointerId) {
                            drag.current = null;
                            setDragPreview(null);
                        }
                    }}
                    onDragStart={(e) => e.preventDefault()}
                >
                    <rect x="0" y="0" width={map.width} height={map.height} fill="#fff" stroke="#52616b" />
                    <rect x="70" y="40" width="35" height="50" fill="#195b78" />

                    {/* Vị trí Robot: Vẽ Footprint thực tế của xe VISTAR 1 (809mm x 500mm) */}
                    {robotPoint && (
                        <g transform={`translate(${robotPoint.x} ${robotPoint.y})`}>
                            {/* Khối thân xe VISTAR 1 xoay theo góc yaw */}
                            <g transform={`rotate(${-(pose.yaw - map.origin.yaw) * (180 / Math.PI)})`}>
                                {/* 2 Bánh xe chủ động hai bên sườn (Drive Wheels: ~150mm x 50mm) */}
                                <rect
                                    x="-1.5"
                                    y="-5.7"
                                    width="3.0"
                                    height="1.3"
                                    rx="0.3"
                                    fill="#37474f"
                                    stroke="#263238"
                                    strokeWidth="0.3"
                                />
                                <rect
                                    x="-1.5"
                                    y="4.4"
                                    width="3.0"
                                    height="1.3"
                                    rx="0.3"
                                    fill="#37474f"
                                    stroke="#263238"
                                    strokeWidth="0.3"
                                />

                                {/* Thân xe chính VISTAR 1 (809mm x 500mm = 16.18 x 10 ô) */}
                                <rect
                                    x="-8.09"
                                    y="-5.0"
                                    width="16.18"
                                    height="10.0"
                                    rx="1.6"
                                    fill={robotColor}
                                    stroke="#ffffff"
                                    strokeWidth="0.8"
                                    strokeDasharray={poseQuality === 'reliable' ? 'none' : '2,1.5'}
                                    opacity={poseQuality === 'reliable' ? 0.95 : 0.7}
                                />

                                {/* Bệ đỡ / khoang trên bo viền (Upper deck 609mm x 380mm) */}
                                <rect
                                    x="-6.09"
                                    y="-3.8"
                                    width="12.18"
                                    height="7.6"
                                    rx="1.0"
                                    fill="none"
                                    stroke="#ffffff"
                                    strokeWidth="0.5"
                                    strokeOpacity="0.75"
                                />

                                {/* 2 Cảm biến LiDAR ở 2 đầu xe (quét 360 độ) */}
                                <circle cx="6.8" cy="0" r="1.1" fill="#263238" stroke="#ffffff" strokeWidth="0.4" />
                                <circle cx="-6.8" cy="0" r="1.1" fill="#263238" stroke="#ffffff" strokeWidth="0.4" />

                                {/* Mũi tên chỉ hướng đầu xe VISTAR 1 (+X) */}
                                <path
                                    d="M -2.5 0 L 5.2 0 M 2.8 -2.2 L 5.2 0 L 2.8 2.2"
                                    fill="none"
                                    stroke="#ffffff"
                                    strokeWidth="1.1"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                />

                                {/* Chữ nhận diện VISTAR 1 */}
                                <text
                                    x="0"
                                    y="2.8"
                                    fontSize="2.0"
                                    fill="#ffffff"
                                    fontWeight="bold"
                                    textAnchor="middle"
                                    fontFamily="sans-serif"
                                    letterSpacing="0.2"
                                    opacity="0.95"
                                >
                                    VISTAR 1
                                </text>
                            </g>

                            {/* Nhãn văn bản nếu robot không ở trạng thái reliable, định vị thông minh 4 hướng */}
                            {robotLabel && (
                                <text
                                    x={labelX}
                                    y={labelY}
                                    textAnchor={labelAnchor}
                                    fontSize="3.8"
                                    fill={robotColor}
                                    fontWeight="bold"
                                    fontFamily="sans-serif"
                                >
                                    {robotLabel}
                                </text>
                            )}
                        </g>
                    )}

                    {goalPoint && (
                        <g transform={`translate(${goalPoint.x} ${goalPoint.y}) rotate(${-(goal.yaw - map.origin.yaw) * 180 / Math.PI})`}>
                            <circle r="3" fill="#b3261e" />
                            <path d="M 0 0 L 12 0 M 8 -3 L 12 0 L 8 3" fill="none" stroke="#b3261e" />
                        </g>
                    )}

                    {/* Đường và mũi tên xem trước trực tiếp khi đang kéo chuột (Live Drag Preview) */}
                    {dragPreview && (
                        <g>
                            <circle cx={dragPreview.start.x} cy={dragPreview.start.y} r="3" fill="#ff5722" opacity="0.85" />
                            <line
                                x1={dragPreview.start.x}
                                y1={dragPreview.start.y}
                                x2={dragPreview.current.x}
                                y2={dragPreview.current.y}
                                stroke="#ff5722"
                                strokeWidth="1.2"
                                strokeDasharray="3,2"
                            />
                            <g
                                transform={`translate(${dragPreview.current.x} ${dragPreview.current.y}) rotate(${
                                    (Math.atan2(dragPreview.current.y - dragPreview.start.y, dragPreview.current.x - dragPreview.start.x) * 180) / Math.PI
                                })`}
                            >
                                <polygon points="0,0 -7,-3.5 -5,0 -7,3.5" fill="#ff5722" />
                            </g>
                        </g>
                    )}
                </svg>
            </Box>
        </Box>
    );
}
