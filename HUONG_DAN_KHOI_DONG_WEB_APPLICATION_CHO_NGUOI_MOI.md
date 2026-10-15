# Khởi động ROBOT_HMI và xem hai camera từ máy trong LAN

Tài liệu này dành cho người mới tiếp quản repository tại
`/home/vistar/projects/ROBOT_HMI`. Mục tiêu của lần chạy là: mở trang HMI từ
một máy khác trong LAN, đăng nhập bằng tài khoản đã có, và xem camera trước/sau
trên Navigation hoặc Mapping. Các lệnh đã được đối chiếu với checkout ngày
14/10/2026. Nếu source hoặc mạng đã thay đổi, kiểm lại các đường dẫn và IP trước
khi chạy.

> **Phạm vi an toàn:** Camera `/image_front` và `/image_rear` là nguồn ROS 2
> thật, nhưng backend vẫn dùng `ROBOT_ADAPTER=mock`. Xem được video **không** có
> nghĩa là map, pose, motor hoặc teleop phần cứng đã sẵn sàng. Không dùng trang
> này để thử lái robot thật; `hardwareReady` vẫn là `false`.

## 1. Hiểu các thành phần trước khi mở terminal

```text
Camera ROS node  ── /image_front, /image_rear ──> ROS camera gateway
                                                     │ VP8/RTP, loopback
                                                     ▼
Máy xem web ── HTTPS :8889 + WebRTC UDP :8189 ──> MediaMTX
      │                                              │ kiểm camera grant
      └── HTTPS :5173 ──> Vite preview ── loopback ──> Backend :3001
                                                        │
                                                        └── PostgreSQL dev
```

| Thành phần | Chạy ở đâu | Vai trò |
| --- | --- | --- |
| Camera ROS node | Máy Ubuntu gắn camera | Publish hai topic ảnh. Chỉ chạy **một** node. |
| ROS camera gateway | Cùng máy Ubuntu | Subscribe hai topic, kiểm metadata, mã hóa video. |
| MediaMTX | Cùng máy Ubuntu | Nhận RTP trên loopback; cấp WebRTC video cho browser. |
| Backend | Cùng máy Ubuntu | Đăng nhập, session, API/WS và camera grant; vẫn dùng mock robot. |
| Vite preview | Cùng máy Ubuntu | Phục vụ bản frontend đã build qua HTTPS, proxy API/WS vào backend. |
| Browser | Máy Ubuntu hoặc máy khác trong LAN | Mở HMI và nhận video WebRTC. |

Giữ **mỗi tiến trình trong một terminal riêng** để thấy log và dừng bằng
`Ctrl+C`. Nếu tiến trình đã chạy đúng cấu hình, không chạy thêm bản thứ hai.

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
- Máy xem web phải có đường mạng đến IP đó. Cổng cần đi từ browser đến Ubuntu:
  `5173/tcp`, `8889/tcp`, `8189/udp`. Backend `3001/tcp` và RTP
  `5004/5006/udp` chỉ cần loopback; không mở chúng ra LAN.

Kiểm tra nhanh các thành phần đã cài, **không cài lại nếu chúng đang có**:

```bash
test -d frontend/node_modules && echo 'Frontend dependencies: có'
test -d backend/node_modules && echo 'Backend dependencies: có'
test -x tools/ros-camera/.bin/mediamtx && echo 'MediaMTX: có'
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
[`tools/ros-camera/README.md`](../tools/ros-camera/README.md) và
[`ros2_ws/src/camera/README.md`](/home/vistar/projects/ros2_ws/src/camera/README.md);
không sửa gateway để nhận một định dạng ảnh khác mà chưa kiểm camera node.

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
`ROBOT_ADAPTER=mock`, `CAMERA_MEDIA_MODE=ros`. File mẫu đã có `APP_ORIGIN` và
`TRUST_LOOPBACK_PROXY`; lệnh khởi động LAN ở mục 5 sẽ ghi đè đúng các giá trị
cần đổi theo IP. **Không dùng `backend/.env.test` để chạy web app.**

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

## 4. Kiểm tra camera ROS trước khi chạy web

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

## 5. Khởi động Web Application: mỗi dịch vụ một terminal

Trước khi chạy, kiểm tra các cổng để tránh khởi động trùng:

```bash
ss -lntu | grep -E ':(3001|5173|8889|8189|5004|5006)\b' || true
curl -sS -o /dev/null -w 'Backend HTTP %{http_code}\n' \
  http://127.0.0.1:3001/api/health/live
