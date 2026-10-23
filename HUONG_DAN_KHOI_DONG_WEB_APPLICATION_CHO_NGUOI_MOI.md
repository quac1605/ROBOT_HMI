# Khởi động ROBOT_HMI, xem camera, bản đồ `/map` và vị trí `/odom` trong LAN

Tài liệu này dành cho người mới tiếp quản repository tại
`/home/vistar/projects/ROBOT_HMI`. Mục tiêu của lần chạy là: mở trang HMI từ
một máy khác trong LAN, đăng nhập bằng tài khoản đã có, xem camera trước/sau
và bản đồ ROS `/map` trên Navigation hoặc Mapping. Trang Navigation còn hiển thị
tọa độ và hướng robot từ `/odom`. Các lệnh đã được đối chiếu với code ngày
22/10/2026. Nếu mạng thay đổi, kiểm lại IP trước khi chạy.

> **Phạm vi an toàn:** Camera `/image_front`, `/image_rear`, bản đồ `/map` và
> vị trí `/odom` là dữ liệu ROS 2 thật khi các nguồn tương ứng hoạt động.
> Backend điều khiển vẫn dùng `ROBOT_ADAPTER=mock`. Thấy video, bản đồ hoặc
> vị trí **không** chứng minh motor hay teleop phần cứng đã sẵn sàng. Bản đồ
> ROS trên Navigation chỉ để xem; muốn đặt đích/waypoint phải chọn bản đồ đã
> lưu. Không dùng trang này để thử lái robot thật; `hardwareReady` vẫn là
> `false`.

## 1. Hiểu các thành phần trước khi mở terminal

```text
Camera ROS node ── /image_front, /image_rear ──> ROS camera gateway
                                                    │ VP8/RTP loopback
                                                    ▼
Máy xem web ── WebRTC UDP :8189 ─────────────────> MediaMTX
      │                                             ▲ HTTPS :8889 (WHEP)
      └── HTTPS :5173 ──> Vite ── WHEP proxy ───────┘
                              └── API/WS loopback ──> Backend :3001 ── PostgreSQL dev
                                                        ▲
Node ROS phát /map ── nav_msgs/msg/OccupancyGrid ──> worker rclpy ──> API bản đồ
Node ROS phát /odom, /tf, /tf_static ──> rosbridge_server :9090
                                             └── WebSocket loopback ──> Backend :3001
```

| Thành phần | Chạy ở đâu | Vai trò |
| --- | --- | --- |
| Camera ROS node | Máy Ubuntu gắn camera | Publish hai topic ảnh. Chỉ chạy **một** node. |
| ROS camera gateway | Cùng máy Ubuntu | Subscribe hai topic, kiểm metadata, mã hóa video. |
| MediaMTX | Cùng máy Ubuntu | Nhận RTP trên loopback; cấp WebRTC video cho browser. |
| Backend + worker `/map` | Cùng máy Ubuntu | Đăng nhập, API/WS, camera grant; subscribe `/map` liên tục khi backend chạy; lấy `/odom` và TF qua rosbridge khi `ROSBRIDGE_URL` được đặt; vẫn dùng mock robot. |
| rosbridge_server | Cùng máy Ubuntu | Cầu WebSocket cục bộ cho backend đọc `/odom`, `/tf`, `/tf_static` và `/cmd_in`. |
| Vite | Cùng máy Ubuntu | Phục vụ frontend qua HTTPS; proxy API/WS vào backend và WHEP vào MediaMTX. |
| Browser | Máy Ubuntu hoặc máy khác trong LAN | Mở HMI, nhận WebRTC và xem ảnh bản đồ qua cùng Origin `5173`. |

Giữ **mỗi nhóm lệnh ở mục 5 trong một terminal riêng** để thấy log và dừng
bằng `Ctrl+C`. Chạy Terminal R (rosbridge) trước Terminal A. Script HMI ở
Terminal A tự chạy **cả backend và Vite**. Nếu chúng đã chạy, không mở thêm
bản thứ hai.

## 2. Trước mỗi lần chạy: chọn IP và kiểm tra môi trường

Các lệnh trong tài liệu chạy trên **máy Ubuntu chứa repository** trừ khi ghi
"máy xem web". Mở một terminal kiểm tra:

```bash
cd /home/vistar/projects/ROBOT_HMI
pwd
ip -br -4 address
source /home/vistar/.nvm/nvm.sh
nvm use
node --version
pg_isready -h 127.0.0.1 -p 5432
```

- `pwd` phải là `/home/vistar/projects/ROBOT_HMI`; `.nvmrc` hiện yêu cầu
  Node `22.23.3`. `pg_isready` phải báo PostgreSQL nhận kết nối. Nó **chưa**
  chứng minh mật khẩu/database đúng.
