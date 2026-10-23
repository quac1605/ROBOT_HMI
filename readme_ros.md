# ROBOT_HMI ↔ ROS 2: đầu vào, đầu ra và giao tiếp

Tài liệu này mô tả dữ liệu trao đổi giữa HMI (backend Node.js và web frontend) và robot chạy **ROS 2 Jazzy**: topic nào HMI nhận, topic nào HMI gửi, kiểu dữ liệu từng topic, sơ đồ hệ thống và phương thức truyền tin trên từng chặng. NavigationPage hiển thị tọa độ/hướng từ `/odom` và đặt marker lên `/map` sau khi đổi hệ tọa độ bằng TF khi cần.

Người đọc: nhóm làm phần robot ROS 2, và người phát triển backend/frontend của dự án. Phụ lục ở cuối (mục 10–13) dành riêng cho người viết tiếp code.

File cấu hình liên quan:

- [`backend/config/ros_status.yaml`](backend/config/ros_status.yaml): topic, nhịp và thời gian quá hạn của `/odom`, `/cmd_out`.
- [`packages/contracts/src/cmdIn.js`](packages/contracts/src/cmdIn.js): tên topic, kiểu và schema gói `/cmd_in`.
- [`tools/ros-map/README.md`](tools/ros-map/README.md): luồng bản đồ `/map`.
- [`tools/ros-camera/README.md`](tools/ros-camera/README.md): cách dựng đường camera.

---

## 1. Đầu vào và đầu ra

### 1.1 Đầu vào (robot → HMI)

| Topic | Kiểu message ROS 2 | Thành phần HMI nhận | Dùng để |
| --- | --- | --- | --- |
| `/odom` | `nav_msgs/msg/Odometry` | backend `rosStatusService` qua rosbridge | Position `x`, `y` và Orientation quaternion, đổi thành góc quay `yaw` của robot |
| `/tf`, `/tf_static` | `tf2_msgs/msg/TFMessage` | backend qua rosbridge | Transform `map ← odom` để đặt pose `/odom` đúng vị trí trên `/map` |
| `/map` | `nav_msgs/msg/OccupancyGrid` | worker `rclpy` trong backend | Lưới bản đồ ROS trên NavigationPage và MappingPage |
| `/cmd_out` | `geometry_msgs/msg/Twist` | backend `rosStatusService` | Vận tốc dài và vận tốc góc hiện tại |
| `/image_front` | `sensor_msgs/msg/Image` | `tools/ros-camera/ros_camera_gateway.py` | Ảnh camera trước |
| `/image_rear` | `sensor_msgs/msg/Image` | `tools/ros-camera/ros_camera_gateway.py` | Ảnh camera sau |

### 1.2 Đầu ra (HMI → robot)

| Topic | Kiểu message ROS 2 | Thành phần HMI gửi | Dùng để |
| --- | --- | --- | --- |
| `/cmd_in` | `robot_hmi_msgs/msg/CmdIn` (message riêng, `ros2_ws/src/robot_hmi_msgs`) | backend `cmdInService` | Lệnh điều khiển: `target`, `mode`, `joystick`, `original_poss` |

HMI không publish topic nào khác. Gateway camera chỉ đọc ảnh, không publish.

### 1.3 Đầu ra lên giao diện (backend → trình duyệt)

| Kênh | Nội dung | Lấy từ |
| --- | --- | --- |
| WebSocket `/ws`, khung `robot.state` | `rosConnected`, `pose`, `mapPose`, `poseSourceUpdateAgeMs`, `velocity` | `/odom`, `/tf`, `/tf_static`, `/cmd_out` |
| HTTP `/api/ros-map` và ảnh PNG | Metadata, kích thước, độ phân giải, gốc tọa độ và ảnh lưới | `/map` |
| WebRTC (qua MediaMTX) | Video camera trước/sau | `/image_front`, `/image_rear` |

---

## 2. Sơ đồ

### 2.1 Sơ đồ tổng thể

```
ROS 2 Jazzy                       Backend HMI (cùng máy Ubuntu)          Browser LAN
/odom, /tf, /tf_static, /cmd_out
      └─► rosbridge_server :9090 ─► rosStatusService ── robot.state /ws ─► Navigation X/Y/yaw, marker
                                        │
                                        └─► sharedRobotState
/map ─────────────────────────────► worker rclpy ── /api/ros-map + PNG ───► nền bản đồ Navigation/Mapping
/image_front, /image_rear ────────► camera gateway ── RTP ── MediaMTX ───► WebRTC video
/cmd_in ◄── rosbridge_server ◄──── cmdInService ◄── controlAuthority ◄── các thao tác được chấp nhận
```

Backend làm việc với `/odom`, `/tf`, `/tf_static`, `/cmd_in` và `/cmd_out` qua **một kết nối rosbridge duy nhất**. Worker `rclpy` đọc `/map` trực tiếp qua ROS 2 DDS, còn hai topic camera đi đường riêng: node ROS 2 đọc ảnh rồi chuyển thành video WebRTC.

### 2.2 Luồng đầu vào: `/odom`, TF, `/map`, `/cmd_out` → giao diện

```
/odom, /tf, /tf_static, /cmd_out ──► rosbridge_server ──(op: publish)──► rosbridgeClient
                                                          │ message JSON
                                                          ▼
                           rosStatusMessages: odometryToPose(), twistToVelocity()
                           (message hỏng → null → bị bỏ, đếm droppedMessages)
                                                          │
                                                          ▼
                rosStatusService: giữ message mới nhất, tính mapPose từ TF,
                                  mỗi 100 ms ghi vào sharedRobotState
                                                          │
                                                          ▼
                robotStateService ──(WS /ws, type 'robot.state')──► ô trạng thái và marker trên Navigation

/map ──(rclpy)──► occupancy_map_worker.py ──► /api/ros-map + PNG ──► nền bản đồ Navigation/Mapping
```

### 2.3 Luồng đầu ra: thao tác trên giao diện → `/cmd_in`

```
Trình duyệt (frontend)
  ├─ nhận quyền lái ── POST /api/control/lease ──────────┐
  ├─ joystick ── WS /ws: teleop.velocity ────────────────┤
  ├─ vị trí ban đầu ── PUT /api/navigation/original-position
  ├─ đi đến đích ── POST /api/missions ──────────────────┤
  └─ dừng / nhả joystick ── POST /api/control/stop ──────┤
                                           ▼
Backend
  controlAuthority / missionService   kiểm tra quyền lái, token, giới hạn vận tốc
            │ ghi lệnh đã được chấp nhận
            ▼
  mockRosAdapter ── onMotionCommand ──► cmdInService ──► rosbridgeCmdInPublisher
  controlAuthority ── onStopRequested ──────▲   (chọn mode,        │ toRosCmdIn → robot_hmi_msgs/msg/CmdIn
  controlAuthority ── onControlClaimed ─────┤    dựng gói)         │ rosbridgeClient (dùng chung)
  sharedRobotState ── onRobotState ─────────┘                      ▼
                                                            rosbridge_server
                                                                   │ topic /cmd_in
                                                                   ▼
                                                                 Robot
```

