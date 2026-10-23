# ROBOT_HMI

Web HMI cho robot ROS 2 Jazzy. Frontend React/Vite, backend Express + PostgreSQL, nối ROS qua rosbridge.
Máy dev: Ubuntu 24.04, repo tại `/home/it/Documents/ROBOT_HMI`.

## Cấu trúc

| Thư mục | Vai trò |
|---|---|
| `frontend/` | React 19 + Vite 8 + MUI. Mode `mock` (giả lập trong browser) hoặc `remote` (gọi backend) |
| `backend/` | Express 5, session/argon2, PostgreSQL, WebSocket. Nối ROS qua `ROSBRIDGE_URL` |
| `packages/contracts`, `packages/control-domain` | Thư viện JS dùng chung (`file:` dependency) |
| `tools/ros-camera/` | Gateway camera ROS → GStreamer VP8/RTP → MediaMTX → WebRTC |
| `readme_ros.md` | Topic ROS: vào `/odom`, `/cmd_out`, `/image_front`, `/image_rear`; ra `/cmd_in` |

## Git và branch (cập nhật 2026-10-21)

- Remote `origin`: `https://github.com/quac1605/ROBOT_HMI.git`. Branch: `main`, `combine`, `combinev2`, `hihi`, `codex/stage9-ubuntu`, `codex/combine-total`.
- Branch đang làm: **`codex/combine-total`**, nhánh từ `combinev2`, gộp ROS bridge của `combinev2` với UI và camera của `combine`, có thêm `/map` (`backend/src/ros/rosMapService.js`, `occupancy_map_worker.py`).
- Thấy branch trên GitHub mà local không có: chạy `git fetch --prune` (git không tự cập nhật danh sách branch remote).

## Hợp đồng topic ROS (đổi tên 2026-10-21, commit `b0e2703`)

Tên `/cmd_in` và `/cmd_out` đã được **đổi chéo** cho đúng góc nhìn của robot:

| Topic | Chiều | Kiểu | Nội dung | Code |
|---|---|---|---|---|
| `/cmd_in` | HMI → robot (backend publish) | `robot_hmi_msgs/msg/CmdIn` (gói `ros2_ws/src/robot_hmi_msgs`) | `{ target: PoseStamped[], mode: 'SLAM'\|'MANUAL'\|'AUTO'\|'STOP', joystick: { v_m, v_rad }, original_poss: PoseStamped }` | `packages/contracts/src/cmdIn.js`, `backend/src/services/cmdInService.js`, `backend/src/ros/rosbridgeCmdInPublisher.js` |
| `/cmd_out` | robot → HMI (backend subscribe) | `geometry_msgs/msg/Twist` | `linear.x` (m/s), `angular.z` (rad/s); quá 1500 ms thì vận tốc về 0 | `backend/config/ros_status.yaml`, `backend/src/services/rosStatusService.js` |
| `/odom` | robot → HMI | `nav_msgs/msg/Odometry` | x, y, yaw; quyết định `rosConnected` | như trên |

- Identifier cũng đổi theo: `cmdOut*` → `cmdIn*` (`CMD_IN_TOPIC`, `buildCmdInMessage`, `createCmdInService`, `runtime.cmdInService`, script `backend/scripts/cmdin-demo.mjs`, test `backend/test/cmdIn.test.mjs`).
- `/cmd_in` dùng `robot_hmi_msgs/msg/CmdIn` với mode chữ hoa, `target: PoseStamped[]`, `joystick.v_m/v_rad` và `original_poss: PoseStamped`. `header.stamp = 0` đánh dấu pose ban đầu chưa được chọn. Build: `source /opt/ros/jazzy/setup.bash && cd ros2_ws && colcon build --packages-select robot_hmi_msgs`. rosbridge, `ros2 topic echo` và node robot đều phải source `ros2_ws/install/setup.bash`.
- Bắt đầu mapping → `SLAM`; dừng/lưu mapping → `STOP`. Bật switch manual → `MANUAL`; tắt switch và trả lease → `AUTO`. Chọn điểm hiện tại hoặc đích cập nhật `original_poss`/`target` và phát `AUTO` ngay. Bấm Yêu cầu dừng hoặc hủy mission → `STOP`.
- Nhả joystick gửi stop an toàn với `keepMode: true` và giữ mode; trả lease manual chủ động chuyển `AUTO`. `original_poss` chỉ giữ trong bộ nhớ backend; chưa nhập thì tạo mission trả `409 ORIGINAL_POSITION_REQUIRED`.
- `/cmd_in` chỉ phát khi có lệnh được chấp nhận; `AUTO` luôn gửi joystick 0; nối lại rosbridge phát lại gói cuối với joystick 0.
- Phía robot phải đổi theo (publish vận tốc lên `/cmd_out`, subscribe lệnh `/cmd_in`). Chưa xác nhận với nhóm robot.
- Ý tưởng chưa làm: gộp x, y, yaw và vận tốc vào một message `/cmd_out` thay cho `/odom`.

## Môi trường đã setup (2026-10-19)