- Chọn **IP của máy Ubuntu** trên mạng mà browser truy cập được, không chọn IP
  của máy browser hoặc `127.0.0.1`. Ví dụ bên dưới dùng `10.1.10.32`. Nếu IP
  khác, thay giá trị ở **mọi terminal**. `export` ở một terminal không tự truyền
  sang terminal khác.
- Máy xem web phải có đường mạng đến IP đó. Browser cần tới `5173/tcp` và
  `8189/udp` trên Ubuntu. Vite trên chính Ubuntu gọi MediaMTX ở `8889/tcp`;
  browser không gọi trực tiếp cổng này. Backend `3001/tcp` và RTP
  `5004/5006/udp` chỉ cần loopback; không mở chúng ra LAN. Rosbridge `9090/tcp`
  cũng chỉ dành cho backend trên Ubuntu.

Kiểm tra nhanh các thành phần đã cài, **không cài lại nếu chúng đang có**:

```bash
test -d frontend/node_modules && echo 'Frontend dependencies: có'
test -d backend/node_modules && echo 'Backend dependencies: có'
test -x tools/ros-camera/.bin/mediamtx && echo 'MediaMTX: có'
source /opt/ros/jazzy/setup.bash
ros2 pkg prefix rosbridge_server >/dev/null 2>&1 && echo 'rosbridge_server: có'
for plugin in rawvideoparse videoconvert vp8enc rtpvp8pay; do
  if gst-inspect-1.0 "$plugin" >/dev/null 2>&1; then
    echo "$plugin: có"
  else
    echo "$plugin: thiếu"
  fi
done
test -f backend/.env && echo 'Backend dev env: có'
```

Thiếu một mục thì xử lý theo **mục 3**, rồi quay lại đây. Nếu mọi mục đã có,
đi thẳng **mục 4**. Đừng gửi nội dung `backend/.env`, mật khẩu, cookie, CSRF,
camera grant hoặc SDP vào chat/ticket.

## 3. Chuẩn bị một lần, chỉ cho phần còn thiếu

### 3.1. Dependencies và MediaMTX

Nếu `node_modules` của package nào thiếu, từ repository root cài bằng lockfile:

```bash
cd /home/vistar/projects/ROBOT_HMI
source /home/vistar/.nvm/nvm.sh
nvm use
npm ci --prefix packages/contracts
npm ci --prefix packages/control-domain
npm ci --prefix backend
npm ci --prefix frontend
```

`npm ci` tải package và **thay nội dung `node_modules`** của package đích;
chỉ chạy các dòng cho package bị thiếu, theo thứ tự ở trên. Nếu MediaMTX chưa có:

```bash
cd /home/vistar/projects/ROBOT_HMI
bash tools/ros-camera/install_mediamtx.sh
```

Script tải bản MediaMTX đã ghim phiên bản và kiểm SHA-256. Nếu thiếu plugin
GStreamer hoặc package ROS, dừng ở đây và đối chiếu với
[`tools/ros-camera/README.md`](tools/ros-camera/README.md) và
[`ros2_ws/src/camera/README.md`](/home/vistar/projects/ros2_ws/src/camera/README.md);
không sửa gateway để nhận một định dạng ảnh khác mà chưa kiểm camera node.

Nếu thiếu `rosbridge_server`, cài package ROS 2 Jazzy một lần trên máy Ubuntu:

```bash
sudo apt update
sudo apt install ros-jazzy-rosbridge-suite
```

Backend dùng rosbridge để đọc `/odom` và các transform TF; worker `/map` dùng
`rclpy` riêng. Chỉ cần rosbridge trên máy Ubuntu chạy backend; browser không
kết nối trực tiếp tới cổng `9090`.

### 3.2. Backend development và tài khoản

Chỉ nếu `backend/.env` chưa tồn tại:

```bash
cd /home/vistar/projects/ROBOT_HMI/backend
test -e .env || cp .env.example .env
chmod 600 .env
```

Mở `.env` **trong editor trên máy Ubuntu**. Điền `DATABASE_URL` của database
development đã chuẩn bị, `SESSION_SECRET` ngẫu nhiên 64–128 ký tự hex, và
`DATA_DIR` là đường dẫn tuyệt đối. Có thể tạo secret cục bộ bằng
`openssl rand -hex 32`; không dùng secret mẫu hay gửi secret ra ngoài. Giữ
`NODE_ENV=development`, `HOST=127.0.0.1`, `PORT=3001`,
`ROBOT_ADAPTER=mock`, `CAMERA_MEDIA_MODE=ros`, `ROS_MAP_ENABLED=true`,
`ROS_MAP_SETUP=/opt/ros/jazzy/setup.bash` (hoặc để dùng mặc định Jazzy) và
`ROSBRIDGE_URL=ws://127.0.0.1:9090`. Worker `/map` chạy độc lập với
`ROSBRIDGE_URL`; nếu biến này trống, Navigation không nhận `/odom`. Script
khởi động LAN ở mục 5
sẽ ghi đè `APP_ORIGIN`, `CAMERA_WHEP_BASE_URL` và `TRUST_LOOPBACK_PROXY` theo
IP; URL WHEP dùng cổng **5173** cùng Origin với web. **Không dùng
`backend/.env.test` để chạy web app.**

