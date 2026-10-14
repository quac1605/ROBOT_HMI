#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly LAN_IP="${1:-}"
if [[ -z "${LAN_IP}" ]]; then
  echo 'Usage: bash create_lan_dev_cert.sh <assigned-private-IPv4>' >&2
  exit 2
fi

# Reject hostnames, public addresses and typos before using the IP in paths.
python3 - "${LAN_IP}" <<'PY'
import ipaddress
import sys

try:
    address = ipaddress.IPv4Address(sys.argv[1])
except ipaddress.AddressValueError:
    raise SystemExit('Expected an IPv4 address')
networks = [ipaddress.IPv4Network(value) for value in
            ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
if not any(address in network for network in networks):
    raise SystemExit('Use an RFC1918 LAN address assigned to this machine')
PY
if ! ip -o -4 addr show | awk '{print $4}' | cut -d/ -f1 | grep -Fxq -- "${LAN_IP}"; then
  echo 'The LAN IP is not assigned to this Ubuntu machine.' >&2
  exit 2
fi

mkdir -p "${ROOT}/.local"
readonly KEY="${ROOT}/.local/lan-${LAN_IP}.key"
readonly CERT="${ROOT}/.local/lan-${LAN_IP}.crt"
if [[ -e "${KEY}" || -e "${CERT}" ]]; then
  echo 'LAN certificate already exists; refusing to overwrite it.' >&2
  exit 1
fi
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 30 \
  -keyout "${KEY}" -out "${CERT}" \
  -subj '/CN=robot-hmi-lan-development' \
  -addext "subjectAltName=IP:${LAN_IP},IP:127.0.0.1,DNS:localhost"
chmod 600 "${KEY}"
echo "LAN development certificate created for ${LAN_IP}."
openssl x509 -in "${CERT}" -noout -fingerprint -sha256
