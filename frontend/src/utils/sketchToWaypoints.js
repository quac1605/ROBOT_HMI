import simplify from 'simplify-js';

/**
 * Biến đổi nét vẽ thô thành danh sách Waypoints tối ưu
 * @param {Array<{x: number, y: number}>} rawWorldPoints - Danh sách điểm tọa độ mét
 * @param {number} toleranceM - Dung sai rút gọn (mặc định 0.1 mét)
 * @returns {Array<{frameId: 'map', x: number, y: number, yaw: number}>}
 */
export function sketchToWaypoints(rawWorldPoints, toleranceM = 0.1) {
    if (!rawWorldPoints || rawWorldPoints.length === 0) return [];
    if (rawWorldPoints.length === 1) {
        return [{ frameId: 'map', x: rawWorldPoints[0].x, y: rawWorldPoints[0].y, yaw: 0 }];
    }

    // 1. Lọc bớt các điểm quá sát nhau (< 0.1 m) do mousemove phát sinh dày đặc
    const filtered = [rawWorldPoints[0]];
    for (let i = 1; i < rawWorldPoints.length; i += 1) {
        const prev = filtered[filtered.length - 1];
        const curr = rawWorldPoints[i];
        const dist = Math.hypot(curr.x - prev.x, curr.y - prev.y);
        if (dist >= 0.1) {
            filtered.push(curr);
        }
    }

    // 2. Rút gọn đỉnh theo thuật toán RDP
    const simplified = simplify(filtered, toleranceM, true);

    // 3. Tính toán góc quay Yaw giữa các đoạn nối tiếp
    return simplified.map((pt, idx) => {
        let yaw = 0;
        if (idx < simplified.length - 1) {
            const next = simplified[idx + 1];
            yaw = Math.atan2(next.y - pt.y, next.x - pt.x);
        } else if (idx > 0) {
            const prev = simplified[idx - 1];
            yaw = Math.atan2(pt.y - prev.y, pt.x - prev.x);
        }

        return {
            frameId: 'map',
            x: Number(pt.x.toFixed(3)),
            y: Number(pt.y.toFixed(3)),
            yaw: Number(yaw.toFixed(3)),
        };
    });
}