1. Frontend không gửi thẳng xuống ROS. Mọi lệnh đi qua backend.
2. `controlAuthority` và `missionService` quyết định lệnh nào được chấp nhận, rồi ghi vào adapter.
3. Adapter báo từng lệnh đã ghi cho `cmdInService` kèm nguồn gốc: `teleop` (joystick), `mission` (bắt đầu đi đến đích, kèm danh sách đích), `cancel` (hủy nhiệm vụ) hoặc `stop` (dừng nội bộ).
4. Khi có yêu cầu dừng, `controlAuthority` báo `cmdInService` **trước** khi thu hồi quyền lái, nên gói đầu tiên sau nút dừng đã là `STOP`. Yêu cầu có `keepMode: true` (nhả joystick) thì không đổi mode.
5. Nhận quyền lái (`onControlClaimed`) chọn `manual`/`slam`; robot vào phiên tạo bản đồ (`onRobotState`) chọn `slam`.
6. `cmdInService` dựng gói bằng `buildCmdInMessage` (đích đổi sang PoseStamped bằng `poseToPoseStamped`) rồi chuyển cho publisher.
7. Publisher đổi gói sang `robot_hmi_msgs/msg/CmdIn` bằng `toRosCmdIn` và gửi qua kết nối rosbridge dùng chung; rosbridge phát lên `/cmd_in`.

Vì gói được dựng **sau** bước kiểm tra quyền, lệnh bị từ chối (hết token, sai quyền lái, vượt giới hạn) không bao giờ xuất hiện trên `/cmd_in`.

---

## 3. Kiểu dữ liệu đầu vào

### 3.1 `/odom`: `nav_msgs/msg/Odometry`

| Trường ROS 2 | Đơn vị | Ánh xạ sang `robot.state` |
| --- | --- | --- |
| `header.frame_id` | chuỗi | `pose.frameId`; rỗng thì dùng `odom` (`default_frame_id`) |
| `pose.pose.position.x` | m | `pose.x` |
| `pose.pose.position.y` | m | `pose.y` |
| `pose.pose.orientation` (`x`, `y`, `z`, `w`) | quaternion | `pose.yaw` (rad, trong khoảng (-π, π]) |

- Các trường khác (`twist`, `covariance`, `child_frame_id`) được bỏ qua.
- Quaternion được chuẩn hóa trước, rồi `yaw = atan2(2(wz + xy), 1 − 2(y² + z²))`. Frontend tự đổi sang độ.
- Message thiếu trường, có số không hữu hạn hoặc quaternion bằng 0 bị bỏ và được đếm vào `droppedMessages`.
- `pose` luôn giữ **tọa độ gốc của `/odom`**; ô trạng thái NavigationPage hiển thị X/Y (m), yaw (độ) và `frameId` này. Backend không gán nhầm x/y odom thành x/y của map.

### 3.2 `/tf`, `/tf_static`: `tf2_msgs/msg/TFMessage`

Mỗi `TransformStamped` có `header.frame_id` (frame cha), `child_frame_id` (frame con), `transform.translation` (`x`, `y`, `z`) và `transform.rotation` quaternion (`x`, `y`, `z`, `w`). Khi frame của `/odom` khác frame của `/map`, backend cần transform hợp lệ `map ← odom` để tính `mapPose` từ `pose`. `mapPose` giữ `{ frameId, x, y, yaw }` trong frame của bản đồ hiện tại; nếu không có transform cần thiết hoặc pose quá hạn thì `mapPose=null`. Transform động chỉ dùng khi còn mới trong 1500 ms; transform tĩnh được giữ tới khi rosbridge ngắt/kết nối lại. Khi frame của `/odom` và `/map` giống nhau, có thể dùng pose trực tiếp. Marker chỉ được vẽ nếu pose đã chọn cùng frame với lưới bản đồ và nằm trong phạm vi lưới.

ROS 2 thường có frame `/odom` là `odom` và `/map` là `map`. Kiểm thực tế bằng `ros2 topic echo /odom --once`, `ros2 topic echo /map --once --qos-durability transient_local --field header.frame_id` và `ros2 run tf2_ros tf2_echo map odom`; không thay frame bằng một giá trị đoán để ép marker lên bản đồ.

### 3.3 `/cmd_out`: `geometry_msgs/msg/Twist`

| Trường ROS 2 | Đơn vị | Ánh xạ sang `robot.state` |
| --- | --- | --- |
| `linear.x` | m/s, dương là tiến | `velocity.linearX` |
| `angular.z` | rad/s, dương là quay trái | `velocity.angularZ` |

Các trường `linear.y`, `linear.z`, `angular.x`, `angular.y` được bỏ qua. Vận tốc được kiểm bằng `VelocitySchema` `{ linearX, angularZ }` (`packages/contracts/src/control.js`); giá trị không phải số hữu hạn bị bỏ.

### 3.4 `/map`: `nav_msgs/msg/OccupancyGrid`

`header.frame_id` xác định frame bản đồ; `info.width`, `info.height`, `info.resolution`, `info.origin.position` và `info.origin.orientation` xác định phép đổi giữa tọa độ mét và ô lưới; `data` là mức chiếm dụng của từng ô. Worker `rclpy` subscribe bản đồ, tạo PNG và API metadata cho frontend. NavigationPage dùng lưới ROS trực tiếp để xem; muốn đặt waypoint hoặc tạo nhiệm vụ, người dùng chọn bản đồ đã lưu.

### 3.5 `/image_front`, `/image_rear`: `sensor_msgs/msg/Image`

| Thuộc tính | Giá trị bắt buộc |
| --- | --- |
| `encoding` | `bgr8` |
| `width` × `height` | 640 × 360 |
| `step` | 1920 (640 × 3) |
| `header.frame_id` | `camera_front_link` (cam trước), `camera_rear_link` (cam sau) |
| QoS khi subscribe | `BEST_EFFORT`, `VOLATILE`, `depth=1` |

Ảnh sai bất kỳ thuộc tính nào bị loại (fail closed). Gateway xuất 15 khung hình mỗi giây; khi nguồn nhanh hơn, chỉ ảnh mới nhất được giữ.

