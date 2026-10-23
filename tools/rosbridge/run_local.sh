#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly LOCAL="${ROOT}/.local"
readonly INTERFACE_SETUP="${ROOT}/../../ros2_ws/install/setup.bash"
readonly SERVER="${LOCAL}/opt/ros/jazzy/lib/rosbridge_server/rosbridge_websocket"
[[ -x "${SERVER}" ]] || {
  echo 'Local rosbridge is missing; run tools/rosbridge/install_local.sh.' >&2
  exit 1
}
[[ -f "${INTERFACE_SETUP}" ]] || {
  echo 'robot_hmi_msgs is not built; run colcon build in ROBOT_HMI/ros2_ws.' >&2
  exit 1
}

# ROS_DOMAIN_ID and RMW_IMPLEMENTATION inherit from the terminal, as they do
# for the system rosbridge launch. Bind only to loopback; the browser uses HMI.
# ROS setup scripts reference optional unset variables, so source them without
# nounset and restore strict mode before running the server.
set +u
# shellcheck source=/dev/null
source /opt/ros/jazzy/setup.bash
# shellcheck source=/dev/null
source "${INTERFACE_SETUP}"
set -u
export AMENT_PREFIX_PATH="${LOCAL}/opt/ros/jazzy:${AMENT_PREFIX_PATH:-}"
export PYTHONPATH="${LOCAL}/opt/ros/jazzy/lib/python3.12/site-packages:${LOCAL}/usr/lib/python3/dist-packages:${PYTHONPATH:-}"
export LD_LIBRARY_PATH="${LOCAL}/opt/ros/jazzy/lib:${LD_LIBRARY_PATH:-}"
exec python3 -u "${SERVER}" --address 127.0.0.1 --port 9090 --max_message_size 10000000
