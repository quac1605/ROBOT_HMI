#pragma once

#include <atomic>
#include <condition_variable>
#include <librealsense2/rs.hpp>
#include <mutex>
#include <opencv2/opencv.hpp>
#include <queue>
#include <string>
#include <thread>

struct CameraFrame {
  double timestamp{0.0};
  cv::Mat image;
};

class CameraHandling {
public:
  CameraHandling() = default;
  ~CameraHandling();


  bool start(int width = 640, int height = 480, int fps = 30,
             const std::string &serial_number = "");
  void stop();
  bool is_running() const { return is_running_.load(); }

  bool get_new_frame(CameraFrame &frame);

  bool get_intrinsics(cv::Mat &K, cv::Mat &D) const;


private:
  void capture_loop();
  
  rs2::pipeline pipe_;
  rs2::config cfg_;
  rs2_intrinsics intrinsics_{};
  std::atomic<bool> is_running_{false};

  std::thread camera_capture_thread_;
  std::mutex buffer_mutex_;
  std::queue<CameraFrame> frame_buffer_;
  std::condition_variable new_frame_;
};