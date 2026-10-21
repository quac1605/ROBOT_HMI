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
# T1: rosbridge (bỏ qua nếu ROSBRIDGE_URL để trống)
source /opt/ros/jazzy/setup.bash
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
cd backend && npm run test:unit                                          # 23 test, không cần ROS
cd backend && ROSBRIDGE_URL=ws://127.0.0.1:9090 npm run test:ros-live    # cần ROS publish /odom, /cmd_out
cd frontend && npm run lint && npm run build
```

## Lưu ý

- `ROBOT_ADAPTER` bị khoá cứng là `mock`, `hardwareReady=false`. Không dùng HMI để lái robot thật.
- Backend chỉ nghe loopback; Vite proxy `/api`, `/ws`, `/map-stream` vào `HMI_BACKEND_URL` (chỉ chấp nhận `127.0.0.1:3001`/`3002`).
- `TRUST_LOOPBACK_PROXY=true` để tránh lỗi `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` khi chạy qua Vite proxy.
- Không commit `.env`, chứng chỉ trong `tools/ros-camera/.local/`, hoặc `tools/ros-camera/.bin/`.
