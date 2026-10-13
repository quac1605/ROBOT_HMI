# Gói ROS 2 Camera Node (Intel RealSense D435 / D435i / D455)

Gói ROS 2 này quản lý việc thu thập dữ liệu hình ảnh từ 2 camera Intel RealSense (Camera trước và Camera sau) và xuất bản dữ liệu hình ảnh (Color BGR8) lên 2 ROS 2 topic:
- `/image_front` (Camera trước)
- `/image_rear` (Camera sau)

Thông số stream được tối ưu hóa cho giao diện Web HMI (tỉ lệ khung hình **16:9** `640x360 @ 30 FPS` phù hợp với các trang `MappingPage` và `NavigationPage`).

---

## 1. Yêu cầu hệ thống trên Ubuntu

- **Hệ điều hành**: Ubuntu 22.04 (ROS 2 Humble) hoặc Ubuntu 24.04 (ROS 2 Jazzy)
- **ROS 2**: Humble / Iron / Jazzy
- **Thư viện phụ thuộc**:
  ```bash
  # Cài đặt librealsense2
  sudo apt-get update
  sudo apt-get install -y librealsense2-dev librealsense2-utils

  # Cài đặt OpenCV và các package ROS2 cần thiết
  sudo apt-get install -y libopencv-dev ros-$ROS_DISTRO-sensor-msgs ros-$ROS_DISTRO-cv-bridge
  ```

---

## 2. Hướng dẫn Build trong ROS 2 Workspace

Giả sử bạn clone/pull mã nguồn về máy Ubuntu vào workspace ROS 2 (ví dụ `~/ros2_ws`):

```bash
# 1. Di chuyển vào workspace ROS 2
cd ~/ros2_ws

# 2. Tạo symlink hoặc đặt thư mục camera vào src/
# Ví dụ:
# ln -s ~/path/to/ROBOT_HMI/camera src/camera

# 3. Source môi trường ROS 2
source /opt/ros/$ROS_DISTRO/setup.bash

# 4. Build gói camera bằng colcon
colcon build --packages-select camera --symlink-install

# 5. Source workspace sau khi build
source install/setup.bash
```

---

## 3. Hướng dẫn Chạy Node

### Cách 1: Chạy trực tiếp bằng `ros2 run`
```bash
ros2 run camera intel_camera_node
```

### Cách 2: Chạy với file tham số YAML qua `ros2 launch`
```bash
ros2 launch camera camera.launch.py
```

### Cách 3: Ghi đè tham số trực tiếp từ dòng lệnh
```bash
# Chạy với serial camera tùy biến hoặc topic khác:
ros2 run camera intel_camera_node --ros-args \
  -p front_camera_serial:="140122075302" \
  -p rear_camera_serial:="146322072685" \
  -p image_width:=640 \
  -p image_height:=360 \
  -p fps:=30
```

---

## 4. Kiểm tra dữ liệu Camera

Sau khi node khởi chạy thành công:

1. **Kiểm tra danh sách topic:**
   ```bash
   ros2 topic list
   # Kết quả sẽ có:
   # /image_front
   # /image_rear
   ```

2. **Kiểm tra tần số khung hình (FPS):**
   ```bash
   ros2 topic hz /image_front
   ros2 topic hz /image_rear
   # Kết quả: ~30.0 Hz
   ```

3. **Xem hình ảnh trực quan trên Ubuntu:**
   ```bash
   ros2 run rqt_image_view rqt_image_view
   # Chọn topic /image_front hoặc /image_rear trên giao diện rqt
   ```
