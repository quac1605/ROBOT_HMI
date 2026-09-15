export function occupancyToRgba({ width, height, cells }) {
    const rgba = new Uint8ClampedArray(width * height * 4);

    for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < width; col += 1) {
            const rosIndex = col + row * width;
            const val = cells[rosIndex];

            // Chặn nghiêm ngặt: không clamp giá trị sai
            if (val < -1 || val > 100 || !Number.isInteger(val)) {
                throw new Error(`Giá trị ô không hợp lệ tại ô (${col}, ${row}): ${val}`);
            }

            // Ánh xạ Row-Order: Hàng ROS 0 ở dưới cùng -> Hàng Canvas dưới cùng (height - 1 - row)
            const canvasIndex = (col + (height - 1 - row) * width) * 4;

            if (val === -1) {
                // Unknown: Xanh xám #b0bec5
                rgba[canvasIndex] = 176;
                rgba[canvasIndex + 1] = 190;
                rgba[canvasIndex + 2] = 197;
                rgba[canvasIndex + 3] = 255;
            } else {
                // Free (0) -> 255 (Trắng), Occupied (100) -> 0 (Đen)
                const gray = Math.round(255 * (1 - val / 100));
                rgba[canvasIndex] = gray;
                rgba[canvasIndex + 1] = gray;
                rgba[canvasIndex + 2] = gray;
                rgba[canvasIndex + 3] = 255;
            }
        }
    }

    return rgba;
}
