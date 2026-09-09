import { createMockTelemetry } from './mockTelemetry.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMockRobotClient() {
  let user = null;
  const telemetry = createMockTelemetry(); // Khởi tạo 1 lần duy nhất

  return {
    kind: 'mock',
    async login({ username, password }) {
      await delay(350); // Giả lập độ trễ mạng
      if (username !== 'admin' || password !== 'demo-only') {
        throw new Error('Sai tài khoản hoặc mật khẩu demo. Hãy dùng admin / demo-only.');
      }
      user = { id: 'demo-admin', username: 'admin' };
      return { user: { ...user } };
    },
    async getSession() {
      return { user: user ? { ...user } : null };
    },
    async logout() {
      await delay(100);
      user = null;
    },

     // Bổ sung các phương thức telemetry:
    async getRobotState() {
      return telemetry.getSnapshot();
    },
    subscribeRobotState(listener) {
      return telemetry.subscribe(listener);
    },
    setDemoScenario(name) {
      telemetry.setScenario(name);
    },
    getDemoScenario() {
      return telemetry.getScenario();
    },
  };
}