Nếu `DATA_DIR` đang là đường dẫn dev mặc định và chưa có thư mục:

```bash
mkdir -p /home/vistar/.local/share/robot-hmi/dev
```

Database dev **đã có schema và tài khoản thì bỏ qua đoạn sau**. Chỉ với một
database dev mới, đã xác nhận `DATABASE_URL` trỏ đúng database, chạy từ cwd
`backend`:

```bash
cd /home/vistar/projects/ROBOT_HMI/backend
source /home/vistar/.nvm/nvm.sh
nvm use
MIGRATE_DATABASE=true node --env-file=.env scripts/migrate.mjs
```

Migration **ghi schema vào database đích**; server không tự chạy migration.
Kỳ vọng `MIGRATION_CHECKED_OR_APPLIED`. Nếu báo `MIGRATION_FAILED`, dừng và
kiểm database/schema, không xóa bảng hay sửa checksum cho qua lỗi.

Nếu chưa có **bất kỳ** tài khoản HMI dev phù hợp, script hiện có có thể tạo
admin một lần. Không chạy để "đoán lại" mật khẩu của user đã tồn tại:

```bash
cd /home/vistar/projects/ROBOT_HMI/backend
read -rp 'Tên admin mới: ' PROVISION_ADMIN_USERNAME
read -rsp 'Mật khẩu admin mới: ' PROVISION_ADMIN_PASSWORD; printf '\n'
export PROVISION_ADMIN_USERNAME PROVISION_ADMIN_PASSWORD
PROVISION_ADMIN=true node --env-file=.env scripts/provision-admin.mjs
unset PROVISION_ADMIN_USERNAME PROVISION_ADMIN_PASSWORD
```

Lệnh có thể **ghi user mới** vào DB dev. Kỳ vọng `ADMIN_CREATED` hoặc
`ADMIN_ALREADY_EXISTS_UNCHANGED`; trường hợp thứ hai **không đổi mật khẩu**
user cũ. Username phải có 3–64 ký tự chữ/số/`_`/`-`; mật khẩu dài ít nhất 12
byte UTF-8. Nhập mật khẩu trong terminal riêng, không đưa lên command line,
log chia sẻ hay tài liệu.

### 3.3. Chứng chỉ HTTPS theo IP hiện tại

Trên máy Ubuntu, từ repository root:

```bash
cd /home/vistar/projects/ROBOT_HMI
export HMI_LAN_IP=10.1.10.32   # THAY bằng IP của máy Ubuntu ở mục 2
ls -l "tools/ros-camera/.local/lan-${HMI_LAN_IP}.crt" \
      "tools/ros-camera/.local/lan-${HMI_LAN_IP}.key"
```

Nếu **cả hai file chưa có**, tạo một lần:

```bash
bash tools/ros-camera/create_lan_dev_cert.sh "$HMI_LAN_IP"
```

Nếu chỉ thiếu một file, dừng để kiểm tra; script cố ý không ghi đè. Kiểm
chứng chỉ (không in private key):

```bash
openssl x509 -in "tools/ros-camera/.local/lan-${HMI_LAN_IP}.crt" \
  -noout -dates -ext subjectAltName -fingerprint -sha256
```

`subjectAltName` phải chứa IP hiện tại, ngày hết hạn còn hiệu lực. Ghi lại
SHA-256 fingerprint để kiểm trên browser. Chứng chỉ development tự ký có hiệu
lực 30 ngày và private key nằm trong thư mục Git bỏ qua. Nếu IP đổi, tạo cặp
file cho IP mới; không dùng chứng chỉ của IP cũ. Nếu **cùng IP nhưng chứng chỉ
đã hết hạn**, script sẽ không ghi đè: dừng các dịch vụ HTTPS, lưu cặp file cũ
vào thư mục riêng chỉ bạn đọc được, rồi tạo cặp mới:

```bash
cd /home/vistar/projects/ROBOT_HMI
umask 077
backup_dir="tools/ros-camera/.local/cert-backup-$(date +%Y%m%dT%H%M%S)"
mkdir -m 700 "$backup_dir"
mv -- "tools/ros-camera/.local/lan-${HMI_LAN_IP}.crt" \
       "tools/ros-camera/.local/lan-${HMI_LAN_IP}.key" "$backup_dir/"
bash tools/ros-camera/create_lan_dev_cert.sh "$HMI_LAN_IP"
```