```

Nếu các dịch vụ HMI đã chạy đúng IP hiện tại, dùng chúng; nếu đang chạy cấu
hình IP cũ, dừng bằng `Ctrl+C` tại terminal cũ rồi mới khởi động lại. Dòng
`LISTEN`/`UNCONN` tự nó không xác định tiến trình; kiểm terminal/log trước khi
dừng bất kỳ process nào. Nếu backend trả `200` và đã xác nhận nó dùng đúng
`APP_ORIGIN`/IP hiện tại, **bỏ qua Terminal A**: chạy thêm một backend trên
`3001` sẽ báo `BACKEND_START_FAILED` vì cổng đã được dùng. `curl` trả lỗi kết
nối hoặc `HTTP 000` thì backend chưa trả lời; kiểm terminal backend trước khi
chạy lại.

### Terminal A — Backend HTTP/WS

```bash
cd /home/vistar/projects/ROBOT_HMI
source /home/vistar/.nvm/nvm.sh
nvm use
export HMI_LAN_IP=10.1.10.32   # THAY bằng IP Ubuntu ở mục 2
APP_ORIGIN="https://${HMI_LAN_IP}:5173" \
CAMERA_WHEP_BASE_URL="https://${HMI_LAN_IP}:8889" \
TRUST_LOOPBACK_PROXY=true \
node --env-file=backend/.env backend/src/server.js
```

Kỳ vọng: `ROBOT_HMI backend listening on 127.0.0.1:3001`. Giữ terminal mở.
Backend chỉ nghe loopback; Vite sẽ proxy `/api`, `/ws`, `/map-stream` đến nó.
Lệnh này đọc/ghi session và có thể reconcile dữ liệu map/mission trong DB dev,
nhưng **không** chạy migration. Nếu `BACKEND_START_FAILED`, **dừng**: kiểm
PostgreSQL, `.env`, migration và cổng 3001; không tiếp tục đăng nhập khi backend
chưa chạy.

### Terminal B — MediaMTX

```bash
cd /home/vistar/projects/ROBOT_HMI
export HMI_LAN_IP=10.1.10.32   # THAY bằng IP Ubuntu ở mục 2
bash tools/ros-camera/run_mediamtx.sh
```

Kỳ vọng log có `WebRTC started with listeners on <IP>:8889 ...
<IP>:8189` và `path front/rear RTP source started`. Script kiểm IP đã gán,
chứng chỉ tồn tại, bind WHEP/ICE trên IP LAN, chỉ cho phép Origin web tương
ứng. MediaMTX kiểm camera grant bằng callback vào backend loopback. Nếu báo
port đang dùng hoặc thiếu chứng chỉ, dừng và xử lý; không chạy thêm MediaMTX.
Chỉ **một** MediaMTX được nhận RTP `127.0.0.1:5004/5006`. Một bản loopback
khác có thể chiếm hai cổng này dù bản LAN vẫn chạy được WHEP `8889`; khi đó
UI nhận `CAMERA_WHEP_HTTP_404` vì bản LAN không có stream.

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
con; `Ctrl+C` sẽ dọn chúng. `MediaMTX` tiếp đó phải báo front/rear `stream is
available and online, 1 track (VP8)`. Nếu counter không tăng, quay lại mục 4.

### Terminal D — Frontend HTTPS

```bash
cd /home/vistar/projects/ROBOT_HMI/frontend
source /home/vistar/.nvm/nvm.sh
nvm use
export HMI_LAN_IP=10.1.10.32   # THAY bằng IP Ubuntu ở mục 2
VITE_ROBOT_CLIENT=remote npm run build
HMI_TLS_CERT_PATH="/home/vistar/projects/ROBOT_HMI/tools/ros-camera/.local/lan-${HMI_LAN_IP}.crt" \
HMI_TLS_KEY_PATH="/home/vistar/projects/ROBOT_HMI/tools/ros-camera/.local/lan-${HMI_LAN_IP}.key" \
HMI_BACKEND_URL=http://127.0.0.1:3001 \
npm run preview -- --host "$HMI_LAN_IP" --port 5173 --strictPort
```

`build` ghi `frontend/dist/` (Git bỏ qua) và nhúng mode `remote`; nó **không**
nhúng IP LAN, vì URL WHEP được backend cấp lúc chạy. `preview` phục vụ bản
build và proxy API/WS, không hot reload; sửa frontend thì build lại và tải
lại trang. Kỳ vọng Vite in URL `https://<IP>:5173/`. Đừng đổi
`HMI_BACKEND_URL` sang IP LAN: backend được cố ý giữ trên loopback.

