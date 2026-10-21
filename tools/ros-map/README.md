# Hiển thị ROS 2 `/map` trên MappingPage

Backend dùng một node `rclpy` để subscribe `nav_msgs/msg/OccupancyGrid` với QoS
`RELIABLE` và `TRANSIENT_LOCAL`. Nhờ vậy bản đồ do `map_server` phát một lần
vẫn được nhận khi HMI khởi động sau. Node đổi toàn bộ lưới sang PNG ở đúng độ
phân giải gốc; backend giữ bản mới nhất và chỉ gửi PNG (~174 KB với bản đồ đang
chạy trên máy này) qua API có xác thực. Frontend lấy metadata mỗi 2 giây và
dùng `Map2D` hiện có để hiển thị, phóng to, thu nhỏ và kéo bản đồ.

## Khởi chạy qua LAN trên máy này

Trong `backend/.env`, đặt:

```dotenv
NODE_ENV=development
APP_ORIGIN=https://10.1.10.32:5173
TRUST_LOOPBACK_PROXY=true
CAMERA_WHEP_BASE_URL=https://10.1.10.32:5173
ROS_MAP_ENABLED=true
ROS_MAP_SETUP=/opt/ros/jazzy/setup.bash
```

`APP_ORIGIN` phải khớp chính xác giao thức và host trong trình duyệt. Máy này
đang có IP `10.1.10.32` và chứng chỉ phát triển chứa IP đó trong SAN. Backend
chỉ nghe trên `127.0.0.1:3001`; Vite HTTPS nghe trên IP LAN rồi chuyển tiếp
API/WebSocket vào backend qua loopback.

Khi xem camera, Vite cũng chuyển tiếp các yêu cầu WHEP `/front/whep` và
`/rear/whep` tới MediaMTX bằng TLS có xác minh chứng chỉ. Trình duyệt chỉ cần
tin cậy Origin `5173`; luồng WebRTC vẫn cần UDP `8189` tới IP LAN. Nếu máy khác
báo `CAMERA_ICE_FAILED`, hãy kiểm tra cổng UDP này.

Từ thư mục `ROBOT_HMI`, chạy một lệnh cho backend và frontend:

```bash
bash tools/run_hmi_lan.sh
```

Script này đã chạy **cả backend trên cổng 3001** và frontend trên cổng 5173.
Giữ terminal đó mở; không chạy thêm
`node --env-file=backend/.env backend/src/server.js` trong terminal khác. Nếu
chạy backend thứ hai, cổng 3001 đang bận và sẽ báo `BACKEND_START_FAILED`.

Trên **cả máy Ubuntu và máy khác cùng LAN**, mở cùng một URL:

`https://10.1.10.32:5173/mapping`

Chứng chỉ HTTPS hiện tại là chứng chỉ tự ký cho môi trường phát triển. Mỗi
trình duyệt/thiết bị cần tự xem và tin cậy chứng chỉ này; đừng tắt kiểm tra
chứng chỉ. Codex in-app browser có thể từ chối chứng chỉ tự ký hoàn toàn;
hãy mở URL LAN bằng Firefox/Chrome của chính máy và tin cậy chứng chỉ sau khi
kiểm tra dấu vân tay bằng
`openssl x509 -in tools/ros-camera/.local/lan-10.1.10.32.crt -noout -fingerprint -sha256`.
Nếu máy khác không kết nối được, kiểm tra `sudo ufw status verbose`. Nếu UFW
đang chặn TCP 5173, chỉ mở cổng trên Wi-Fi và mạng nội bộ này:

```bash
sudo ufw allow in on wlo1 from 10.1.0.0/16 to 10.1.10.32 port 5173 proto tcp
```

Nếu IP máy thay đổi, tạo chứng chỉ SAN mới bằng
`tools/ros-camera/create_lan_dev_cert.sh <IP>` rồi chạy script với
`HMI_LAN_IP=<IP>` và cập nhật `backend/.env` cho IP tương ứng.

Sau khi đăng nhập, nếu không chọn bản đồ đã lưu,
MappingPage ưu tiên bản đồ ROS `/map`; chip `Nguồn: ROS /map` cho biết kích thước
và độ phân giải. Bản đồ đã lưu vẫn hiển thị khi được chọn. Dữ liệu map đi trực
tiếp từ ROS 2, không phụ thuộc `ROSBRIDGE_URL` hay chế độ camera.

## Dữ liệu và kiểm tra

```bash
source /opt/ros/jazzy/setup.bash
ros2 topic info /map -v
ros2 topic echo /map --once --no-arr --qos-durability transient_local
```

`/map` gồm `header.frame_id`, dấu thời gian, `info.resolution`, `width`,
`height`, `origin` (vị trí và quaternion), và mảng `data` theo hàng. Ô `-1` là
chưa biết, `0` là trống, `100` là vật cản; các giá trị giữa 0–100 được tô xám.
Ảnh PNG đảo trục hàng ROS để hướng bản đồ trong SVG đúng với tọa độ thế giới.

Backend cung cấp `GET /api/ros-map` (trạng thái, hình học, số ô theo loại) và
`GET /api/ros-map/image?revision=...` (PNG). Hai endpoint yêu cầu phiên đăng
nhập HMI. Robot chỉ hiện đè lên map khi pose đã ở cùng `frame_id`; nếu pose ở
`odom` còn bản đồ ở `map`, cần transform TF `map → odom` trước khi vẽ robot như
RViz. Lớp bản đồ tự nó không cần TF.
