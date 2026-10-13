#ifndef INTEL_CAMERA_NODE_HPP
#define INTEL_CAMERA_NODE_HPP

#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/image.hpp>
#include <sensor_msgs/image_encodings.hpp>
#include <librealsense2/rs.hpp>
#include "camera_handler.hpp"
#include <memory>
#include <string>

namespace amr {
namespace sensors {

/**
 * @class IntelCameraNode
 * @brief Node ROS 2 quản lý luồng dữ liệu ảnh màu RGB và publish cho camera trước (/image_front) và camera sau (/image_rear).
 */
class IntelCameraNode : public rclcpp::Node {
public:
    /**
     * @brief Khởi tạo ROS 2 Node và nạp các thông số cấu hình.
     */
    explicit IntelCameraNode(const rclcpp::NodeOptions & options = rclcpp::NodeOptions());
    
    /**
     * @brief Dọn dẹp tài nguyên và dừng các pipeline camera.
     */
    ~IntelCameraNode() override;

private:
    /**
     * @brief Dò tìm phần cứng, xử lý cấu hình Serial và khởi chạy Interface cho các camera.
     */
    void initializeCameras();

    /**
     * @brief Định kỳ lấy dữ liệu frame mới nhất từ các camera và publish lên topic ROS 2 tương ứng.
     */
    void pollAndPublish();

    /**
     * @brief Đóng gói dữ liệu cv::Mat sang sensor_msgs::msg::Image và publish lên topic màu.
     */
    void publishColorFrame(
        const rclcpp::Publisher<sensor_msgs::msg::Image>::SharedPtr& pub,
        const CameraFrame& frame,
        const std::string& frame_id);

    // Context của driver RealSense quản lý các kết nối USB vật lý
    rs2::context ctx_;

    // Handler của camera trước và sau
    std::unique_ptr<CameraHandling> front_cam_;
    std::unique_ptr<CameraHandling> rear_cam_;

    // Publishers cho ảnh màu
    rclcpp::Publisher<sensor_msgs::msg::Image>::SharedPtr front_color_pub_;
    rclcpp::Publisher<sensor_msgs::msg::Image>::SharedPtr rear_color_pub_;

    // Tọa độ TF frame ID
    std::string front_frame_id_;
    std::string rear_frame_id_;

    // Serial numbers
    std::string front_camera_serial_;
    std::string rear_camera_serial_;

    // Topic names
    std::string front_color_topic_;
    std::string rear_color_topic_;

    // Stream settings - Tỉ lệ 16:9 (640x360) phù hợp chuẩn aspectRatio: '16/9' của CameraPanel trên Web UI
    int image_width_{640};
    int image_height_{360};
    int fps_{30};
    bool use_sensor_time_{false};

    // Timer thực hiện vòng lặp polling
    rclcpp::TimerBase::SharedPtr timer_;
};

} // namespace sensors
} // namespace amr

#endif // INTEL_CAMERA_NODE_HPP
