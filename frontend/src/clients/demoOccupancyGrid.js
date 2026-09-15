export function createDemoGridSnapshot() {
    return {
        source: 'mock',
        mode: 'snapshot',
        encoding: 'occupancy-0-100-v1',
        context: {
            kind: 'saved',
            mapId: 'map-fixture-4x3',
            mapRevision: 'rev-1',
        },
        gridRevision: 1,
        grid: {
            header: { frame_id: 'map', stamp: { sec: 100, nanosec: 0 } },
            info: {
                map_load_time: { sec: 100, nanosec: 0 },
                resolution: 0.05,
                width: 4,
                height: 3,
                origin: {
                    position: { x: 0, y: 0, z: 0 },
                    orientation: { x: 0, y: 0, z: 0, w: 1 },
                },
            },
            data: [
                0, 100, -1, 50, // hàng ROS dưới cùng (row = 0)
                100, 0, 50, -1, // hàng ROS ở giữa (row = 1)
                -1, 50, 0, 100, // hàng ROS trên cùng (row = 2)
            ],
        },
    };
}
/**
 * Hàm sinh ma trận phòng 200x160 ô (10m x 8m)
 * Tương ứng với demoMap của Chặng 5: Tường biên và hộp vật cản giữa phòng (x=70..105, y=40..90)
 */
function createRoomCells(width, height) {
    const cells = new Array(width * height).fill(-1); // Mặc định vùng ngoài là Unknown
    for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < width; col += 1) {
            // Vùng đã khám phá bên trong phòng
            if (col >= 10 && col < width - 10 && row >= 10 && row < height - 10) {
                cells[col + row * width] = 0; // Free
            }
            // Tường bao quanh phòng
            if (
                ((col === 10 || col === width - 11) && row >= 10 && row < height - 10) ||
                ((row === 10 || row === height - 11) && col >= 10 && col < width - 10)
            ) {
                cells[col + row * width] = 100; // Occupied
            }
            // Hộp vật cản đặc trưng ở giữa phòng (tương tự rect demo Chặng 5)
            if (col >= 70 && col < 105 && row >= 40 && row < 90) {
                cells[col + row * width] = 100; // Occupied
            }
        }
    }
    return cells;
}
/**
 * Factory map 200x160 chuẩn: Origin (x=0, y=0, yaw=0)
 */
export function createDemoGrid200x160() {
    const width = 200;
    const height = 160;
    return {
        source: 'mock',
        mode: 'snapshot',
        encoding: 'occupancy-0-100-v1',
        context: {
            kind: 'saved',
            mapId: 'map-demo',
            mapRevision: 'rev-1',
        },
        gridRevision: 1,
        grid: {
            header: { frame_id: 'map', stamp: { sec: 1000, nanosec: 0 } },
            info: {
                map_load_time: { sec: 1000, nanosec: 0 },
                resolution: 0.05,
                width,
                height,
                origin: {
                    position: { x: 0, y: 0, z: 0 },
                    orientation: { x: 0, y: 0, z: 0, w: 1 },
                },
            },
            data: createRoomCells(width, height),
        },
    };
}
/**
 * Factory map 200x160 xoay: Origin (x=10, y=-3, yaw=pi/2)
 * Quaternion origin yaw theta là: x=0, y=0, z=sin(theta/2), w=cos(theta/2)
 */
export function createDemoGrid200x160Rotated() {
    const width = 200;
    const height = 160;
    const sinHalfPi = Math.sin(Math.PI / 4);
    const cosHalfPi = Math.cos(Math.PI / 4);
    return {
        source: 'mock',
        mode: 'snapshot',
        encoding: 'occupancy-0-100-v1',
        context: {
            kind: 'saved',
            mapId: 'map-rotated',
            mapRevision: 'rev-1',
        },
        gridRevision: 1,
        grid: {
            header: { frame_id: 'map', stamp: { sec: 1000, nanosec: 0 } },
            info: {
                map_load_time: { sec: 1000, nanosec: 0 },
                resolution: 0.05,
                width,
                height,
                origin: {
                    position: { x: 10, y: -3, z: 0 },
                    orientation: { x: 0, y: 0, z: sinHalfPi, w: cosHalfPi },
                },
            },
            data: createRoomCells(width, height),
        },
    };
}
