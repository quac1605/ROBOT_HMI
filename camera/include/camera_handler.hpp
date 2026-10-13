#pragma once

#include <atomic>
#include <condition_variable>
#include <librealsense2/rs.hpp>
#include <mutex>
#include <opencv2/opencv.hpp>
#include <queue>
#include <string>
#include <thread>

/**
 * @struct CameraFrame
 * @brief Chứa dữ liệu ảnh RGB và timestamp.
 */
struct CameraFrame {
  double timestamp{0.0};
  cv::Mat image; // BGR8
};

/**
 * @class CameraHandling
 * @brief Lớp điều khiển phần cứng camera RealSense qua librealsense2 (chỉ luồng Color RGB).
 */
class CameraHandling {
public:
  CameraHandling() = default;
  explicit CameraHandling(rs2::context ctx);
  ~CameraHandling();

  /**
   * @brief Khởi chạy pipeline và thread thu thập hình ảnh của camera.
   * @param width Chiều rộng ảnh (mặc định 640, tỉ lệ 16:9)
   * @param height Chiều cao ảnh (mặc định 360, tỉ lệ 16:9)
   * @param fps Tốc độ khung hình (mặc định 30)
   * @param serial_number Số serial phần cứng camera RealSense
   */
  bool start(int width = 640, int height = 360, int fps = 30,
             const std::string &serial_number = "");

  /**
   * @brief Dừng pipeline và giải phóng thread thu thập.
   */
  void stop();

  /**
   * @brief Kiểm tra trạng thái hoạt động của camera.
   */
  bool is_running() const { return is_running_.load(); }

  /**
   * @brief Lấy frame mới nhất không block thread (dành cho vòng lặp polling ROS 2).
   */
  bool get_latest_frame(CameraFrame &frame);

  /**
   * @brief Lấy frame với timeout tùy chọn.
   */
  bool get_new_frame(CameraFrame &frame, int timeout_ms = 100);

  /**
   * @brief Lấy ma trận thông số nội tại (Intrinsics) của camera.
   */
  bool get_intrinsics(cv::Mat &K, cv::Mat &D) const;

private:
  void capture_loop();

  rs2::context ctx_{};
  bool has_custom_ctx_{false};
  rs2::pipeline pipe_;
  rs2_intrinsics intrinsics_{};
  std::atomic<bool> is_running_{false};

  std::thread camera_capture_thread_;
  std::mutex buffer_mutex_;
  std::queue<CameraFrame> frame_buffer_;
  std::condition_variable new_frame_;
};