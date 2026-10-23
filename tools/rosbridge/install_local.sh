#!/usr/bin/env bash
set -euo pipefail

# Install the official Ubuntu/ROS deb payloads in this checkout when sudo is
# unavailable. Only the local rosbridge WebSocket executable is run by HMI.
readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly LOCAL="${ROOT}/.local"
if [[ -x "${LOCAL}/opt/ros/jazzy/lib/rosbridge_server/rosbridge_websocket" ]]; then
  echo "Local rosbridge is already available at ${LOCAL}"
  exit 0
fi
if [[ -e "${LOCAL}" ]]; then
  echo "Incomplete local rosbridge at ${LOCAL}; inspect it before reinstalling." >&2
  exit 1
fi
command -v apt >/dev/null || { echo 'apt is required' >&2; exit 1; }
command -v dpkg-deb >/dev/null || { echo 'dpkg-deb is required' >&2; exit 1; }

readonly STAGING="$(mktemp -d "${ROOT}/.local.tmp.XXXXXX")"
cleanup() { rm -rf -- "${STAGING}"; }
trap cleanup EXIT
mkdir -p "${STAGING}/debs" "${STAGING}/root"
(
  cd "${STAGING}/debs"
  apt download \
    python3-bson python3-bson-ext python3-cbor2 python3-tornado python3-ujson \
    ros-jazzy-rosapi ros-jazzy-rosapi-msgs ros-jazzy-rosbridge-library \
    ros-jazzy-rosbridge-msgs ros-jazzy-rosbridge-server ros-jazzy-rosbridge-suite
)
for deb in "${STAGING}"/debs/*.deb; do
  dpkg-deb -x "${deb}" "${STAGING}/root"
done
test -x "${STAGING}/root/opt/ros/jazzy/lib/rosbridge_server/rosbridge_websocket"
mv -- "${STAGING}/root" "${LOCAL}"
echo "Local rosbridge installed at ${LOCAL}"