Chỉ làm khi đã xác nhận đúng IP và **cả hai file cũ** tồn tại. Sau đó kiểm
fingerprint mới và chấp nhận chứng chỉ mới trên browser.

## 4. Kiểm tra nguồn ROS trước khi chạy web

### 4.1. Hai camera

Mở **Terminal ROS** trên máy Ubuntu:

```bash
source /opt/ros/jazzy/setup.bash
source /home/vistar/projects/ros2_ws/install/setup.bash
pgrep -af intel_camera_node || true
ros2 topic info --verbose /image_front
ros2 topic info --verbose /image_rear
```

Mỗi topic phải có publisher loại `sensor_msgs/msg/Image`. Nếu publisher đã
chạy, **không** launch node thứ hai. Nếu `pgrep` cho thấy node đang chạy nhưng
ROS CLI không thấy publisher, dừng và kiểm `ROS_DOMAIN_ID`/môi trường DDS thay
vì mở thêm thiết bị camera. Chỉ khi node thực sự chưa chạy, package `camera` đã
được build trong `ros2_ws` và hai camera vật lý đã sẵn sàng, dùng một terminal
riêng để chạy node:

```bash
source /opt/ros/jazzy/setup.bash
source /home/vistar/projects/ros2_ws/install/setup.bash
ros2 launch camera camera.launch.py
```

Sau đó kiểm `ros2 topic info --verbose` lại. Lệnh launch dùng tham số camera
trong `/home/vistar/projects/ros2_ws/src/camera/config/camera_params.yaml` và
mở thiết bị camera; chỉ chạy một instance. Gateway HMI hiện yêu cầu ảnh `bgr8`,
`640×360`, stride `1920`, frame ID `camera_front_link`/
`camera_rear_link`, với QoS `BEST_EFFORT`. Nếu node đã đổi dữ liệu, gateway sẽ
từ chối ảnh thay vì hiển thị nhầm camera.

### 4.2. Bản đồ `/map`

Trong Terminal ROS đã source Jazzy ở trên, chạy:

```bash
ros2 topic info /map -v
```

Để thấy bản đồ thật, topic phải có **Publisher count ít nhất 1**, type
`nav_msgs/msg/OccupancyGrid`. Nếu chưa có publisher, mở node SLAM hoặc
`map_server` của robot theo quy trình robot của bạn; HMI không tự tạo bản đồ.
Nếu lệnh báo `Unknown topic '/map'`, nguồn chưa chạy hoặc `ROS_DOMAIN_ID`/DDS
của terminal khác với robot. Sau khi Terminal A ở mục 5 chạy, lệnh này còn
phải thấy **hai subscription** tên `robot_hmi_map_raster`: một
`RELIABLE`/`TRANSIENT_LOCAL` nhận map đã phát trước đó, và một
`BEST_EFFORT`/`VOLATILE` nhận luồng đang cập nhật. Không cần khởi động lại HMI
khi publisher `/map` xuất hiện sau.

### 4.3. Vị trí `/odom` và hệ tọa độ TF

Trong cùng môi trường ROS 2 với robot:

```bash
ros2 topic info /odom -v
ros2 topic echo /odom --once
ros2 topic info /tf -v
ros2 topic info /tf_static -v
```

`/odom` cần publisher loại `nav_msgs/msg/Odometry`. Trong message, xem
`header.frame_id` (thường là `odom`), `pose.pose.position.x/y` (mét) và
`pose.pose.orientation.x/y/z/w` (quaternion). Backend chuẩn hóa quaternion
rồi tính yaw; Navigation hiển thị X, Y và góc quay theo độ trong ô trạng thái.
Nếu chưa có message, kiểm nguồn ROS, `ROS_DOMAIN_ID` và DDS trước khi mở HMI.

Map và odometry có thể ở **hai hệ tọa độ khác nhau**. Nếu `/map` có
`header.frame_id=map` và `/odom` có `header.frame_id=odom`, robot cần publish
TF `map ← odom` qua `/tf` hoặc `/tf_static`; thử:

```bash
ros2 run tf2_ros tf2_echo map odom
```

Lệnh chạy liên tục; thấy transform mới rồi nhấn `Ctrl+C`. Không có transform
thì HMI vẫn có thể hiện X/Y/yaw của `/odom`, nhưng **không đặt marker robot
vào lưới `/map` bằng tọa độ odom**. Khi frame giống nhau, HMI dùng pose trực
tiếp. Pose cũ hoặc nằm ngoài vùng lưới cũng không được vẽ. Lần kiểm trên máy
ngày 22/10/2026 thấy `/odom` ở frame `odom`, `/map` ở frame `map` và node SLAM
có transform động `map ← odom`; `/tf_static` không có publisher vẫn hợp lệ nếu
transform cần thiết đã đến từ `/tf`.