---

## 4. Kiểu dữ liệu đầu ra

### 4.1 `/cmd_in`: `robot_hmi_msgs/msg/CmdIn`

Một message gồm cả 4 thuộc tính, `target` là `geometry_msgs/PoseStamped[]` thật. Định nghĩa ở `ros2_ws/src/robot_hmi_msgs/msg/`:

```
# CmdIn.msg
string MODE_SLAM="SLAM"
string MODE_MANUAL="MANUAL"
string MODE_AUTO="AUTO"
string MODE_STOP="STOP"
geometry_msgs/PoseStamped[] target
string mode
Joystick joystick                  # Joystick.msg: float64 v_m, float64 v_rad
geometry_msgs/PoseStamped original_poss
```

Ví dụ `ros2 topic echo /cmd_in` khi bấm "Bắt đầu" nhiệm vụ:

```yaml
target: [{header: {stamp: {sec: 1792640317, nanosec: 489000000}, frame_id: map},
          pose: {position: {x: 2.0, y: 1.0, z: 0.0}, orientation: {x: 0.0, y: 0.0, z: 0.7071, w: 0.7071}}}]
mode: AUTO
joystick: {v_m: 0.0, v_rad: 0.0}
original_poss: {header: {stamp: {sec: 1792640317, nanosec: 489000000}, frame_id: map},
                pose: {position: {x: 0.5, y: -1.0, z: 0.0},
                       orientation: {x: 0.0, y: 0.0, z: 0.1247, w: 0.9922}}}
```

| Trường | Kiểu | Ý nghĩa |
| --- | --- | --- |
| `target` | `geometry_msgs/PoseStamped[]` | Các đích theo thứ tự; ở `SLAM`, `MANUAL`, `STOP` là mảng rỗng. |
| `mode` | `string`: `SLAM` \| `MANUAL` \| `AUTO` \| `STOP` | Tạo bản đồ, lái tay, đi đến đích, dừng. So sánh với hằng `CmdIn.MODE_*`. |
| `joystick.v_m` | `float64`, m/s | Cùng đơn vị và chiều dấu với `linear.x` của `/cmd_out`. `AUTO`, `STOP`: luôn 0. |
| `joystick.v_rad` | `float64`, rad/s | Cùng đơn vị và chiều dấu với `angular.z` của `/cmd_out`. `AUTO`, `STOP`: luôn 0. |
| `original_poss` | `geometry_msgs/PoseStamped` | Ước lượng pose ban đầu trong frame `map`; quaternion từ yaw. `header.stamp = 0` khi chưa chọn, cần bỏ qua pose mặc định này. |

Mỗi phần tử `target` dựng bằng `poseToPoseStamped({ x, y, theta })` trong `packages/contracts/src/cmdIn.js`: `position.z = 0`, orientation là quaternion quay quanh trục z (`z = sin(θ/2)`, `w = cos(θ/2)`), `header.frame_id = "map"`, `header.stamp` là thời điểm bắt đầu nhiệm vụ.

Trong backend, `CmdInMessageSchema` kiểm tra đúng cấu trúc ROS; `target` luôn là mảng. Khi chưa chọn pose ban đầu, `original_poss` là pose gốc với timestamp 0. ROS `float64` không có `null`, nên `AUTO` gửi `v_m = v_rad = 0`.

**Bắt buộc:** robot, rosbridge và `ros2 topic echo` đều phải biết kiểu `robot_hmi_msgs/msg/CmdIn`. Build một lần, rồi source ở mọi terminal cần nó (xem mục 6.1). rosbridge chưa source workspace sẽ từ chối advertise `/cmd_in`.

### 4.2 Cách chọn `mode`

Người dùng không chọn `mode` trực tiếp. Backend suy ra `mode` từ đường điều khiển đang được dùng:

| Người dùng làm gì trên UI | Backend nhận | `mode` | `target` | `joystick` |
| --- | --- | --- | --- | --- |
| Bắt đầu phiên tạo bản đồ (trang Mapping) | `POST /api/mapping/start` | `SLAM` | `[]` | `(0; 0)` |
| Bật switch manual ở trang Điều hướng | `POST /api/control/lease` | `MANUAL` | `[]` | `(0; 0)` |
| Lái bằng joystick/W/A/S/D | `teleop.velocity` qua `/ws` | `MANUAL` hoặc `SLAM` | `[]` | Vận tốc đang giữ |
| Nhả joystick/phím | Stop an toàn với `keepMode: true` | giữ mode | giữ target | `(0; 0)` |
| Tắt switch manual | `POST /api/control/release` | `AUTO` | `[]` | `(0; 0)` |
| Chọn điểm hiện tại | `PUT /api/navigation/original-position` | `AUTO` | giữ target | `(0; 0)` |
| Chọn điểm đích | `PUT /api/navigation/target` | `AUTO` | PoseStamped đã chọn | `(0; 0)` |
| Bắt đầu mission | `POST /api/missions` | `AUTO` | Các waypoint dạng PoseStamped | `(0; 0)` |
| Dừng/lưu mapping, Yêu cầu dừng, hủy mission | Stop hoặc cancel | `STOP` | `[]` | `(0; 0)` |

Quy tắc chuyển `mode`: **mode chỉ đổi khi người dùng chọn mode khác** (các dòng có mode cụ thể ở bảng trên). Mọi việc khác chỉ phát lại mode hiện tại với joystick `(0; 0)`.

- Giao diện cho nhập/chọn lại vị trí ước lượng trước mission; `PUT /api/navigation/original-position` nhận `{ "original_poss": { "x": ..., "y": ..., "theta": ... } }` (theta rad), backend chuyển sang `PoseStamped` và phát ngay. Chưa nhập thì `POST /api/missions` trả `409 ORIGINAL_POSITION_REQUIRED`.
- Lệnh vận tốc 0 giữ mode hiện tại. Trả quyền manual bằng switch thì backend chuyển `AUTO` sau khi ghi vận tốc 0. Hết hạn quyền lái ngoài ý định của người dùng giữ mode cùng vận tốc 0.
- Kết thúc mapping chuyển `STOP`. Kết thúc mission bình thường giữ `AUTO` với joystick 0; hủy mission chuyển `STOP`.
- `POST /api/control/stop` thiếu `keepMode` (hoặc `false`) luôn là người dùng chọn dừng → `stop`. Frontend chỉ gửi `keepMode: true` khi lý do dừng không phải nút dừng/phím Space (`stopOptionsForReason` trong `frontend/src/utils/controlStopAction.js`).
- Từ lúc backend khởi động tới lệnh điều khiển đầu tiên, không có gói nào được phát.

