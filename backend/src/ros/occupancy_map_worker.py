"""Subscribe to /map and send a compact, full-resolution PNG to the backend.

stdout is a newline-delimited JSON protocol; diagnostics go to stderr.  The
image uses the same palette and vertical flip as the HMI OccupancyGrid raster.
"""

import base64
import hashlib
import json
import math
import struct
import sys
import zlib

import rclpy
from rclpy.executors import ExternalShutdownException
from nav_msgs.msg import OccupancyGrid
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy


MAX_DIMENSION = 8192
MAX_CELLS = 12_000_000
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
CELL_TO_PALETTE = bytes(i + 1 if i <= 100 else 0 for i in range(256))
PALETTE = bytes([176, 190, 197]) + b"".join(
    bytes([round(255 * (1 - value / 100))] * 3) for value in range(101)
)


def chunk(kind, data):
    return (struct.pack(">I", len(data)) + kind + data +
            struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def yaw_from_quaternion(q):
    norm = math.hypot(q.x, q.y, q.z, q.w)
    if abs(norm - 1) > 1e-3:
        raise ValueError("Map origin quaternion is not normalized")
    x, y, z, w = q.x / norm, q.y / norm, q.z / norm, q.w / norm
    roll = math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y))
    pitch = math.asin(max(-1, min(1, 2 * (w * y - z * x))))
    if abs(roll) > 1e-4 or abs(pitch) > 1e-4:
        raise ValueError("A tilted OccupancyGrid cannot be shown in the 2D map")
    return math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))


def encode_map(message, skip_revision=None):
    width, height = message.info.width, message.info.height
    cells = width * height
    if (not width or not height or width > MAX_DIMENSION or
            height > MAX_DIMENSION or cells > MAX_CELLS):
        raise ValueError("OccupancyGrid dimensions exceed the viewer limit")
    if not math.isfinite(message.info.resolution) or message.info.resolution <= 0:
        raise ValueError("OccupancyGrid resolution is invalid")
    if not message.header.frame_id:
        raise ValueError("OccupancyGrid frame_id is missing")

    raw = message.data.tobytes()
    if len(raw) != cells or any(value > 100 and value != 255 for value in set(raw)):
        raise ValueError("OccupancyGrid data length or cell value is invalid")

    position = message.info.origin.position
    if not all(math.isfinite(v) for v in (position.x, position.y, position.z)):
        raise ValueError("OccupancyGrid origin is invalid")
    geometry = {
        "frameId": message.header.frame_id,
        "width": width,
        "height": height,
        "resolution": message.info.resolution,
        "origin": {"x": position.x, "y": position.y,
                   "yaw": yaw_from_quaternion(message.info.origin.orientation)},
    }
    stamp = {"sec": message.header.stamp.sec,
             "nanosec": message.header.stamp.nanosec}
    map_load_time = {"sec": message.info.map_load_time.sec,
                     "nanosec": message.info.map_load_time.nanosec}
    counts = {
        "unknown": raw.count(255),
        "free": raw.count(0),
        "occupied": raw.count(100),
    }
    counts["other"] = cells - sum(counts.values())

    revision_hash = hashlib.sha256(raw)
    # A fresh header stamp alone does not change the visible map. Avoid
    # re-encoding the same large PNG on every periodic OccupancyGrid publish.
    revision_hash.update(json.dumps([geometry, map_load_time],
                                    sort_keys=True).encode("utf-8"))
    revision = revision_hash.hexdigest()[:32]
    if revision == skip_revision:
        return None

    # ROS row 0 is at the bottom; PNG row 0 is at the top. Filter 0 keeps
    # occupied cells crisp and lets zlib compress large unknown/free regions.
    scanlines = bytearray((width + 1) * height)
    for output_row in range(height):
        source_row = height - 1 - output_row
        start = source_row * width
        target = output_row * (width + 1) + 1
        scanlines[target:target + width] = raw[start:start + width].translate(CELL_TO_PALETTE)

    image = (PNG_SIGNATURE +
             chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 3, 0, 0, 0)) +
             chunk(b"PLTE", PALETTE) +
             chunk(b"IDAT", zlib.compress(scanlines, 6)) +
             chunk(b"IEND", b""))
    if len(image) > 12 * 1024 * 1024:
        raise ValueError("OccupancyGrid PNG exceeds the viewer limit")
    return {
        "revision": revision,
        "geometry": geometry,
        "stamp": stamp,
        "mapLoadTime": map_load_time,
        "counts": counts,
        "pngBase64": base64.b64encode(image).decode("ascii"),
    }


def main():
    rclpy.init()
    node = rclpy.create_node("robot_hmi_map_raster")
    latched_qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                            durability=DurabilityPolicy.TRANSIENT_LOCAL)
    live_qos = QoSProfile(depth=1, reliability=ReliabilityPolicy.BEST_EFFORT,
                          durability=DurabilityPolicy.VOLATILE)
    last_revision = None
    had_publisher = False
    missing_checks = 0

    def on_map(message):
        nonlocal last_revision, had_publisher, missing_checks
        try:
            had_publisher = True
            missing_checks = 0
            result = encode_map(message, skip_revision=last_revision)
            if result is None:
                return
            print(json.dumps(result, separators=(",", ":")), flush=True)
            last_revision = result["revision"]
        except (ValueError, OverflowError) as error:
            print(f"/map rejected: {error}", file=sys.stderr, flush=True)

    # The latched subscription receives an existing map from map_server.
    # The volatile one also matches publishers that only offer volatile QoS.
    # Both may receive a live update; revision deduplication keeps one PNG.
    node.create_subscription(OccupancyGrid, "/map", on_map, latched_qos)
    node.create_subscription(OccupancyGrid, "/map", on_map, live_qos)

    def check_publisher():
        nonlocal had_publisher, last_revision, missing_checks
        present = node.count_publishers("/map") > 0
        missing_checks = 0 if present else missing_checks + 1
        if had_publisher and missing_checks >= 2:
            last_revision = None
            print('{"type":"source_lost"}', flush=True)
            had_publisher = False
        elif present:
            had_publisher = True

    node.create_timer(2.0, check_publisher)
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, ExternalShutdownException):
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
