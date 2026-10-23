# Hiển thị ROS 2 `/map` trên MappingPage và NavigationPage

Backend dùng một node `rclpy` với hai subscription
`nav_msgs/msg/OccupancyGrid`: `RELIABLE`/`TRANSIENT_LOCAL` nhận map latched
do `map_server` đã phát, và `BEST_EFFORT`/`VOLATILE` nhận publisher chỉ phát
luồng live. Node đổi lưới mới sang PNG ở đúng độ phân giải gốc; thay đổi mỗi
timestamp mà không đổi ô bản đồ không tạo PNG mới. Backend giữ bản mới nhất
và vài revision gần đây để request metadata/PNG không bị lỗi khi map đổi giữa
hai request. Khi publisher biến mất, backend bỏ ảnh cũ và chuyển về chờ.
Frontend kiểm metadata mỗi giây, tự thử tải lại PNG nếu lỗi và dùng `Map2D`
để hiển thị, phóng to, thu nhỏ và kéo bản đồ.

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

Sau khi đăng nhập, MappingPage ưu tiên bản đồ ROS `/map` nếu không chọn bản đồ
đã lưu; NavigationPage mặc định mở **ROS /map (trực tiếp)**. Chip nguồn cho
biết kích thước và độ phân giải. Muốn đặt đích, thêm waypoint hoặc tạo nhiệm
vụ trên NavigationPage, chọn bản đồ đã lưu: chế độ ROS trực tiếp chỉ để quan
sát. Dữ liệu map đi trực tiếp từ ROS 2, không phụ thuộc `ROSBRIDGE_URL` hay
chế độ camera.

## Dữ liệu và kiểm tra

```bash
source /opt/ros/jazzy/setup.bash
ros2 topic info /map -v
```

Khi backend chạy, `robot_hmi_map_raster` phải có hai subscription. Ảnh bản đồ
chỉ xuất hiện khi có publisher `/map` cùng ROS domain; nếu không, web hiển thị
trạng thái chờ. Không cần khởi động lại HMI khi publisher bắt đầu phát.

`/map` gồm `header.frame_id`, dấu thời gian, `info.resolution`, `width`,
`height`, `origin` (vị trí và quaternion), và mảng `data` theo hàng. Ô `-1` là
chưa biết, `0` là trống, `100` là vật cản; các giá trị giữa 0–100 được tô xám.
Ảnh PNG đảo trục hàng ROS để hướng bản đồ trong SVG đúng với tọa độ thế giới.

Backend cung cấp `GET /api/ros-map` (trạng thái, hình học, số ô theo loại) và
`GET /api/ros-map/image?revision=...` (PNG). Hai endpoint yêu cầu phiên đăng
nhập HMI. Robot chỉ hiện đè lên map khi pose đã ở cùng `frame_id`; nếu pose ở
`odom` còn bản đồ ở `map`, cần transform TF `map → odom` trước khi vẽ robot như
RViz. Lớp bản đồ tự nó không cần TF.