### 4.3 Vận tốc khi lái bằng joystick

| Hướng | `linear` (m/s) | `angular` (rad/s) |
| --- | --- | --- |
| Trái | 0 | 0.3 |
| Phải | 0 | -0.3 |
| Tiến | 0.3 | 0 |
| Lùi | -0.3 | 0 |
| Dừng | 0 | 0 |

Giá trị 0.3 lấy từ `MANUAL_DRIVE_SPEED` trong `packages/control-domain/src/controlPolicy.js`. Backend từ chối mọi vận tốc ngoài bảng trên (lỗi `VELOCITY_NOT_FIXED`), nên gói `SLAM`/`MANUAL` chỉ mang các giá trị này. Ở `AUTO` và `STOP`, joystick luôn là `(0; 0)`.

### 4.4 `robot.state`: dữ liệu backend đẩy lên frontend

Không phải topic ROS, nhưng là đích cuối của `/odom` và `/cmd_out`. Mỗi khung WebSocket trên `/ws`:

```json
{
  "version": 1,
  "type": "robot.state",
  "streamEpoch": "<mã phiên khởi động>",
  "sequence": 42,
  "sentAt": "2026-10-16T06:04:18.014Z",
  "payload": { "...": "RobotStateSchema" }
}
```

Các trường trong `payload` (`packages/contracts/src/robotState.js`) liên quan tới ROS:

| Trường | Kiểu | Nguồn |
| --- | --- | --- |
| `rosConnected` | boolean | `true` khi rosbridge đang mở **và** `/odom` cuối còn trong 1500 ms |
| `pose` | `{ frameId, x, y, yaw }` hoặc `null` | `/odom` gốc; `null` khi chưa từng nhận |
| `mapPose` | `{ frameId, x, y, yaw }` hoặc `null` | Pose đổi sang frame `map` bằng `/tf`/`/tf_static`; `null` khi chưa đủ dữ liệu hoặc pose quá hạn |
| `poseSourceUpdateAgeMs` | số (ms) hoặc `null` | Thời gian kể từ `/odom` cuối |
| `velocity` | `{ linearX, angularZ }` | `/cmd_out`; về `0` khi `/cmd_out` quá hạn |

---

## 5. Phương thức giao tiếp

### 5.1 Backend ↔ rosbridge: rosbridge v2 trên WebSocket

- **Kết nối:** một WebSocket tới `ROSBRIDGE_URL` (ví dụ `ws://127.0.0.1:9090`), dùng cho cả nhận lẫn gửi. Client: `backend/src/ros/rosbridgeClient.js`. Browser nhận snapshot qua `/ws` của backend, không cần nối thẳng tới rosbridge.
- **Định dạng:** mỗi tin là một object JSON có trường `op`.

Tin backend gửi tới rosbridge:

```jsonc
// Đăng ký nhận /odom, TF và /cmd_out (gửi lại sau mỗi lần nối)
{ "op": "subscribe", "id": "hmi:/odom", "topic": "/odom",
  "type": "nav_msgs/msg/Odometry", "throttle_rate": 50, "queue_length": 1 }
{ "op": "subscribe", "id": "hmi:/tf", "topic": "/tf", "type": "tf2_msgs/msg/TFMessage",
  "throttle_rate": 50, "queue_length": 1,
  "qos": { "history": "keep_last", "depth": 10, "reliability": "best_effort", "durability": "volatile" } }
{ "op": "subscribe", "id": "hmi:/tf_static", "topic": "/tf_static", "type": "tf2_msgs/msg/TFMessage",
  "throttle_rate": 0, "queue_length": 1,
  "qos": { "history": "keep_last", "depth": 100, "reliability": "reliable", "durability": "transient_local" } }
{ "op": "subscribe", "id": "hmi:/cmd_out", "topic": "/cmd_out",
  "type": "geometry_msgs/msg/Twist", "throttle_rate": 50, "queue_length": 1 }

// Khai báo sẽ phát /cmd_in (gửi lại sau mỗi lần nối)
{ "op": "advertise", "id": "hmi:/cmd_in", "topic": "/cmd_in", "type": "robot_hmi_msgs/msg/CmdIn" }

// Phát một gói /cmd_in
{ "op": "publish", "topic": "/cmd_in",
  "msg": { "target": [], "mode": "MANUAL", "joystick": { "v_m": 0.3, "v_rad": 0 },
           "original_poss": { "header": { "stamp": { "sec": 0, "nanosec": 0 }, "frame_id": "map" },
                              "pose": { "position": { "x": 0, "y": 0, "z": 0 },
                                        "orientation": { "x": 0, "y": 0, "z": 0, "w": 1 } } } } }
```

Tin rosbridge gửi về backend:

```jsonc
{ "op": "publish", "topic": "/odom", "msg": { "header": { "frame_id": "odom" }, "pose": { "pose": { "...": "..." } } } }
{ "op": "publish", "topic": "/tf", "msg": { "transforms": [{ "header": { "frame_id": "map" }, "child_frame_id": "odom", "transform": { "translation": { "x": 0, "y": 0, "z": 0 }, "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 } } }] } }
{ "op": "publish", "topic": "/cmd_out", "msg": { "linear": { "x": 0.2 }, "angular": { "z": 0.1 } } }
```

`throttle_rate: 50` nghĩa là rosbridge gửi tối đa 20 message mỗi giây cho mỗi topic. `queue_length: 1` nghĩa là chỉ giữ message mới nhất.

### 5.2 Nhịp gửi và xử lý quá hạn

| Luồng | Nhịp | Khi mất dữ liệu |
| --- | --- | --- |
| `/odom` → backend | Tối đa 20 Hz (`throttle_ms: 50`) | Quá 1500 ms: `rosConnected=false`, giữ pose cuối, tuổi pose tiếp tục tăng |
| `/tf`, `/tf_static` → backend | Theo node định vị; `/tf` tối đa 20 Hz sau throttle của rosbridge | Thiếu transform `map ← odom` mới/hợp lệ: `mapPose=null`, không vẽ marker sai hệ tọa độ |
| `/map` → backend | Theo SLAM hoặc `map_server` | Worker báo chờ; Navigation/Mapping không hiển thị lưới ROS mới |
| `/cmd_out` → backend | Tối đa 20 Hz | Quá 1500 ms: vận tốc về `(0; 0)`, vẫn online nếu `/odom` còn |
| backend → frontend (`robot.state`) | 10 Hz cố định (`publish_rate_hz`), kiêm heartbeat | Frontend tự báo dữ liệu cũ |
| backend → `/cmd_in` | Chỉ khi có lệnh; khoảng 20 Hz khi giữ joystick (frontend gửi mỗi 50 ms) | Không phát định kỳ; khi không ai điều khiển, topic im lặng |

