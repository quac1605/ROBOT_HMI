#!/usr/bin/env bash
set -euo pipefail
readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"
[[ -x .bin/mediamtx ]] || { echo 'Run install_mediamtx.sh first' >&2; exit 1; }
if [[ -n "${HMI_LAN_IP:-}" ]]; then
  # Only the ICE/media and HTTPS signaling listeners move to the selected LAN
  # interface. The ROS RTP input and backend auth callback remain on loopback.
  python3 - "${HMI_LAN_IP}" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.IPv4Address(sys.argv[1])
except ipaddress.AddressValueError:
    raise SystemExit('HMI_LAN_IP must be an IPv4 address')
networks = [ipaddress.IPv4Network(value) for value in
            ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
if not any(address in network for network in networks):
    raise SystemExit('HMI_LAN_IP must be an RFC1918 address')
PY
  if ! ip -o -4 addr show | awk '{print $4}' | cut -d/ -f1 | grep -Fxq -- "${HMI_LAN_IP}"; then
    echo 'HMI_LAN_IP is not assigned to this Ubuntu machine.' >&2
    exit 2
  fi
  readonly LAN_KEY=".local/lan-${HMI_LAN_IP}.key"
  readonly LAN_CERT=".local/lan-${HMI_LAN_IP}.crt"
  [[ -f "${LAN_KEY}" && -f "${LAN_CERT}" ]] || {
    echo 'Run create_lan_dev_cert.sh for HMI_LAN_IP first.' >&2
    exit 1
  }
  export MTX_WEBRTCADDRESS="${HMI_LAN_IP}:8889"
  export MTX_WEBRTCLOCALUDPADDRESS="${HMI_LAN_IP}:8189"
  export MTX_WEBRTCADDITIONALHOSTS="${HMI_LAN_IP}"
  export MTX_WEBRTCALLOWORIGINS="https://${HMI_LAN_IP}:5173"
  export MTX_WEBRTCSERVERKEY="${LAN_KEY}"
  export MTX_WEBRTCSERVERCERT="${LAN_CERT}"
else
  [[ -f .local/server.key && -f .local/server.crt ]] || {
    echo 'Create .local/server.key and .local/server.crt as described in README.md' >&2
    exit 1
  }
fi
exec .bin/mediamtx mediamtx.yml