## 5. Khởi động Web Application: bốn terminal

Trước khi chạy, kiểm tra cổng để tránh mở bản thứ hai:

```bash
ss -lntup | grep -E ':(3001|5173|8889|8189|5004|5006|9090)\b' || true
curl -sS -o /dev/null -w 'Backend HTTP %{http_code}\n' \
  http://127.0.0.1:3001/api/health/live
```

Nếu backend trả `200` hoặc cổng đã có tiến trình, xem terminal/log của tiến
trình đó. Nếu là HMI cũ hoặc IP cũ, dừng bằng `Ctrl+C` ở đúng terminal trước
khi chạy lại. **Terminal A sẽ tự mở cả cổng 3001 và 5173**; không chạy thêm
backend hay Vite trong terminal khác. `curl` lỗi kết nối hoặc `HTTP 000` chỉ
cho biết backend chưa trả lời, không phải lý do để dừng một tiến trình khác.

### Terminal R — rosbridge cho `/odom` (mở trước Terminal A)

```bash
source /opt/ros/jazzy/setup.bash
source /home/vistar/projects/ros2_ws/install/setup.bash
ros2 launch rosbridge_server rosbridge_websocket_launch.xml address:=127.0.0.1
```

Kỳ vọng log báo WebSocket server chạy ở cổng `9090`; `ss -lnt | grep :9090`
phải cho thấy địa chỉ `127.0.0.1:9090`. Dùng cùng `ROS_DOMAIN_ID` và môi
trường DDS với node phát `/odom`, `/map`, `/tf`. Nếu cổng đã được rosbridge
chiếm, dùng instance đó sau khi kiểm đúng môi trường ROS thay vì chạy thêm.
Giữ terminal này mở trong suốt thời gian xem vị trí robot.

### Terminal A — Backend và frontend HTTPS

```bash
cd /home/vistar/projects/ROBOT_HMI
source /home/vistar/.nvm/nvm.sh
nvm use
export HMI_LAN_IP=10.1.10.32   # THAY bằng IP Ubuntu ở mục 2
bash tools/run_hmi_lan.sh
```

Kỳ vọng `ROBOT_HMI backend listening on 127.0.0.1:3001` và
`HMI LAN: https://<IP>:5173/login`, sau đó Vite báo ready. Script kiểm IP đã
gán, chứng chỉ còn hạn/có SAN đúng IP và `backend/.env` tồn tại. Nó đặt
`APP_ORIGIN=https://<IP>:5173`, `CAMERA_WHEP_BASE_URL=https://<IP>:5173`,
`TRUST_LOOPBACK_PROXY=true`, `VITE_ROBOT_CLIENT=remote`, rồi chạy backend và
Vite dev server. Vite proxy API/WS vào backend loopback và WHEP
`/front/whep`, `/rear/whep` vào MediaMTX `https://<IP>:8889` bằng chứng chỉ
đã kiểm. Với `ROSBRIDGE_URL` trong `backend/.env`, backend duy trì kết nối tới
Terminal R, subscribe `/odom`, `/tf`, `/tf_static` và gửi trạng thái mới nhất
qua WebSocket `/ws`. Một lần `Ctrl+C` dừng cả backend lẫn Vite.

Vite dev server phục vụ code hiện tại và hot reload; **không cần build trước
mỗi lần chạy**. Khi muốn kiểm build riêng, chạy `npm run build` trong
`frontend/`; build không tự khởi động server. Backend có thể đọc/ghi session
và reconcile map/mission trong DB dev, nhưng script không chạy migration.
Nếu `BACKEND_START_FAILED`, kiểm PostgreSQL, `.env`, migration và cổng 3001;
không tiếp tục đăng nhập khi backend chưa chạy.

### Terminal B — MediaMTX

```bash
cd /home/vistar/projects/ROBOT_HMI
export HMI_LAN_IP=10.1.10.32   # THAY bằng IP Ubuntu ở mục 2
bash tools/ros-camera/run_mediamtx.sh
```

Kỳ vọng log có `WebRTC started with listeners on <IP>:8889 ...
<IP>:8189` và `path front/rear RTP source started`. Script bind WHEP/ICE trên
IP LAN, dùng chứng chỉ cho IP đó và chỉ cho phép Origin web tương ứng.
MediaMTX kiểm camera grant qua backend loopback. Browser chỉ cần tin cậy
Origin `5173`; WHEP đi qua Vite, còn media đi trực tiếp qua UDP `8189`.
Chỉ **một** MediaMTX được nhận RTP `127.0.0.1:5004/5006`. Nếu một bản khác
chiếm cổng RTP, UI có thể báo `CAMERA_WHEP_HTTP_404` vì bản LAN không có stream.

### Terminal C — ROS camera gateway