Robot nên tự dừng nếu không nhận được gói `MANUAL` mới sau một khoảng thời gian, vì HMI không phát lặp lại.

### 5.3 Mất và nối lại kết nối rosbridge

- Client thử nối lại sau `bridge.reconnect_ms` (2000 ms) cho tới khi được.
- Sau mỗi lần nối, client gửi lại toàn bộ `subscribe` và `advertise`, gồm `/odom`, `/cmd_out`, `/tf`, `/tf_static` và `/cmd_in`.
- Gói `/cmd_in` phát trong lúc mất kết nối bị bỏ, không xếp hàng.
- Khi nối lại, backend phát lại gói `/cmd_in` mới nhất nhưng với joystick `(0; 0)` (giữ nguyên `mode`, `target`, `original_poss`), để robot không nhận lại một lệnh chạy đã cũ.

### 5.4 Frontend ↔ backend

| Kênh | Giao thức | Nội dung |
| --- | --- | --- |
| `/ws` | WebSocket, JSON có `version`, `type`, `sequence` | `robot.state`, `control.*` (quyền lái, heartbeat mỗi 100 ms), `teleop.velocity` (joystick, mỗi 50 ms) |
| `POST /api/control/lease` | HTTP JSON | Xin quyền lái (tối đa 15 giây, không tự gia hạn) |
| `POST /api/control/stop` | HTTP JSON | Yêu cầu dừng |
| `POST /api/missions`, `POST /api/missions/:id/cancel` | HTTP JSON | Tạo, hủy nhiệm vụ đi đến đích |

Kênh `/ws` giới hạn 30 tin nhắn mỗi giây cho mỗi kết nối. Lái tay: mất lệnh joystick quá 300 ms thì quyền lái bị thu hồi.

### 5.5 Đường camera

| Chặng | Giao thức |
| --- | --- |
| Driver camera → gateway | DDS của ROS 2 (`sensor_msgs/msg/Image`) |
| Gateway → MediaMTX | VP8 trong RTP qua UDP loopback: `127.0.0.1:5004` (trước), `127.0.0.1:5006` (sau) |
| MediaMTX → Vite → trình duyệt | Vite chuyển tiếp WHEP vào MediaMTX HTTPS `8889` qua cùng Origin web `5173`; WebRTC media đi trực tiếp tới Ubuntu qua UDP `8189` |
| Kiểm quyền | MediaMTX hỏi backend; backend chỉ cấp vé ngắn hạn, gắn với từng camera, cho người đã đăng nhập |

---

## 6. Cài đặt và cấu hình

### 6.1 Phía ROS 2

```bash
sudo apt install ros-jazzy-rosbridge-suite

# Một lần (và mỗi khi sửa file .msg): build kiểu message /cmd_in
source /opt/ros/jazzy/setup.bash
cd /home/vistar/projects/ROBOT_HMI/ros2_ws && colcon build --packages-select robot_hmi_msgs

# Mỗi lần chạy: source cả workspace rồi mới mở rosbridge
source /opt/ros/jazzy/setup.bash
source /home/vistar/projects/ROBOT_HMI/ros2_ws/install/setup.bash
ros2 launch rosbridge_server rosbridge_websocket_launch.xml address:=127.0.0.1
```

Lệnh cuối chạy lâu dài trong một terminal riêng, mở `ws://127.0.0.1:9090` cho backend trên cùng máy Ubuntu. Dùng cùng `ROS_DOMAIN_ID` và môi trường DDS với các node robot. Không cần mở cổng `9090` cho browser trong LAN. Nếu `/odom` đã chạy nhưng `rosbridge_server` chưa có, backend vẫn không thể subscribe `/odom` qua JavaScript.

### 6.2 Phía backend

Trong `backend/.env`:

```
ROSBRIDGE_URL=ws://127.0.0.1:9090
```

- Biến này bật việc đọc `/odom`, `/cmd_out`, `/tf`, `/tf_static` và phát `/cmd_in` trên cùng một kết nối.
- Để trống thì backend không nối ROS và giữ hành vi mô phỏng.
- Chỉ nhận `ws://` hoặc `wss://`; giá trị khác làm backend báo `CONFIG_VALIDATION_FAILED` khi khởi động.

Muốn đổi tên topic, nhịp hoặc thời gian quá hạn của `/odom` và `/cmd_out`, sửa `backend/config/ros_status.yaml` (sai cấu trúc thì backend báo `ROS_STATUS_SPEC_INVALID` khi khởi động). Tên, kiểu và schema của `/cmd_in` nằm trong `packages/contracts/src/cmdIn.js`.

### 6.3 Phía frontend

`frontend/.env.local` chọn chế độ client; script `tools/run_hmi_lan.sh` đặt `VITE_ROBOT_CLIENT=remote` khi chạy trên LAN:

- `VITE_ROBOT_CLIENT=mock`: robot và backend giả lập trong trình duyệt; không có gì đi tới ROS.
- `VITE_ROBOT_CLIENT=remote`: gọi backend thật qua `/api` và `/ws` (Vite proxy tới `127.0.0.1:3001`).

### 6.4 Phía camera

Xem `tools/ros-camera/README.md`. Tóm tắt: chạy MediaMTX, chạy `ros_camera_gateway.py` sau khi `source /opt/ros/jazzy/setup.bash`, và đặt `CAMERA_MEDIA_MODE=ros`. Script `tools/run_hmi_lan.sh` đặt `CAMERA_WHEP_BASE_URL=https://<IP-Ubuntu>:5173`; Vite chuyển tiếp WHEP đến MediaMTX trên cùng máy.

---

## 7. Kiểm tra

Các lệnh `info`, `echo`, `hz` và `tf2_echo` chỉ đọc dữ liệu, phù hợp khi robot đang chạy. Những lệnh `topic pub` và script `cmdin-demo.mjs` ở cuối bảng **phát dữ liệu/lệnh ROS**; chỉ chạy trong môi trường mô phỏng cô lập, không chạy để kiểm tính năng hiển thị trên robot thật.

