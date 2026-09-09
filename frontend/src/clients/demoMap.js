// Bản đồ mẫu chuẩn 10m x 8m
export const demoMap = {
  id: 'map-demo',
  name: 'Bản đồ mẫu VKIST (10x8m)',
  revision: 'rev-1',
  frameId: 'map',
  width: 200,
  height: 160,
  resolution: 0.05,
  origin: { x: 0, y: 0, yaw: 0 },
};

// Bản đồ xoay trục để kiểm tra tính năng đổi map và reset mục tiêu
export const demoMapRotated = {
  id: 'map-rotated',
  name: 'Bản đồ xoay 90° (Origin yaw=π/2)',
  revision: 'rev-1',
  frameId: 'map',
  width: 200,
  height: 160,
  resolution: 0.05,
  origin: { x: 10, y: -3, yaw: Math.PI / 2 },
};
