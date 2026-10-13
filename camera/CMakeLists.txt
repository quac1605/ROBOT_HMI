cmake_minimum_required(VERSION 3.8)
project(camera)

if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# C++ 17 standard
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(ament_cmake REQUIRED)
find_package(rclcpp REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(OpenCV REQUIRED)

# Tim librealsense2 qua CMake hoac PkgConfig
find_package(realsense2 QUIET)
if(NOT realsense2_FOUND)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(realsense2 REQUIRED realsense2)
endif()

if(TARGET realsense2::realsense2)
  set(REALSENSE_LIBS realsense2::realsense2)
else()
  set(REALSENSE_LIBS ${realsense2_LIBRARIES})
  include_directories(${realsense2_INCLUDE_DIRS})
endif()

include_directories(
  include
  ${OpenCV_INCLUDE_DIRS}
)

# Thu vien xu ly hardware Camera
add_library(camera_handler
  src/camera_handler.cpp
)
target_include_directories(camera_handler PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
target_link_libraries(camera_handler
  ${OpenCV_LIBS}
  ${REALSENSE_LIBS}
)

# Executable Node ROS 2
add_executable(intel_camera_node
  src/intel_camera_node.cpp
)
target_include_directories(intel_camera_node PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include>
)
target_link_libraries(intel_camera_node
  camera_handler
  ${OpenCV_LIBS}
  ${REALSENSE_LIBS}
)
ament_target_dependencies(intel_camera_node
  rclcpp
  sensor_msgs
)

# Install targets
install(TARGETS
  camera_handler
  ARCHIVE DESTINATION lib
  LIBRARY DESTINATION lib
  RUNTIME DESTINATION bin
)

install(TARGETS
  intel_camera_node
  DESTINATION lib/${PROJECT_NAME}
)

install(DIRECTORY include/
  DESTINATION include
)

install(DIRECTORY launch config
  DESTINATION share/${PROJECT_NAME}
  OPTIONAL
)

ament_package()