| Việc | Lệnh |
| --- | --- |
| Xem robot có phát odometry không | `ros2 topic info /odom -v`, `ros2 topic echo /odom --once`, `ros2 topic hz /odom` |
| Xem frame bản đồ và transform | `ros2 topic info /map -v`, `ros2 topic echo /map --once --qos-durability transient_local --field header.frame_id`, `ros2 run tf2_ros tf2_echo map odom` (nhấn `Ctrl+C` sau khi thấy transform) |
| Xem rosbridge đã mở | `ss -lnt | grep :9090`; `ros2 topic info /odom -v` có subscription của `rosbridge_websocket` |
| Xem backend đã nhận ROS | Mở NavigationPage: ô trạng thái hiện X/Y/yaw từ `/odom`; bản đồ ROS có marker/mũi tên khi `mapPose` hợp lệ. Kết nối browser tới backend qua `/ws` (`robot.state`). |
| Xem vận tốc hiện tại | `ros2 topic hz /cmd_out` |
| Xem HMI phát gì (đã source workspace interface) | `ros2 topic echo /cmd_in robot_hmi_msgs/msg/CmdIn` |
| Giả lập robot phát `/odom` | `ros2 topic pub -r 10 /odom nav_msgs/msg/Odometry "{header: {frame_id: odom}, pose: {pose: {position: {x: 1.5, y: -0.8}, orientation: {z: 0.3827, w: 0.9239}}}}"` |
| Giả lập robot phát `/cmd_out` | `ros2 topic pub -r 10 /cmd_out geometry_msgs/msg/Twist "{linear: {x: 0.2}, angular: {z: 0.1}}"` |
| Phát thử chuỗi 9 gói `/cmd_in` (không cần backend) | `cd backend && node scripts/cmdin-demo.mjs ws://127.0.0.1:9090` |
| Test unit (rosbridge giả, không cần ROS) | `cd backend && npm run test:unit` |
| Test với ROS 2 thật | `cd backend && ROSBRIDGE_URL=ws://127.0.0.1:9090 npm run test:ros-live` |

Script demo phát từng bước cách nhau 1 giây: `SLAM` và joystick tiến, kết thúc mapping về `STOP`, bật `MANUAL` để lái, trả quyền về `AUTO`, yêu cầu `STOP`, đặt vị trí ban đầu và hai đích trong `AUTO`, rồi hủy nhiệm vụ về `STOP`. Kiểm tra bằng `ros2 topic echo /cmd_in`.

Script gọi thẳng `cmdInService` nên không đi qua kiểm tra quyền lái; nó chỉ dùng để kiểm nội dung gói và đường truyền tới ROS.

### 7.1 Xử lý sự cố `/cmd_in`

| Hiện tượng | Nguyên nhân | Cách sửa |
| --- | --- | --- |
| `ros2 topic echo /cmd_in robot_hmi_msgs/msg/CmdIn` báo `The passed message type is invalid` | Terminal chưa source workspace (chỉ source `/opt/ros/jazzy`) | `source /home/vistar/projects/ROBOT_HMI/ros2_ws/install/setup.bash` sau khi source ROS |
| Echo chạy nhưng không nhận gói nào, `ros2 topic info /cmd_in` báo `Publisher count: 0` | rosbridge chạy trong terminal chưa source workspace nên từ chối advertise kiểu `CmdIn` | Tắt rosbridge, source cả `/opt/ros/jazzy/setup.bash` và `ros2_ws/install/setup.bash`, chạy lại rosbridge |
| Vẫn không có gói dù rosbridge đã đúng | Chưa có thao tác nào: backend chỉ phát khi có lệnh (bấm dừng, nhận quyền lái, bắt đầu nhiệm vụ…) | Chạy `node scripts/cmdin-demo.mjs`, hoặc thao tác trên giao diện / gọi `POST /api/control/stop` |
| `Unable to start server: [Errno 98] Address already in use` khi mở rosbridge | Còn một rosbridge khác giữ cổng 9090 | `ss -ltnp \| grep 9090` để tìm PID, tắt tiến trình đó rồi chạy lại |
| Sửa file `.msg` nhưng robot/echo vẫn thấy cấu trúc cũ | Chưa build lại | `colcon build --packages-select robot_hmi_msgs`, rồi khởi động lại rosbridge và node robot |

Kiểm tra nhanh rosbridge đang chạy đã source workspace chưa: `tr '\0' '\n' < /proc/<PID>/environ | grep AMENT_PREFIX_PATH` phải có `.../ros2_ws/install/robot_hmi_msgs`.

---

## 8. Ví dụ node robot nhận `/cmd_in` (ROS 2, Python)

```python
# Cần gói robot_hmi_msgs: copy ros2_ws/src/robot_hmi_msgs sang workspace của robot rồi colcon build.
import math
import rclpy
from rclpy.node import Node
from robot_hmi_msgs.msg import CmdIn


class CmdInListener(Node):
    def __init__(self):
        super().__init__('cmd_in_listener')
        self.create_subscription(CmdIn, '/cmd_in', self.on_cmd, 10)

    def on_cmd(self, msg):
        v = msg.joystick.v_m              # m/s, như linear.x của Twist
        w = msg.joystick.v_rad            # rad/s, như angular.z của Twist
        if msg.mode == CmdIn.MODE_AUTO:
            for goal in msg.target:       # geometry_msgs/msg/PoseStamped
                p = goal.pose.position
                q = goal.pose.orientation
                yaw = 2 * math.atan2(q.z, q.w)
                self.get_logger().info(f'goal ({goal.header.frame_id}): x={p.x} y={p.y} yaw={yaw}')
        origin = msg.original_poss if msg.original_poss.header.stamp.sec or msg.original_poss.header.stamp.nanosec else None
        self.get_logger().info(f'{msg.mode}: v={v} w={w} origin={origin}')


def main():
    rclpy.init()
    rclpy.spin(CmdInListener())


if __name__ == '__main__':
    main()
```

---

## 9. Lưu ý khi dùng với robot thật

- **Nhả joystick không đổi mode.** Frontend gọi `POST /api/control/stop` với `keepMode: true`, nên `/cmd_in` giữ `SLAM`/`MANUAL` với joystick `(0; 0)`. Nút "Yêu cầu dừng", phím Space, dừng mapping và hủy nhiệm vụ phát `STOP`.
- **Ở `AUTO`, joystick luôn là `(0; 0)`; robot tự đi theo `target`.** Tiến trình nhiệm vụ trong backend hiện là mô phỏng; vận tốc mô phỏng không được đưa xuống robot.
- **Chưa lái được từ giao diện khi nối ROS thật.** `/odom` làm `rosConnected=true`, nhưng `motionInhibited` vẫn là `true` và `physicalEstopActive` vẫn là `null` vì chưa có topic nào cung cấp. Nhận quyền lái và tạo nhiệm vụ vì vậy bị từ chối; chỉ đường dừng (`stop`) hoạt động (mục 13.1).
- **Định dạng `/cmd_in` chưa được nhóm robot xác nhận** (mục 13.4).

