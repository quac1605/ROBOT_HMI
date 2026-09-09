export function worldToGrid({ x, y }, map) {
    const dx = x - map.origin.x;
    const dy = y - map.origin.y;
    const c = Math.cos(map.origin.yaw);
    const s = Math.sin(map.origin.yaw);
    const u = (c * dx + s * dy) / map.resolution;
    const v = (-s * dx + c * dy) / map.resolution;
    return { u, v };
}

export function gridToWorld({ u, v }, map) {
    const c = Math.cos(map.origin.yaw);
    const s = Math.sin(map.origin.yaw);
    return {
        x: map.origin.x + map.resolution * (c * u - s * v),
        y: map.origin.y + map.resolution * (s * u + c * v),
    };
}

export function worldToSvg(point, map) {
    const { u, v } = worldToGrid(point, map);
    return { x: u, y: map.height - v };
}

export function svgToWorld(point, map) {
    return gridToWorld({ u: point.x, v: map.height - point.y }, map);
}

const EPSILON = 1e-9;

export function isInsideMap(point, map) {
    const { u, v } = worldToGrid(point, map);
    return u >= -EPSILON && v >= -EPSILON && u < map.width && v < map.height;
}