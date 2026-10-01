import { parseMapGridSnapshot } from '../schemas/mapGrid.js';

export function quaternionToEuler({ x, y, z, w }) {
    const norm = Math.hypot(x, y, z, w);
    if (Math.abs(norm - 1.0) > 1e-3) {
        const err = new Error(`Quaternion không chuẩn hóa (norm=${norm})`);
        err.code = 'INVALID_MAP_DATA';
        throw err;
    }

    const qx = x / norm;
    const qy = y / norm;
    const qz = z / norm;
    const qw = w / norm;

    const roll = Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy));
    const sinp = Math.max(-1, Math.min(1, 2 * (qw * qy - qz * qx)));
    const pitch = Math.asin(sinp);
    const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));

    return { roll, pitch, yaw };
}

export function normalizeOccupancyGrid(snapshot) {
    // 1. Preflight toàn bộ cell và Zod-validate metadata strict tại source chuẩn.
    const { grid, context, gridRevision } = parseMapGridSnapshot(snapshot);
    const { roll, pitch, yaw } = quaternionToEuler(grid.info.origin.orientation);

    // 2. Từ chối nếu có độ nghiêng 3D
    if (Math.abs(roll) > 1e-4 || Math.abs(pitch) > 1e-4) {
        const err = new Error('Bản đồ có độ nghiêng 3D (roll/pitch) không được hỗ trợ trong 2D viewer');
        err.code = 'UNSUPPORTED_MAP_ORIENTATION';
        throw err;
    }

    const geometry = {
        frameId: grid.header.frame_id,
        width: grid.info.width,
        height: grid.info.height,
        resolution: grid.info.resolution,
        origin: {
            x: grid.info.origin.position.x,
            y: grid.info.origin.position.y,
            yaw,
        },
    };

    // 3. Chỉ ép sang Int8Array sau khi toàn bộ dữ liệu đã hợp lệ
    const cells = new Int8Array(grid.data);

    return {
        context,
        gridRevision,
        geometry,
        cells,
    };
}
