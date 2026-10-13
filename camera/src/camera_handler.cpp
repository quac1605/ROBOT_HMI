#include "slam/camera_handler.hpp"
#include <chrono>
#include <librealsense2/h/rs_sensor.h>
#include <mutex>
#include <opencv2/core/mat.hpp>
#include <opencv2/core/types.hpp>

CameraHandling::~CameraHandling() { stop(); }

bool CameraHandling::start(int width, int height, int fps,
                           const std::string &serial_number) {
  if (is_running_) {
    return true;
  }

  try {
    if (!serial_number.empty()) {
      cfg_.enable_device(serial_number);
    }
    cfg_.enable_stream(RS2_STREAM_COLOR, width, height, RS2_FORMAT_BGR8, fps);
    auto profile = pipe_.start(cfg_);
    is_running_ = true;

    auto stream = profile.get_stream(RS2_STREAM_COLOR)
                      .as<rs2::video_stream_profile>();
    intrinsics_ = stream.get_intrinsics();

    camera_capture_thread_ = std::thread(&CameraHandling::capture_loop, this);
    return true;
  } catch (const rs2::error &e) {
    std::cerr << "[CameraHandling] RealSense error: " << e.what() << std::endl;
    return false;
  }
}

void CameraHandling::capture_loop() {
  while (is_running_) {
    try {
      rs2::frameset frames = pipe_.wait_for_frames(5000);

      double timestamp =
          std::chrono::duration<double>(
              std::chrono::system_clock::now().time_since_epoch())
              .count();

      rs2::video_frame color_frame = frames.get_color_frame();
      if (!color_frame)
        continue;

      cv::Mat raw_image(
          cv::Size(color_frame.get_width(), color_frame.get_height()), CV_8UC3,
          (void *)color_frame.get_data(), cv::Mat::AUTO_STEP);
      cv::Mat img = raw_image.clone();

      {
        std::lock_guard<std::mutex> lock(buffer_mutex_);
        if (frame_buffer_.size() >= 5) {
          frame_buffer_.pop();
        }
        frame_buffer_.emplace(CameraFrame{timestamp, std::move(img)});
      } // unlock

      new_frame_.notify_one();
    } catch (const rs2::error &e) {
      std::cerr << "[CameraHandling] RealSense error: " << e.what()
                << std::endl;
    }
  }
}

void CameraHandling::stop() {
  if (is_running_) {
    is_running_ = false;
    new_frame_.notify_all();
    if (camera_capture_thread_.joinable()) {
      camera_capture_thread_.join();
    }
    try {
      pipe_.stop();
      std::cout << "[CameraHandling] Camera RealSense da dung." << std::endl;
    } catch (...) {
    }
  }
}

bool CameraHandling::get_new_frame(CameraFrame &frame) {
  std::unique_lock<std::mutex> lock(buffer_mutex_);

  new_frame_.wait(lock,
                  [this] { return !frame_buffer_.empty() || !is_running_; });

  if (!is_running_ && frame_buffer_.empty()) {
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

  // D435i mau: model = RS2_DISTORTION_INVERSE_BROWN_CONRADY, du 5 he so k1,k2,p1,p2,k3
  D = (cv::Mat_<double>(1, 5) << intrinsics_.coeffs[0], intrinsics_.coeffs[1],
       intrinsics_.coeffs[2], intrinsics_.coeffs[3], intrinsics_.coeffs[4]);

  return true;
}

