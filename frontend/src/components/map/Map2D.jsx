import { useLayoutEffect, useRef, useState } from 'react';
import { Box, Button, ButtonGroup } from '@mui/material';
import { isInsideMap, svgToWorld, worldToSvg, worldYawToSvgDegrees } from '../../utils/mapCoordinates.js';
import { mapContextKey, geometryKey } from '../../utils/mapRenderModel.js';

const PADDING = 8;
const POSE_PRESENTATION = Object.freeze({
  reliable: { body: '#4caf50', stroke: '#1b5e20', opacity: 1, label: null },
  odom: { body: '#00acc1', stroke: '#006064', opacity: 1, label: 'Vị trí từ /odom' },
  stale: { body: '#ffb300', stroke: '#e65100', opacity: 0.6, label: 'Vị trí robot đã cũ' },
  lost: { body: '#ef5350', stroke: '#b71c1c', opacity: 0.5, label: 'Robot mất định vị' },
  offline: { body: '#9e9e9e', stroke: '#424242', opacity: 0.4, label: 'Robot ngoại tuyến' },
});

function getInitialView(geo) {
  if (!geo) return { x: 0, y: 0, w: 100, h: 100 };
  return {
    x: -PADDING,
    y: -PADDING,
    w: geo.width + PADDING * 2,
    h: geo.height + PADDING * 2,
  };
}