```bash
cd /home/vistar/projects/ROBOT_HMI
source /opt/ros/jazzy/setup.bash
source /home/vistar/projects/ros2_ws/install/setup.bash
python3 -u tools/ros-camera/ros_camera_gateway.py
```

Kỳ vọng log `front: /image_front -> VP8/RTP 127.0.0.1:5004`, dòng tương tự
cho rear `5006`, rồi `sent frames front=... rear=...` mỗi 10 giây. Các bộ đếm
phải tăng khi camera node đang publish. Gateway chạy hai tiến trình GStreamer
con; `Ctrl+C` sẽ dọn chúng. MediaMTX tiếp đó phải báo front/rear `stream is
available and online, 1 track (VP8)`. Nếu counter không tăng, quay lại mục 4.

Không có terminal riêng cho `/map`: worker `robot_hmi_map_raster` tự khởi động
trong backend của Terminal A khi `ROS_MAP_ENABLED=true`. Backend giữ hai
subscription `/map` ngay cả khi chưa có browser; frontend hỏi metadata mỗi
giây và tải PNG mới khi lưới thay đổi. Rosbridge ở Terminal R nhận các topic
trạng thái ROS, còn backend giữ subscription `/odom` và TF khi chưa có browser.

## 6. Kiểm tra dịch vụ trước khi mở browser

Trong terminal kiểm tra trên máy Ubuntu (thay IP cho đúng):

```bash
cd /home/vistar/projects/ROBOT_HMI
export HMI_LAN_IP=10.1.10.32
curl --cacert "tools/ros-camera/.local/lan-${HMI_LAN_IP}.crt" \
  -sS -o /dev/null -w 'Web/API HTTP %{http_code}\n' \
  "https://${HMI_LAN_IP}:5173/api/health/live"
ss -lntu | grep -E ':(3001|5173|8889|8189|5004|5006|9090)\b' || true
```

Kỳ vọng health live `200`; đây chỉ chứng minh HTTP/backend chạy. `ready` có
thể trả `503` vì robot source chưa được xác minh và `hardwareReady=false`, dù
camera và `/map` vẫn xem được. `5173/tcp`, `8889/tcp`, `8189/udp` phải nghe
trên IP LAN; `3001/tcp`, `9090/tcp` và `5004/5006/udp` phải ở `127.0.0.1`. Browser chỉ
cần tới `5173/tcp` và `8189/udp`; `8889/tcp` là đường Vite tới MediaMTX trên
cùng máy Ubuntu. Nếu `curl` báo lỗi TLS, kiểm IP trong chứng chỉ; **không**
chuyển sang `curl -k` để che lỗi.

Kiểm tra ROS sau khi backend đã chạy:

```bash
source /opt/ros/jazzy/setup.bash
ros2 topic info /map -v
ros2 topic info /odom -v
ros2 topic info /tf -v
```

Kỳ vọng ít nhất hai subscription, trong đó có hai dòng của
`robot_hmi_map_raster`. Để có ảnh bản đồ
thật, còn cần `Publisher count: 1` trở lên. Nếu publisher bằng `0`, HMI sẽ báo
đang chờ dữ liệu `/map`; đừng thử khởi động worker thứ hai.
`/odom` phải có publisher và subscription từ `rosbridge_websocket`. Khi map
và odom khác frame, `/tf` hoặc `/tf_static` phải cung cấp transform `map ←
odom` như mục 4.3. Nếu rosbridge chưa hiện trong ROS graph, kiểm Terminal R và
`ROS_DOMAIN_ID`/DDS trước khi xem Navigation.

## 7. Mở và kiểm tra trên máy xem web

1. Kết nối máy xem web với mạng có thể đi đến IP Ubuntu. Mở chính xác
   `https://<IP-UBUNTU>:5173/login`, ví dụ
   `https://10.1.10.32:5173/login`. Không dùng `localhost`, `127.0.0.1` hoặc
   IP cũ: backend kiểm `APP_ORIGIN` chính xác.
2. Browser sẽ cảnh báo chứng chỉ development tự ký. Tự so SHA-256 fingerprint
   với kết quả ở mục 3.3 rồi mới chấp nhận cho Origin `5173`. WHEP đi qua
   cùng Origin nên không cần mở `https://<IP-UBUNTU>:8889/` trong browser.
3. Đăng nhập bằng **tài khoản HMI dev đã có**. Mở Navigation; ô camera ở bên
   phải map. Chọn **Cam trước**, nhìn ảnh có thay đổi; chọn **Cam sau** và
   kiểm lại. Sang Mapping và làm tương tự. Không cần bấm joystick hoặc tạo
   phiên mapping để xem camera.