- **Conda env `robot-hmi`**: chỉ chứa Node **22.23.3** (bản chính thức từ nodejs.org, giải nén vào `$CONDA_PREFIX`; conda-forge không có bản này). **Không có Python** → `python3` vẫn là `/usr/bin/python3`, nên ROS/rclpy chạy được khi env đang bật. Không cài thêm python vào env này.
- `conda config --set auto_activate_base false` (tránh conda base đè Python của ROS).
- **ROS 2 Jazzy** qua apt: `ros-jazzy-desktop`, `ros-dev-tools`, `ros-jazzy-rosbridge-suite`. Không source trong `~/.bashrc`, chỉ source ở terminal cần ROS.
- **GStreamer**: có sẵn các plugin `rawvideoparse`, `videoconvert`, `vp8enc`, `rtpvp8pay`.
- **PostgreSQL** (apt, systemd): role `robot_hmi`, database `robot_hmi_dev`, migration đã chạy.
- **`backend/.env`** (chmod 600, không commit): `DATABASE_URL`, `SESSION_SECRET` (`openssl rand -hex 32`), `DATA_DIR=/home/it/.local/share/robot-hmi/dev`, `ROSBRIDGE_URL=ws://127.0.0.1:9090`, `TRUST_LOOPBACK_PROXY=true`, `CAMERA_MEDIA_MODE=demo`.
- Admin HMI: `it-vkist`.
- **Chưa có**: MediaMTX, chứng chỉ dev, gói ROS `camera` (`ros2_ws`, repo riêng, không nằm trong folder này).

## Luồng 1: Chỉ frontend, chế độ mock (không cần backend/DB/ROS)

```bash
conda activate robot-hmi
cd /home/it/Documents/ROBOT_HMI/frontend
npm run dev            # frontend/.env.local đặt VITE_ROBOT_CLIENT=mock
```

## Luồng 2: Frontend + backend + ROS (mỗi lệnh một terminal)

```bash
# T1: rosbridge (bỏ qua nếu ROSBRIDGE_URL để trống); phải source ros2_ws để biết kiểu CmdIn
cd /home/it/Documents/ROBOT_HMI && source /opt/ros/jazzy/setup.bash && source ros2_ws/install/setup.bash
ros2 launch rosbridge_server rosbridge_websocket_launch.xml      # :9090

# T2: backend
conda activate robot-hmi && cd /home/it/Documents/ROBOT_HMI
node --env-file=backend/.env backend/src/server.js               # 127.0.0.1:3001

# T3: frontend
conda activate robot-hmi && cd /home/it/Documents/ROBOT_HMI/frontend
VITE_ROBOT_CLIENT=remote npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Mở **`http://127.0.0.1:5173/login`** (phải là `127.0.0.1`, không dùng `localhost`, vì backend kiểm tra `APP_ORIGIN`).
Kiểm tra: `curl http://127.0.0.1:3001/api/health/live` → 200. `ready` trả 503 khi chưa có `/odom`, đây là hành vi đúng thiết kế.

## Luồng 3: Camera ROS thật (cần thêm)

Một lần: `bash tools/ros-camera/install_mediamtx.sh && bash tools/ros-camera/create_dev_cert.sh`.
Đổi `.env`: `CAMERA_MEDIA_MODE=ros`, `CAMERA_WHEP_BASE_URL=https://127.0.0.1:8889`, `APP_ORIGIN=https://127.0.0.1:5173`.

```bash
bash tools/ros-camera/run_mediamtx.sh                                           # MediaMTX
source /opt/ros/jazzy/setup.bash && python3 -u tools/ros-camera/ros_camera_gateway.py   # gateway
HTTPS=true VITE_ROBOT_CLIENT=remote npm run dev -- --host 127.0.0.1 --port 5173 --strictPort  # frontend (trong frontend/)
```
Ảnh phải là `bgr8` 640×360. Truy cập từ máy khác trong LAN: xem `HUONG_DAN_KHOI_DONG_WEB_APPLICATION_CHO_NGUOI_MOI.md` (đổi `/home/vistar/projects` thành `/home/it/Documents`).

## Database và tài khoản

```bash
cd backend
MIGRATE_DATABASE=true node --env-file=.env scripts/migrate.mjs     # → MIGRATION_CHECKED_OR_APPLIED

read -rp 'User: ' PROVISION_ADMIN_USERNAME; read -rsp 'Pass: ' PROVISION_ADMIN_PASSWORD; echo
export PROVISION_ADMIN_USERNAME PROVISION_ADMIN_PASSWORD
PROVISION_ADMIN=true node --env-file=.env scripts/provision-admin.mjs  # → ADMIN_CREATED
unset PROVISION_ADMIN_USERNAME PROVISION_ADMIN_PASSWORD
```
- Username 3–64 ký tự `[A-Za-z0-9_-]`; mật khẩu ≥ 12 byte.
- Script **không đổi mật khẩu** user đã tồn tại (`ADMIN_ALREADY_EXISTS_UNCHANGED`). Quên mật khẩu (DB dev): `sudo -u postgres psql -d robot_hmi_dev -c "DELETE FROM users WHERE username='...';"`, rồi tạo lại.
- Script migrate/provision cố ý ẩn lỗi. Lỗi thường gặp: `.env` chưa lưu hoặc còn trống, mật khẩu DB có ký tự đặc biệt làm hỏng URL, username quá ngắn.

## Cài lại dependencies

```bash
npm ci --prefix packages/contracts && npm ci --prefix packages/control-domain \
  && npm ci --prefix backend && npm ci --prefix frontend
```

## Test và lint

```bash
cd backend && npm run test:unit                                          # không cần ROS
cd backend && ROSBRIDGE_URL=ws://127.0.0.1:9090 npm run test:ros-live    # cần ROS publish /odom, /cmd_out
cd frontend && npm run lint && npm run build
```

## Lưu ý

- `ROBOT_ADAPTER` bị khoá cứng là `mock`, `hardwareReady=false`. Không dùng HMI để lái robot thật.
- Backend chỉ nghe loopback; Vite proxy `/api`, `/ws`, `/map-stream` vào `HMI_BACKEND_URL` (chỉ chấp nhận `127.0.0.1:3001`/`3002`).
- `TRUST_LOOPBACK_PROXY=true` để tránh lỗi `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` khi chạy qua Vite proxy.
- Không commit `.env`, chứng chỉ trong `tools/ros-camera/.local/`, hoặc `tools/ros-camera/.bin/`.