export default function Map2D({
  model, // Nhận renderModel nguyên tử: { context, gridRevision, geometry, objectUrl, token, onLoad, onError }
  pose,
  initialPose = null,
  poseQuality = 'reliable',
  goal,
  path = null,
  routeDraft = null,
  previewPath = null,
  plannedPath = null,
  trajectory = null,
  showGrid = true,
  showRobot = true,
  showPath = true,
  tool = 'goal',
  viewportMaxHeight = '56vh',
  onGoalChange,
  onWaypointAdd,
  onInitialPoseSelect,
}) {
  const svgRef = useRef(null);
  const drag = useRef(null);

  const geometry = model?.geometry;
  const geometryWidth = geometry?.width;
  const geometryHeight = geometry?.height;

  const [view, setView] = useState(() => getInitialView(geometry));
  const [dragPreview, setDragPreview] = useState(null);

  // viewportKey chỉ bao gồm context và geometry, KHÔNG chứa gridRevision hay objectUrl
  const viewportKey = model
    ? [mapContextKey(model.context), geometryKey(geometry)].join('|')
    : '';

  useLayoutEffect(() => {
    if (!geometryWidth || !geometryHeight) return;
    setView(getInitialView({ width: geometryWidth, height: geometryHeight }));
    setDragPreview(null);

    if (drag.current?.pointerId != null && svgRef.current) {
      try {
        if (svgRef.current.hasPointerCapture(drag.current.pointerId)) {
          svgRef.current.releasePointerCapture(drag.current.pointerId);
        }
      } catch {
        // ignore
      }
    }
    drag.current = null;
  }, [viewportKey, geometryWidth, geometryHeight]);

  if (!model || !geometry || !model.objectUrl) {
    return null;
  }

  function toSvg(clientX, clientY) {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!matrix) return null;
    return new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  }

  function pointerDown(event) {
    if (event.button !== 0) return;
    if (drag.current) return;

    const point = toSvg(event.clientX, event.clientY);
    if (!point) return;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    drag.current = {
      pointerId: event.pointerId,
      point,
      tool,
      view: { ...view },
      clientX: event.clientX,
      clientY: event.clientY,
      viewportKey,
    };
  }

  function pointerMove(event) {
    const start = drag.current;
    if (!start || event.pointerId !== start.pointerId || start.viewportKey !== viewportKey || start.tool !== tool) {
      if (start && start.viewportKey !== viewportKey) drag.current = null;
      return;
    }

    if (start.tool === 'pan') {
      const matrix = svgRef.current?.getScreenCTM();
      if (!matrix) return;
      const inverse = matrix.inverse();
      const a = new DOMPoint(start.clientX, start.clientY).matrixTransform(inverse);
      const b = new DOMPoint(event.clientX, event.clientY).matrixTransform(inverse);
      setView({ ...start.view, x: start.view.x - (b.x - a.x), y: start.view.y - (b.y - a.y) });
    } else if (start.tool === 'goal' || start.tool === 'initial') {
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
    if (!start || event.pointerId !== start.pointerId || start.viewportKey !== viewportKey || start.tool !== tool) {
      drag.current = null;
      setDragPreview(null);
      return;
    }
    drag.current = null;
    setDragPreview(null);

    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // ignore
    }

    // A. Nếu là chế độ Waypoint: Click chọn thêm 1 điểm vào tuyến
    if (start.tool === 'waypoint') {
      const position = svgToWorld(start.point, geometry);
      if (!isInsideMap(position, geometry)) return;
      onWaypointAdd?.({
        frameId: geometry.frameId || 'map',
        x: Number(position.x.toFixed(3)),
        y: Number(position.y.toFixed(3)),
        yaw: 0,
      });
      return;
    }
    // B. Nếu là chế độ Goal: Chọn 1 đích và kéo để chỉnh góc quay Yaw
    if (start.tool === 'goal' || start.tool === 'initial') {
      const end = toSvg(event.clientX, event.clientY);
      if (!end) return;
      const position = svgToWorld(start.point, geometry);
      if (!isInsideMap(position, geometry)) return;
      const target = svgToWorld(end, geometry);
      const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) >= 5;
      const yaw = moved ? Math.atan2(target.y - position.y, target.x - position.x) :
        (start.tool === 'goal' ? (goal?.yaw ?? 0) : 0);
      const selectedPose = { frameId: geometry.frameId || 'map', ...position, yaw };
      if (start.tool === 'initial') onInitialPoseSelect?.(selectedPose);
      else onGoalChange?.(selectedPose);
    }
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
      const w = Math.min(geometry.width * 4, Math.max(10, old.w * factor));
      const h = (w * geometry.height) / geometry.width;
      return { x: old.x + (old.w - w) / 2, y: old.y + (old.h - h) / 2, w, h };
    });
  }

  function handleFit() {
    if (drag.current?.pointerId != null && svgRef.current) {
      try {
        if (svgRef.current.hasPointerCapture(drag.current.pointerId)) {
          svgRef.current.releasePointerCapture(drag.current.pointerId);
        }
      } catch {
        // ignore
      }
    }
    drag.current = null;
    setDragPreview(null);
    setView(getInitialView(geometry));
  }

  const knownPoseQuality = ['reliable', 'odom', 'stale', 'lost', 'offline'].includes(poseQuality)
    ? poseQuality
    : 'lost';
  const robotPoint = pose && pose.frameId === geometry.frameId
    ? worldToSvg(pose, geometry)
    : null;
  const initialPoint = initialPose && isInsideMap(initialPose, geometry)
    ? worldToSvg(initialPose, geometry) : null;
  const goalPoint = goal && (!goal.frameId || goal.frameId === geometry.frameId)
    ? worldToSvg(goal, geometry)
    : null;
  const pathPoints = showPath && Array.isArray(path)
    ? path
      .filter((point) => !point.frameId || point.frameId === geometry.frameId)
      .map((point) => worldToSvg(point, geometry))
      .map((point) => `${point.x},${point.y}`)
      .join(' ')
    : '';

  // Tỉ lệ chuyển đổi từ mét sang số ô SVG: 1m = (1 / resolution) cells
  const metersToCells = 1 / geometry.resolution;
  const robotRotation = pose
    ? worldYawToSvgDegrees(pose.yaw, geometry.origin?.yaw ?? 0)
    : 0;
  const robotPresentation = POSE_PRESENTATION[knownPoseQuality];
  const robotIsDegraded = !['reliable', 'odom'].includes(knownPoseQuality);
  // Giữ vòng định vị và mũi hướng nhìn thấy được khi /map rất lớn (SVG thu nhỏ).
  const locatorRadius = view.w * 0.015;
  const locatorTip = view.w * 0.04;

  return (
    <Box sx={{ userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'none' }} onDragStart={(e) => e.preventDefault()}>
      <Box sx={{ mb: 1, display: 'flex', gap: 1 }}>
        <ButtonGroup size="small" variant="outlined" aria-label="Điều khiển phóng to thu nhỏ bản đồ">
          <Button onClick={() => zoom(0.8)} aria-label="Phóng to bản đồ">Phóng to (+)</Button>
          <Button onClick={() => zoom(1.25)} aria-label="Thu nhỏ bản đồ">Thu nhỏ (-)</Button>
          <Button onClick={handleFit} aria-label="Khung nhìn vừa bản đồ">Vừa bản đồ</Button>
        </ButtonGroup>
      </Box>

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
            maxWidth: `calc(${viewportMaxHeight} * ${geometry.width} / ${geometry.height})`,
            height: 'auto',
            maxHeight: viewportMaxHeight,
            aspectRatio: `${geometry.width} / ${geometry.height}`,
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
          data-testid="map2d-svg"
          aria-label="Bản đồ 2D Occupancy Grid"
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
          {/* 1. LỚP NỀN RASTER BẢN ĐỒ PHẢI ĐẶT Ở ĐẦU TIÊN (NẰM DƯỚI CÙNG) */}
          {/* Lớp hiển thị ảnh Occupancy Grid nguyên tử */}
          <image
            data-testid="map2d-raster"
            href={model.objectUrl}
            x={0}
            y={0}
            width={geometry.width}
            height={geometry.height}
            visibility={showGrid ? 'visible' : 'hidden'}
            aria-hidden={!showGrid}
            style={{ imageRendering: 'pixelated', pointerEvents: 'none' }}
            onLoad={model.onLoad}
            onError={model.onError}
          />
          {/* 2. CÁC LỚP TUYẾN ĐƯỜNG ĐẶT TIẾP THEO ĐỂ NẰM ĐÈ LÊN TRÊN BẢN ĐỒ */}
          {/* Trajectory (Vệt bánh xe thực tế) - Chấm tròn màu cyan */}
          {trajectory && trajectory.length > 0 && (
            <g id="trajectory-layer">
              {trajectory.map((p, idx) => {
                const svgPt = worldToSvg(p, geometry);
                return <circle key={`traj-${idx}`} cx={svgPt.x} cy={svgPt.y} r="1.5" fill="#00bcd4" opacity="0.7" />;
              })}
            </g>
          )}
          {/* Planned Path (Đường do robot lập) - Nét liền màu xanh lá */}
          {plannedPath && plannedPath.length > 1 && (
            <polyline
              id="planned-path"
              fill="none"
              stroke="#2e7d32"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={plannedPath.map((p) => {
                const pt = worldToSvg(p, geometry);
                return `${pt.x},${pt.y}`;
              }).join(' ')}
            />
          )}
          {/* Preview Path (Đường xem trước) - Nét đứt màu xanh dương */}
          {previewPath && previewPath.length > 1 && (
            <polyline
              id="preview-path"
              fill="none"
              stroke="#0288d1"
              strokeWidth="2.5"
              strokeDasharray="6 3"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={previewPath.map((p) => {
                const pt = worldToSvg(p, geometry);
                return `${pt.x},${pt.y}`;
              }).join(' ')}
            />
          )}
          {/* Route Draft (Ý định đang soạn thảo) - Nét đứt màu cam & đánh số điểm */}
          {routeDraft?.poses && routeDraft.poses.length > 0 && (
            <g id="route-draft-layer">
              {routeDraft.poses.length > 1 && (
                <polyline
                  fill="none"
                  stroke="#ff9800"
                  strokeWidth="2"
                  strokeDasharray="4 4"
                  points={routeDraft.poses.map((p) => {
                    const pt = worldToSvg(p, geometry);
                    return `${pt.x},${pt.y}`;
                  }).join(' ')}
                />
              )}
              {routeDraft.poses.map((p, idx) => {
                const pt = worldToSvg(p, geometry);
                return (
                  <g key={`draft-wp-${idx}`}>
                    <circle cx={pt.x} cy={pt.y} r="5" fill="#ff9800" stroke="#fff" strokeWidth="1.5" />
                    <text
                      x={pt.x}
                      y={pt.y - 8}
                      textAnchor="middle"
                      fill="#e65100"
                      fontSize="10"
                      fontWeight="bold"
                    >
                      {idx + 1}
                    </text>
                  </g>
                );
              })}
            </g>
          )}
          {/* 3. LỚP VẼ ROBOT VÀ GOAL (NẰM TRÊN CÙNG) */}
          {/* Vị trí Robot Footprint VISTAR 1 (809mm x 500mm theo mét) */}
          {showRobot && robotPoint && (
            <g
              data-testid="map2d-robot"
              transform={`translate(${robotPoint.x} ${robotPoint.y})`}
              data-pose-quality={knownPoseQuality}
              aria-label={robotPresentation.label || 'Vị trí robot tin cậy'}
              opacity={robotPresentation.opacity}
            >
              <g transform={`rotate(${robotRotation})`} aria-hidden="true">
                <circle r={locatorRadius} fill="none" stroke={robotPresentation.stroke}
                  strokeWidth={2} vectorEffect="non-scaling-stroke" />
                <path d={`M ${locatorRadius} 0 L ${locatorTip} 0`}
                  fill="none" stroke={robotPresentation.stroke} strokeWidth={3}
                  vectorEffect="non-scaling-stroke" />
                <polygon points={`${locatorTip},0 ${locatorTip - locatorRadius * 0.45},${-locatorRadius * 0.35} ${locatorTip - locatorRadius * 0.45},${locatorRadius * 0.35}`}
                  fill="#e65100" stroke="#ffffff" strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke" />
              </g>
              <g transform={`rotate(${robotRotation}) scale(${metersToCells})`}>
                {/* 2 Bánh xe chủ động hai bên (~150mm x 50mm -> 0.15m x 0.05m) */}
                <rect x={-0.075} y={-0.285} width={0.15} height={0.05} rx={0.015} fill={robotPresentation.stroke} />
                <rect x={-0.075} y={0.235} width={0.15} height={0.05} rx={0.015} fill={robotPresentation.stroke} />
                {/* Thân xe chính: 0.809m x 0.5m */}
                <rect
                  x={-0.809 / 2}
                  y={-0.5 / 2}
                  width={0.809}
                  height={0.5}
                  rx={0.05}
                  fill={robotPresentation.body}
                  stroke={robotPresentation.stroke}
                  strokeWidth={0.04}
                  strokeDasharray={robotIsDegraded ? '0.08,0.05' : undefined}
                  opacity={0.85}
                />
                {/* Mũi tên hướng đầu xe */}
                <polygon points="0.3,-0.12 0.45,0 0.3,0.12" fill="#e65100" />
                <circle cx={0} cy={0} r={0.07} fill="#b71c1c" />
              </g>
              {robotPresentation.label && (
                <text
                  x={5}
                  y={-5}
                  fontSize={3.5}
                  fontWeight="bold"
                  fill={robotPresentation.stroke}
                  paintOrder="stroke"
                  stroke="#ffffff"
                  strokeWidth={0.8}
                >
                  {robotPresentation.label}
                </text>
              )}
            </g>
          )}

          {/* Chỉ vẽ path thật do caller cung cấp; không tạo đường minh họa. */}
          {pathPoints && (
            <polyline
              data-testid="map2d-path"
              points={pathPoints}
              fill="none"
              stroke="#1976d2"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              pointerEvents="none"
            />
          )}

          {/* Marker Mục tiêu Điều hướng */}
          {initialPoint && (
            <g data-testid="map2d-initial-pose" transform={`translate(${initialPoint.x} ${initialPoint.y}) rotate(${worldYawToSvgDegrees(initialPose.theta, geometry.origin?.yaw ?? 0)})`}
              pointerEvents="none">
              <circle r={4} fill="#7b1fa2" stroke="#fff" strokeWidth={1} />
              <path d="M 0 0 L 13 0 M 13 0 L 8 -3 M 13 0 L 8 3" fill="none" stroke="#7b1fa2"
                strokeWidth={2} strokeLinecap="round" />
            </g>
          )}
          {goalPoint && (
            <g data-testid="map2d-goal" transform={`translate(${goalPoint.x} ${goalPoint.y})`}>
              <circle cx={0} cy={0} r={3.5} fill="#d32f2f" stroke="#ffffff" strokeWidth={1} />
              <line
                x1={0}
                y1={0}
                x2={10 * Math.cos(goal.yaw - (geometry.origin?.yaw ?? 0))}
                y2={-10 * Math.sin(goal.yaw - (geometry.origin?.yaw ?? 0))}
                stroke="#d32f2f"
                strokeWidth={1.5}
              />
            </g>
          )}

          {/* Đường Preview Kéo Chuột */}
          {dragPreview && (
            <line
              x1={dragPreview.start.x}
              y1={dragPreview.start.y}
              x2={dragPreview.current.x}
              y2={dragPreview.current.y}
              stroke="#e65100"
              strokeWidth={1.5}
              strokeDasharray="2,2"
            />
          )}
        </svg>
      </Box>
    </Box>
  );
}
