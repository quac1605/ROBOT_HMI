#!/usr/bin/env python3
"""Read two ROS Image topics and publish bounded VP8/RTP streams on loopback.

This process never publishes a ROS topic or touches the robot motion adapter.
The MediaMTX RTP receiver must be running on UDP ports 5004 and 5006.
"""

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
MAX_SOURCE_AGE_S = 1.0


class CameraOutput:
    def __init__(self, name, port):
        self.name = name
        self.lock = threading.Lock()
        self.latest = None  # Only one pending image; new frames replace old frames.
        self.running = True
        self.sent = 0
        # A separate process avoids mixing the ROS DDS and GStreamer native
        # libraries in one Python interpreter (which crashes on this host).
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

    def offer(self, pixels):
        with self.lock:
            self.latest = (time.monotonic(), pixels)

    def _send_loop(self):
        interval = 1.0 / FPS
        while self.running:
            started = time.monotonic()
            with self.lock:
                item, self.latest = self.latest, None
            if item and started - item[0] <= MAX_SOURCE_AGE_S:
                pixels = item[1]
                try:
                    self.encoder.stdin.write(pixels)
                    self.sent += 1
                except (BrokenPipeError, OSError) as error:
                    if self.running:
                        print(f"{self.name}: encoder stopped: {error}", flush=True)
                    self.running = False
                    break
            time.sleep(max(0, interval - (time.monotonic() - started)))

    def close(self):
        self.running = False
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


class CameraGateway(Node):
    def __init__(self):
        super().__init__("hmi_camera_gateway")
        self.outputs = {name: CameraOutput(name, port) for name, (_, _, port) in CAMERAS.items()}
        qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT,
                         durability=DurabilityPolicy.VOLATILE)
        self.camera_subscriptions = []
        self.last_reject_log = {name: 0.0 for name in CAMERAS}
        for name, (topic, frame_id, _) in CAMERAS.items():
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
                self.outputs[camera].offer(bytes(msg.data))
            self.camera_subscriptions.append(self.create_subscription(Image, topic, receive, qos))
            self.get_logger().info(f"{name}: {topic} -> VP8/RTP 127.0.0.1:{CAMERAS[name][2]}")
        self.timer = self.create_timer(10.0, self._report)

    def _report(self):
        self.get_logger().info("sent frames front=%d rear=%d" %
                               (self.outputs["front"].sent, self.outputs["rear"].sent))

    def close(self):
        for output in self.outputs.values():
            output.close()


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
