#!/usr/bin/env python3
"""Read two ROS Image topics and publish bounded VP8/RTP streams on loopback.

This process never publishes a ROS topic or touches the robot motion adapter.
The MediaMTX RTP receiver must be running on UDP ports 5004 and 5006.
"""

## @file ros_camera_gateway.py
# @brief [READ FLOW STEP 4] Cầu nối ảnh ROS 2 sang kênh video của trình duyệt.
# sensor_msgs/msg/Image là ảnh thô, chưa phải video mà thẻ <video> có thể phát.
# Mỗi camera có một tiến trình GStreamer mã hóa VP8 và đóng gói RTP; MediaMTX
# nhận RTP nội bộ rồi thực hiện WHEP/WebRTC với từng người xem. Backend HMI
# kiểm tra quyền xem ở luồng signaling riêng, không xử lý từng pixel tại đây.
# Chỉ đọc topic: file này không cấp quyền lái và không publish /cmd_vel.

import subprocess
import threading
import time

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, DurabilityPolicy
from rclpy.signals import SignalHandlerOptions
from sensor_msgs.msg import Image


CAMERAS = {
    "front": ("/image_front", "camera_front_link", 5004),
    "rear": ("/image_rear", "camera_rear_link", 5006),
}
WIDTH, HEIGHT, FPS = 640, 360, 15
# Đây là tuổi từ lúc gateway NHẬN ảnh vào slot, không phải tuổi ảnh từ cảm biến.
# msg.header.stamp chưa được đối chiếu: tên hằng không chứng minh độ trễ đầu-cuối.
MAX_SOURCE_AGE_S = 1.0


