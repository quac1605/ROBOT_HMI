#include "intel_camera_node.hpp"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <sensor_msgs/image_encodings.hpp>

namespace amr {
namespace sensors {

// ==========================================
// IMPLEMENTATION OF IntelCameraNode
// ==========================================

IntelCameraNode::IntelCameraNode(const rclcpp::NodeOptions & options)
    : Node("intel_camera_node", options) {

    // 1. Declare ROS2 Parameters
    // Các thông số mặc định được tối ưu cho khung hiển thị 16:9 của CameraPanel (MappingPage & NavigationPage)
    this->declare_parameter<std::string>("front_camera_serial", "140122075302");
    this->declare_parameter<std::string>("front_frame_id", "camera_front_link");
    this->declare_parameter<std::string>("front_color_topic", "/image_front");

    this->declare_parameter<std::string>("rear_camera_serial", "146322072685");
    this->declare_parameter<std::string>("rear_frame_id", "camera_rear_link");
    this->declare_parameter<std::string>("rear_color_topic", "/image_rear");

    this->declare_parameter<int>("image_width", 640);
    this->declare_parameter<int>("image_height", 360); // 16:9 aspect ratio khớp với CameraPanel (style: aspectRatio: '16/9')
    this->declare_parameter<int>("fps", 30);            // 30 FPS mượt mà cho điều khiển và giám sát teleop
    this->declare_parameter<bool>("use_sensor_time", false); // Dùng ROS 2 clock (this->now()) để đồng bộ đồng hồ robot
    this->declare_parameter<std::string>("qos_reliability", "sensor_data"); // "sensor_data" (best_effort) hoặc "reliable"

    // 2. Read Parameters
    this->get_parameter("front_camera_serial", front_camera_serial_);
    this->get_parameter("front_frame_id", front_frame_id_);
    this->get_parameter("front_color_topic", front_color_topic_);

    this->get_parameter("rear_camera_serial", rear_camera_serial_);
    this->get_parameter("rear_frame_id", rear_frame_id_);
    this->get_parameter("rear_color_topic", rear_color_topic_);

    this->get_parameter("image_width", image_width_);
    this->get_parameter("image_height", image_height_);
    this->get_parameter("fps", fps_);
    this->get_parameter("use_sensor_time", use_sensor_time_);

    std::string qos_type;
    this->get_parameter("qos_reliability", qos_type);

    // 3. Configure QoS
    rclcpp::QoS qos = (qos_type == "reliable")
        ? rclcpp::QoS(1)
        : rclcpp::SensorDataQoS().keep_last(1);

    // 4. Initialize publishers cho 2 topic ảnh màu
    front_color_pub_ = this->create_publisher<sensor_msgs::msg::Image>(front_color_topic_, qos);
    rear_color_pub_ = this->create_publisher<sensor_msgs::msg::Image>(rear_color_topic_, qos);

    // 5. Initialize camera hardware
    initializeCameras();

    // 6. Start polling timer (~33ms tương ứng 30Hz)
    int timer_period_ms = std::max(1, 1000 / std::max(1, fps_));
    timer_ = this->create_wall_timer(
        std::chrono::milliseconds(timer_period_ms),
        std::bind(&IntelCameraNode::pollAndPublish, this)
    );

    RCLCPP_INFO(this->get_logger(),
        "IntelCameraNode successfully initialized.\n"
        "  - Front Color Topic: %s (Frame ID: %s)\n"
        "  - Rear Color Topic:  %s (Frame ID: %s)\n"
        "  - Resolution: %dx%d (16:9) @ %d FPS (Sensor Time: %s)",
        front_color_topic_.c_str(), front_frame_id_.c_str(),
        rear_color_topic_.c_str(), rear_frame_id_.c_str(),
        image_width_, image_height_, fps_,
        use_sensor_time_ ? "true" : "false");
}

IntelCameraNode::~IntelCameraNode() {
    if (front_cam_) {
        front_cam_->stop();
    }
    if (rear_cam_) {
        rear_cam_->stop();
    }
    RCLCPP_INFO(this->get_logger(), "IntelCameraNode stopped and resources cleaned up.");
}

void IntelCameraNode::initializeCameras() {
    rs2::device_list devices;
    try {
        devices = ctx_.query_devices();
    } catch (const rs2::error& e) {
        RCLCPP_ERROR(this->get_logger(), "RealSense query devices failed: %s", e.what());
        return;
    }

    if (devices.size() == 0) {
        RCLCPP_WARN(this->get_logger(), "No Intel RealSense devices detected. Waiting for device connection...");
        return;
    }

    RCLCPP_INFO(this->get_logger(), "System detected %d connected RealSense device(s).", static_cast<int>(devices.size()));

    // 1. Resolve front camera serial
    std::string resolved_front_serial = front_camera_serial_;
    if (resolved_front_serial.empty()) {
        resolved_front_serial = devices[0].get_info(RS2_CAMERA_INFO_SERIAL_NUMBER);
        RCLCPP_INFO(this->get_logger(), "Front Camera: Auto-selecting first device (Serial: %s)", resolved_front_serial.c_str());
    } else {
        bool found = false;
        for (auto&& dev : devices) {
            if (std::string(dev.get_info(RS2_CAMERA_INFO_SERIAL_NUMBER)) == resolved_front_serial) {
                found = true;
                break;
            }
        }
        if (!found) {
            RCLCPP_WARN(this->get_logger(),
                "Front Camera specified Serial %s was NOT found! Attempting auto-assign to device[0].",
                resolved_front_serial.c_str());
            resolved_front_serial = devices[0].get_info(RS2_CAMERA_INFO_SERIAL_NUMBER);
        }
    }

    // 2. Resolve rear camera serial
    std::string resolved_rear_serial = rear_camera_serial_;
    if (resolved_rear_serial.empty()) {
        if (devices.size() > 1) {
            for (auto&& dev : devices) {
                std::string sn = dev.get_info(RS2_CAMERA_INFO_SERIAL_NUMBER);
                if (sn != resolved_front_serial) {
                    resolved_rear_serial = sn;
                    break;
                }
            }
            RCLCPP_INFO(this->get_logger(), "Rear Camera: Auto-selecting second device (Serial: %s)", resolved_rear_serial.c_str());
        } else {
            RCLCPP_WARN(this->get_logger(), "Rear Camera: Only 1 RealSense camera detected. Rear camera will be disabled.");
            resolved_rear_serial = "";
        }
    } else {
        bool found = false;
        for (auto&& dev : devices) {
            if (std::string(dev.get_info(RS2_CAMERA_INFO_SERIAL_NUMBER)) == resolved_rear_serial) {
                found = true;
                break;
            }
        }
        if (!found) {
            RCLCPP_WARN(this->get_logger(),
                "Rear Camera specified Serial %s was NOT found! Attempting auto-assign.",
                resolved_rear_serial.c_str());
            if (devices.size() > 1) {
                for (auto&& dev : devices) {
                    std::string sn = dev.get_info(RS2_CAMERA_INFO_SERIAL_NUMBER);
                    if (sn != resolved_front_serial) {
                        resolved_rear_serial = sn;
                        break;
                    }
                }
            } else {
                resolved_rear_serial = "";
            }
        }
    }

    // 3. Initialize Front Camera
    if (!resolved_front_serial.empty() && (!front_cam_ || !front_cam_->is_running())) {
        front_cam_ = std::make_unique<CameraHandling>(ctx_);
        if (front_cam_->start(image_width_, image_height_, fps_, resolved_front_serial)) {
            RCLCPP_INFO(this->get_logger(), "Front Camera (Serial: %s) started successfully at %dx%d @ %d FPS.",
                        resolved_front_serial.c_str(), image_width_, image_height_, fps_);
        } else {
            RCLCPP_ERROR(this->get_logger(), "Failed to start Front Camera (Serial: %s).", resolved_front_serial.c_str());
        }
    }

    // 4. Initialize Rear Camera (đảm bảo không trùng serial với camera trước)
    if (!resolved_rear_serial.empty() && resolved_rear_serial != resolved_front_serial && (!rear_cam_ || !rear_cam_->is_running())) {
        rear_cam_ = std::make_unique<CameraHandling>(ctx_);
        if (rear_cam_->start(image_width_, image_height_, fps_, resolved_rear_serial)) {
            RCLCPP_INFO(this->get_logger(), "Rear Camera (Serial: %s) started successfully at %dx%d @ %d FPS.",
                        resolved_rear_serial.c_str(), image_width_, image_height_, fps_);
        } else {
            RCLCPP_ERROR(this->get_logger(), "Failed to start Rear Camera (Serial: %s).", resolved_rear_serial.c_str());
        }
    }
}

void IntelCameraNode::pollAndPublish() {
    // Nếu chưa khởi tạo được camera nào, thử khởi tạo lại mỗi 2 giây
    if ((!front_cam_ || !front_cam_->is_running()) && (!rear_cam_ || !rear_cam_->is_running())) {
        static auto last_retry = std::chrono::steady_clock::now();
        auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration_cast<std::chrono::seconds>(now - last_retry).count() >= 2) {
            last_retry = now;
            initializeCameras();
        }
    }

