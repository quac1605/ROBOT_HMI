/**
 * backend/src/ros/rosbridgeCmdInPublisher.js
 *
 * PHÁT GÓI /cmd_in (ROS 2: std_msgs/msg/String) QUA KẾT NỐI rosbridge DÙNG CHUNG.
 *
 * Chỉ giữ gói mới nhất: gói phát lúc mất kết nối bị bỏ, không xếp hàng.
 * Khi nối lại, phát lại gói mới nhất nhưng với vận tốc 0, để robot không nhận một lệnh chạy đã cũ.
 * Phải tạo trước client.start() vì topic được advertise lúc mở kết nối.
 */
import { CMD_IN_TOPIC, CMD_IN_ROS_TYPE } from '@robot-hmi/contracts/cmdIn';

const toRosString = message => ({ data: JSON.stringify(message) });

export function createRosbridgeCmdInPublisher({ client }) {
    let latest = null;
    let disposed = false;

    client.advertise(CMD_IN_TOPIC, {
        type: CMD_IN_ROS_TYPE,
        onReconnect: () => (disposed || !latest ? null
            : toRosString({ ...latest, velocity: { linear: 0, angular: 0 } })),
    });

    return {
        publish(message) {
            if (disposed) return;
            latest = message;
            client.publish(CMD_IN_TOPIC, toRosString(message));
        },
        // Client thuộc runtime (dùng chung với rosStatusService), publisher không đóng nó.
        dispose() { disposed = true; },
    };
}
