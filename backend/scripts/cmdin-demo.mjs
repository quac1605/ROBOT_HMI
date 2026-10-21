/**
 * backend/scripts/cmdin-demo.mjs
 *
 * PHÁT THỬ MỘT CHUỖI GÓI /cmd_in LÊN rosbridge, KHÔNG CẦN BACKEND, DATABASE HAY FRONTEND.
 *
 * Cách dùng: node scripts/cmdin-demo.mjs [ws://127.0.0.1:9090]
 * Script gọi thẳng cmdInService nên không đi qua kiểm tra quyền lái;
 * chỉ dùng để kiểm tra nội dung gói và đường truyền tới ROS.
 */
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { MANUAL_DRIVE_SPEED } from '@robot-hmi/control-domain/controlPolicy';
import { createCmdInService } from '../src/services/cmdInService.js';
import { createRosbridgeCmdInPublisher } from '../src/ros/rosbridgeCmdInPublisher.js';
import { createRosbridgeClient } from '../src/ros/rosbridgeClient.js';

const url = process.argv[2] ?? 'ws://127.0.0.1:9090';
const v = MANUAL_DRIVE_SPEED.linearX;
const w = MANUAL_DRIVE_SPEED.angularZ;

const client = createRosbridgeClient({ url, reconnectMs: 1000 });
const publisher = createRosbridgeCmdInPublisher({ client });
const service = createCmdInService({ publishers: [publisher], logger: console });
client.start();

const steps = [
    ['joystick trái', () => service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0, angularZ: w } })],
    ['joystick phải', () => service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0, angularZ: -w } })],
    ['joystick tiến', () => service.onMotionCommand({ origin: 'teleop', velocity: { linearX: v, angularZ: 0 } })],
    ['joystick lùi', () => service.onMotionCommand({ origin: 'teleop', velocity: { linearX: -v, angularZ: 0 } })],
    ['trả quyền lái', () => service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0, angularZ: 0 } })],
    ['yêu cầu dừng', () => service.emergencyStop()],
    ['lệnh 0 sau dừng', () => service.onMotionCommand({ origin: 'teleop', velocity: { linearX: 0, angularZ: 0 } })],
    ['bắt đầu đi đến đích', () => service.onMotionCommand({ origin: 'mission', velocity: { linearX: 0, angularZ: 0 } })],
    ['kết thúc đi đến đích', () => service.onMotionCommand({ origin: 'stop', velocity: { linearX: 0, angularZ: 0 } })],
];

// Chờ kết nối tối đa 5 giây trước khi phát.
for (let i = 0; i < 50 && !client.isConnected(); i++) await delay(100);
if (!client.isConnected()) {
    console.error(`Không nối được rosbridge tại ${url}`);
    service.dispose();
    client.dispose();
    process.exit(1);
}

for (const [label, run] of steps) {
    run();
    console.log(`${label}: mode=${service.getMode()}`);
    await delay(1000);
}
service.dispose();
client.dispose();