## 6. Kiểm tra dịch vụ trước khi mở browser

Trong terminal kiểm tra trên máy Ubuntu (thay IP cho đúng):

```bash
cd /home/vistar/projects/ROBOT_HMI
export HMI_LAN_IP=10.1.10.32
curl --cacert "tools/ros-camera/.local/lan-${HMI_LAN_IP}.crt" \
  -sS -o /dev/null -w 'Web/API HTTP %{http_code}\n' \
  "https://${HMI_LAN_IP}:5173/api/health/live"
ss -lntu | grep -E ':(3001|5173|8889|8189|5004|5006)\b' || true
```

Kỳ vọng health live `200`; đây chỉ chứng minh HTTP/backend chạy. `ready` có
thể trả `503` vì robot source chưa được xác minh và `hardwareReady=false`, dù
camera vẫn xem được. `5173/tcp`, `8889/tcp`, `8189/udp` phải nghe trên IP LAN;
`3001/tcp` và `5004/5006/udp` phải ở `127.0.0.1`. Nếu `curl` báo lỗi TLS,
kiểm IP trong chứng chỉ; **không** chuyển sang `curl -k` để che lỗi.

## 7. Mở và kiểm tra trên máy xem web

1. Kết nối máy xem web với mạng có thể đi đến IP Ubuntu. Mở chính xác
   `https://<IP-UBUNTU>:5173/login`, ví dụ
   `https://10.1.10.32:5173/login`. Không dùng `localhost`, `127.0.0.1` hoặc
   IP cũ: backend kiểm `APP_ORIGIN` chính xác.
2. Browser sẽ cảnh báo chứng chỉ development tự ký. Tự so SHA-256 fingerprint
   với kết quả ở mục 3.3 rồi mới chấp nhận. Mở thêm
   `https://<IP-UBUNTU>:8889/` trong **cùng browser** để kiểm chứng chỉ của
   MediaMTX; trang gốc có thể trả 401/404, đây không phải lỗi video.
3. Đăng nhập bằng **tài khoản HMI dev đã có**. Mở Navigation; ô camera ở bên
   phải map. Chọn **Cam trước**, nhìn ảnh có thay đổi; chọn **Cam sau** và
   kiểm lại. Sang Mapping và làm tương tự. Không cần bấm joystick hoặc tạo
   phiên mapping để xem camera.
4. Nếu cần kiểm kỹ, trong DevTools Network: request
   `GET /api/cameras/front/stream` hoặc rear phải trả descriptor `kind=webrtc`;
   `POST https://<IP>:8889/front/whep` hoặc rear phải trả `201`. Trong
   `about:webrtc`/WebRTC internals, ICE remote candidate phải là
   `<IP-UBUNTU>:8189`, có candidate pair được chọn và byte nhận tăng. Không
   chụp/chia sẻ `Authorization`, `grantToken`, cookie hay SDP.
5. Đăng xuất; video phải dừng. Nếu đổi mạng/IP, xem mục 9 rồi đăng nhập lại
   bằng URL mới.

## 8. Khi có lỗi, xem theo thứ tự

| Hiện tượng | Kiểm tra đầu tiên | Dừng ở đâu? |
| --- | --- | --- |
| `BACKEND_START_FAILED` | Kiểm `3001` trước: nếu backend cũ đã trả health `200` và đúng IP thì dùng nó, không chạy bản thứ hai. Nếu không, kiểm PostgreSQL, `.env` dev và migration; không in secret. | Terminal A, chưa mở browser. |
| `EADDRINUSE`/port đã dùng | Dịch vụ đã chạy chưa; không khởi động bản thứ hai. | Terminal tương ứng. |
| Không mở được `https://<IP>:5173` từ máy khác | IP Ubuntu, cùng mạng/route, Wi-Fi client isolation, firewall `5173/tcp`. | Chưa xét camera. |
| `ORIGIN_FORBIDDEN` khi login | URL browser phải trùng `APP_ORIGIN=https://<IP>:5173`; restart backend sau đổi IP. | Đăng nhập. |
| Browser báo lỗi chứng chỉ hoặc `NetworkError` | Kiểm chứng chỉ còn hạn/SAN đúng IP, đã chấp nhận cả origin `5173` và `8889` trong cùng browser. | Trước WHEP. |
| Chỉ thấy video MP4 mẫu | Frontend có build `VITE_ROBOT_CLIENT=remote` không; backend `.env` có `CAMERA_MEDIA_MODE=ros` không. | Descriptor camera. |
| Camera WHEP `401` | Đã đăng nhập? Backend và callback media còn chạy? Grant còn hạn và đúng camera? | WHEP auth. |
| `CAMERA_WHEP_SIGNALING: CAMERA_WHEP_HTTP_404` | Xem log MediaMTX LAN: `no stream is available` cùng `bind: address already in use` ở `5004/5006` nghĩa là MediaMTX thứ hai đang chiếm RTP. Dùng `ss -ltnup` xác định bản chạy trùng, dừng đúng bản đó, chờ front/rear báo `stream is available and online`, rồi tải lại UI. | Nguồn RTP/MediaMTX; không sửa UI. |
| WHEP `201` nhưng ICE failed/ô đen | Candidate MediaMTX có IP LAN mới? Máy xem tới được `8189/udp`? Firewall/client isolation? | Đường video, sau signaling. |
| Front/rear không online | ROS publisher có hai topic? Gateway counter tăng? Metadata ảnh có đúng `bgr8`/640×360/frame ID? | ROS → gateway → RTP. |
| Robot báo `Stale` hoặc health ready `503` | Đây là robot mock/chưa xác minh source; không suy ra camera hỏng nếu video vẫn chạy. | Không dùng để cho phép motor thật. |

