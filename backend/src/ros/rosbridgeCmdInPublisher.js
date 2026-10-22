/**
 * backend/src/ros/rosbridgeCmdInPublisher.js
 *
 * PHÁT GÓI /cmd_in (ROS 2: robot_hmi_msgs/msg/CmdIn) QUA KẾT NỐI rosbridge DÙNG CHUNG.
 *
 * rosbridge phải chạy trong terminal đã source ros2_ws/install/setup.bash, nếu không
 * nó không biết kiểu robot_hmi_msgs/msg/CmdIn và từ chối advertise.
 *
 * Chỉ giữ gói mới nhất: gói phát lúc mất kết nối bị bỏ, không xếp hàng.
 * Khi nối lại, phát lại gói mới nhất nhưng với joystick 0, để robot không nhận một lệnh chạy đã cũ
 * (target và original_position giữ nguyên).
 * Phải tạo trước client.start() vì topic được advertise lúc mở kết nối.
 */
import { CMD_IN_TOPIC, CMD_IN_ROS_TYPE, toRosCmdIn } from '@robot-hmi/contracts/cmdIn';

export function createRosbridgeCmdInPublisher({ client }) {
    let latest = null;
    let disposed = false;

    client.advertise(CMD_IN_TOPIC, {
        type: CMD_IN_ROS_TYPE,
        onReconnect: () => (disposed || !latest ? null
            : toRosCmdIn({ ...latest, joystick: { linear: 0, angular: 0 } })),
    });

    return {
        publish(message) {
            if (disposed) return;
            latest = message;
            client.publish(CMD_IN_TOPIC, toRosCmdIn(message));
        },
        // Client thuộc runtime (dùng chung với rosStatusService), publisher không đóng nó.
        dispose() { disposed = true; },
    };
}
