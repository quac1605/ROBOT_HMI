#include "camera_handler.hpp"
#include <chrono>
#include <iostream>
#include <librealsense2/h/rs_sensor.h>
#include <mutex>
#include <opencv2/core/mat.hpp>
#include <opencv2/core/types.hpp>

CameraHandling::CameraHandling(rs2::context ctx)
    : ctx_(ctx), has_custom_ctx_(true), pipe_(ctx) {}

CameraHandling::~CameraHandling() {
  stop();
}

bool CameraHandling::start(int width, int height, int fps,
                           const std::string &serial_number) {
  if (is_running_) {
    return true;
  }

  try {
    rs2::config cfg;
    if (!serial_number.empty()) {
      cfg.enable_device(serial_number);
    }
    // Chỉ kích hoạt luồng ảnh màu Color (BGR8)
    cfg.enable_stream(RS2_STREAM_COLOR, width, height, RS2_FORMAT_BGR8, fps);

    auto profile = pipe_.start(cfg);
    is_running_ = true;

    auto stream = profile.get_stream(RS2_STREAM_COLOR)
                      .as<rs2::video_stream_profile>();
    intrinsics_ = stream.get_intrinsics();

    camera_capture_thread_ = std::thread(&CameraHandling::capture_loop, this);
    return true;
  } catch (const rs2::error &e) {
    std::cerr << "[CameraHandling] RealSense error starting camera "
              << serial_number << ": " << e.what() << std::endl;
    return false;
  } catch (const std::exception &e) {
    std::cerr << "[CameraHandling] Error starting camera "
              << serial_number << ": " << e.what() << std::endl;
    return false;
  }
}

void CameraHandling::capture_loop() {
  while (is_running_) {
    try {
      // Đợi frame với timeout 200ms để capture thread thoát nhanh khi gọi stop()
      rs2::frameset frames = pipe_.wait_for_frames(200);

      rs2::video_frame color_frame = frames.get_color_frame();
      if (!color_frame) {
        continue;
      }

      double timestamp = 0.0;
      auto domain = color_frame.get_frame_timestamp_domain();
      if (domain == RS2_TIMESTAMP_DOMAIN_SYSTEM_TIME || domain == RS2_TIMESTAMP_DOMAIN_GLOBAL_TIME) {
        timestamp = color_frame.get_timestamp() * 1e-3;
      } else {
        timestamp = std::chrono::duration<double>(
            std::chrono::system_clock::now().time_since_epoch()).count();
      }

      cv::Mat raw_image(
          cv::Size(color_frame.get_width(), color_frame.get_height()),
          CV_8UC3,
          const_cast<void *>(color_frame.get_data()),
          cv::Mat::AUTO_STEP);
      cv::Mat img = raw_image.clone();

      CameraFrame frame;
      frame.timestamp = timestamp;
      frame.image = std::move(img);

      {
        std::lock_guard<std::mutex> lock(buffer_mutex_);
        if (frame_buffer_.size() >= 5) {
          frame_buffer_.pop();
        }
        frame_buffer_.emplace(std::move(frame));
      }

      new_frame_.notify_one();
    } catch (const rs2::error &e) {
      if (!is_running_) {
        break;
      }
      // Tiếp tục vòng lặp khi timeout tạm thời chưa có frame
    } catch (const std::exception &e) {
      if (!is_running_) {
        break;
      }
      std::cerr << "[CameraHandling] Exception in capture loop: " << e.what() << std::endl;
    }
  }
}

void CameraHandling::stop() {
  if (is_running_.exchange(false)) {
    new_frame_.notify_all();
    if (camera_capture_thread_.joinable()) {
      camera_capture_thread_.join();
    }
    try {
      pipe_.stop();
      std::cout << "[CameraHandling] RealSense camera pipeline stopped." << std::endl;
    } catch (...) {
    }
  }
}

bool CameraHandling::get_latest_frame(CameraFrame &frame) {
  std::lock_guard<std::mutex> lock(buffer_mutex_);
  if (frame_buffer_.empty()) {
    return false;
  }

  // Giữ lại frame mới nhất, bỏ các frame cũ để đảm bảo tính real-time thấp độ trễ
  while (frame_buffer_.size() > 1) {
    frame_buffer_.pop();
  }
  frame = std::move(frame_buffer_.front());
  frame_buffer_.pop();
  return true;
}

bool CameraHandling::get_new_frame(CameraFrame &frame, int timeout_ms) {
  std::unique_lock<std::mutex> lock(buffer_mutex_);

  if (timeout_ms <= 0) {
    new_frame_.wait(lock, [this] { return !frame_buffer_.empty() || !is_running_; });
  } else {
    new_frame_.wait_for(lock, std::chrono::milliseconds(timeout_ms),
                        [this] { return !frame_buffer_.empty() || !is_running_; });
  }

  if (frame_buffer_.empty()) {
    return false;
  }

  frame = std::move(frame_buffer_.front());
  frame_buffer_.pop();
  return true;
}

bool CameraHandling::get_intrinsics(cv::Mat &K, cv::Mat &D) const {
  if (!is_running_) {
    return false;
  }

  K = (cv::Mat_<double>(3, 3) << intrinsics_.fx, 0.0, intrinsics_.ppx,
       0.0, intrinsics_.fy, intrinsics_.ppy,
       0.0, 0.0, 1.0);

  // Model Brown-Conrady: 5 hệ số k1, k2, p1, p2, k3
  D = (cv::Mat_<double>(1, 5) << intrinsics_.coeffs[0], intrinsics_.coeffs[1],
       intrinsics_.coeffs[2], intrinsics_.coeffs[3], intrinsics_.coeffs[4]);

  return true;
}