---

# Phụ lục: ghi chú cho người phát triển

## 10. Thành phần code

| File | Vai trò |
| --- | --- |
| `backend/src/ros/rosbridgeClient.js` | Client rosbridge v2 dùng chung: `subscribe`, `advertise`, `publish`, tự nối lại và đăng ký lại topic. |
| `backend/src/ros/rosStatusSpec.js` | Đọc và kiểm tra `config/ros_status.yaml`; sai cấu trúc thì dừng ngay lúc khởi động. |
| `backend/src/ros/rosStatusMessages.js` | `odometryToPose()`, `twistToVelocity()`; message hỏng trả `null`. |
| `backend/src/ros/rosTfTransforms.js` | Lưu TF động/tĩnh và đổi pose odom sang frame bản đồ khi transform hợp lệ. |
| `backend/src/services/rosStatusService.js` | Giữ message mới nhất, ghi vào `sharedRobotState` theo `publish_rate_hz`, xử lý quá hạn. |
| `backend/src/ros/occupancy_map_worker.py`, `backend/src/ros/rosMapService.js` | Subscribe `/map` qua DDS, tạo ảnh PNG và metadata có frame bản đồ hiện tại. |
| `frontend/src/components/navigation/RosNavigationWorkspace.jsx`, `frontend/src/utils/rosMapPose.js` | Chọn pose đúng frame, kiểm độ mới/phạm vi lưới và hiển thị marker/hướng trên bản đồ ROS. |
| `backend/src/services/cmdInService.js` | Chọn `mode` và dựng gói `/cmd_in`. |
| `backend/src/ros/rosbridgeCmdInPublisher.js` | Advertise `/cmd_in`, phát gói qua client dùng chung, phát lại gói cuối với joystick 0 khi nối lại. |
| `backend/src/ros/mockRosAdapter.js` | Hook `onMotionCommand({ origin, velocity, poses? })` sau mỗi lệnh đã ghi. |
| `packages/control-domain/src/controlAuthority.js` | Hook `onStopRequested()` ở đầu mỗi lần dừng. |
| `backend/src/runtime.js` | Tạo một client rosbridge khi có `ROSBRIDGE_URL`, nối các phần trên với nhau. |
| `backend/src/config.js` | Biến `ROSBRIDGE_URL`. |
| `packages/contracts/src/cmdIn.js` | `CMD_IN_TOPIC`, `CMD_IN_ROS_TYPE`, `CmdInMessageSchema`, `buildCmdInMessage`, `poseToPoseStamped`, `yawToQuaternion`, `toRosCmdIn`. |
| `ros2_ws/src/robot_hmi_msgs/` | Gói interface ROS 2: `CmdIn.msg`, `Joystick.msg`. |
| `backend/src/routes/navigationRouter.js` | `GET`/`PUT /api/navigation/original-position`, `PUT /api/navigation/target`. |
| `frontend/src/components/navigation/OriginalPositionDialog.jsx` | Hộp thoại nhập vị trí ban đầu, bật khi bấm "Bắt đầu" lần đầu. |
| `packages/contracts/src/control.js` | `VelocitySchema`, kiểu vận tốc dùng chung cho `/cmd_out` và `/cmd_in`. |
| `packages/contracts/src/robotState.js` | `RobotStateSchema`. |
| `tools/ros-camera/ros_camera_gateway.py` | Node ROS 2 đọc ảnh camera, mã hóa VP8/RTP. |
| `backend/test/cmdIn.test.mjs`, `backend/test/rosStatus.test.mjs`, `backend/test/rosTfTransforms.test.mjs`, `backend/test/rosMapService.test.mjs` | Test unit (`npm run test:unit`). |
| `backend/test/rosStatus.live.test.mjs` | Test với ROS 2 thật (`npm run test:ros-live`). |
| `backend/scripts/cmdin-demo.mjs` | Phát thử chuỗi gói `/cmd_in`. |

### 10.1 Sự kiện nào gọi hàm nào

| Sự kiện | Hàm được gọi | File |
| --- | --- | --- |
| Lệnh joystick hợp lệ | `core.send` gọi `setVelocity`, rồi `adapter.writeCommand(velocity)` | `controlLeaseCore.js`, `controlAuthority.js` |
| Thu hồi quyền lái (trả, hết hạn, watchdog) | `revoke` gọi `setVelocity(ZERO)`, rồi `adapter.writeCommand` | `controlLeaseCore.js` |
| Yêu cầu dừng | `performStop` gọi `onStopRequested()` trước, sau đó thu hồi quyền lái và ghi 0 | `controlAuthority.js` |
| Bắt đầu nhiệm vụ | `adapter.beginMission(missionId, poses)` | `missionService.js` |
| Vào phiên tạo bản đồ | `sharedRobotState` đổi sang mode `mapping`, gọi `cmdInService.onRobotState` | `runtime.js` |
| Mỗi bước nhiệm vụ mô phỏng | `adapter.writeMissionVelocity(handle, velocity)` | `missionService.js` |
| Kết thúc nhiệm vụ | `adapter.finishMission(handle)` gọi `ensureStopped()` (origin `stop`) | `missionService.js` |
| Hủy nhiệm vụ | `adapter.cancelMission(handle)` báo origin `cancel` → mode `STOP` | `missionService.js` |
| Tắt server, lỗi database | `adapter.ensureStopped()` | `backend/src/server.js` |

Adapter gọi `onMotionCommand({ origin, velocity })` với `origin` là:

- `teleop`: từ `writeCommand` (đường quyền lái, gồm cả lệnh 0 của `controlAuthority`).
- `mission`: từ `beginMission` và `writeMissionVelocity`.
- `stop`: từ `ensureStopped`.

`cmdInService` nhận `setMode()`, `setTarget()`, `setOriginalPose()`, `onMotionCommand()` và `onRobotState()`. Service nhận danh sách `publishers`, mỗi phần tử có `publish(message)` và tùy chọn `dispose()`.

## 11. Quyết định thiết kế và lý do

Các quyết định dưới đây là có chủ ý. Nếu cần đổi, hãy đổi có lý do.