    // Publish frame cho Front Camera -> /image_front
    if (front_cam_ && front_cam_->is_running()) {
        CameraFrame frame;
        if (front_cam_->get_latest_frame(frame)) {
            publishColorFrame(front_color_pub_, frame, front_frame_id_);
        }
    }

    // Publish frame cho Rear Camera -> /image_rear
    if (rear_cam_ && rear_cam_->is_running()) {
        CameraFrame frame;
        if (rear_cam_->get_latest_frame(frame)) {
            publishColorFrame(rear_color_pub_, frame, rear_frame_id_);
        }
    }
}

void IntelCameraNode::publishColorFrame(
    const rclcpp::Publisher<sensor_msgs::msg::Image>::SharedPtr& pub,
    const CameraFrame& frame,
    const std::string& frame_id) {

    if (!pub || frame.image.empty()) {
        return;
    }

    sensor_msgs::msg::Image msg;
    msg.header.frame_id = frame_id;

    if (use_sensor_time_ && frame.timestamp > 0.0) {
        uint64_t ns = static_cast<uint64_t>(frame.timestamp * 1e9);
        msg.header.stamp = rclcpp::Time(ns);
    } else {
        msg.header.stamp = this->now();
    }

    msg.height = static_cast<uint32_t>(frame.image.rows);
    msg.width = static_cast<uint32_t>(frame.image.cols);
    msg.encoding = sensor_msgs::image_encodings::BGR8;
    msg.is_bigendian = false;
    msg.step = static_cast<sensor_msgs::msg::Image::_step_type>(frame.image.step);

    size_t size = frame.image.step * frame.image.rows;
    msg.data.resize(size);
    std::memcpy(msg.data.data(), frame.image.data, size);

    pub->publish(msg);
}

} // namespace sensors
} // namespace amr

/**
 * @brief Hàm khởi chạy Node thực thi
 */
int main(int argc, char *argv[]) {
    rclcpp::init(argc, argv);
    rclcpp::NodeOptions options;
    try {
        auto node = std::make_shared<amr::sensors::IntelCameraNode>(options);
        rclcpp::spin(node);
    } catch (const std::exception& e) {
        RCLCPP_FATAL(rclcpp::get_logger("main"), "Fatal error during camera node execution: %s", e.what());
    }
    rclcpp::shutdown();
    return 0;
}
