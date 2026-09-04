import { createMockRobotClient } from './mockRobotClient.js';

const mode = import.meta.env.VITE_ROBOT_CLIENT;
if (mode !== 'mock') {
  throw new Error('Chặng này cần VITE_ROBOT_CLIENT=mock trong file .env.local');
}

// Khởi tạo Singleton client dùng chung xuyên suốt app
export const robotClient = createMockRobotClient();