- **Backend dựng gói, frontend không gửi `/cmd_in`.** Nếu trình duyệt tự gửi vận tốc xuống robot thì bỏ qua toàn bộ kiểm tra quyền lái, token và giới hạn vận tốc của backend.
- **Gói được dựng sau bước kiểm tra quyền.** Điểm móc nằm ở adapter, nơi mọi lệnh đã được chấp nhận đều đi qua.
- **`STOP` được báo trước khi thu hồi quyền lái.** Nếu báo muộn hơn, lệnh 0 do việc thu hồi sinh ra sẽ đi ra với `mode` cũ trước gói `STOP`.
- **`STOP` được giữ qua các lệnh vận tốc 0.** Lệnh 0 ngay sau yêu cầu dừng không đổi `mode` về `MANUAL`/`SLAM`.
- **`SLAM` chỉ phát lúc robot mới vào mode `mapping`.** `robot.state` cập nhật liên tục trong phiên; nếu phát mỗi lần thì sẽ kéo `STOP` về `SLAM`.
- **Ở `AUTO`, vận tốc luôn là 0.** `missionService` ghi vận tốc mô phỏng `(0.3; 0.05)` để giả lập chuyển động; đưa xuống robot thật sẽ làm robot chạy sai.
- **Gói chỉ phát khi có lệnh.** Không có timer phát định kỳ; nhịp 50 ms của frontend đã tạo dòng gói đều khi giữ joystick.
- **`/cmd_in` là message riêng `robot_hmi_msgs/msg/CmdIn`.** Một gói chứa `target`, `mode`, `joystick`, `original_poss`. Robot và rosbridge phải source cùng bản interface sau khi build.
- **Dùng chung kiểu vận tốc với `/cmd_out`.** `joystick` được dựng từ `VelocitySchema` qua một hàm `buildCmdInMessage` duy nhất, bảo đảm hai chiều khớp đơn vị và dấu.
- **Mode đổi theo thao tác.** Nhả joystick giữ mode với vận tốc 0; tắt switch manual chuyển `AUTO`; kết thúc mapping chuyển `STOP`.
- **Một kết nối rosbridge dùng chung.** Ít tài nguyên hơn, một biến cấu hình, một chỗ xử lý nối lại. Chọn rosbridge vì `rosbridge_server` có sẵn trên ROS 2 và không cần build module native như `rclnodejs`.
- **Chỉ giữ gói mới nhất.** Khi mất kết nối, lệnh cũ bị bỏ chứ không xếp hàng; khi nối lại chỉ phát lại gói cuối với joystick 0.
- **Hợp đồng mode và trường theo định nghĩa robot:** `MANUAL`, `AUTO`, `STOP`, `SLAM`; `v_m`, `v_rad`, `original_poss`.

## 12. Quy ước code

- Module ESM, không dùng class. Mỗi module xuất một hàm `createXxx({...})`; phụ thuộc và đồng hồ (`now`, `setEvery`, `WebSocketImpl`…) được truyền vào để test thay thế được.
- Đầu file có khối comment ghi đường dẫn file và một dòng tiêu đề viết hoa bằng tiếng Việt. Comment viết bằng tiếng Việt, ngắn, giải thích lý do.
- Thụt 4 dấu cách ở `backend/src` và `packages/`; frontend dùng 2 dấu cách. Giữ theo file đang sửa.
- Schema `zod` đặt ở `packages/contracts/src/` và dùng `.strict()`. Thêm file mới thì khai báo trong `exports` của `packages/contracts/package.json`.
- Nguyên tắc "fail closed": khi không chắc robot an toàn thì chặn. Trạng thái `null` hoặc không rõ được coi là không an toàn.
- Callback và hook không được làm hỏng đường chính: bọc `try/catch` quanh listener.
- Thêm biến môi trường thì khai báo trong `ConfigShape` ở `backend/src/config.js` và trong `backend/.env.example`.

## 13. Việc còn mở

Xếp theo mức ảnh hưởng tới việc dùng với robot thật.

1. **Thiếu trạng thái an toàn từ robot.** `rosStatusService` đã cập nhật `rosConnected`, `pose`, `velocity` từ ROS, nhưng `motionInhibited` (khởi động là `true`) và `physicalEstopActive` (khởi động là `null`) chưa có nguồn nào cập nhật. Hệ quả: nhận quyền lái và tạo nhiệm vụ bị từ chối. Cần thống nhất với nhóm robot một topic trạng thái an toàn (ví dụ nút dừng khẩn vật lý), rồi đọc nó trong `rosStatusService`. Lưu ý `ROBOT_ADAPTER` đang khóa cứng là `mock` trong `config.js`, và `telemetry.transportStale` trong `runtime.js` đang đặt cứng là `false`.
2. **Đã xử lý: nhả joystick không còn phát `stop`.** `RequestStopRequestSchema` có trường tùy chọn `keepMode`; `controlAuthority` chuyển request vào `onStopRequested(request)`, và `runtime.js` chỉ gọi `cmdInService.emergencyStop()` khi không có `keepMode`. Nhận quyền lái gọi hook `onControlClaimed(context)` → `cmdInService.selectMode()`.
3. **`target` đã có (mảng PoseStamped ở mode `AUTO`), nhưng nhiệm vụ trong backend vẫn mô phỏng.** Backend chưa đọc kết quả điều hướng thật từ robot; tiến trình, `pose` khi chạy nhiệm vụ và trạng thái `succeeded` vẫn do `missionService` tự sinh. Vị trí ban đầu (`original_poss`) chỉ giữ trong bộ nhớ backend, khởi động lại thì phải nhập lại.
4. **Chưa thống nhất định dạng `/cmd_in` với nhóm robot:** kiểu `robot_hmi_msgs/msg/CmdIn`, tên trường, giá trị `mode`, cách robot xử lý `stop` (có khóa lại không, mở khóa bằng gì). Robot phải build cùng bản `robot_hmi_msgs`; lệch định nghĩa `.msg` thì rosbridge và robot không nói chuyện được với nhau.
5. **Không phát định kỳ.** Nếu robot cần nhận gói đều đặn để biết HMI còn sống, thêm timer trong `cmdInService` phát lại gói gần nhất; không được phát lại một vận tốc khác 0 đã cũ.
6. **Quyền lái loại `manual` (không phải `mapping`) có giới hạn khác:** 0.2 m/s và 0.5 rad/s, không ép bốn hướng cố định. Giao diện hiện chỉ dùng loại `mapping`.
7. **Phát hiện người và cử chỉ chưa có nguồn dữ liệu.** Giao diện đã có ô hiển thị trong khung camera ở `/navigation` (`NavigationCameraPanel.jsx`), nhưng chưa có topic nào cung cấp kết quả.
8. **Chưa chạy end-to-end với backend đầy đủ** (cần PostgreSQL và `backend/.env`), nên đường từ giao diện web tới `/cmd_in` mới được kiểm gián tiếp qua test unit.