Đừng giảm kiểm tra Origin, tắt TLS toàn browser, mở backend `3001` ra LAN,
hoặc thêm STUN công cộng chỉ để che một lỗi routing trên mạng nội bộ.

## 9. Khi đổi mạng hoặc IP máy Ubuntu

1. Xem IP mới bằng `ip -br -4 address`; xác nhận máy browser có thể truy cập.
2. Dừng frontend, MediaMTX và backend cũ bằng `Ctrl+C`. Gateway ROS và camera
   node có thể giữ nếu topic vẫn đang chạy.
3. Tạo chứng chỉ **mới** bằng `create_lan_dev_cert.sh <IP-MOI>`; kiểm SAN và
   fingerprint. Chứng chỉ cho IP cũ không tự hợp lệ ở IP mới.
4. Thay `HMI_LAN_IP` ở Terminal A, B, D rồi chạy lại các lệnh mục 5. Không
   cần sửa code hay build lại chỉ vì IP đổi, nếu `frontend/dist` đã là bản
   `remote`; vẫn có thể chạy build lại để chắc chắn bản build mới nhất.
5. Mở URL mới, chấp nhận chứng chỉ mới sau khi kiểm fingerprint, đăng nhập
   lại, thử cả hai camera. Kiểm `5173/tcp`, `8889/tcp`, `8189/udp` trên mạng
   mới. Chỉ đổi IP của **máy xem web** thì không cần bước 2–4.

Để hạn chế thay đổi IP, có thể đặt DHCP reservation cho máy Ubuntu trên mạng
thường dùng. Cấu hình hiện tại chọn **một IP LAN**; muốn dùng tên DNS nội bộ
hoặc phục vụ nhiều interface đồng thời cần thiết kế lại chứng chỉ, Origin và
candidate MediaMTX, không chỉ sửa một URL.

## 10. Dừng hệ thống gọn gàng

Đăng xuất HMI, sau đó nhấn `Ctrl+C` tại Terminal D (frontend), C (gateway),
B (MediaMTX), A (backend). Chỉ dừng camera ROS node nếu bạn đã khởi động nó
riêng ở mục 4 và không có ứng dụng khác đang dùng. Backend có handler shutdown
để đóng socket, thu hồi authority và pool DB; tránh `kill -9` trong thao tác
thông thường. Nếu cần báo lỗi cho người hỗ trợ, gửi lệnh/terminal, HTTP status,
thông báo lỗi đã che secret và IP LAN; không gửi `.env`, mật khẩu, token hoặc
toàn bộ `about:webrtc` chứa ICE credential.

### Tài liệu liên quan

- [Camera gateway](../tools/ros-camera/README.md)
- [Kế hoạch Chặng 10](CHANG_10_ROS_UBUNTU_TRIEN_KHAI.md)
- [Camera node ROS](</home/vistar/projects/ros2_ws/src/camera/README.md>)

Các hướng dẫn cũ về frontend mock không mô tả cấu hình camera LAN hiện tại;
dùng các lệnh đã kiểm trong tài liệu này cho lần chạy camera.

`docs/*` đang được `.gitignore` bỏ qua theo quy ước tài liệu nội bộ của
repository. File hướng dẫn này có trên máy hiện tại để bạn/coding agent đọc;
nó sẽ không tự xuất hiện trong `git status` hoặc được push lên GitHub.