4. Navigation mặc định chọn **ROS /map (trực tiếp)**. Khi node robot phát
   `/map`, ô bản đồ hiện lưới OccupancyGrid và tự cập nhật khi ô bản đồ đổi.
   Mapping cũng ưu tiên `/map` nếu chưa chọn bản đồ đã lưu. Có thể phóng to,
   thu nhỏ, kéo bản đồ. Ô **Trạng thái robot** trên Navigation hiển thị X, Y
   theo mét và góc quay theo độ từ `/odom`, kèm `frame_id`. Marker và mũi tên
   hướng trên bản đồ ROS dùng pose đã đổi sang frame của `/map` bằng TF, hoặc
   dùng pose trực tiếp khi hai frame trùng nhau. Thiếu TF, pose cũ hoặc pose
   ngoài vùng bản đồ thì marker không hiện; không nên sửa tọa độ thủ công để
   buộc hiển thị.
   Muốn đặt đích, thêm waypoint hoặc tạo nhiệm vụ trên Navigation, chọn một
   **bản đồ đã lưu** trong menu: chế độ `/map` trực tiếp chỉ để quan sát.
5. Nếu cần kiểm kỹ, trong DevTools Network: request
   `GET /api/cameras/front/stream` hoặc rear phải trả descriptor `kind=webrtc`;
   `POST https://<IP>:5173/front/whep` hoặc rear phải trả `201`. Khi có
   publisher `/map`, `GET /api/ros-map` trả `status=ready` và
   `GET /api/ros-map/image?revision=...` trả PNG. Hai API map yêu cầu đã đăng
   nhập. Kiểm robot di chuyển/quay: X/Y/yaw ở ô trạng thái thay đổi; marker
   trên bản đồ đổi vị trí/hướng tương ứng nếu TF và map hợp lệ. Trong
   `about:webrtc`/WebRTC internals, ICE remote candidate phải là
   `<IP-UBUNTU>:8189`, có candidate pair được chọn và byte nhận tăng. Không
   chụp/chia sẻ `Authorization`, `grantToken`, cookie hay SDP.
6. Đăng xuất; video phải dừng. Nếu đổi mạng/IP, xem mục 9 rồi đăng nhập lại
   bằng URL mới.

## 8. Khi có lỗi, xem theo thứ tự

| Hiện tượng | Kiểm tra đầu tiên | Dừng ở đâu? |
| --- | --- | --- |
| `BACKEND_START_FAILED` | Kiểm `3001` trước: nếu backend cũ đã trả health `200` và đúng IP thì dừng bản cũ hoặc dùng bản đó, không chạy script lần hai. Nếu không, kiểm PostgreSQL, `.env` dev và migration; không in secret. | Terminal A, chưa mở browser. |
| `EADDRINUSE`/port đã dùng | Dịch vụ đã chạy chưa; không khởi động bản thứ hai. | Terminal tương ứng. |
| Không mở được `https://<IP>:5173` từ máy khác | IP Ubuntu, cùng mạng/route, Wi-Fi client isolation, firewall `5173/tcp`. | Chưa xét camera. |
| `ORIGIN_FORBIDDEN` khi login | URL browser phải trùng `APP_ORIGIN=https://<IP>:5173`; restart backend sau đổi IP. | Đăng nhập. |
| Browser báo lỗi chứng chỉ hoặc camera `NetworkError` | Kiểm chứng chỉ còn hạn/SAN đúng IP và đã tin cậy Origin `5173`. Xem DevTools: WHEP phải gọi `https://<IP>:5173/front/whep` hoặc rear; nếu vẫn gọi `:8889`, backend/Vite đang chạy cấu hình cũ. | Trước WHEP. |
| Chỉ thấy video MP4 mẫu | Có chạy đúng `tools/run_hmi_lan.sh` với `VITE_ROBOT_CLIENT=remote` không; backend `.env` có `CAMERA_MEDIA_MODE=ros` không. | Descriptor camera. |
| Camera WHEP `401` | Đã đăng nhập? Backend và callback media còn chạy? Grant còn hạn và đúng camera? | WHEP auth. |
| `CAMERA_WHEP_SIGNALING: CAMERA_WHEP_HTTP_404` | Xem log MediaMTX LAN: `no stream is available` cùng `bind: address already in use` ở `5004/5006` nghĩa là MediaMTX thứ hai đang chiếm RTP. Dùng `ss -ltnup` xác định bản chạy trùng, dừng đúng bản đó, chờ front/rear báo `stream is available and online`, rồi tải lại UI. | Nguồn RTP/MediaMTX; không sửa UI. |
| WHEP `201` nhưng ICE failed/ô đen | Candidate MediaMTX có IP LAN mới? Máy xem tới được `8189/udp`? Firewall/client isolation? | Đường video, sau signaling. |
| Front/rear không online | ROS publisher có hai topic? Gateway counter tăng? Metadata ảnh có đúng `bgr8`/640×360/frame ID? | ROS → gateway → RTP. |
| Navigation/Mapping báo chờ `/map` | Chạy `ros2 topic info /map -v`: phải có publisher `nav_msgs/msg/OccupancyGrid` và hai subscriber `robot_hmi_map_raster`; kiểm `ROS_DOMAIN_ID`/DDS và `ROS_MAP_ENABLED=true` nếu không thấy subscriber. | Nguồn ROS → backend. |
| Bản đồ cũ hoặc PNG lỗi | Kiểm log backend `ROS /map received`, trạng thái `GET /api/ros-map`, request PNG; web kiểm revision mỗi giây và tự thử tải lại. Nếu publisher biến mất, backend xóa ảnh cache và chuyển về chờ. | ROS worker → API → browser. |
| X/Y/góc quay trống hoặc `/odom` báo cũ | Kiểm publisher `/odom`, Terminal R ở cổng `9090`, `ROSBRIDGE_URL` trong `backend/.env`, `ROS_DOMAIN_ID`/DDS và log kết nối rosbridge. `/odom` phải tới đều trước khi hết hạn 1500 ms. | ROS `/odom` → rosbridge → backend `/ws`. |
| Có X/Y/góc quay nhưng không thấy marker trên `/map` | So `header.frame_id` của `/odom` với frame của `/map`; nếu khác, kiểm TF `map ← odom` bằng `tf2_echo`. Pose cũ hoặc nằm ngoài lưới cũng không vẽ. | TF/định vị và phạm vi bản đồ. |
| Robot báo `Stale` hoặc health ready `503` | Đây là robot mock/chưa xác minh source; không suy ra camera hỏng nếu video vẫn chạy. | Không dùng để cho phép motor thật. |