## @brief Quản lý một encoder và một slot ảnh chờ cho đúng một camera.
# Một slot giúp ưu tiên hình hiện tại khi nguồn 30 FPS nhanh hơn đầu ra 15 FPS;
# nó không biến pipe/GStreamer/mạng thành một hệ thống không có bộ đệm.
class CameraOutput:
    ## @brief Khởi chạy encoder VP8/RTP và worker gửi ảnh qua stdin.
    # @param name Nhãn front/rear để đặt tên thread và ghi lỗi.
    # @param port Cổng UDP loopback mà MediaMTX đang nhận RTP camera tương ứng.
    # @return Constructor không trả giá trị; tài nguyên được giữ trên self.
    # @throws OSError Nếu không chạy được gst-launch; lỗi tạo thread có thể lan ra.
    def __init__(self, name, port):
        self.name = name
        self.lock = threading.Lock()
        self.latest = None  # Only one pending image; new frames replace old frames.
        self.running = True
        self.sent = 0
        # A separate process avoids mixing the ROS DDS and GStreamer native
        # libraries in one Python interpreter (which crashes on this host).
        # rawvideoparse phải biết hình học/stride cố định vì stdin chỉ có byte,
        # không kèm header ROS. videoconvert đổi BGR sang I420 cho bộ mã hóa.
        # deadline=1 là chế độ realtime của vp8enc: ưu tiên thời gian xử lý;
        # KHÔNG có nghĩa toàn hệ thống cam kết truyền một frame trong 1 ms.
        # target-bitrate là mục tiêu encoder, không phải trần tổng băng thông
        # WebRTC. keyframe tối đa mỗi 15 frame giúp người xem mới sớm giải mã.
        # do-timestamp lấy thời gian pipeline, không giữ timestamp cảm biến.
        # UDP chỉ gửi tới MediaMTX cùng máy; IP LAN/ICE cấu hình tại MediaMTX.
        self.encoder = subprocess.Popen([
            "gst-launch-1.0", "-q", "fdsrc", "fd=0", "do-timestamp=true",
            "!", "rawvideoparse", "format=bgr", f"width={WIDTH}",
            f"height={HEIGHT}", f"framerate={FPS}/1",
            "!", "videoconvert", "!", "video/x-raw,format=I420",
            "!", "vp8enc", "deadline=1", "target-bitrate=700000",
            f"keyframe-max-dist={FPS}", "!", "rtpvp8pay", "pt=96",
            "!", "udpsink", "host=127.0.0.1", f"port={port}",
            "sync=false", "async=false",
        ], stdin=subprocess.PIPE)
        self.worker = threading.Thread(target=self._send_loop, name=f"camera-{name}", daemon=True)
        self.worker.start()

    ## @brief Thay ảnh đang chờ bằng ảnh vừa nhận, không xếp hàng lịch sử.
    # @param pixels bytes BGR8 đã được kiểm tra kích thước ở callback ROS.
    # @return None; worker sẽ lấy slot sau khi có thể tiếp tục gửi.
    # @throws Không có lỗi ứng dụng chủ động được ném trong phương thức này.
    def offer(self, pixels):
        with self.lock:
            # monotonic chỉ đo khoảng thời gian trong process, tránh đồng hồ
            # lịch bị chỉnh làm tuổi ảnh âm; không so được trực tiếp với ROS stamp.
            self.latest = (time.monotonic(), pixels)

    ## @brief Worker gửi tối đa một ảnh mới mỗi nhịp 1/FPS, bỏ slot quá cũ.
    # @return None khi close() hoặc encoder đóng pipe.
    # @throws BrokenPipeError/OSError được bắt; lỗi khác không có retry tự động.
    def _send_loop(self):
        interval = 1.0 / FPS
        while self.running:
            started = time.monotonic()
            with self.lock:
                # Lấy quyền sở hữu slot rồi mở khóa trước khi I/O: callback ROS
                # vẫn nhận/thay ảnh mới dù encoder hiện đang chậm.
                item, self.latest = self.latest, None
            if item and started - item[0] <= MAX_SOURCE_AGE_S:
                pixels = item[1]
                try:
                    # Đây là pipe có bộ đệm và có sao chép, KHÔNG zero-copy.
                    # write có thể block khi encoder không đọc; kiểm tra tuổi
                    # phía trên không giới hạn thời gian block hoặc tuổi khi render.
                    self.encoder.stdin.write(pixels)
                    # Đếm lần write thành công, không xác nhận trình duyệt nhận hình.
                    self.sent += 1
                except (BrokenPipeError, OSError) as error:
                    if self.running:
                        print(f"{self.name}: encoder stopped: {error}", flush=True)
                    self.running = False
                    break
            time.sleep(max(0, interval - (time.monotonic() - started)))

    ## @brief Dừng encoder và worker, thu hồi child process khi thoát gateway.
    # @return None.
    # @throws Lỗi đóng pipe được bỏ qua; TimeoutExpired dẫn đến kill encoder.
    # Lỗi OS khác từ thao tác quản lý process có thể lan ra caller.
    def close(self):
        self.running = False
        # terminate trước join để đầu đọc stdin đóng và write đang block có
        # cơ hội thoát; join timeout không phải bảo đảm thread đã kết thúc.
        self.encoder.terminate()
        self.worker.join(timeout=2)
        try:
            self.encoder.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            self.encoder.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.encoder.kill()
            self.encoder.wait()


