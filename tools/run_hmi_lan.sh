#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly LAN_IP="${HMI_LAN_IP:-10.1.10.32}"
readonly CERT="${ROOT}/tools/ros-camera/.local/lan-${LAN_IP}.crt"
readonly KEY="${ROOT}/tools/ros-camera/.local/lan-${LAN_IP}.key"

python3 - "${LAN_IP}" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.IPv4Address(sys.argv[1])
except ipaddress.AddressValueError:
    raise SystemExit('HMI_LAN_IP must be an IPv4 address')
if not any(address in ipaddress.IPv4Network(network) for network in
           ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
    raise SystemExit('HMI_LAN_IP must be an RFC1918 LAN address')
PY
if ! ip -o -4 addr show | awk '{print $4}' | cut -d/ -f1 | grep -Fxq -- "${LAN_IP}"; then
  echo "LAN IP ${LAN_IP} is not assigned to this machine." >&2
  exit 1
fi
if [[ ! -f "${CERT}" || ! -f "${KEY}" ]]; then
  echo "Missing LAN TLS certificate; run tools/ros-camera/create_lan_dev_cert.sh ${LAN_IP}." >&2
  exit 1
fi
if ! openssl x509 -in "${CERT}" -noout -checkend 0 >/dev/null ||
   ! openssl x509 -in "${CERT}" -noout -ext subjectAltName | grep -Fq "IP Address:${LAN_IP}"; then
  echo "LAN TLS certificate is expired or does not cover ${LAN_IP}." >&2
  exit 1
fi
if [[ ! -f "${ROOT}/backend/.env" ]]; then
  echo 'Missing backend/.env.' >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
  # shellcheck source=/dev/null
  [[ -f "${NVM_DIR}/nvm.sh" ]] && source "${NVM_DIR}/nvm.sh"
fi
command -v node >/dev/null 2>&1 || { echo 'Node.js is not available.' >&2; exit 1; }

backend_pid=''
frontend_pid=''
cleanup() {
  trap - EXIT INT TERM
  [[ -z "${frontend_pid}" ]] || kill "${frontend_pid}" 2>/dev/null || true
  [[ -z "${backend_pid}" ]] || kill "${backend_pid}" 2>/dev/null || true
  [[ -z "${frontend_pid}" ]] || wait "${frontend_pid}" 2>/dev/null || true
  [[ -z "${backend_pid}" ]] || wait "${backend_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "${ROOT}"
HOST=127.0.0.1 PORT=3001 APP_ORIGIN="https://${LAN_IP}:5173" \
CAMERA_WHEP_BASE_URL="https://${LAN_IP}:5173" \
TRUST_LOOPBACK_PROXY=true \
node --env-file=backend/.env backend/src/server.js &
backend_pid=$!

# Wait for the loopback API before accepting LAN browser connections.
backend_ready=false
for _ in {1..80}; do
  if ! kill -0 "${backend_pid}" 2>/dev/null; then
    echo 'Backend exited before becoming ready.' >&2
    exit 1
  fi
  if curl --fail --silent --output /dev/null http://127.0.0.1:3001/api/health/live; then
    backend_ready=true
    break
  fi
  sleep 0.25
done
if [[ "${backend_ready}" != true ]]; then
  echo 'Backend did not become ready on 127.0.0.1:3001.' >&2
  exit 1
fi

(
  cd "${ROOT}/frontend"
  HMI_LAN_IP="${LAN_IP}" HMI_WHEP_PROXY_TARGET="https://${LAN_IP}:8889" \
  HMI_TLS_CERT_PATH="${CERT}" HMI_TLS_KEY_PATH="${KEY}" \
  VITE_ROBOT_CLIENT=remote HMI_BACKEND_URL=http://127.0.0.1:3001 \
  exec node node_modules/vite/bin/vite.js --host "${LAN_IP}" --port 5173 --strictPort
) &
frontend_pid=$!

echo "HMI LAN: https://${LAN_IP}:5173/login"
wait -n "${backend_pid}" "${frontend_pid}"