Đừng giảm kiểm tra Origin, tắt TLS toàn browser, mở backend `3001` ra LAN,
hoặc thêm STUN công cộng chỉ để che một lỗi routing trên mạng nội bộ.

## 9. Khi đổi mạng hoặc IP máy Ubuntu

1. Xem IP mới bằng `ip -br -4 address`; xác nhận máy browser có thể truy cập.
2. Dừng Terminal A (backend + Vite) và B (MediaMTX) bằng `Ctrl+C`. Gateway ROS
   và camera node có thể giữ nếu topic vẫn đang chạy.
3. Tạo chứng chỉ **mới** bằng `create_lan_dev_cert.sh <IP-MOI>`; kiểm SAN và
   fingerprint. Chứng chỉ cho IP cũ không tự hợp lệ ở IP mới.
4. Thay `HMI_LAN_IP` ở Terminal A và B rồi chạy lại các lệnh mục 5. Script
   dùng Vite dev server nên không cần build lại chỉ vì IP đổi.
5. Mở URL mới, chấp nhận chứng chỉ mới sau khi kiểm fingerprint, đăng nhập
   lại, thử cả hai camera, `/map` và `/odom`. Kiểm browser tới `5173/tcp`, `8189/udp`;
   Vite trên Ubuntu phải tới MediaMTX `8889/tcp` tại IP mới. Chỉ đổi IP của
   **máy xem web** thì không cần bước 2–4.

Để hạn chế thay đổi IP, có thể đặt DHCP reservation cho máy Ubuntu trên mạng
thường dùng. Cấu hình hiện tại chọn **một IP LAN**; muốn dùng tên DNS nội bộ
hoặc phục vụ nhiều interface đồng thời cần thiết kế lại chứng chỉ, Origin và
candidate MediaMTX, không chỉ sửa một URL.

## 10. Dừng hệ thống gọn gàng

Đăng xuất HMI, sau đó nhấn `Ctrl+C` tại Terminal C (gateway), B (MediaMTX),
A (backend + Vite) và R (rosbridge). Chỉ dừng camera ROS node nếu bạn đã khởi động nó
riêng ở mục 4 và không có ứng dụng khác đang dùng. Backend có handler shutdown
để đóng socket, thu hồi authority và pool DB; tránh `kill -9` trong thao tác
thông thường. Nếu cần báo lỗi cho người hỗ trợ, gửi lệnh/terminal, HTTP status,
thông báo lỗi đã che secret và IP LAN; không gửi `.env`, mật khẩu, token hoặc
toàn bộ `about:webrtc` chứa ICE credential.

### Tài liệu liên quan

- [Camera gateway](tools/ros-camera/README.md)
- [Luồng bản đồ ROS](tools/ros-map/README.md)
- [Kế hoạch Chặng 10](docs/CHANG_10_ROS_UBUNTU_TRIEN_KHAI.md)
- [Camera node ROS](</home/vistar/projects/ros2_ws/src/camera/README.md>)

Các hướng dẫn cũ về frontend mock không mô tả cấu hình LAN hiện tại; dùng
các lệnh đã kiểm trong tài liệu này cho lần chạy camera và `/map`.