## @brief Node ROS 2 chỉ subscribe hai nguồn camera đã định danh rõ ràng.
class CameraGateway(Node):
    ## @brief Tạo hai output độc lập, subscription ROS và timer thống kê.
    # @return Constructor không trả giá trị.
    # @throws Lỗi ROS/GStreamer khi khởi tạo có thể lan ra; không tự phục hồi
    # encoder đã chết. Cấu hình frame/topic phải khớp driver ở READ FLOW STEP 3.
    def __init__(self):
        super().__init__("hmi_camera_gateway")
        self.outputs = {name: CameraOutput(name, port) for name, (_, _, port) in CAMERAS.items()}
        qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT,
                         durability=DurabilityPolicy.VOLATILE)
        # BEST_EFFORT ưu tiên frame mới thay vì chờ truyền lại ảnh đã lỗi thời;
        # depth=1 chỉ giữ mẫu DDS mới nhất; VOLATILE không xin ảnh lịch sử.
        # Subscriber best effort tương thích publisher best effort hoặc reliable.
        self.camera_subscriptions = []
        self.last_reject_log = {name: 0.0 for name in CAMERAS}
        for name, (topic, frame_id, _) in CAMERAS.items():
            ## @brief Chặn metadata sai trước khi đưa raw bytes vào encoder.
            # @param msg sensor_msgs/msg/Image do DDS giao tới callback.
            # @param camera,expected_frame Giá trị mặc định cố định binding của
            # vòng for; nếu chỉ đóng trên name, cả hai callback dễ dùng camera cuối.
            # @return None; ảnh sai bị loại và log tối đa một lần/giây/camera.
            # @throws Lỗi ngoài điều kiện metadata có thể lan tới ROS executor.
            def receive(msg, camera=name, expected_frame=frame_id):
                # Fail closed on a swapped frame, different resolution or stride.
                if (msg.header.frame_id != expected_frame or msg.encoding != "bgr8" or
                        msg.width != WIDTH or msg.height != HEIGHT or
                        msg.step != WIDTH * 3 or len(msg.data) != HEIGHT * msg.step):
                    current = time.monotonic()
                    if current - self.last_reject_log[camera] >= 1.0:
                        self.last_reject_log[camera] = current
                        self.get_logger().error(f"Rejected invalid {camera} image metadata")
                    return
                # bytes tạo bản sao độc lập khỏi bộ đệm message ROS; an toàn cho
                # worker chạy sau callback, nhưng tốn copy 640*360*3 byte/ảnh.
                # Frame ID chỉ kiểm tra nhãn; không xác minh camera vật lý đã gắn
                # đúng vị trí nếu driver tự fallback sang serial khác.
                self.outputs[camera].offer(bytes(msg.data))
            self.camera_subscriptions.append(self.create_subscription(Image, topic, receive, qos))
            self.get_logger().info(f"{name}: {topic} -> VP8/RTP 127.0.0.1:{CAMERAS[name][2]}")
        self.timer = self.create_timer(10.0, self._report)

    ## @brief Báo số ảnh đã ghi vào pipe để quan sát hoạt động nguồn/encoder.
    # @return None; đây không phải bằng chứng WebRTC/decoder/UI đang hoạt động.
    # @throws Lỗi logger nếu có không được xử lý riêng.
    def _report(self):
        self.get_logger().info("sent frames front=%d rear=%d" %
                               (self.outputs["front"].sent, self.outputs["rear"].sent))

    ## @brief Đóng lần lượt hai encoder trước khi destroy_node/shutdown ROS.
    # @return None.
    # @throws Lỗi close output có thể lan ra; vòng lặp không che mọi ngoại lệ.
    def close(self):
        for output in self.outputs.values():
            output.close()


## @brief Entry point: spin executor nhận ảnh, sau Ctrl-C thu hồi tài nguyên.
# @return None khi kết thúc bình thường.
# @throws KeyboardInterrupt được bắt; lỗi runtime khác lan ra sau finally.
# Lưu ý constructor CameraGateway chạy trước try nên lỗi khởi tạo một phần
# chưa được finally này bảo đảm dọn hết; đây là giới hạn implementation hiện tại.
def main():
    # Let Python deliver Ctrl-C as KeyboardInterrupt. Jazzy's default handler
    # can shut the ROS context down inside spin() while a camera callback is
    # being taken, which raises a RuntimeError before our encoders are closed.
    rclpy.init(signal_handler_options=SignalHandlerOptions.NO)
    node = CameraGateway()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.close()
        node.destroy_node()
        # Jazzy may already shut the default context down on SIGINT.
        rclpy.try_shutdown()


if __name__ == "__main__":
    main()
